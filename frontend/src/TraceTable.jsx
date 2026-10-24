import { useMemo } from 'react';
import { directionAt, findHeaderValues, findSenderName } from './logFormat.js';
import { Typed, useTypewriter } from './typewriter.jsx';

// Request headers shown in the table beside every log.
const TRACE_HEADERS = ['X-Consumer-Username', 'X-Consumer-ID', 'Kong-Request-ID', 'X-Kong-Request-Id', 'appId', 'originatorApplicationId'];

/**
 * The table beside a log: who called, from the headers and body of the log itself, plus an optional Comments row
 * (what the other logs of the template point to) when this log names no caller.
 * With animate on, the values are typed out one after another, and the Comments row appears once they are done.
 * @param {{ message: string, deepResult?: object|null, animate?: boolean }} props
 */
export default function TraceTable({ message, deepResult = null, animate = false }) {
  const rows = useMemo(
    () => [...findHeaderValues(message, TRACE_HEADERS), { name: 'Sender', value: findSenderName(message), index: -1 }],
    [message],
  );
  // Each value's place in the typing order: the characters before it.
  const texts = rows.map((r) => r.value ?? '—');
  const starts = texts.map((_, i) => texts.slice(0, i).reduce((n, t) => n + t.length, 0));
  const total = texts.reduce((n, t) => n + t.length, 0);
  const shown = useTypewriter(total, animate, { seconds: 1.4 });
  const done = shown >= total;

  return (
    <table className="trace-table">
      <tbody>
        {rows.map(({ name, value, index }, i) => {
          // For the consumer, say whether it was found in the request or in the response, once its value is typed.
          const way = name === 'X-Consumer-Username' && value && done ? directionAt(message, index) : null;
          return (
            <tr key={name} className={name === 'X-Consumer-Username' ? 'key-row' : undefined}>
              <th scope="row">{name}</th>
              <td className={value ? '' : 'muted'}>
                <Typed text={texts[i]} start={starts[i]} shown={shown} />
                {way && (
                  <span className="trace-way" title={`Found in the ${way.kind} (${way.direction})`}>
                    {' '}({way.label})
                  </span>
                )}
              </td>
            </tr>
          );
        })}
        {done && deepResult && (
          <tr>
            <th scope="row">Comments</th>
            <td className={deepResult.name ? '' : 'muted'}>
              {deepResult.name ? (
                <>
                  <strong>{deepResult.name}</strong>
                  <span className="deep-note">
                    {deepResult.field} in {deepResult.count} of {deepResult.examined} logs for {deepResult.template} &middot; {deepResult.confidence} confidence
                    {deepResult.reason ? ` · ${deepResult.reason}` : ''}
                  </span>
                </>
              ) : (
                deepResult.reason
              )}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
