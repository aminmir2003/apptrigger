import { useEffect, useMemo, useRef, useState } from 'react';
import { findIdentifiers, maskHeaderValue, parseLog } from './logFormat.js';

// Colours JSON tokens: keys, strings, numbers and true/false/null each get their own class.
const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function JsonView({ data }) {
  const text = JSON.stringify(data, null, 2);
  const parts = [];
  let last = 0;
  let m;
  while ((m = TOKEN.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const [full, str, colon, literal] = m;
    const cls = str ? (colon ? 'j-key' : 'j-str') : literal ? 'j-lit' : 'j-num';
    parts.push(
      <span key={m.index} className={cls}>
        {str && colon ? str : full}
      </span>,
    );
    if (str && colon) parts.push(colon);
    last = m.index + full.length;
  }
  parts.push(text.slice(last));
  return <pre className="json">{parts}</pre>;
}

// Copies text to the clipboard. navigator.clipboard needs a secure page, so fall back to a hidden textarea.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const box = document.createElement('textarea');
    box.value = text;
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    document.execCommand('copy');
    document.body.removeChild(box);
  }
}

// Small round copy button for the top right corner of a section header.
function CopyButton({ getText, label }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []); // no timer left running after unmount
  const onClick = async (e) => {
    e.preventDefault(); // the button sits inside <summary>; don't collapse the section
    e.stopPropagation();
    await copyText(getText());
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 5000);
  };
  return (
    <button
      type="button"
      className={`copy-btn${copied ? ' done' : ''}`}
      onClick={onClick}
      aria-label={copied ? 'Copied' : label}
      title={label}
    >
      {copied ? (
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"
          />
        </svg>
      )}
    </button>
  );
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function Identifiers({ ids, match }) {
  if (ids.length === 0) return null;
  return (
    <section>
      <h4>Identifiers</h4>
      <dl className="lv-ids">
        {ids.map((h) => (
          <div key={h.name} className={`lv-id ${match && same(match.key, h.name) ? 'hit' : ''}`}>
            <dt>{h.name}</dt>
            <dd>{h.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * Shows a log message, whether it was pasted or fetched from Cloud Logging.
 * Request logs get identifiers, a header table and an indented JSON body; structured (JSON) entries
 * are indented and coloured; anything else is shown as plain text.
 * @param {{ message: string, match?: {key: string, value: string}|null, keys: string[] }} props
 */
export default function LogView({ message, match, keys }) {
  const parsed = useMemo(() => parseLog(message), [message]);
  const ids = useMemo(() => findIdentifiers(message, keys), [message, keys]);

  if (!parsed) {
    return (
      <div className="lv">
        <Identifiers ids={ids} match={match} />
        <details open>
          <summary>
            Log message
            <CopyButton label="Copy log message" getText={() => message} />
          </summary>
          <pre className="plain">{message}</pre>
        </details>
      </div>
    );
  }

  if (parsed.kind === 'json') {
    return (
      <div className="lv">
        <Identifiers ids={ids} match={match} />
        <details open>
          <summary>
            Log entry
            <CopyButton label="Copy log entry" getText={() => JSON.stringify(parsed.data, null, 2)} />
          </summary>
          <JsonView data={parsed.data} />
        </details>
      </div>
    );
  }

  const { headers, body, rawBody } = parsed.request;
  const headerIds = keys.map((k) => headers.find((h) => same(h.name, k))).filter(Boolean);
  const others = headers.filter((h) => !keys.some((k) => same(k, h.name)));

  return (
    <div className="lv">
      <Identifiers ids={headerIds} match={match} />

      <details open>
        <summary>
          Request headers <span className="count">{others.length}</span>
          <CopyButton
            label="Copy request headers"
            getText={() => others.map((h) => `${h.name}: ${maskHeaderValue(h.name, h.value)}`).join('\n')}
          />
        </summary>
        <table className="lv-table">
          <tbody>
            {others.map((h) => (
              <tr key={h.name}>
                <th scope="row">{h.name}</th>
                <td>{maskHeaderValue(h.name, h.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      {rawBody && (
        <details open>
          <summary>
            Request body
            <CopyButton label="Copy request body" getText={() => (body === null ? rawBody : JSON.stringify(body, null, 2))} />
          </summary>
          {body === null ? <pre>{rawBody}</pre> : <JsonView data={body} />}
        </details>
      )}

      {parsed.rest && (
        <details>
          <summary>
            Other log fields
            <CopyButton label="Copy other log fields" getText={() => JSON.stringify(parsed.rest, null, 2)} />
          </summary>
          <JsonView data={parsed.rest} />
        </details>
      )}
    </div>
  );
}
