// Configuration kept outside the code: the keys to search for in logs, and the display labels for
// them.
//
// Where it comes from:
//   - GITHUB_REPO set    -> a JSON file in that GitHub repository, cached for a few minutes, so editing it
//                           on GitHub updates the app without a redeploy.
//   - GITHUB_REPO empty  -> a local JSON file (for running on your own machine): CONFIG_FILE if set, else
//                           backend/config.local.json, else backend/config.example.json. Re-read on every call,
//                           so edits apply straight away.
// Both use the same format, see config.example.json.
//
//   GITHUB_REPO                 owner/repository                      (empty = use the local file)
//   CONFIG_FILE                 path of the local file                (local mode only)
//   GITHUB_CONFIG_PATH          path of the file in the repo          (default apptrigger-config.json)
//   GITHUB_BRANCH               branch, tag or commit                 (default main)
//   GITHUB_TOKEN                token with read access to the repo    (needed for a private repo)
//   GITHUB_API_URL              API base URL                          (default https://api.github.com)
//   GITHUB_CONFIG_TTL_SECONDS   how long a download is reused         (default 300)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;
const MAX_KEYS = 20;
const RETRY_AFTER_FAILURE_MS = 30_000;

let cache = null; // { config, fetchedAt, stale }
let inflight = null;

function settings() {
  const repo = (process.env.GITHUB_REPO || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`GITHUB_REPO must look like owner/repository (got "${repo.slice(0, 60)}")`);
  }
  return {
    repo,
    path: (process.env.GITHUB_CONFIG_PATH || 'apptrigger-config.json').replace(/^\/+/, ''),
    branch: (process.env.GITHUB_BRANCH || 'main').trim(),
    token: (process.env.GITHUB_TOKEN || '').trim(),
    api: (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
  };
}

const ttlMs = () => (Number(process.env.GITHUB_CONFIG_TTL_SECONDS) || 300) * 1000;
const text = (v) => (v == null ? '' : String(v).trim());

/**
 * Validate the JSON from GitHub and turn it into the shape the app uses.
 * @returns {{ searchKeys: string[], labels: Record<string,string>, logQueries: {project: string, resource: string, filter: string[]}[] }}
 */
export function parseConfig(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('config must be a JSON object');

  const { searchKeys, labels = {}, logQueries = [] } = json;
  if (!Array.isArray(searchKeys) || searchKeys.length === 0 || searchKeys.length > MAX_KEYS) {
    throw new Error(`config "searchKeys" must be a list of 1-${MAX_KEYS} names`);
  }
  const keys = [];
  for (const k of searchKeys) {
    if (typeof k !== 'string' || !KEY_PATTERN.test(k)) throw new Error(`config "searchKeys" has an invalid name: ${JSON.stringify(k)} (letters, digits, _ . or - only)`);
    if (!keys.some((x) => x.toLowerCase() === k.toLowerCase())) keys.push(k);
  }

  if (labels === null || typeof labels !== 'object' || Array.isArray(labels)) throw new Error('config "labels" must be an object of key -> display name');
  const cleanLabels = {};
  for (const [k, v] of Object.entries(labels)) if (text(v)) cleanLabels[k] = text(v);

  // Ready-made log queries per project. When the chosen log source and the project match one of these, its lines
  // (each one a Cloud Logging query line, all joined with AND) replace the generic "resource.type=..." filter.
  if (!Array.isArray(logQueries) || logQueries.length > 20) throw new Error('config "logQueries" must be a list of at most 20 entries');
  const queries = logQueries.map((q, i) => {
    const where = `config "logQueries" entry ${i + 1}`;
    if (!q || typeof q !== 'object' || Array.isArray(q)) throw new Error(`${where} must be an object`);
    if (typeof q.project !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(q.project)) throw new Error(`${where} needs a "project" (a Google Cloud project id)`);
    if (typeof q.resource !== 'string' || !/^[a-z0-9_]{1,60}$/.test(q.resource)) throw new Error(`${where} needs a "resource" such as k8s_container`);
    const lines = Array.isArray(q.filter) ? q.filter.map(text).filter(Boolean) : [];
    if (lines.length === 0 || lines.length > 30 || lines.some((l) => l.length > 500)) throw new Error(`${where} needs a "filter" list of 1-30 query lines`);
    return { project: q.project, resource: q.resource, filter: lines };
  });

  return { searchKeys: keys, labels: cleanLabels, logQueries: queries };
}

