// FuelIX layer: sends log messages to an OpenAI-compatible chat completions
// endpoint and asks the model to pull structured values out of them.
import { parseTimeRange, withoutSearch } from './timeRange.js';
import { log, timer, warn } from './log.js';

const BATCH_SIZE = 25;

// Never send credentials to the model: remove bearer tokens and JWT-shaped strings from log text.
export const redactSecrets = (text) =>
  String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]');

// A request log is a line whose message starts the request dump: request [{header=value, ...},{json body}]
export const REQUEST_MARKER = 'request [{';
export const isRequestLog = (text) => String(text).includes(REQUEST_MARKER);

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

// A FuelIX call that takes longer than this fails with a clear message instead of waiting for ever.
// Override with FUELIX_TIMEOUT_MS.
const FUELIX_TIMEOUT_MS = Number(process.env.FUELIX_TIMEOUT_MS) || 60_000;

async function chat(messages, purpose = 'call') {
  const { key, endpoint, model } = config();
  const t = timer();
  log('fuelix', `${purpose}: asking ${model} (${messages.reduce((n, m) => n + m.content.length, 0)} characters)`);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, temperature: 0 }),
      signal: AbortSignal.timeout(FUELIX_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`FuelIX request failed (${res.status}): ${text.slice(0, 300)}`);
    const content = JSON.parse(text).choices?.[0]?.message?.content;
    if (!content) throw new Error('FuelIX returned no content');
    log('fuelix', `${purpose}: answered in ${t.text()} (${content.length} characters)`);
    return content;
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `no answer after ${FUELIX_TIMEOUT_MS / 1000} s (FUELIX_TIMEOUT_MS)` : err.cause?.code ? `${err.message} (${err.cause.code})` : err.message;
    fail('fuelix', `${purpose}: failed after ${t.text()}: ${reason}`);
    throw new Error(err.name === 'TimeoutError' ? `FuelIX did not answer within ${FUELIX_TIMEOUT_MS / 1000} seconds` : err.message);
  }
}

