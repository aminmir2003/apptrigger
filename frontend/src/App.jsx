import { useEffect, useRef, useState } from 'react';
import LogView from './LogView.jsx';
import { API_URL, apiFetch } from './api.js';

// Format a Date for <input type="datetime-local"> (local time).
const toLocalInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};
const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000);
const monthsAgo = (n) => {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
};

// Each preset resolves to a fresh [from, to] at search time, so "Today" never goes stale.
const PRESETS = [
  { id: 'today', label: 'Today', range: () => [startOfToday(), new Date()] },
  { id: '5d', label: 'Last 5 days', range: () => [daysAgo(5), new Date()] },
  { id: '10d', label: 'Last 10 days', range: () => [daysAgo(10), new Date()] },
  { id: '30d', label: 'Last 30 days', range: () => [daysAgo(30), new Date()] },
  { id: '5m', label: 'Last 5 months', range: () => [monthsAgo(5), new Date()] },
];

const RESOURCES = [
  { id: 'cloud_run_revision', label: 'Cloud Run' },
  { id: 'cloudsql_database', label: 'Cloud SQL' },
  { id: 'k8s_container', label: 'GKE Container' },
];
const LIMITS = ['50', '100', '250', '500'];
// 'all' means any configured search key (the first one present wins). The keys themselves come from the server.
const ALL_KEYS = 'all';

// Settings survive reloads. Storage can be unavailable (private mode), so never let it throw.
const loadSetting = (name, allowed, fallback) => {
  try {
    const v = localStorage.getItem(`logsearch.v2.${name}`);
    return v != null && (allowed == null || allowed.includes(v)) ? v : fallback;
  } catch {
    return fallback;
  }
};
const saveSetting = (name, value) => {
  try {
    localStorage.setItem(`logsearch.v2.${name}`, value);
  } catch {}
};

