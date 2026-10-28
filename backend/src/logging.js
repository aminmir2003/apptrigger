import { existsSync } from 'node:fs';
import { Logging } from '@google-cloud/logging';
import { getConfig } from './githubConfig.js';
import { uniqueRecords } from './dedupe.js';
import { fail, log, maskCredentials, timer, warn } from './log.js';

// The environments a request may read, each with its own project (GCP_PROJECT_NP / GCP_PROJECT_PR). This API has no
// sign-in, so it never reads a project that is not listed here. With neither set, GCP_PROJECT_ID is the only one.
const ENV_LABELS = { np: 'NP', pr: 'PR' };
const projects = Object.fromEntries(
  Object.keys(ENV_LABELS).map((id) => [id, process.env[`GCP_PROJECT_${id.toUpperCase()}`]?.trim()]).filter(([, p]) => p),
);
if (!Object.keys(projects).length) {
  if (!process.env.GCP_PROJECT_ID) throw new Error('GCP_PROJECT_NP / GCP_PROJECT_PR (or GCP_PROJECT_ID) is not set');
  projects.default = process.env.GCP_PROJECT_ID;
}
export const environments = Object.entries(projects).map(([id, project]) => ({ id, label: ENV_LABELS[id] ?? id, project }));
const defaultEnv = projects[process.env.DEFAULT_ENV?.toLowerCase()] ? process.env.DEFAULT_ENV.toLowerCase() : environments[0].id;

/**
 * The service account key given as text (the whole JSON key file). Throws a short reason, never the key itself.
 * @param {string} text
 */
export function parseServiceAccountKey(text) {
  let key;
  try {
    key = JSON.parse(text);
  } catch {
    throw new Error('is not valid JSON (paste the whole key file, starting with "{")');
  }
  if (key?.type !== 'service_account' || !key.client_email || !key.private_key) {
    throw new Error('is not a service account key (it needs type, client_email and private_key)');
  }
  return key;
}

// At start-up, say so if a key file named in the settings is not there. A Windows path (C:\...) never exists on Linux
// or in Cloud Shell, and this is far easier to spot now than as a failed search later.
for (const { id } of environments) {
  const suffix = id.toUpperCase();
  const file = process.env[`GOOGLE_APPLICATION_CREDENTIALS_${suffix}`]?.trim();
  if (!file || process.env[`GCP_SA_KEY_${suffix}`]?.trim() || existsSync(file)) continue;
  const windowsPath = /^[A-Za-z]:[\\/]/.test(file) && process.platform !== 'win32';
  warn(
    'auth',
    `${suffix}: the key file ${file} does not exist${windowsPath ? ` (this is a Windows path, but the server runs on ${process.platform}; use a path on this machine, or remove the line to use the default Google login)` : ''}`,
  );
}

// One client per environment, signed in as that environment's own service account. The key comes from, in order:
//   GCP_SA_KEY_NP / GCP_SA_KEY_PR                         the key file's content as text (Cloud Run, GitHub secret)
//   GOOGLE_APPLICATION_CREDENTIALS_NP / _PR               the path of a key file (your own machine)
//   GOOGLE_APPLICATION_CREDENTIALS / the platform account  shared by both (ADC)
const clients = new Map();
function clientFor(env) {
  if (!clients.has(env)) {
    const suffix = env.toUpperCase();
    const keyText = process.env[`GCP_SA_KEY_${suffix}`]?.trim();
    let credentials;
    if (keyText) {
      try {
        credentials = parseServiceAccountKey(keyText);
      } catch (err) {
        throw new Error(`GCP_SA_KEY_${suffix} ${err.message}`);
      }
    }
    const keyFilename = credentials ? undefined : process.env[`GOOGLE_APPLICATION_CREDENTIALS_${suffix}`]?.trim() || undefined;
    clients.set(env, new Logging({ projectId: projects[env], credentials, keyFilename }));
    log('auth', `${suffix} (${projects[env]}) signs in with ${credentials ? `the key in GCP_SA_KEY_${suffix} (${credentials.client_email})` : keyFilename ? `the key file ${keyFilename}` : 'the default Google credentials (ADC)'}`);
  }
  return clients.get(env);
}

