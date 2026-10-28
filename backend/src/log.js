// Backend log lines, printed to the terminal the server runs in:
//   12:34:56.789 [logs] page 3: 500 entries in 4.2 s, kept 0
// Each line has a time and a scope (http, logs, fuelix, ...). Only counts, names and timings are written. As a second
// line of defence every line (and every error message sent to the page) goes through scrub(), which hides anything that
// looks like a key or token, in case an error from Google, FuelIX or GitHub repeats one.
//
//   LOG_LEVEL   info (default) shows everything, quiet shows only warnings and errors.

const quiet = () => String(process.env.LOG_LEVEL ?? '').toLowerCase() === 'quiet';
const stamp = () => new Date().toISOString().slice(11, 23);

const HIDDEN = '[hidden]';

// Settings that hold a secret. Their exact value (and the private key inside a service account key) is hidden wherever
// it appears; so is the start of a long one, because an error may repeat only part of a key ("ak-1HGa8R***").
const SECRET_SETTINGS = ['FUELIX_API_KEY', 'GITHUB_TOKEN', 'SESSION_SECRET', 'OIDC_CLIENT_SECRET', 'CONFIG_GITHUB_TOKEN'];
const KEY_SETTINGS = ['GCP_SA_KEY_NP', 'GCP_SA_KEY_PR'];

function knownSecrets() {
  const found = new Set();
  const add = (value, { start = true } = {}) => {
    if (typeof value !== 'string' || value.length < 8) return;
    found.add(value);
    if (start && value.length >= 16) found.add(value.slice(0, 10));
  };
  for (const name of SECRET_SETTINGS) add(process.env[name]?.trim());
  for (const name of KEY_SETTINGS) {
    const text = process.env[name]?.trim();
    add(text, { start: false }); // the file's first characters are just "{ "type"..."
    try {
      const key = JSON.parse(text);
      add(key.private_key, { start: false });
      // Each line of the key itself, in case only a piece of it is repeated.
      for (const part of String(key.private_key ?? '').split('\n')) if (part.length >= 16 && !part.startsWith('-----')) add(part, { start: false });
      add(key.private_key_id);
    } catch {
      // not JSON: nothing more to pick out
    }
  }
  return [...found];
}

// Shapes of keys and tokens, whether or not they are in the settings.
const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, HIDDEN], // a key file's private key
  [/(["']?private_key(?:_id)?["']?\s*[:=]\s*["']?)[^"',\s}]{8,}/gi, `$1${HIDDEN}`],
  [/(authorization["']?\s*[:=]\s*["']?)(?:Bearer\s+|Basic\s+)?[A-Za-z0-9._~+/=-]{8,}/gi, `$1${HIDDEN}`],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${HIDDEN}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, HIDDEN], // a JWT
  [/\b(?:sk|ak|pk)-[A-Za-z0-9*._-]{8,}/g, HIDDEN], // API keys such as sk-... / ak-...
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, HIDDEN], // GitHub tokens
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, HIDDEN],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, HIDDEN], // a Google API key
  [/\bya29\.[A-Za-z0-9._-]{20,}/g, HIDDEN], // a Google access token
  [/((?:client_secret|api[_-]?key|access_token|refresh_token|id_token|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}&]{6,}/gi, `$1${HIDDEN}`],
];

/** The text with every key, token and secret hidden. Safe to call on any error message before it is shown or logged. */
export function scrub(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  const [pem, ...others] = PATTERNS; // a whole private key block goes first, before anything is cut out of it
  text = text.replace(pem[0], pem[1]);
  for (const secret of knownSecrets()) text = text.split(secret).join(HIDDEN);
  for (const [pattern, replacement] of others) text = text.replace(pattern, replacement);
  return text;
}

/**
 * Hides only login credentials (authorization headers, bearer tokens, JWTs, private key blocks) in a log entry that is
 * about to be shown on the page. The rest of the entry is left exactly as it was, because it is the data being looked at.
 */
export function maskCredentials(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  for (const [pattern, replacement] of [PATTERNS[0], PATTERNS[2], PATTERNS[3], PATTERNS[4]]) text = text.replace(pattern, replacement);
  return text;
}

const line = (scope, message) => `${stamp()} [${scope}] ${scrub(message)}`;

export const log = (scope, message) => {
  if (!quiet()) console.log(line(scope, message));
};
export const warn = (scope, message) => console.warn(line(scope, `WARN ${message}`));
export const fail = (scope, message) => console.error(line(scope, `ERROR ${message}`));

/** A running clock: const t = timer(); ... t.text() -> "850 ms" or "4.2 s". */
export function timer() {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  return { ms, text: () => (ms() < 1000 ? `${ms()} ms` : `${(ms() / 1000).toFixed(1)} s`) };
}