const fmtMs = (ms) => (ms == null ? 'n/a' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function InfoRow({ label, children }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export default function App() {
  const [search, setSearch] = useState('');
  const [resource, setResource] = useState(() => loadSetting('resource', RESOURCES.map((r) => r.id), 'k8s_container'));
  const [preset, setPreset] = useState('today'); // preset id or 'custom'
  const [editingTime, setEditingTime] = useState(false);
  const [from, setFrom] = useState(() => toLocalInput(startOfToday()));
  const [to, setTo] = useState(() => toLocalInput(new Date()));
  const [limit, setLimit] = useState(() => loadSetting('limit', LIMITS, '500'));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pasteEnabled, setPasteEnabled] = useState(() => loadSetting('paste', ['true', 'false'], 'false') === 'true');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false); // the "Cloud logs" details card
  const infoRef = useRef(null);
  const [info, setInfo] = useState(null); // non-secret server facts for the details card
  const [stats, setStats] = useState(null); // numbers from the last run
  const [pasted, setPasted] = useState(''); // a log pasted in by hand, used instead of searching Cloud Logging
  const settingsRef = useRef(null);
  const [logs, setLogs] = useState(null);
  const [values, setValues] = useState(null); // matched { key, value } per log, from FuelIX
  const [teams, setTeams] = useState(null); // team (CMDBID.xlsx Description) per log
  const [config, setConfig] = useState({ searchKeys: [], labels: {}, source: null, error: '', loaded: false }); // from the server (GitHub or a local file)
  const [searchKey, setSearchKey] = useState(() => loadSetting('searchKey', null, ALL_KEYS));
  const [user, setUser] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(e) {
    e.preventDefault();
    if (pasteEnabled && pasted.trim()) {
      const list = [{ severity: 'PASTED', timestamp: new Date().toISOString(), message: pasted.trim() }];
      setError('');
      setLogs(list);
      setStats({ logs: 1, searchMs: null, at: Date.now() });
      setValues(null);
      setTeams(null);
      setLoading(true);
      try {
        await analyze(list);
      } finally {
        setLoading(false);
      }
      return;
    }
    if (!search.trim()) return;
    let range;
    if (preset === 'custom') {
      range = [from && new Date(from), to && new Date(to)];
      if (range[0] && range[1] && range[0] > range[1]) {
        setError('"From" must be before "To".');
        return;
      }
    } else {
      range = PRESETS.find((p) => p.id === preset).range();
    }
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ search, resource, limit });
      if (range[0]) params.set('from', range[0].toISOString());
      if (range[1]) params.set('to', range[1].toISOString());
      const t0 = performance.now();
      const res = await apiFetch(`/logs?${params}`);
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`Log API is not reachable (HTTP ${res.status}). Is it running on port 3000? Start it with "npm start".`);
      }
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      setLogs(body);
      setStats({ logs: body.length, searchMs: Math.round(performance.now() - t0), at: Date.now() });
      setValues(null);
      setTeams(null);
      // Second step of the single button: look up the triggering application for what was found.
      if (body.length > 0) await analyze(body);
    } catch (err) {
      setError(err.message);
      setLogs(null);
    } finally {
      setLoading(false);
    }
  }

  // Who is signed in (absent when SSO is disabled for local development).
  useEffect(() => saveSetting('resource', resource), [resource]);
  useEffect(() => saveSetting('limit', limit), [limit]);
  useEffect(() => saveSetting('searchKey', searchKey), [searchKey]);
  useEffect(() => saveSetting('paste', String(pasteEnabled)), [pasteEnabled]);

  useEffect(() => {
    if (!infoOpen) return undefined;
    const onDown = (e) => infoRef.current && !infoRef.current.contains(e.target) && setInfoOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [infoOpen]);

  useEffect(() => {
    if (!settingsOpen) return undefined;
    const onClick = (e) => settingsRef.current && !settingsRef.current.contains(e.target) && setSettingsOpen(false);
    const onKey = (e) => e.key === 'Escape' && setSettingsOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [settingsOpen]);

  useEffect(() => {
    apiFetch('/config')
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (ok) setConfig({ searchKeys: body.searchKeys, labels: body.labels ?? {}, source: body.source ?? null, error: '', loaded: true });
        else setConfig((c) => ({ ...c, source: body.source ?? null, error: body.error || 'Could not load the configuration', loaded: true }));
      })
      .catch(() => setConfig((c) => ({ ...c, error: 'The server did not answer. Is it running?', loaded: true })));
  }, []);

  useEffect(() => {
    if (config.loaded && !config.error && searchKey !== ALL_KEYS && !config.searchKeys.includes(searchKey)) setSearchKey(ALL_KEYS);
  }, [config, searchKey]);

  useEffect(() => {
    apiFetch('/info')
      .then((r) => (r.ok ? r.json() : null))
      .then((i) => i && setInfo(i))
      .catch(() => {});
  }, []);

  useEffect(() => {
    apiFetch('/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => u && setUser(u))
      .catch(() => {});
  }, []);

  function resetSettings() {
    setResource('k8s_container');
    setSearchKey(ALL_KEYS);
    setLimit('500');
    setPasteEnabled(false);
    setPasteOpen(false);
    setPasted('');
  }

  async function analyze(list) {
    setAnalyzing(true);
    setError('');
    const t1 = performance.now();
    try {
      const res = await apiFetch('/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: list.map((l) => l.message),
          keys: searchKey === ALL_KEYS ? config.searchKeys : [searchKey],
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Analyze failed (${res.status})`);
      setValues(body.ids);
      setTeams(body.teams);
      setStats((s) => ({
        ...s,
        identified: body.ids.filter(Boolean).length,
        withTeam: body.teams.filter(Boolean).length,
        analyzeMs: Math.round(performance.now() - t1),
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setAnalyzing(false);
    }
  }

  const closeInfo = () => {
    setInfoOpen(false);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };

  const rangeText =
    preset === 'custom'
      ? `${from.replace('T', ' ')} to ${to.replace('T', ' ')}`
      : (() => {
          const [start, end] = PRESETS.find((p) => p.id === preset).range();
          return `${start.toLocaleString()} to ${end.toLocaleString()}`;
        })();

  return (
    <>
      <nav className="topbar">
        <img className="topbar-logo" src="/telus_logo.png" alt="TELUS" />
        <div className="topbar-right">
          <div className="settings" ref={settingsRef}>
            <button
              type="button"
              className="gear"
              aria-label="Settings"
              aria-expanded={settingsOpen}
              title="Settings"
              onClick={() => setSettingsOpen((v) => !v)}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"
                />
              </svg>
            </button>
            {settingsOpen && (
              <>
                <div className="drawer-backdrop" onClick={() => setSettingsOpen(false)} />
                <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="settings-title">
                  <header className="drawer-head">
                    <h2 id="settings-title">Settings</h2>
                    <button type="button" className="drawer-close" aria-label="Close settings" onClick={() => setSettingsOpen(false)} autoFocus>
                      &times;
                    </button>
                  </header>

                  <div className="drawer-body">
                    <section className="help">
                      <h3>
                        <span className="help-icon" aria-hidden="true">?</span>
                        Why do I need these settings?
                      </h3>
                      <p>
                        They tell the app where to look and what to look for. It reads your logs from the chosen source,
                        finds the identifier you pick in each log, and uses that identifier's value to work out which
                        application triggered the template.
                      </p>
                      <p>Your choices are saved in this browser, so you only need to set them once.</p>
                    </section>

                    <div className="field">
                      <label htmlFor="set-source">Log source</label>
                      <select id="set-source" value={resource} onChange={(e) => setResource(e.target.value)}>
                        {RESOURCES.map((r) => (
                          <option key={r.id} value={r.id}>{r.label}</option>
                        ))}
                      </select>
                      <p className="field-help">Where the logs are read from: Cloud Run services, Cloud SQL databases or GKE containers.</p>
                    </div>

                    <div className="field">
                      <label htmlFor="set-key">Search key</label>
                      <select id="set-key" value={searchKey} onChange={(e) => setSearchKey(e.target.value)}>
                        <option value={ALL_KEYS}>All keys</option>
                        {config.searchKeys.map((k) => (
                          <option key={k} value={k}>{k}</option>
                        ))}
                      </select>
                      <p className="field-help">
                        The identifier to find in each log. The list comes from the configuration kept in GitHub.
                        &ldquo;All keys&rdquo; tries every one and uses the first it finds.
                      </p>
                    </div>

                    <div className="field">
                      <label htmlFor="set-limit">Max results</label>
                      <select id="set-limit" value={limit} onChange={(e) => setLimit(e.target.value)}>
                        {LIMITS.map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                      <p className="field-help">The most logs fetched per search, newest first. Higher numbers reach further back but take longer.</p>
                    </div>

                    <div className="field">
                      <div className="toggle">
                        <label htmlFor="set-paste">Paste a log</label>
                        <input
                          id="set-paste"
                          type="checkbox"
                          role="switch"
                          checked={pasteEnabled}
                          onChange={(e) => {
                            setPasteEnabled(e.target.checked);
                            if (!e.target.checked) {
                              setPasteOpen(false);
                              setPasted('');
                            }
                          }}
                        />
                      </div>
                      <p className="field-help">
                        Adds a &ldquo;Paste a log instead&rdquo; box under the search. A pasted log is analysed directly and Cloud
                        Logging is not searched. Leave this off for normal use.
                      </p>
                    </div>
                  </div>

                  <footer className="drawer-foot">
                    <button type="button" className="link" onClick={resetSettings}>Reset to defaults</button>
                    <button type="button" className="btn-primary" onClick={() => setSettingsOpen(false)}>Done</button>
                  </footer>
                </aside>
              </>
            )}
          </div>
          <span
            ref={infoRef}
            className={`topbar-note info${infoOpen ? ' open' : ''}`}
            tabIndex={0}
            aria-describedby="cloud-info"
            onMouseEnter={() => setInfoOpen(true)}
            onFocus={(e) => e.currentTarget.matches(':focus-visible') && setInfoOpen(true)}
            onKeyDown={(e) => e.key === 'Escape' && closeInfo()}
          >
            <span className="info-anchor">Cloud logs</span> &middot; FuelIX analysis
            {infoOpen && (
            <span className="info-pop open" id="cloud-info" role="tooltip">
              <button type="button" className="info-close" aria-label="Close details" onClick={closeInfo}>
                &times;
              </button>
              <span className="info-head">
                <img className="info-butterfly" src="/butterfly.png" alt="" aria-hidden="true" />
                <strong className="info-title">Cloud logs &amp; FuelIX analysis</strong>
                <span className="info-text">
                  This page reads logs from Google Cloud Logging, asks FuelIX to find an identifier in each log, and then looks that
                  identifier up in the CMDBID.xlsx sheet to show the consumer and the team that triggered the template.
                </span>
              </span>

              <span className="info-body">
                <span className="info-col">
                  <span className="info-h">Current search</span>
                  <dl className="info-list">
                    <InfoRow label="Search text">{pasteEnabled && pasted.trim() ? 'A pasted log' : search.trim() || 'Nothing entered yet'}</InfoRow>
                    <InfoRow label="Log source">{RESOURCES.find((r) => r.id === resource)?.label ?? resource}</InfoRow>
                    <InfoRow label="Project">{info?.project ?? 'Not available'}</InfoRow>
                    <InfoRow label="Time range">{rangeText}</InfoRow>
                    <InfoRow label="Max results">{limit} logs, newest first</InfoRow>
                    <InfoRow label="Search key">{searchKey === ALL_KEYS ? 'All keys' : searchKey}</InfoRow>
                  </dl>

                  <span className="info-h">Last run</span>
                  {stats ? (
                    <dl className="info-list">
                      <InfoRow label="Started">{new Date(stats.at).toLocaleTimeString()}</InfoRow>
                      <InfoRow label="Logs loaded">{stats.logs}</InfoRow>
                      <InfoRow label="Log search time">{fmtMs(stats.searchMs)}</InfoRow>
                      <InfoRow label="Identifiers found">{stats.identified ?? 'Working…'}</InfoRow>
                      <InfoRow label="Teams found">{stats.withTeam ?? 'Working…'}</InfoRow>
                      <InfoRow label="FuelIX time">{fmtMs(stats.analyzeMs)}</InfoRow>
                    </dl>
                  ) : (
                    <span className="info-text">No search has been run yet.</span>
                  )}

                  <span className="info-h">System</span>
                  <dl className="info-list">
                    <InfoRow label="FuelIX model">{info?.fuelixModel ?? 'Not set'}</InfoRow>
                    <InfoRow label="Sign-in (SSO)">{info == null ? 'Unknown' : info.sso ? 'On' : 'Off (local use)'}</InfoRow>
                    <InfoRow label="Paste a log">{pasteEnabled ? 'On' : 'Off'}</InfoRow>
                    <InfoRow label="Config source">
                      {config.source ? (config.source.type === 'local' ? `Local file ${config.source.file ?? ''}`.trim() : `${config.source.repo}@${config.source.branch}`) : 'Not set up'}
                      {config.error ? ' (error)' : ''}
                    </InfoRow>
                  </dl>
                </span>

                <span className="info-col">
                  <span className="info-h">How the team is found</span>
                  <ol className="info-steps">
                    <li>Logs are fetched from the chosen source, newest first, up to Max results.</li>
                    <li>Bearer tokens are removed from every log before it is sent to FuelIX.</li>
                    <li>
                      FuelIX reports each key it finds, such as <code>X-Consumer-Username=PaymentManagement</code>, and each value is
                      checked against the log text.
                    </li>
                    <li>
                      Each value is looked up in the Key column of CMDBID.xlsx{info?.cmdbRows != null ? ` (${info.cmdbRows} rows)` : ''}. The first key
                      with a row wins, and that row&apos;s Description is the team.
                    </li>
                  </ol>

                  <span className="info-h">Search keys, in priority order</span>
                  <ol className="info-keys">
                    {config.searchKeys.map((k) => (
                      <li key={k} className={searchKey === ALL_KEYS || searchKey === k ? 'on' : 'off'}>
                        {k}
                      </li>
                    ))}
                  </ol>
                </span>
              </span>

              <span className="info-foot">Settings are saved in this browser. Change them with the gear icon or Edit time.</span>
            </span>
            )}
          </span>
          {user && (
            <span className="user">
              {user.name} &middot; <a href={`${API_URL}/auth/logout`}>Sign out</a>
            </span>
          )}
        </div>
      </nav>
      <main>
      <section className="hero">
        <div>
          <h1>Template Triggering App.</h1>
          <p>Search communication API logs, then let FuelIX match triggering application.</p>
        </div>
        <img className="hero-logo" src="/logo_cub.png" alt="Logo" />
      </section>
      <form onSubmit={onSubmit} className="panel">
        <div className="row">
          <input
            className="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Searching Template"
            autoFocus
          />
          <button className="btn-primary" disabled={loading || analyzing || !(search.trim() || (pasteEnabled && pasted.trim()))}>
            {analyzing ? 'Getting app name…' : loading ? 'Searching…' : 'Get Triggering App Name'}
          </button>
        </div>

        {pasteEnabled && (
          <>
          <div className="paste">
            <button type="button" className="link" onClick={() => setPasteOpen((v) => !v)}>
              {pasteOpen ? 'Hide pasted log' : 'Paste a log instead'}
            </button>
            {pasted.trim() && <span className="paste-note">A pasted log is set, so Cloud Logging will not be searched.</span>}
          </div>
          {pasteOpen && (
            <div className="paste-box">
              <label htmlFor="paste-log">Paste a log to test</label>
              <textarea
                id="paste-log"
                rows={6}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder="Paste a full log line here, then click Get Triggering App Name"
                spellCheck={false}
              />
              <div className="paste-actions">
                <span className="field-help">Bearer tokens are removed before the log is analysed. Clear the box to search Cloud Logging again.</span>
                <button type="button" className="link" onClick={() => setPasted('')} disabled={!pasted}>Clear</button>
              </div>
            </div>
          )}
          </>
        )}

        <div className="time">
          <span className="time-label">
            Time: <strong>{preset === 'custom' ? 'Custom range' : PRESETS.find((p) => p.id === preset).label}</strong>
          </span>
          <button type="button" className="link" onClick={() => setEditingTime((v) => !v)}>
            {editingTime ? 'Done' : 'Edit time'}
          </button>
        </div>

        {editingTime && (
          <div className="time-panel">
            <div className="chips">
              {PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className={`chip ${preset === p.id ? 'active' : ''}`}
                  onClick={() => {
                    setPreset(p.id);
                    setEditingTime(false); // close the panel once a range is picked
                  }}
                >
                  {p.label}
                </button>
              ))}
              <button
                type="button"
                className={`chip ${preset === 'custom' ? 'active' : ''}`}
                onClick={() => setPreset('custom')}
              >
                Custom range
              </button>
            </div>
            {preset === 'custom' && (
              <div className="row">
                <label>
                  From
                  <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
                </label>
                <label>
                  To
                  <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
                </label>
              </div>
            )}
          </div>
        )}
      </form>

      {config.error && <p className="error">Could not load the configuration: {config.error}</p>}
      {error && <p className="error">{error}</p>}
      {logs && logs.length === 0 && <p className="no-results">No Search Result Found</p>}
      {logs && logs.length > 0 && (
        <p className="count">
          Showing {logs.length} logs, newest first ({logs[logs.length - 1].timestamp} → {logs[0].timestamp})
          {logs.length >= Number(limit) && ' — limit reached, older matches are hidden. Raise Max results in Settings (gear icon) or narrow the range.'}
        </p>
      )}
      {logs?.map((log, i) => (
        <article key={i} className="log-card">
          <div className="log-main">
            <header>
              <span className={`sev ${log.severity}`}>{log.severity || 'DEFAULT'}</span>
              <time>{log.timestamp}</time>
            </header>
            <LogView message={log.message} match={values?.[i]} keys={config.searchKeys} />
          </div>
          <aside className="log-app" title={values?.[i] ? `${values[i].key}: ${values[i].value}` : undefined}>
            {!values ? (
              <p className="hint">
                {analyzing ? (
                  <span className="finding" role="status">
                    Finding the triggering application
                    <span className="dots" aria-hidden="true">
                      <i>.</i>
                      <i>.</i>
                      <i>.</i>
                    </span>
                  </span>
                ) : (
                  'Triggering application not determined.'
                )}
              </p>
            ) : values[i] ? (
              <div className="app-details">
                <p>The triggering application details for this template are as:</p>
                <dl>
                  <div>
                    <dt>{config.labels[values[i].key] ?? values[i].key}</dt>
                    <dd>{values[i].value}</dd>
                  </div>
                  <div>
                    <dt>Team</dt>
                    <dd className={teams?.[i] ? '' : 'muted'}>{teams?.[i] ?? 'Not found in CMDBID.xlsx'}</dd>
                  </div>
                </dl>
              </div>
            ) : (
              <p className="hint no-key">Not able to find the App name, please try again with different Key</p>
            )}
          </aside>
        </article>
      ))}
      </main>
      <footer className="footer">@2026 TELUS</footer>
    </>
  );
}