// Strip characters that could break out of a quoted filter value.
const q = (s) => String(s).replace(/["\\]/g, '');

// Safety cap only, so one huge entry can't blow up a response. Override with MAX_MESSAGE_CHARS.
const MAX_MESSAGE_CHARS = Number(process.env.MAX_MESSAGE_CHARS) || 100_000;

// Return the complete log message (structured payloads are turned into a JSON string).
const fullMessage = (data) => {
  // Credentials inside a log entry (such as the Authorization header of a request) never reach the page.
  const text = maskCredentials(typeof data === 'string' ? data : JSON.stringify(data) ?? '');
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}… [truncated]` : text;
};

/**
 * Query Cloud Run logs from Cloud Logging.
 * @param {object} o
 * @param {string} [o.env] environment to read, "np" or "pr" (default: DEFAULT_ENV, else the first configured)
 * @param {string} [o.resource=cloud_run_revision] resource type, e.g. cloudsql_database, k8s_container, or "all"
 * @param {string} [o.service] Cloud Run service name
 * @param {string} [o.revision] Cloud Run revision name
 * @param {string} [o.severity] minimum severity, e.g. ERROR
 * @param {string} [o.search] text to find in the log entries
 * @param {string} [o.filter] extra Logging query language filter
 * @param {boolean} [o.raw] return every matching entry of any kind, uncollapsed (used to study a template's other logs)
 * @param {string} [o.from] range start (ISO date); overrides hours
 * @param {string} [o.to] range end (ISO date)
 * @param {number} [o.hours=1] lookback window used when from is not given
 * @param {number} [o.limit=50]
 */
export async function queryLogs({ env, resource = 'cloud_run_revision', service, revision, severity, filter, search, insertId, raw, from, to, hours = 1, limit = 50 } = {}) {
  const envId = String(env || defaultEnv).toLowerCase();
  const projectId = Object.hasOwn(projects, envId) ? projects[envId] : null;
  if (!projectId) throw new Error(`Environment "${q(envId)}" is not configured. Available: ${environments.map((e) => e.id).join(', ')}.`);
  const start = from ? new Date(from) : new Date(Date.now() - hours * 3600 * 1000);
  const end = to ? new Date(to) : null;
  if (Number.isNaN(start.getTime()) || (end && Number.isNaN(end.getTime()))) throw new Error('Invalid from/to date');
  // Looking up one entry by its insertId reads that entry whatever kind of log it is, so no log source applies and
  // the request/pubsub display filter is skipped.
  if (insertId != null && !INSERT_ID.test(String(insertId))) throw new Error('Invalid insertId');
  const profile = insertId ? null : await findProfile(projectId, resource);
  const parts = insertId
    ? [`insertId="${q(insertId)}"`, `timestamp>="${start.toISOString()}"`, ...(end ? [`timestamp<="${end.toISOString()}"`] : [])]
    : buildClauses({ resource, profile, since: start.toISOString(), end, service, revision, severity, search, filter });

  // Show exactly what is sent to Cloud Logging (one clause per line, all joined with AND).
  log('logs', `query for ${envId.toUpperCase()} (project ${projectId}${profile ? ', ready-made query from the config' : ''}), up to ${Math.min(Number(limit) || 50, 500)} unique records:\n  ${parts.join('\n  AND ')}`);

  const wanted = Math.min(Number(limit) || 50, 500);
  return listEntries(envId, projectId, parts.join(' AND '), wanted, { showAll: Boolean(insertId) || Boolean(raw), term: insertId ? null : search });
}

// What a Cloud Logging insertId looks like, and the only characters accepted for one.
const INSERT_ID = /^[A-Za-z0-9._:-]{4,64}$/;

// A ready-made query from the config applies when its project is the one being read and its log source is the one chosen.
async function findProfile(projectId, resource) {
  try {
    const { logQueries } = await getConfig();
    return logQueries.find((p) => p.project === projectId && p.resource === resource) ?? null;
  } catch (err) {
    warn('logs', `config not available, using the generic query: ${err.message}`);
    return null;
  }
}

/**
 * The query clauses, in order. A matching ready-made query replaces the generic resource.type clause; "all" has no
 * resource clause at all. The time range, the search text and the optional filters are always added.
 */
export function buildClauses({ resource, profile, since, end, service, revision, severity, search, filter }) {
  const parts = profile ? [...profile.filter] : resource === 'all' ? [] : [`resource.type="${q(resource)}"`];
  parts.push(`timestamp>="${since}"`);
  if (end) parts.push(`timestamp<="${end.toISOString()}"`);
  if (service) parts.push(`resource.labels.service_name="${q(service)}"`);
  if (revision) parts.push(`resource.labels.revision_name="${q(revision)}"`);
  if (severity) parts.push(`severity>=${String(severity).replace(/[^A-Za-z]/g, '')}`);
  if (search) parts.push(`SEARCH("${q(search)}")`);
  if (filter) parts.push(`(${filter})`);
  return parts;
}

// Only two kinds of log are shown: a request dump ("request [{...") and a pubsub message ("message: {...").
const REQUEST_MARKER = 'request [{';
const PUBSUB_MESSAGE = /\bmessage["']?\s*[:=]\s*\{/i;
export const isShownLog = (text) => text.includes(REQUEST_MARKER) || PUBSUB_MESSAGE.test(text);

/**
 * Cloud Logging's text search also finds the term inside a longer name (searching BYOD_ORDER_CONF_KOODO returns
 * BYOD_ORDER_CONF_KOODO_CSAG too). Keep an entry only when the term stands alone: no letter, digit or underscore
 * directly before or after it. Case does not matter.
 */
export function containsWholeTerm(text, term) {
  const escaped = String(term).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i').test(text);
}

// Entries come from the Cloud Logging REST API (entries:list), which returns every payload as plain JSON.
// The client library's own getEntries() hands audit logs back still packed as { type_url, value: <bytes> },
// which is unreadable; the REST form is what the Google console shows (protoPayload with named fields).
const LIST_URL = 'https://logging.googleapis.com/v2/entries:list';
const MAX_PAGES = 10; // a sparse search can return short pages, so keep asking until there are enough or the pages run out
// A single call to Google that takes longer than this fails with a clear error instead of hanging (LOG_PAGE_TIMEOUT_MS),
// and a search stops asking for more pages after this long and returns what it has (LOG_SEARCH_BUDGET_MS).
const PAGE_TIMEOUT_MS = Number(process.env.LOG_PAGE_TIMEOUT_MS) || 30_000;
const SEARCH_BUDGET_MS = Number(process.env.LOG_SEARCH_BUDGET_MS) || 45_000;

async function listEntries(envId, projectId, filter, wanted, { showAll = false, term = null } = {}) {
  const total = timer();
  let client;
  try {
    client = await clientFor(envId).auth.getClient();
  } catch (err) {
    fail('logs', `could not sign in to Google Cloud for ${envId.toUpperCase()}: ${err.message}`);
    throw err;
  }
  log('logs', `signed in (${total.text()}), reading Cloud Logging`);

  const results = [];
  // Newest first, so the first record of each kind is the newest; later identical ones are only counted (see dedupe.js).
  // A lookup of one entry by its insertId is never collapsed.
  const unique = uniqueRecords();
  let pageToken;
  let scanned = 0;
  let pagesRead = 0;
  let stop = 'page limit';
  for (let page = 0; page < MAX_PAGES && results.length < wanted; page += 1) {
    if (page > 0 && total.ms() > SEARCH_BUDGET_MS) {
      stop = 'time budget';
      warn('logs', `stopping after ${total.text()} (LOG_SEARCH_BUDGET_MS=${SEARCH_BUDGET_MS}); returning what was found so far`);
      break;
    }
    const t = timer();
    let res;
    try {
      res = await client.request({
        url: LIST_URL,
        method: 'POST',
        data: { resourceNames: [`projects/${projectId}`], filter, orderBy: 'timestamp desc', pageSize: wanted, ...(pageToken && { pageToken }) },
        timeout: PAGE_TIMEOUT_MS,
      });
    } catch (err) {
      const slow = /timeout|timed out|ETIMEDOUT|aborted/i.test(`${err.code} ${err.message}`);
      fail('logs', `page ${page + 1} failed after ${t.text()}: ${err.message}`);
      throw slow ? new Error(`Google Cloud Logging did not answer within ${PAGE_TIMEOUT_MS / 1000} seconds`) : err;
    }
    const entries = res.data.entries ?? [];
    const before = results.length;
    for (const entry of entries) {
      const r = toResult(entry);
      if (!showAll && !isShownLog(r.message)) continue;
      if (term && !containsWholeTerm(r.message, term)) continue;
      if (showAll || unique.add(r)) results.push(r);
    }
    scanned += entries.length;
    pagesRead += 1;
    log('logs', `page ${page + 1}/${MAX_PAGES}: ${entries.length} entries in ${t.text()}, ${results.length - before} new unique (${results.length} so far)`);
    pageToken = res.data.nextPageToken;
    if (!pageToken) {
      stop = 'no more entries';
      break;
    }
    if (results.length >= wanted) stop = 'enough records';
  }
  const kept = results.slice(0, wanted);
  const matches = kept.reduce((n, r) => n + (r.repeats ?? 1), 0);
  log('logs', `done in ${total.text()}: read ${scanned} entries in ${pagesRead} page${pagesRead === 1 ? '' : 's'} (stopped: ${stop}), ${kept.length} unique record${kept.length === 1 ? '' : 's'} from ${matches} matches`);
  if (stop === 'page limit') warn('logs', `stopped at the page limit (${MAX_PAGES} pages of up to ${wanted}); older matches were not read, so repeat counts may be low`);
  return kept;
}

/** Turn one REST log entry into what the page shows. Text logs stay text; JSON and audit payloads become JSON text. */
export function toResult(e) {
  const payload = e.textPayload !== undefined ? e.textPayload : (e.jsonPayload ?? e.protoPayload);
  return {
    timestamp: e.timestamp,
    severity: e.severity,
    service: e.resource?.labels?.service_name,
    revision: e.resource?.labels?.revision_name,
    httpRequest: e.httpRequest,
    message: fullMessage(payload),
  };
}
