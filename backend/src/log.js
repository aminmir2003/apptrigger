// Backend log lines, printed to the terminal the server runs in:
//   12:34:56.789 [logs] page 3: 500 entries in 4.2 s, kept 0
// Each line has a time and a scope (http, logs, fuelix, ...). Only counts, names and timings are written; never keys,
// tokens or the text of a log entry.
//
//   LOG_LEVEL   info (default) shows everything, quiet shows only warnings and errors.

const quiet = () => String(process.env.LOG_LEVEL ?? '').toLowerCase() === 'quiet';
const stamp = () => new Date().toISOString().slice(11, 23);
const line = (scope, message) => `${stamp()} [${scope}] ${message}`;

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
