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
    const m = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(key)}["']?\\s*[:=]\\s*["']?([\\w.@+-]+)`, 'i').exec(text);
    if (m) found.push({ name: key, value: m[1] });
  }
  return found;
}

/**
 * Value of each named header/field in the text (null when absent), in the order given.
 * A "-" before a name counts as part of a longer name, so "Kong-Request-ID" does not match inside "X-Kong-Request-Id".
 */
export function findHeaderValues(text, names) {
  return names.map((name) => {
    // Quotes may be escaped (\") when the value sits inside a JSON string, and a ";" before the name means it is
    // part of another header's value (for example "X-dynaTrace-Application=v=2;appId=...").
    const m = new RegExp(`(?<![A-Za-z0-9_;-])${escapeRegex(name)}[\\\\"']*\\s*[:=]\\s*[\\\\"']*([\\w.@+-]+)`, 'i').exec(text);
    return { name, value: m ? m[1] : null, index: m ? m.index : -1 };
  });
}

/**
 * The sender's name from a request body: "sender": { "@type": "TelusSender", "name": "Netcracker-Order-Handler" }.
 * Works on plain JSON and on JSON escaped inside a string (\"sender\":{\"name\":\"...\"}). Null when there is none.
 */
export function findSenderName(text) {
  // The sender object has no nested braces, so [^{}] keeps the search inside it.
  const m = /(?<![A-Za-z0-9_])sender[\\"']*\s*:\s*\{[^{}]*?[\\"']name[\\"']*\s*:\s*[\\"']*([\w.@+-]+)/i.exec(text);
  return m ? m[1] : null;
}

// Values that are only a placeholder, not a real name (a template that was never filled in).
const PLACEHOLDER_NAMES = new Set(['appname', 'string', 'null', 'undefined', 'name', 'sender', 'test', 'unknown', 'n/a', 'none']);

/**
 * Whether the log's own request says who called: an X-Consumer-Username / X-Consumer-ID, an appId, an
 * originatorApplicationId, or a sender name that is not a placeholder.
 */
export function hasCaller(text) {
  const named = findHeaderValues(text, ['X-Consumer-Username', 'X-Consumer-ID', 'appId', 'originatorApplicationId']).map((h) => h.value);
  return [...named, findSenderName(text)].some((v) => v && !PLACEHOLDER_NAMES.has(v.toLowerCase()));
}

const lastStart = (text, pattern) => {
  let last = -1;
  for (const m of text.matchAll(pattern)) last = m.index;
  return last;
};

/**
 * Whether the value found at this position in the log came from a request (a call To ECP) or from a response (the
 * answer From ECP): the nearest "request [{" or "response [{" before it decides. Null when neither comes before it.
 * @param {string} text the whole log message
 * @param {number} index where the value was found (the index findHeaderValues reports)
 * @returns {{kind: 'request'|'response', label: string, direction: string}|null} label is Request or Response;
 *   direction is the same thing as To ECP / From ECP
 */
export function directionAt(text, index) {
  if (index < 0) return null;
  const before = text.slice(0, index);
  const request = lastStart(before, /(?<![A-Za-z0-9_])request\s*\[\{/gi);
  const response = lastStart(before, /(?<![A-Za-z0-9_])response\s*\[\{/gi);
  if (request < 0 && response < 0) return null;
  return request > response
    ? { kind: 'request', label: 'Request', direction: 'To ECP' }
    : { kind: 'response', label: 'Response', direction: 'From ECP' };
}

/** The templateName in the log ("templateName":"TELUS_WELCOME"), or null. */
export const templateNameOf = (text) => findHeaderValues(text, ['templateName'])[0].value;

// Show only the shape of a bearer token, never the token itself.
export const maskHeaderValue = (name, value) =>
  /^authorization$/i.test(name) ? value.replace(/(Bearer\s+)\S+/i, '$1••••••••') : value;
