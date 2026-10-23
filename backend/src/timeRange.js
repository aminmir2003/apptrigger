// Reads a time range out of a sentence typed in the chat box, for example
//   "... from today", "... last 5 days", "... past 2 weeks", "... yesterday",
//   "... Jan-2026 to Oct 2026", "... between 2026-01-15 and 2026-02-03", "... in March 2026".
// It answers with what was said, not with clock times: the page turns it into dates in the viewer's own time zone.
//   { kind: 'today' } | { kind: 'yesterday' } | { kind: 'days', days } | { kind: 'months', months }
//   | { kind: 'dates', from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }   (a month stands for its first to last day)

const MONTH = '(?:january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\\.?';
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// One date or month, in the forms people type. Order matters: the most specific form is tried first.
const DATE = new RegExp(
  [
    '(?<![\\d-])(?<iy>\\d{4})-(?<im>\\d{2})-(?<id>\\d{2})(?!\\d)', //  2026-01-15
    `(?<![\\d])(?<dd>\\d{1,2})(?:st|nd|rd|th)?[\\s-]+(?<dm>${MONTH})[\\s,-]+(?<dy>\\d{4})(?!\\d)`, //  15 Jan 2026
    `\\b(?<md>${MONTH})\\s+(?<mdd>\\d{1,2})(?:st|nd|rd|th)?,?\\s+(?<mdy>\\d{4})(?!\\d)`, //  Jan 15, 2026
    `\\b(?<mm>${MONTH})[\\s,-]+(?<my>\\d{4})(?!\\d)`, //  Jan-2026, January 2026
    '(?<![\\d-])(?<ym>\\d{4})-(?<ymm>\\d{2})(?![\\d-])', //  2026-01
  ].join('|'),
  'gi',
);

const pad = (n) => String(n).padStart(2, '0');
const monthNumber = (name) => MONTH_NAMES.findIndex((m) => name.toLowerCase().startsWith(m)) + 1;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const validYear = (y) => y >= 2000 && y <= 2100;

// {from, to} for a day, or for a whole month when day is null. Null when it is not a real date.
function period(y, m, d) {
  if (!validYear(y) || m < 1 || m > 12) return null;
  if (d == null) return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}` };
  if (d < 1 || d > lastDay(y, m)) return null;
  const day = `${y}-${pad(m)}-${pad(d)}`;
  return { from: day, to: day };
}

function datePeriods(text) {
  const found = [];
  for (const { groups: g } of text.matchAll(DATE)) {
    const p =
      g.iy ? period(+g.iy, +g.im, +g.id)
      : g.dm ? period(+g.dy, monthNumber(g.dm), +g.dd)
      : g.md ? period(+g.mdy, monthNumber(g.md), +g.mdd)
      : g.mm ? period(+g.my, monthNumber(g.mm), null)
      : period(+g.ym, +g.ymm, null);
    if (p) found.push(p);
  }
  return found;
}

/**
 * @param {string} text the request, ideally without the template name (a name must not be mistaken for a date)
 * @returns {{kind: string}|null} what was asked for, or null when the text names no time range
 */
export function parseTimeRange(text) {
  const t = String(text);

  // Dates win: "from Jan-2026 to Oct 2026" is a range even if it also says "last".
  const periods = datePeriods(t);
  if (periods.length > 0) {
    const from = periods.map((p) => p.from).sort()[0];
    const to = periods.map((p) => p.to).sort().at(-1);
    return { kind: 'dates', from, to };
  }

  const counted = /\b(?:last|past|previous)\s+(\d{1,3})\s*(da[yt]|week|month)s?\b/i.exec(t);
  if (counted) {
    const n = Number(counted[1]);
    const unit = counted[2].toLowerCase();
    if (n >= 1) {
      if (unit.startsWith('da') && n <= 730) return { kind: 'days', days: n };
      if (unit === 'week' && n <= 104) return { kind: 'days', days: n * 7 };
      if (unit === 'month' && n <= 60) return { kind: 'months', months: n };
    }
  }
  const single = /\b(?:last|past|previous)\s+(week|month)\b/i.exec(t);
  if (single) return single[1].toLowerCase() === 'week' ? { kind: 'days', days: 7 } : { kind: 'months', months: 1 };

  if (/\byesterday\b/i.test(t)) return { kind: 'yesterday' };
  if (/\btoday\b/i.test(t)) return { kind: 'today' };
  return null;
}

/** The request without the search text, so an identifier like "RENEWAL_2026-01" is never read as a date. */
export const withoutSearch = (prompt, search) =>
  search ? String(prompt).replace(new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ') : String(prompt);
