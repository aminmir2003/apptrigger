// Quick checks, run by `npm run check` and by the GitHub Actions workflow. They use made-up sample
// logs only (never real tokens or customer data) to make sure the log formatter still works.
import { findIdentifiers, maskHeaderValue, parseLog } from '../src/logFormat.js';

let failed = 0;
const check = (name, ok, got) => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)})`}`);
};

const KEYS = ['CMDBID', 'X-Kong-Request-Id', 'XID', 'TID', 'relfrozenxid', 'X-Consumer-Username'];

// 1. A request log: headers plus a JSON body, with a JSON string nested inside the body.
const request =
  'request [{X-Consumer-Username=PaymentManagement, X-Kong-Request-Id=abc123, authorization=Bearer FAKE.TOKEN.VALUE, via=1.1 google},' +
  '{"@type":"Create","amount":12.5,"nested":"{\\"a\\":1}"}]';
const r = parseLog(request);
check('request log is recognised', r?.kind === 'request', r?.kind);
check('  4 headers split correctly', r?.request.headers.length === 4, r?.request.headers.length);
check('  body parsed as JSON', r?.request.body?.amount === 12.5, r?.request.body);
check('  JSON nested inside a string is expanded', r?.request.body?.nested?.a === 1, r?.request.body);
check('  bearer token is masked for display', !maskHeaderValue('authorization', 'Bearer FAKE.TOKEN.VALUE').includes('FAKE'));

// 2. A Cloud Logging entry with the request inside its "message" field.
const structured = JSON.stringify({ severity: 'INFO', logger: 'gateway', message: request });
const s = parseLog(structured);
check('structured entry holding a request is recognised', s?.kind === 'request', s?.kind);
check('  other fields kept, message field removed', s?.rest?.logger === 'gateway' && !('message' in (s?.rest ?? {})), s?.rest);

// 3. A structured entry without a request.
const j = parseLog(JSON.stringify({ level: 'info', 'X-Consumer-Username': 'PaymentManagement' }));
check('plain JSON entry is shown as JSON', j?.kind === 'json', j?.kind);

// 4. Plain text stays plain, and identifiers are still found in it.
const text = 'LOG:  automatic vacuum\nnew relfrozenxid: 101892, which is 61 XIDs ahead';
check('plain text is not treated as a request', parseLog(text) === null);
const ids = findIdentifiers(text, KEYS);
check('  relfrozenxid found in plain text', ids.length === 1 && ids[0].value === '101892', ids);
check('  "XID" is not matched inside "relfrozenxid"', !ids.some((i) => i.name === 'XID'), ids);

// 5. E-mail addresses are one value (the "@" must not end it), in plain, = and quoted-JSON forms.
const emailKeys = [...KEYS, 'principal_email'];
const email = (text) => findIdentifiers(text, emailKeys).find((i) => i.name === 'principal_email')?.value;
check('principal_email: user@telus.com', email('authenticationInfo principal_email: jean.dupont+x@telus.com, next') === 'jean.dupont+x@telus.com', email('principal_email: jean.dupont+x@telus.com, next'));
check('  principal_email=… form', email('principal_email=a@b.com;') === 'a@b.com', email('principal_email=a@b.com;'));
check('  quoted JSON form', email('{"principal_email":"a.b@c.example.com"}') === 'a.b@c.example.com', email('{"principal_email":"a.b@c.example.com"}'));

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
