import { Logging } from '@google-cloud/logging';
import { getConfig } from './githubConfig.js';

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

// One client per environment. Its key comes from GOOGLE_APPLICATION_CREDENTIALS_NP / _PR when set, otherwise the
// shared GOOGLE_APPLICATION_CREDENTIALS (ADC).
const clients = new Map();
function clientFor(env) {
  if (!clients.has(env)) {
    const keyFilename = process.env[`GOOGLE_APPLICATION_CREDENTIALS_${env.toUpperCase()}`]?.trim() || undefined;
    clients.set(env, new Logging({ projectId: projects[env], keyFilename }));
  }
  return clients.get(env);
}

// Strip characters that could break out of a quoted filter value.
const q = (s) => String(s).replace(/["\\]/g, '');

// Safety cap only, so one huge entry can't blow up a response. Override with MAX_MESSAGE_CHARS.
const MAX_MESSAGE_CHARS = Number(process.env.MAX_MESSAGE_CHARS) || 100_000;

// Return the complete log message (structured payloads are turned into a JSON string).
const fullMessage = (data) => {
  const text = typeof data === 'string' ? data : JSON.stringify(data) ?? '';
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
 * @param {string} [o.from] range start (ISO date); overrides hours
 * @param {string} [o.to] range end (ISO date)
 * @param {number} [o.hours=1] lookback window used when from is not given
 * @param {number} [o.limit=50]
 */
export async function queryLogs({ env, resource = 'cloud_run_revision', service, revision, severity, filter, search, insertId, from, to, hours = 1, limit = 50 } = {}) {
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
  console.log(`Cloud Logging query (project ${projectId}${profile ? ', ready-made query from the config' : ''}):\n  ${parts.join('\n  AND ')}`);

  const wanted = Math.min(Number(limit) || 50, 500);
  return listEntries(envId, projectId, parts.join(' AND '), wanted, { showAll: Boolean(insertId), term: insertId ? null : search });
}

// What a Cloud Logging insertId looks like, and the only characters accepted for one.
const INSERT_ID = /^[A-Za-z0-9._:-]{4,64}$/;

// A ready-made query from the config applies when its project is the one being read and its log source is the one chosen.
async function findProfile(projectId, resource) {
  try {
    const { logQueries } = await getConfig();
    return logQueries.find((p) => p.project === projectId && p.resource === resource) ?? null;
  } catch (err) {
    console.warn(`Config not available, using the generic query: ${err.message}`);
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

async function listEntries(envId, projectId, filter, wanted, { showAll = false, term = null } = {}) {
  const client = await clientFor(envId).auth.getClient();
  const results = [];
  let pageToken;
  for (let page = 0; page < MAX_PAGES && results.length < wanted; page += 1) {
    const res = await client.request({
      url: LIST_URL,
      method: 'POST',
      data: { resourceNames: [`projects/${projectId}`], filter, orderBy: 'timestamp desc', pageSize: wanted, ...(pageToken && { pageToken }) },
    });
    results.push(
      ...(res.data.entries ?? [])
        .map(toResult)
        .filter((r) => (showAll || isShownLog(r.message)) && (!term || containsWholeTerm(r.message, term))),
    );
    pageToken = res.data.nextPageToken;
    if (!pageToken) break;
  }
  return results.slice(0, wanted);
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
