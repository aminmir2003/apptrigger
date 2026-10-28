// When a log's own request holds no caller, look at the other logs that mention the same template and see who
// appears around it. FuelIX then picks the most likely application, but only from names that really appear in those
// logs; it cannot make one up. Without FuelIX the same ranking is used directly.
import { fieldValue } from './dedupe.js';
import { queryLogs } from './logging.js';
import { askWhichApplication } from './fuelix.js';
import { log, timer } from './log.js';

// Values that are only a placeholder, not a real name (a template that was never filled in).
const PLACEHOLDERS = new Set(['appname', 'string', 'null', 'undefined', 'name', 'sender', 'test', 'unknown', 'n/a', 'none']);

// The sender object has no nested braces, so [^{}] keeps the search inside it.
const senderName = (text) =>
  /(?<![A-Za-z0-9_])sender[\\"']*\s*:\s*\{[^{}]*?[\\"']name[\\"']*\s*:\s*[\\"']*([\w.@+-]+)/i.exec(text)?.[1] ?? null;

// Where a caller can show up, most telling first.
const FIELDS = [
  { label: 'X-Consumer-Username', read: (t) => fieldValue(t, 'X-Consumer-Username') },
  { label: 'originatorApplicationId', read: (t) => fieldValue(t, 'originatorApplicationId') },
  { label: 'appId', read: (t) => fieldValue(t, 'appId') },
  { label: 'Sender', read: senderName },
];

/**
 * Count, for each place a caller can show up, which values appear and in how many of the logs.
 * Each log counts a value once. Placeholders are ignored.
 * @param {string[]} messages
 * @returns {{field: string, value: string, count: number}[]} most telling field first, then most frequent value
 */
export function rankCandidates(messages) {
  const counts = FIELDS.map(() => new Map());
  for (const message of messages) {
    FIELDS.forEach((f, i) => {
      const value = f.read(message);
      if (value && !PLACEHOLDERS.has(value.toLowerCase())) counts[i].set(value, (counts[i].get(value) ?? 0) + 1);
    });
  }
  return FIELDS.flatMap((f, i) => [...counts[i]].map(([value, count]) => ({ field: f.label, value, count })).sort((a, b) => b.count - a.count));
}

/** Without a model: the most frequent value of the most telling field, with a confidence from how often it appears. */
export function bestByRanking(candidates, examined) {
  const top = candidates[0];
  if (!top) return null;
  const share = examined > 0 ? top.count / examined : 0;
  return { ...top, confidence: share >= 0.6 ? 'high' : share >= 0.3 ? 'medium' : 'low' };
}

/**
 * Keep the model's answer only when it names one of the candidates (guards against an invented name).
 * @param {{name?: any, confidence?: any, reason?: any}} raw what the model said
 * @param {{field: string, value: string, count: number}[]} candidates
 */
export function validatePick(raw, candidates) {
  const name = typeof raw?.name === 'string' ? raw.name.trim().toLowerCase() : '';
  const hit = candidates.find((c) => c.value.toLowerCase() === name);
  if (!hit) return null;
  const confidence = ['high', 'medium', 'low'].includes(String(raw?.confidence).toLowerCase()) ? String(raw.confidence).toLowerCase() : 'low';
  const reason = typeof raw?.reason === 'string' ? raw.reason.replace(/\s+/g, ' ').trim().slice(0, 240) : '';
  return { ...hit, confidence, reason };
}

const TEMPLATE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{1,199}$/;
const DAY = 24 * 3600 * 1000;

/**
 * Look at every log that mentions the template (any kind of log, at least the last 7 days, at most 200 of them) and
 * work out which application most likely triggers it.
 * @param {{env?: string, template: string, from?: string}} o from is the start of the search the user ran; the look-back
 *   is never shorter than 7 days, because one quiet day says little about who triggers a template.
 */
export async function deepAnalyze({ env, template, from }) {
  if (!TEMPLATE.test(String(template))) throw new Error('Invalid template name');
  const weekAgo = new Date(Date.now() - 7 * DAY);
  const asked = from ? new Date(from) : null;
  const start = asked && !Number.isNaN(asked.getTime()) && asked < weekAgo ? asked : weekAgo;

  log('deep', `${template}: reading every log that mentions it since ${start.toISOString()} (at least 7 days, up to 200 logs)`);
  const t = timer();
  const logs = await queryLogs({ env, search: template, resource: 'all', raw: true, from: start.toISOString(), limit: 200 });
  const examined = logs.length;
  const candidates = rankCandidates(logs.map((l) => l.message));
  const base = { template, examined, since: start.toISOString(), candidates: candidates.slice(0, 5) };
  log('deep', `${template}: ${examined} log${examined === 1 ? '' : 's'} read in ${t.text()}, ${candidates.length} possible caller${candidates.length === 1 ? '' : 's'}${candidates.length ? ` (top: ${candidates.slice(0, 3).map((c) => `${c.value} via ${c.field} in ${c.count}`).join('; ')})` : ''}`);

  if (candidates.length === 0) {
    log('deep', `${template}: no caller named anywhere, so no application is suggested`);
    return { ...base, name: null, by: 'none', reason: examined ? `None of the ${examined} logs that mention ${template} name a caller.` : `No other logs mention ${template} in this period.` };
  }
  const picked = validatePick(await askWhichApplication(template, candidates, examined), candidates);
  if (picked) {
    log('deep', `${template}: FuelIX picked ${picked.value} (${picked.confidence} confidence)`);
    return { ...base, name: picked.value, field: picked.field, count: picked.count, confidence: picked.confidence, reason: picked.reason, by: 'fuelix' };
  }
  const best = bestByRanking(candidates, examined);
  log('deep', `${template}: the plain ranking picked ${best.value} (${best.confidence} confidence)`);
  return { ...base, name: best.value, field: best.field, count: best.count, confidence: best.confidence, reason: '', by: 'ranking' };
}
