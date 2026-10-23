// Quick safety checks, run by `npm run check` and by the GitHub Actions workflow:
//   1. every source file parses (a syntax error would only show up when the server starts)
//   2. config.example.json is a valid config, so the example you copy to GitHub is never broken
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/githubConfig.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = ['src', 'scripts']
  .flatMap((dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).map((f) => `${dir}/${f}`))
  .filter((f) => /\.m?js$/.test(f));

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.status === 0) {
    console.log(`ok    ${file}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${file}\n${result.stderr}`);
  }
}

try {
  const config = parseConfig(JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')));
  console.log(`ok    config.example.json (${config.searchKeys.length} search keys)`);
} catch (err) {
  failed += 1;
  console.error(`FAIL  config.example.json: ${err.message}`);
}

// The chat box: what is taken from a typed request, with and without the model.
{
  const { guessSearch, validateInterpretation } = await import('../src/fuelix.js');
  const prompt = 'can you search triggering application of NOTIFY_DATA_ROLLOVER_KOODO for the last 3 days';
  const cases = [
    ['plain pattern finds the template name', guessSearch(prompt) === 'NOTIFY_DATA_ROLLOVER_KOODO'],
    ['a bare name is used as typed', guessSearch('NOTIFY_DATA_ROLLOVER_KOODO') === 'NOTIFY_DATA_ROLLOVER_KOODO'],
    ['an insertId inside a sentence is found', guessSearch('can you find the log with insertId 2hz8yue1s9cs please') === '2hz8yue1s9cs'],
    ['a long sentence with no name gives nothing', guessSearch('who triggered the thing yesterday please') === null],
    ['model answer kept when it is in the request', validateInterpretation(prompt, { search: 'NOTIFY_DATA_ROLLOVER_KOODO', environment: 'PR' }).env === 'pr'],
    ['invented search text is dropped', validateInterpretation(prompt, { search: 'SOMETHING_ELSE' }).search === null],
    ['search text with quotes is dropped', validateInterpretation('say "x" now', { search: '"x"' }).search === null],
    ['unknown environment is dropped', validateInterpretation(prompt, { search: 'NOTIFY_DATA_ROLLOVER_KOODO', environment: 'qa' }).env === null],
  ];
  // logging.js insists on a project being configured when it loads; the check never contacts Google.
  process.env.GCP_PROJECT_NP ??= 'check-project';
  const { containsWholeTerm, parseServiceAccountKey } = await import('../src/logging.js');
  const reason = (text) => { try { parseServiceAccountKey(text); return null; } catch (err) { return err.message; } };
  cases.push(
    ['service account key text is accepted', reason('{"type":"service_account","client_email":"a@b.iam.gserviceaccount.com","private_key":"x"}') === null],
    ['a key file missing its opening brace is refused', /not valid JSON/.test(reason('"type": "service_account"}'))],
    ['JSON that is not a service account key is refused', /not a service account key/.test(reason('{"type":"authorized_user"}'))],
    ['the refusal never repeats the key', !String(reason('{"type":"authorized_user","private_key":"SECRET123"}')).includes('SECRET123')],
  );
  cases.push(
    ['whole name matches on its own', containsWholeTerm('"templateName": "BYOD_ORDER_CONF_KOODO",', 'BYOD_ORDER_CONF_KOODO')],
    ['a longer name with a suffix does not match', !containsWholeTerm('for template BYOD_ORDER_CONF_KOODO_CSAG with TTL', 'BYOD_ORDER_CONF_KOODO')],
    ['a longer name with a prefix does not match', !containsWholeTerm('X_BYOD_ORDER_CONF_KOODO', 'BYOD_ORDER_CONF_KOODO')],
    ['match ignores case', containsWholeTerm('byod_order_conf_koodo done', 'BYOD_ORDER_CONF_KOODO')],
    ['a line holding both the short and the long name matches', containsWholeTerm('BYOD_ORDER_CONF_KOODO_CSAG then BYOD_ORDER_CONF_KOODO.', 'BYOD_ORDER_CONF_KOODO')],
    ['regex characters in the term are literal', !containsWholeTerm('aXb', 'a.b') && containsWholeTerm('see a.b now', 'a.b')],
  );
  const { parseTimeRange, withoutSearch } = await import('../src/timeRange.js');
  const range = (text) => JSON.stringify(parseTimeRange(text));
  const timeCases = [
    ['from today', 'search X from today', { kind: 'today' }],
    ['last 5 days', 'search X for last 5 days', { kind: 'days', days: 5 }],
    ['last 30 dat (typo)', 'search X last 30 dat', { kind: 'days', days: 30 }],
    ['past 2 weeks', 'search X past 2 weeks', { kind: 'days', days: 14 }],
    ['last month', 'search X last month', { kind: 'months', months: 1 }],
    ['yesterday', 'search X yesterday', { kind: 'yesterday' }],
    ['Jan-2026 to Oct 2026', 'search X Jan-2026 to Oct 2026', { kind: 'dates', from: '2026-01-01', to: '2026-10-31' }],
    ['January 2026 to October 2026', 'from January 2026 to October 2026', { kind: 'dates', from: '2026-01-01', to: '2026-10-31' }],
    ['ISO days', 'between 2026-01-15 and 2026-02-03', { kind: 'dates', from: '2026-01-15', to: '2026-02-03' }],
    ['15 Jan 2026 - 3 Feb 2026', '15 Jan 2026 to 3 Feb 2026', { kind: 'dates', from: '2026-01-15', to: '2026-02-03' }],
    ['one month only', 'in March 2026', { kind: 'dates', from: '2026-03-01', to: '2026-03-31' }],
    ['leap February', 'Feb 2028', { kind: 'dates', from: '2028-02-01', to: '2028-02-29' }],
    ['reversed range is put in order', 'Oct 2026 to Jan 2026', { kind: 'dates', from: '2026-01-01', to: '2026-10-31' }],
  ];
  for (const [name, text, want] of timeCases) cases.push([`time range: ${name}`, range(text) === JSON.stringify(want)]);
  cases.push(['time range: nothing said gives null', range('can you search X') === 'null']);
  cases.push(['time range: impossible date is ignored', range('search X 31 Feb 2026') === 'null']);
  cases.push(['time range: a name with a date in it is not read as one', range(withoutSearch('search RENEWAL_2026-01 today', 'RENEWAL_2026-01')) === JSON.stringify({ kind: 'today' })]);
  for (const [name, ok] of cases) {
    if (ok) console.log(`ok    chat box: ${name}`);
    else {
      failed += 1;
      console.error(`FAIL  chat box: ${name}`);
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