// The first complete JSON array or object in the text, or undefined. Everything after it is ignored, so a model that
// keeps talking after a correct answer ("Wait, let me re-examine…") does not break it. Brackets inside strings are
// skipped, and a start that never closes properly is passed over for the next one.
function firstJsonValue(text) {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '[' && text[start] !== '{') continue;
    const closers = [];
    let inString = false;
    for (let i = start; i < text.length; i += 1) {
      const c = text[i];
      if (inString) {
        if (c === '\\') i += 1;
        else if (c === '"') inString = false;
      } else if (c === '"') {
        inString = true;
      } else if (c === '[' || c === '{') {
        closers.push(c === '[' ? ']' : '}');
      } else if (c === ']' || c === '}') {
        if (closers.pop() !== c) break;
        if (closers.length === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}

// Models sometimes wrap JSON in code fences or prose despite instructions, or return an object
// ({"results": [...]}) or a single item instead of a bare array.
export const parseJsonArray = (content) => {
  const cleaned = content.replace(/```(?:json)?/g, '').trim();
  const parsed = firstJsonValue(cleaned);
  if (parsed === undefined) throw new Error(`FuelIX reply was not usable JSON: ${JSON.stringify(cleaned.slice(0, 200))}`);
  if (Array.isArray(parsed)) return parsed;
  // {"results": [...]} or any single property holding an array
  const nested = Object.values(parsed ?? {}).find(Array.isArray);
  if (nested) return nested;
  // A single lookup object such as {"value": "101892", "description": "EPS"}
  return [parsed];
};

const escapeRegex = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const interpretPrompt_ = `You turn a request typed in a chat box into log search parameters. The user wants to find which application triggered a communication template.
Reply with ONLY a JSON object, no prose and no code fences, in the form:
{"search": "NOTIFY_DATA_ROLLOVER_KOODO", "environment": null}
- "search": the template name or identifier to look for in the logs, copied EXACTLY as the user typed it (letters, digits and _ . - : / only). Use null if the request contains none. Never invent one. Do not include any date or time words in it.
- "environment": "np" if the user says NP or non-production, "pr" if the user says PR or production, otherwise null.`;

const pickApplicationPrompt = `You help find which application triggers a communication template.
You get the template name and a list of candidates. Each candidate is a value found in logs that mention the template: the field it was found in, the value, and in how many logs it appeared.
Choose the single most likely triggering application. Prefer a value that appears in most of the logs; X-Consumer-Username and originatorApplicationId are more telling than appId or Sender. You may use the template name as a hint to break a tie.
You MUST answer with one of the candidate values, copied exactly, or null if none is believable. Never invent a name.
Reply with ONLY a JSON object: {"name": "<candidate value or null>", "confidence": "high|medium|low", "reason": "one short sentence"}`;

/**
 * Ask the model which candidate most likely triggers the template. Returns the raw reply, or null when the model
 * is unavailable or the reply cannot be read (the caller then falls back to the plain ranking).
 * @param {string} template
 * @param {{field: string, value: string, count: number}[]} candidates
 * @param {number} examined how many logs the counts come from
 */
export async function askWhichApplication(template, candidates, examined) {
  try {
    const list = candidates.slice(0, 10).map((c) => `- ${c.field}: ${c.value} (in ${c.count} of ${examined} logs)`).join('\n');
    const content = await chat(
      [
        { role: 'system', content: pickApplicationPrompt },
        { role: 'user', content: `Template: ${template}\nCandidates:\n${list}` },
      ],
      'pick the likely application',
    );
    return parseJsonArray(content)[0] ?? null;
  } catch (err) {
    warn('fuelix', `could not pick the application, using the plain ranking instead: ${err.message}`);
    return null;
  }
}

// A token that looks like a template name or identifier: letters, digits and _ . - : /
const SEARCH_TOKEN = /[A-Za-z0-9][A-Za-z0-9_.:/-]*/g;
const SEARCH_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:/ -]{1,199}$/;

/**
 * Without the model: take the identifier from the request. A token with an underscore (a template name) wins;
 * a short request is used whole; otherwise there is nothing safe to search for.
 * @param {string} prompt
 * @returns {string|null}
 */
export function guessSearch(prompt) {
  const text = String(prompt).trim();
  const tokens = text.match(SEARCH_TOKEN) ?? [];
  const named = tokens.find((t) => t.includes('_'));
  if (named) return named;
  // A Cloud Logging insertId (lowercase letters and digits, like "2hz8yue1s9cs") is also something to look up.
  const insertId = tokens.find((t) => /^(?=.*\d)(?=.*[a-z])[a-z0-9]{8,24}$/.test(t));
  if (insertId) return insertId;
  return tokens.length > 0 && tokens.length <= 2 ? tokens.join(' ') : null;
}

/**
 * Keep only what the model reported that is believable: the search text must really be in the request (guards
 * against invented values) and the environment one we know. The time range is not left to the model; it is read
 * from the request by parseTimeRange.
 * @param {string} prompt the request as typed
 * @param {{search?: any, environment?: any}} raw what the model said
 */
export function validateInterpretation(prompt, raw) {
  const search = typeof raw?.search === 'string' ? raw.search.trim() : '';
  const okSearch = SEARCH_VALUE.test(search) && String(prompt).toLowerCase().includes(search.toLowerCase());
  const env = String(raw?.environment ?? '').toLowerCase();
  return {
    search: okSearch ? search : null,
    env: env === 'np' || env === 'pr' ? env : null,
  };
}

/**
 * Work out what to search for from a sentence typed in the chat box.
 * Falls back to a plain pattern when the model is unavailable or gives nothing usable.
 * @param {string} rawPrompt
 * @returns {Promise<{search: string|null, range: object|null, env: 'np'|'pr'|null, by: 'fuelix'|'pattern'}>}
 *   range is what the request said about time (see timeRange.js), or null when it said nothing
 */
export async function interpretPrompt(rawPrompt) {
  const prompt = redactSecrets(rawPrompt).trim().slice(0, 1000);
  const result = (search, env, by) => ({ search, env, by, range: search ? parseTimeRange(withoutSearch(prompt, search)) : null });
  log('interpret', `reading a request of ${prompt.length} characters`);
  try {
    const content = await chat(
      [
        { role: 'system', content: interpretPrompt_ },
        { role: 'user', content: prompt },
      ],
      'read the request',
    );
    const [raw] = parseJsonArray(content);
    const found = validateInterpretation(prompt, raw);
    if (found.search) {
      const out = result(found.search, found.env, 'fuelix');
      log('interpret', `FuelIX understood: search "${out.search}", time ${out.range ? JSON.stringify(out.range) : 'not named'}, environment ${out.env ?? 'not named'}`);
      return out;
    }
    warn('interpret', 'FuelIX answered, but its search text was not found in the request, so the plain pattern is used');
  } catch (err) {
    warn('interpret', `FuelIX could not read the request, using the plain pattern instead: ${err.message}`);
  }
  const out = result(guessSearch(prompt), null, 'pattern');
  log('interpret', `plain pattern: search ${out.search ? `"${out.search}"` : 'not found'}, time ${out.range ? JSON.stringify(out.range) : 'not named'}`);
  return out;
}

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
    // A value is letters, digits and . _ - plus @ and + so that e-mail addresses are one value.
    if (!key || !/^[\w.@+-]+$/.test(value) || accepted.some((a) => a.key === key)) continue;
    const found = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(key)}["']?\\s*[:=]\\s*["']?${escapeRegex(value)}(?![\\w.@+-])`, 'i');
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
    const m = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(key)}["']?\\s*[:=]\\s*["']?([\\w.@+-]+)`, 'i').exec(log);
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
  // Only request logs ("message": "request [{...") are analysed; other lines matching the search are not sent to the model.
  const eligible = messages.map((m, i) => i).filter((i) => isRequestLog(messages[i]));

  const batches = Math.ceil(eligible.length / BATCH_SIZE);
  log('analyze', `${messages.length} log${messages.length === 1 ? '' : 's'}: ${eligible.length} request log${eligible.length === 1 ? '' : 's'} go to FuelIX in ${batches} batch${batches === 1 ? '' : 'es'}, ${messages.length - eligible.length} skipped (not request logs); looking for ${keys.length} key${keys.length === 1 ? '' : 's'}`);

  for (let start = 0; start < eligible.length; start += BATCH_SIZE) {
    const indexes = eligible.slice(start, start + BATCH_SIZE);
    const batch = indexes.map((i) => messages[i]);
    const prompt = batch.map((m, i) => `--- log ${i} ---\n${m}`).join('\n');
    const content = await chat(
      [
        { role: 'system', content: systemPrompt(keys) },
        { role: 'user', content: prompt },
      ],
      `find the caller, batch ${start / BATCH_SIZE + 1}/${batches}`,
    );
    for (const item of parseJsonArray(content)) {
      if (!Number.isInteger(item?.index) || item.index < 0 || item.index >= batch.length) continue;
      // Accept the older single-match shape {index, key, value} as well.
      const candidates = Array.isArray(item.matches) ? item.matches : item.key ? [{ key: item.key, value: item.value }] : [];
      results[indexes[item.index]] = validateMatches(batch[item.index], keys, candidates);
    }
  }
  // Safety net: if the model reported nothing but the key is plainly in the log, use the pattern match.
  const byModel = eligible.filter((i) => results[i].length).length;
  for (const i of eligible) if (!results[i].length) results[i] = findKeysByPattern(messages[i], keys);
  log('analyze', `done: a caller key found in ${byModel} of ${eligible.length} request logs by FuelIX, ${eligible.filter((i) => results[i].length).length} in total with the plain pattern as backup`);
  return results;
}