async function download() {
  const s = settings();
  const url = `${s.api}/repos/${s.repo}/contents/${s.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(s.branch)}`;
  const headers = { Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'apptrigger' };
  if (s.token) headers.Authorization = `Bearer ${s.token}`;

  const res = await fetch(url, { headers });
  const body = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 404 ? `file "${s.path}" not found in ${s.repo}@${s.branch} (for a private repo, GITHUB_TOKEN is required)`
      : res.status === 401 ? 'GITHUB_TOKEN was rejected'
      : res.status === 403 ? 'access denied or rate limit reached (set GITHUB_TOKEN)'
      : body.slice(0, 200);
    throw new Error(`GitHub config request failed (${res.status}): ${hint}`);
  }
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`"${s.path}" in ${s.repo} is not valid JSON`);
  }
  return parseConfig(json);
}

// ----- local file mode -----------------------------------------------------------------------------

const useGithub = () => (process.env.GITHUB_REPO || '').trim() !== '';
const here = (name) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const localCandidates = () => [(process.env.CONFIG_FILE || '').trim() || null, here('config.local.json'), here('config.example.json')].filter(Boolean);
let localFile = null; // the file the last local read used

async function loadLocal() {
  for (const file of localCandidates()) {
    let body;
    try {
      body = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue; // not there: try the next candidate
      throw new Error(`Could not read the local config file ${file}: ${err.message}`);
    }
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error(`The local config file ${path.basename(file)} is not valid JSON`);
    }
    localFile = file;
    return parseConfig(json);
  }
  throw new Error('No local config file found. Create backend/config.local.json (copy config.example.json) or set GITHUB_REPO.');
}

/** The current config, from cache when it is fresh. A failed refresh keeps serving the last good copy. */
export async function getConfig() {
  if (!useGithub()) return loadLocal();
  const now = Date.now();
  if (cache && now - cache.fetchedAt < ttlMs() && !cache.stale) return cache.config;
  if (cache && cache.stale && now - cache.fetchedAt < RETRY_AFTER_FAILURE_MS) return cache.config;

  inflight ??= download()
    .then((config) => {
      cache = { config, fetchedAt: Date.now(), stale: false };
      return config;
    })
    .catch((err) => {
      if (!cache) throw err;
      console.warn(`GitHub config refresh failed, using the last good copy: ${err.message}`);
      cache = { ...cache, fetchedAt: Date.now(), stale: true };
      return cache.config;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Non-secret facts about where the config came from (for the page's details card). */
export function configSource() {
  if (!useGithub()) return { type: 'local', file: localFile ? path.basename(localFile) : null };
  try {
    const s = settings();
    return { type: 'github', repo: s.repo, path: s.path, branch: s.branch, fetchedAt: cache ? new Date(cache.fetchedAt).toISOString() : null, stale: cache?.stale ?? false };
  } catch {
    return null;
  }
}

/**
 * Keys a request may search for: all configured keys, or the requested ones if every one of them is configured.
 * @param {string[]|undefined} requested
 * @param {string[]} configured keys from GitHub
 */
export function chooseKeys(requested, configured) {
  if (requested == null) return configured;
  if (!Array.isArray(requested) || requested.length === 0) throw new Error('keys must be a non-empty list');
  const chosen = [];
  for (const k of requested) {
    const match = configured.find((c) => c.toLowerCase() === String(k).toLowerCase());
    if (!match) throw new Error(`unknown key "${String(k).slice(0, 40)}": it is not in the configured search keys`);
    if (!chosen.includes(match)) chosen.push(match);
  }
  return chosen;
}

/** Test helper: forget the cached download. */
export function resetConfigCache() {
  cache = null;
  inflight = null;
}
