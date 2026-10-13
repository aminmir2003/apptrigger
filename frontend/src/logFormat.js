// Turns raw log text into structured data so it can be shown nicely. Handles:
//   - a "request [{header=value, ...},{json body}]" line, pasted or coming from Cloud Logging
//   - a structured (JSON) Cloud Logging entry, including one whose "message" field holds such a request
//   - anything else is left alone (shown as plain text by the caller)

const HEADER_SPLIT = /, (?=[A-Za-z][\w-]*=)/;
const REQUEST_MARKER = 'request [{';

const tryParse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// Logs copied out of a JSON "message" field have every quote escaped; undo one level of that.
const unescapeOnce = (text) => {
  const viaJson = tryParse(`"${text}"`);
  return typeof viaJson === 'string' ? viaJson : text.replace(/\\"/g, '"');
};

// Strings that themselves contain JSON (like a "value" field) are expanded so they read naturally.
export const deepParse = (value) => {
  if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
    const inner = tryParse(value);
    return inner === undefined ? value : deepParse(inner);
  }
  if (Array.isArray(value)) return value.map(deepParse);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepParse(v)]));
  return value;
};

// Index of the "}" that closes the "{" at `start`, so trailing text such as "]" or a closing quote is ignored.
function matchingBrace(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && (depth -= 1) === 0) return i;
  }
  return -1;
}

export function parseRequestLog(message) {
  const start = message.indexOf(REQUEST_MARKER);
  if (start < 0) return null;

  const headersStart = start + REQUEST_MARKER.length;
  const headersEnd = message.indexOf('},{', headersStart);
  if (headersEnd < 0) return null;

  const headers = message
    .slice(headersStart, headersEnd)
    .split(HEADER_SPLIT)
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq < 0 ? null : { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
    })
    .filter(Boolean);
  if (headers.length === 0) return null;

  const bodyStart = headersEnd + 2;
  const bodyEnd = matchingBrace(message, bodyStart);
  const rawBody = bodyEnd < 0 ? message.slice(bodyStart) : message.slice(bodyStart, bodyEnd + 1);
  const parsed = rawBody ? (tryParse(rawBody) ?? tryParse(unescapeOnce(rawBody))) : undefined;

  return { headers, body: parsed === undefined ? null : deepParse(parsed), rawBody };
}

/**
 * Work out how to display a log message.
 * @returns {{kind:'request', request:object, rest:object|null}|{kind:'json', data:any}|null}
 */
export function parseLog(message) {
  const obj = tryParse(message);
  if (obj && typeof obj === 'object') {
    // Structured entry: look for a field that holds a request log.
    if (!Array.isArray(obj)) {
      for (const [field, value] of Object.entries(obj)) {
        if (typeof value === 'string' && value.includes(REQUEST_MARKER)) {
          const request = parseRequestLog(value);
          if (request) {
            const { [field]: _removed, ...others } = obj;
            return { kind: 'request', request, rest: Object.keys(others).length ? deepParse(others) : null };
          }
        }
      }
    }
    return { kind: 'json', data: deepParse(obj) };
  }

  const request = parseRequestLog(message);
  return request ? { kind: 'request', request, rest: null } : null;
}

const escapeRegex = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Values of the given keys found anywhere in the text, as "key=value" / "key: value" (or quoted JSON). */
export function findIdentifiers(text, keys) {
  const found = [];
  for (const key of keys) {
    const m = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(key)}["']?\\s*[:=]\\s*["']?([\\w.-]+)`, 'i').exec(text);
    if (m) found.push({ name: key, value: m[1] });
  }
  return found;
}

// Show only the shape of a bearer token, never the token itself.
export const maskHeaderValue = (name, value) =>
  /^authorization$/i.test(name) ? value.replace(/(Bearer\s+)\S+/i, '$1••••••••') : value;
