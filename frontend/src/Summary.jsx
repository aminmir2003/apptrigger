import { useMemo } from 'react';
import { directionAt, findHeaderValues, templateNameOf } from './logFormat.js';
import { Typed, useTypewriter } from './typewriter.jsx';

const MAX_RECORDS = 5; // unique records described one by one; the rest are only counted

const fmt = (d) => d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtMs = (ms) => (ms == null ? null : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

// How long a period is, in words: "42 min", "1 h 14 min", "6 days".
function fmtLength(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  return `${Math.round(hours / 24)} days`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// "Today" -> "today", "Last 5 days" -> "last 5 days"; a date range is left as it is (month names keep their capital).
const lowerLead = (s) => s.replace(/^(Today|Yesterday|Last)\b/, (m) => m.toLowerCase());

const b = (text) => ({ text, bold: true }); // a highlighted name or number
const t = (text) => ({ text });

// One record, told in a sentence or two: its template, who called, and how often it was seen.
function describeRecord(log, i, unique, understood) {
  const consumer = findHeaderValues(log.message, ['X-Consumer-Username'])[0];
  const way = consumer.value ? directionAt(log.message, consumer.index) : null;
  const template = templateNameOf(log.message) ?? understood?.search ?? null;
  const newest = fmt(new Date(log.timestamp));
  const oldest = fmt(new Date(log.firstSeen ?? log.timestamp));
  const repeats = log.repeats ?? 1;

  const lead = unique === 1 ? 'That record is' : i === 0 ? 'The newest record is' : `Record ${i + 1} is`;
  const parts = [t(`${lead} for `), b(template ?? 'no named template'), t(', ')];
  if (consumer.value) parts.push(t('called by '), b(consumer.value), t(way ? ` (I found that in the ${way.kind})` : ''));
  else parts.push(t('and the log does not name a caller'));
  parts.push(t(repeats > 1 ? `. I saw it ${repeats} times between ${oldest} and ${newest}.` : `. It was logged at ${newest}.`));
  return parts;
}

// The summary as a short reply in first person: paragraphs, each a list of { text, bold? } pieces.
function buildReply({ logs, stats, understood, deep, limit, sourceLabel }) {
  const paragraphs = [];
  const unique = logs.length;
  const matches = logs.reduce((n, l) => n + (l.repeats ?? 1), 0);
  const hidden = matches - unique;
  const range = stats?.range;

  if (!understood) {
    paragraphs.push([t('You pasted a log, so I did not search Cloud Logging. I only asked FuelIX to read it.')]);
  } else {
    const where = understood.env ? `${understood.env}${understood.project ? ` (${understood.project})` : ''}` : 'Cloud Logging';
    const source = sourceLabel === 'All' ? 'all log types' : `${sourceLabel} logs`;
    const intro = understood.by === 'exact' ? 'FuelIX could not be reached, so I searched your text exactly as you typed it. ' : '';
    const when = range?.[0] && range?.[1] ? ` from ${fmt(range[0])} to ${fmt(range[1])} (${lowerLead(understood.time)}, ${fmtLength(range[1] - range[0])})` : '';
    paragraphs.push([t(`${intro}I searched the ${where} logs for `), b(understood.search), t(`, across ${source}${when}.`)]);
  }

  let found =
    hidden > 0
      ? [t('I found '), b(plural(matches, 'matching record')), t(`, but ${hidden} of them were repeats with the same template and X-Consumer-Username, so I collapsed them into `), b(plural(unique, 'unique record')), t('.')]
      : [t('I found '), b(plural(unique, 'unique record')), t(unique === 1 ? ', and it was not repeated.' : ', and none of them were repeated.')];
  if (understood && logs.length >= Number(limit)) found = [...found, t(` I stopped at your limit of ${limit}, so older matches are not included.`)];
  if (understood) paragraphs.push(found); // a pasted log was not searched for, so there is nothing to count

  logs.slice(0, MAX_RECORDS).forEach((log, i) => paragraphs.push(describeRecord(log, i, unique, understood)));
  if (unique > MAX_RECORDS) paragraphs.push([t(`There ${unique - MAX_RECORDS === 1 ? 'is' : 'are'} ${plural(unique - MAX_RECORDS, 'more unique record')} below.`)]);

  if (stats?.identified != null) {
    const related = Object.entries(deep ?? {}).filter(([, r]) => r.name);
    const piece = [t(`FuelIX picked out a caller in ${stats.identified} of ${plural(unique, 'log')}.`)];
    if (related.length) {
      piece.push(t(' Some logs named no caller, so I studied the related logs, and they point to '));
      related.forEach(([template, r], i) => piece.push(...(i ? [t(', ')] : []), b(r.name), t(` for ${template}`)));
      piece.push(t('.'));
    }
    paragraphs.push(piece);
  }

  const search = fmtMs(stats?.searchMs);
  const ai = fmtMs(stats?.analyzeMs);
  if (search) paragraphs.push([t(`The log search took ${search}${ai ? ` and FuelIX needed another ${ai}` : ''}.`)]);
  paragraphs.push([t('For more details please refer the below')]);
  return paragraphs;
}

/**
 * The summary above the results, told like a chat reply: what was searched and where, how many records there were and
 * how many were repeats, each unique record, and what the analysis found. It is typed out as it appears.
 */
export default function Summary({ logs, stats, understood, deep, limit, sourceLabel }) {
  const paragraphs = useMemo(
    () => buildReply({ logs, stats, understood, deep, limit, sourceLabel }),
    [logs, stats, understood, deep, limit, sourceLabel],
  );
  // Every piece gets its place in the typing order, so the paragraphs are typed one after another.
  let offset = 0;
  const placed = paragraphs.map((pieces) => pieces.map((p) => {
    const start = offset;
    offset += p.text.length;
    return { ...p, start };
  }));
  const shown = useTypewriter(offset, true, { seconds: 2.4 });

  return (
    <section className="summary" aria-label="AI Summary">
      <h3 className="summary-title">
        {/* The usual "AI" sparkle: one large four-point star with two small ones (Material "auto_awesome"). */}
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
          <path
            fill="currentColor"
            d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z"
          />
        </svg>
        AI Summary
      </h3>
      {placed.map((pieces, i) => (
        <p key={i}>
          {pieces.map((p, j) => (p.bold ? <strong key={j}><Typed text={p.text} start={p.start} shown={shown} /></strong> : <Typed key={j} text={p.text} start={p.start} shown={shown} />))}
        </p>
      ))}
    </section>
  );
}
