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
  const { recordKey, uniqueRecords } = await import('../src/dedupe.js');
  const reqLog = (consumer, template) => `request [{X-Consumer-Username=${consumer}, X-Kong-Request-Id=${Math.random()}},{"templateName":"${template}","language":"EN"}]`;
  const escapedLog = (consumer, template) => `request [{X-Consumer-Username=${consumer}},{"characteristic":[{"value":"{\\"templateName\\":\\"${template}\\"}"}]}]`;
  const run = (messages) => { const u = uniqueRecords(); return messages.map((message) => { const r = { message }; return [u.add(r), r]; }); };
  const first = run([reqLog('ECP', 'FFH_SelfLinkConf'), reqLog('ECP', 'FFH_SelfLinkConf'), reqLog('ECP', 'FFH_SelfLinkConf')]);
  cases.push(
    ['dedupe: the same template and caller are one record', first.filter(([kept]) => kept).length === 1 && first[0][1].repeats === 3],
    ['dedupe: the same template from another caller is kept', run([reqLog('ECP', 'T1'), reqLog('MyTelus', 'T1')]).every(([kept]) => kept)],
    ['dedupe: another template from the same caller is kept', run([reqLog('ECP', 'T1'), reqLog('ECP', 'T2')]).every(([kept]) => kept)],
    ['dedupe: a template inside an escaped JSON string is read', recordKey(escapedLog('ECP', 'FFH_SelfLinkConf')) === 'ffh_selflinkconf|ecp'],
    ['dedupe: a record naming neither is never collapsed', run(['Cached dummy config', 'Cached dummy config']).every(([kept]) => kept)],
    ['dedupe: the oldest repeat gives the first-seen time', (() => { const u = uniqueRecords(); const m = reqLog('ECP', 'T1'); const a = { message: m, timestamp: '2026-10-26T01:00:00Z' }; u.add(a); u.add({ message: m, timestamp: '2026-10-25T23:00:00Z' }); u.add({ message: m, timestamp: '2026-10-25T20:00:00Z' }); return a.repeats === 3 && a.firstSeen === '2026-10-25T20:00:00Z' && a.timestamp === '2026-10-26T01:00:00Z'; })()],
    ['dedupe: the newest (first seen) record is the one kept', (() => { const u = uniqueRecords(); const a = { message: reqLog('ECP', 'T1'), id: 'new' }; const b = { message: reqLog('ECP', 'T1'), id: 'old' }; return u.add(a) && !u.add(b) && a.repeats === 2; })()],
  );
  // Nothing that looks like a key may reach a log line or an error sent to the page.
  const { scrub } = await import('../src/log.js');
  process.env.FUELIX_API_KEY = 'ak-SMOKE1234567890abcdefXYZ';
  process.env.GCP_SA_KEY_PR = JSON.stringify({ type: 'service_account', client_email: 'pr@x.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----\n', private_key_id: 'abcdef0123456789abcdef' });
  const hides = (text, secret) => !scrub(text).includes(secret);
  cases.push(
    ['secrets: the FuelIX key from the settings is hidden', hides('FuelIX request failed (401): bad key ak-SMOKE1234567890abcdefXYZ', 'SMOKE1234567890')],
    ['secrets: a partly repeated key is hidden', hides('Incorrect API key provided: ak-SMOKE12345***', 'SMOKE12345')],
    ['secrets: the private key inside a service account key is hidden', hides('failed with MIIEvQIBADANBgkq in the key', 'MIIEvQIBADANBgkq')],
    ['secrets: a private key block is hidden', hides('key=-----BEGIN PRIVATE KEY-----\nQUJDREVGRw==\n-----END PRIVATE KEY-----', 'QUJDREVGRw')],
    ['secrets: a private_key field is hidden', hides('{"private_key":"abcdefghijklmnop"}', 'abcdefghijklmnop')],
    ['secrets: a bearer token is hidden', hides('Authorization: Bearer abc123def456ghi789', 'abc123def456ghi789')],
    ['secrets: a Basic authorization header is hidden', hides('authorization=Basic ODNkYWVlNWMtMzI1Yi00YzQx', 'ODNkYWVlNWMtMzI1Yi00YzQx')],
    ['secrets: a JWT is hidden', hides('token eyJhbGciOiJSUzI1NiIs.eyJzY29wZSI6WyIxOC1SUCJd.MBnIZ6JIK5yOeoYK', 'eyJzY29wZSI6')],
    ['secrets: a GitHub token is hidden', hides('using ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'abcdefghijklmnopqrstuvwxyz0123456789')],
    ['secrets: a Google access token is hidden', hides('got ya29.a0AfH6SMBabcdefghijklmnopqrstuvwxyz', 'a0AfH6SMBabcdefghijklmnopqrstuvwxyz')],
    ['secrets: client_secret=... and api_key=... are hidden', hides('client_secret=hunter2hunter2&api_key: abcdefgh123', 'hunter2hunter2') && hides('api_key: abcdefgh123', 'abcdefgh123')],
    ['secrets: normal log text is left alone', scrub('page 3/10: 500 entries in 4.2 s, kept TELUS_WELCOME for np') === 'page 3/10: 500 entries in 4.2 s, kept TELUS_WELCOME for np'],
    ['secrets: a service account email is not a secret and stays', scrub('signs in with pr@x.iam.gserviceaccount.com').includes('pr@x.iam.gserviceaccount.com')],
  );
  delete process.env.FUELIX_API_KEY;
  delete process.env.GCP_SA_KEY_PR;
  // Log entries shown on the page: credentials are hidden, the data is not.
  const { maskCredentials } = await import('../src/log.js');
  const shown = maskCredentials('request [{X-Consumer-Username=ECP, Authorization=Bearer eyJhbGciOiJSUzI1NiJ9.eyJzY29wZSI6WyIxOC1SUCJd.MBnIZ6JIK5yOeoYK, authz-capture=Basic ODNkYWVlNWMtMzI1Yi00YzQx, X-Consumer-ID=25ebd5dd},{"templateName":"T1","password":"visible-data"}]');
  cases.push(
    ['entries: the bearer token and JWT in a request log are hidden', !shown.includes('eyJhbGci') && !shown.includes('MBnIZ6JIK5yOeoYK')],
    ['entries: the data around it is left as it was', shown.includes('X-Consumer-Username=ECP') && shown.includes('X-Consumer-ID=25ebd5dd') && shown.includes('"templateName":"T1"') && shown.includes('visible-data')],
  );
  const { parseJsonArray } = await import('../src/fuelix.js');
  const answer = '[{"index": 0, "matches": [{"key": "X-Consumer-Username", "value": "PaymentManagement"}]}]';
  const parses = (text) => { try { return parseJsonArray(text); } catch { return null; } };
  cases.push(
    ['reply: a clean array is read', parses(answer)?.[0]?.matches?.[0]?.value === 'PaymentManagement'],
    ['reply: a correct answer followed by more talking is read (the reported failure)', parses(`${answer}\n\n\nWait, let me re-examine the log more carefully. I need to search for the specific keys in priority order: "C`)?.[0]?.matches?.[0]?.value === 'PaymentManagement'],
    ['reply: more talking that contains brackets does not break it', parses(`${answer}\nNote [1]: also {see} the keys ["a"`)?.[0]?.index === 0],
    ['reply: prose before the answer is skipped', parses(`Here you go: ${answer}`)?.[0]?.index === 0],
    ['reply: a code fence is removed', parses('```json\n' + answer + '\n```')?.[0]?.index === 0],
    ['reply: brackets inside a value do not confuse it', parses('[{"index":0,"matches":[{"key":"k","value":"a]b}c"}]}]')?.[0]?.matches?.[0]?.value === 'a]b}c'],
    ['reply: an object holding the array is unwrapped', parses('{"results": [{"index": 1}]}')?.[0]?.index === 1],
    ['reply: a single object becomes a one-item list', parses('{"value": "101892"}')?.[0]?.value === '101892'],
    ['reply: text with no JSON is refused', parses('I could not find anything') === null],
    ['reply: a broken first array falls through to the next good one', parses('[{"a": 1 , nope] then [{"index": 2}]')?.[0]?.index === 2],
  );
  const { rankCandidates, bestByRanking, validatePick } = await import('../src/deepAnalysis.js');
  const logsFor = (n, consumer, extra = '') => Array.from({ length: n }, () => `request [{X-Consumer-Username=${consumer}${extra}},{"templateName":"TELUS_WELCOME","sender":{"name":"appName"}}]`);
  const ranked = rankCandidates([...logsFor(6, 'MyTelus'), ...logsFor(2, 'Koodo'), ...logsFor(1, 'MyTelus', ', appId=ABC123')]);
  cases.push(
    ['deep: the most frequent caller of the best field comes first', ranked[0].field === 'X-Consumer-Username' && ranked[0].value === 'MyTelus' && ranked[0].count === 7],
    ['deep: a placeholder sender (appName) is ignored', !ranked.some((c) => c.field === 'Sender')],
    ['deep: a less telling field is listed after a more telling one', ranked.findIndex((c) => c.field === 'appId') > ranked.findIndex((c) => c.field === 'X-Consumer-Username')],
    ['deep: the ranking alone gives a confidence from how often it appears', bestByRanking(ranked, 9).confidence === 'high' && bestByRanking(ranked, 40).confidence === 'low'],
    ['deep: nothing found gives no answer', rankCandidates(['plain log line']).length === 0 && bestByRanking([], 3) === null],
    ['deep: the model must name a candidate', validatePick({ name: 'MyTelus', confidence: 'HIGH', reason: 'most calls' }, ranked)?.confidence === 'high' && validatePick({ name: 'Invented' }, ranked) === null],
    ['deep: a sender that is a real name is a candidate', rankCandidates(['"sender": {"@type":"TelusSender","name":"Order-Handler"}'])[0]?.value === 'Order-Handler'],
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
