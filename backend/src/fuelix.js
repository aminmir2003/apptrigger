// FuelIX layer: sends log messages to an OpenAI-compatible chat completions
// endpoint and asks the model to pull structured values out of them.
const BATCH_SIZE = 25;

// Never send credentials to the model: remove bearer tokens and JWT-shaped strings from log text.
export const redactSecrets = (text) =>
  String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]');

const systemPrompt = (keys) => `You analyse log lines.
For each numbered log, look for these keys, in priority order: ${keys.map((k) => `"${k}"`).join(', ')}.
A key appears as "<key>: <value>" or "<key>=<value>", optionally with quotes around the key or value, e.g. relfrozenxid: 101892, relfrozenxid=101892, X-Consumer-Username=PaymentManagement or "X-Consumer-Username":"PaymentManagement" (case-insensitive, whole word only, e.g. "XID" must not match inside "relfrozenxid").
Return EVERY key from the list that is present in the log, in the priority order given, each with its value copied exactly as it appears.
Reply with ONLY a JSON array, no prose and no code fences, in the form:
[{"index": 0, "matches": [{"key": "${keys[0]}", "value": "274942"}, {"key": "${keys[keys.length - 1]}", "value": "abc"}]}, {"index": 1, "matches": []}]
Use an empty matches array when the log contains none of the keys.`;

function config() {
  const { FUELIX_API_KEY: key, FUELIX_ENDPOINT: endpoint, FUELIX_MODEL: model } = process.env;
  if (!key) throw new Error('FUELIX_API_KEY is not set');
  if (!endpoint) throw new Error('FUELIX_ENDPOINT is not set');
  if (!model) throw new Error('FUELIX_MODEL is not set (add a model name from your FuelIX account to .env)');
  return { key, endpoint, model };
}

async function chat(messages) {
  const { key, endpoint, model } = config();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: 0 }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`FuelIX request failed (${res.status}): ${text.slice(0, 300)}`);
  const content = JSON.parse(text).choices?.[0]?.message?.content;
  if (!content) throw new Error('FuelIX returned no content');
  return content;
}

// Models sometimes wrap JSON in code fences or prose despite instructions, or return an object
// ({"results": [...]}) or a single item instead of a bare array.
const parseJsonArray = (content) => {
  const cleaned = content.replace(/```(?:json)?/g, '').trim();
  const fail = () => new Error(`FuelIX reply was not usable JSON: ${JSON.stringify(cleaned.slice(0, 200))}`);

  const arrayStart = cleaned.indexOf('[');
  const objectStart = cleaned.indexOf('{');
  // Prefer a top-level array; fall back to an object if it comes first or there is no array.
  const useArray = arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart);
  const text = useArray
    ? cleaned.slice(arrayStart, cleaned.lastIndexOf(']') + 1)
    : objectStart !== -1
      ? cleaned.slice(objectStart, cleaned.lastIndexOf('}') + 1)
      : '';
  if (!text) throw fail();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail();
  }
  if (Array.isArray(parsed)) return parsed;
  // {"results": [...]} or any single property holding an array
  const nested = Object.values(parsed ?? {}).find(Array.isArray);
  if (nested) return nested;
  // A single lookup object such as {"value": "101892", "description": "EPS"}
  return [parsed];
};

const escapeRegex = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Keep only matches whose value really follows the key in the log (guards against hallucinated values),
 * drop repeats, and order them by the key priority.
 * @param {string} log the (redacted) log text
 * @param {string[]} keys keys in priority order
 * @param {{key:string, value:string}[]} candidates what the model reported
 */
export function validateMatches(log, keys, candidates) {
  const accepted = [];
  for (const c of candidates) {
    const key = keys.find((k) => k.toLowerCase() === String(c?.key ?? '').toLowerCase());
    const value = String(c?.value ?? '');
    if (!key || !/^[\w.-]+$/.test(value) || accepted.some((a) => a.key === key)) continue;
    const found = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(key)}["']?\\s*[:=]\\s*["']?${escapeRegex(value)}(?![\\w.-])`, 'i');
    if (found.test(log)) accepted.push({ key, value });
  }
  return accepted.sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
}

/**
 * Plain pattern match for the same "key: value" / "key=value" shapes, used when the model reports nothing
 * for a log that visibly contains a key. Returns matches in key priority order.
 * @param {string} log the (redacted) log text
 * @param {string[]} keys keys in priority order
 */
export function findKeysByPattern(log, keys) {
  const found = [];
  for (const key of keys) {
    const m = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(key)}["']?\\s*[:=]\\s*["']?([\\w.-]+)`, 'i').exec(log);
    if (m) found.push({ key, value: m[1] });
  }
  return found;
}

/**
 * Find every configured key (the search keys come from the GitHub config)
 * present in each log, with its value.
 * @param {string[]} rawMessages log message texts
 * @param {string[]} keys keys to search for, in priority order (from the GitHub config)
 * @returns {Promise<{key: string, value: string}[][]>} per message, the matches in priority order (maybe empty)
 */
export async function extractIds(rawMessages, keys) {
  const messages = rawMessages.map(redactSecrets);
  const results = messages.map(() => []);

  for (let start = 0; start < messages.length; start += BATCH_SIZE) {
    const batch = messages.slice(start, start + BATCH_SIZE);
    const prompt = batch.map((m, i) => `--- log ${i} ---\n${m}`).join('\n');
    const content = await chat([
      { role: 'system', content: systemPrompt(keys) },
      { role: 'user', content: prompt },
    ]);
    for (const item of parseJsonArray(content)) {
      if (!Number.isInteger(item?.index) || item.index < 0 || item.index >= batch.length) continue;
      // Accept the older single-match shape {index, key, value} as well.
      const candidates = Array.isArray(item.matches) ? item.matches : item.key ? [{ key: item.key, value: item.value }] : [];
      results[start + item.index] = validateMatches(batch[item.index], keys, candidates);
    }
  }
  // Safety net: if the model reported nothing but the key is plainly in the log, use the pattern match.
  return results.map((r, i) => (r.length ? r : findKeysByPattern(messages[i], keys)));
}
