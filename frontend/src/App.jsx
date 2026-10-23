import { useEffect, useRef, useState } from 'react';
import LogView from './LogView.jsx';
import { apiFetch } from './api.js';
import { findHeaderValues, findSenderName } from './logFormat.js';

// A Cloud Logging insertId: lowercase letters and digits, both present, like "2hz8yue1s9cs". Template names are
// upper case with underscores, so they never look like this.
const INSERT_ID_SHAPE = /^(?=.*\d)(?=.*[a-z])[a-z0-9]{8,24}$/;

// Example requests offered under an empty chat box; clicking one fills the box in.
const EXAMPLES = [
  'Search triggering application of NOTIFY_DATA_ROLLOVER_KOODO from today',
  'Who triggered NOTIFY_DATA_ROLLOVER_KOODO in the last 5 days?',
  'Triggering application of NOTIFY_DATA_ROLLOVER_KOODO from Jan-2026 to Oct 2026',
];

// Request headers shown in the table beside every log.
const TRACE_HEADERS = ['X-Consumer-Username', 'X-Consumer-ID', 'Kong-Request-ID', 'X-Kong-Request-Id', 'appId', 'originatorApplicationId'];

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

// Turns the time range found in a typed request ({ kind, ... } from the server) into dates in this browser's time zone.
// Returns { range: [from, to], label, preset } (preset is set when it is the same as one of the Time menu choices),
// or { error } when the request cannot be searched.
const PRESET_FOR_DAYS = { 5: '5d', 10: '10d', 30: '30d' };
const fmtDay = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
function resolveRange(spec) {
  const now = new Date();
  const preset = (id) => ({ range: PRESETS.find((p) => p.id === id).range(), label: PRESETS.find((p) => p.id === id).label, preset: id });
  switch (spec.kind) {
    case 'today':
      return preset('today');
    case 'yesterday': {
      const start = startOfToday();
      start.setDate(start.getDate() - 1);
      return { range: [start, new Date(startOfToday().getTime() - 1)], label: 'Yesterday', preset: null };
    }
    case 'days':
      return PRESET_FOR_DAYS[spec.days]
        ? preset(PRESET_FOR_DAYS[spec.days])
        : { range: [daysAgo(spec.days), now], label: `Last ${spec.days} day${spec.days === 1 ? '' : 's'}`, preset: null };
    case 'months':
      return spec.months === 5
        ? preset('5m')
        : { range: [monthsAgo(spec.months), now], label: `Last ${spec.months} month${spec.months === 1 ? '' : 's'}`, preset: null };
    case 'dates': {
      const [fy, fm, fd] = spec.from.split('-').map(Number);
      const [ty, tm, td] = spec.to.split('-').map(Number);
      const start = new Date(fy, fm - 1, fd, 0, 0, 0, 0);
      const end = new Date(ty, tm - 1, td, 23, 59, 59, 999);
      if (start > now) return { error: `${fmtDay(spec.from)} is in the future, so there are no logs to search yet.` };
      const label = spec.from === spec.to ? fmtDay(spec.from) : `${fmtDay(spec.from)} – ${fmtDay(spec.to)}`;
      return { range: [start, end > now ? now : end], label, preset: null };
    }
    default:
      return null;
  }
}

const RESOURCES = [
  { id: 'all', label: 'All' },
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

const fmtDateTime = (d) => d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

const fmtMs =(ms) => (ms == null ? 'n/a' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

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
  const [env, setEnv] = useState(() => loadSetting('env', ['np', 'pr'], 'np')); // which environment's project is searched
  const [preset, setPreset] = useState('today'); // preset id or 'custom'
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
  const [analyzing, setAnalyzing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [interpreting, setInterpreting] = useState(false); // FuelIX is reading the typed request
  const [understood, setUnderstood] = useState(null); // what the last request was turned into: { search, time, env, by }
  const [error, setError] = useState('');
  // The server decides which environments exist (NP / PR); a saved choice it no longer offers falls back to its first one.
  const busy = interpreting || loading || analyzing;
  const composerRef = useRef(null);
  const envs = info?.environments ?? [];
  const activeEnv = envs.find((e) => e.id === env) ?? envs[0] ?? null;

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
    setError('');
    setInterpreting(true);
    // FuelIX reads the typed request and says what to search for. If it can't be reached, the text is searched as typed.
    let plan;
    try {
      const res = await apiFetch('/interpret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: search }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      plan = body;
    } catch {
      plan = { search: search.trim(), range: null, env: null, by: 'exact' };
    } finally {
      setInterpreting(false);
    }
    if (!plan.search) {
      setUnderstood(null);
      setError("I couldn't find a template name in that. Try: can you search triggering application of NOTIFY_DATA_ROLLOVER_KOODO");
      return;
    }

    // A time window or environment named in the request wins over the page's own choices (and is shown there).
    const envId = plan.env && envs.some((x) => x.id === plan.env) ? plan.env : activeEnv?.id;
    if (envId && envId !== activeEnv?.id) setEnv(envId);
    let range;
    let timeLabel;
    const asked = plan.range ? resolveRange(plan.range) : null;
    if (asked?.error) {
      setError(asked.error);
      return;
    }
    if (asked) {
      // Remember the range asked for (the "Cloud logs" card shows it): a matching preset, otherwise a custom range.
      range = asked.range;
      timeLabel = asked.label;
      setPreset(asked.preset ?? 'custom');
      if (!asked.preset) {
        setFrom(toLocalInput(range[0]));
        setTo(toLocalInput(range[1]));
      }
    } else {
      // The request named no time, so it is Today (not whatever an earlier request asked for).
      const today = resolveRange({ kind: 'today' });
      range = today.range;
      timeLabel = today.label;
      setPreset('today');
    }
    setUnderstood({ search: plan.search, time: timeLabel, env: envs.find((x) => x.id === envId)?.label ?? null, by: plan.by });
    await runSearch(plan.search, range, envId);
  }

  // Search Cloud Logging for the term, then look up the triggering application for what was found.
  async function runSearch(term, range, envId) {
    setLoading(true);
    setError('');
    try {
      // A Cloud Logging insertId is looked up directly (any kind of log), not searched for as text.
      const params = new URLSearchParams({ resource, limit });
      params.set(INSERT_ID_SHAPE.test(term) ? 'insertId' : 'search', term);
      if (envId) params.set('env', envId);
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
      setStats({ logs: body.length, searchMs: Math.round(performance.now() - t0), at: Date.now(), range });
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

  // The box grows with what is typed (up to a few lines), like a chat composer.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [search]);

  useEffect(() => saveSetting('resource', resource), [resource]);
  useEffect(() => saveSetting('env', env), [env]);
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

  const infoTimer = useRef(null);
  useEffect(() => () => clearTimeout(infoTimer.current), []); // no timer left running after unmount
  const closeInfo = () => {
    clearTimeout(infoTimer.current);
    setInfoOpen(false);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };
  const openInfo = () => {
    clearTimeout(infoTimer.current);
    setInfoOpen(true);
  };
  // Closing waits a moment after the pointer leaves, so crossing from the label onto the window never closes it;
  // being over either one cancels the close.
  const closeInfoSoon = () => {
    clearTimeout(infoTimer.current);
    infoTimer.current = setTimeout(closeInfo, 250);
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
        <img className="topbar-logo" src="/TELUS_Logo.svg" alt="TELUS" />
        <div className="topbar-right">
          {envs.length > 1 && (
            // An on/off switch like the one in Settings: off searches NP, on searches PR, and the word beside it says which.
            <div className="env-switch toggle" title={activeEnv?.project}>
              <label htmlFor="env-toggle" className="env-label">Environment:</label>
              <input
                id="env-toggle"
                type="checkbox"
                role="switch"
                checked={activeEnv?.id === 'pr'}
                onChange={(e) => setEnv(e.target.checked ? 'pr' : 'np')}
              />
              <span className="env-value" aria-live="polite">{activeEnv?.label}</span>
            </div>
          )}
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
                      <p className="field-help">Where the logs are read from: Cloud Run services, Cloud SQL databases, GKE containers, or All of them together (the search then runs across every log type in the project).</p>
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
            onMouseEnter={openInfo}
            onMouseLeave={closeInfoSoon}
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
                    <InfoRow label="Project">{activeEnv ? `${activeEnv.project} (${activeEnv.label})` : 'Not available'}</InfoRow>
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

              <span className="info-foot">Settings are saved in this browser. Change them with the gear icon. Name a time range in your request, such as "last 5 days".</span>
            </span>
            )}
          </span>
        </div>
      </nav>
      <main>
      <section className="hero">
        <div>
          <div className="brand-hero">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
                <circle cx="12" cy="12" r="5" strokeDasharray="25.4 6" transform="rotate(124.4 12 12)" />
                <circle cx="12" cy="12" r="9" strokeDasharray="46.5 10" transform="rotate(121.9 12 12)" />
              </svg>
            </span>
            <div>
              <h1 className="brand-name">
                Trigger<span>Trace</span>
                <em>Bot</em>
              </h1>
              <p className="brand-sub">Find which application triggered a template</p>
            </div>
          </div>
        </div>
        <img className="hero-logo" src="/logo_cub.png" alt="Logo" />
      </section>
      <form onSubmit={onSubmit} className="panel">
        {!logs && !busy && !understood && <h2 className="chat-title">Which template do you want to trace?</h2>}

        <div className="composer">
          <textarea
            ref={composerRef}
            className="composer-input"
            rows={1}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter makes a new line (and never send while an input method is composing).
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!busy) e.currentTarget.form.requestSubmit();
              }
            }}
            placeholder="Ask anything, e.g. who triggered NOTIFY_DATA_ROLLOVER_KOODO in the last 5 days?"
            aria-label="Ask which application triggered a template"
            spellCheck={false}
            autoFocus
          />
          <div className="composer-bar">
            <button
              className="send-btn"
              aria-label="Find the triggering application"
              title="Find the triggering application"
              disabled={busy || !(search.trim() || (pasteEnabled && pasted.trim()))}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />
              </svg>
            </button>
          </div>
        </div>

        {!search.trim() && !busy && (
          <div className="suggestions" aria-label="Example requests">
            {EXAMPLES.map((text) => (
              <button
                type="button"
                key={text}
                className="suggestion"
                onClick={() => {
                  setSearch(text);
                  composerRef.current?.focus();
                }}
              >
                {text}
              </button>
            ))}
          </div>
        )}

        {(busy || understood) && (
          <p className="chat-status" role="status">
            {busy ? (
              // One big pulsing purple dot while working; the words are kept for screen readers only.
              <span className="thinking">
                <span className="sr-only">
                  {interpreting ? 'Reading your request' : analyzing ? 'Finding the triggering application' : 'Searching the logs'}
                </span>
                <i aria-hidden="true" />
              </span>
            ) : (
              <>
                {understood.by === 'exact' ? 'FuelIX could not be reached, so I searched your text as typed: ' : 'Searched for '}
                <strong>{understood.search}</strong>
                {' · '}{understood.time}
                {understood.env && <>{' · '}{understood.env}</>}
              </>
            )}
          </p>
        )}

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

      </form>

      {config.error && <p className="error">Could not load the configuration: {config.error}</p>}
      {error && <p className="error">{error}</p>}
      {logs && logs.length === 0 && <p className="no-results">No Search Result Found</p>}
      {logs && logs.length > 0 && (
        <p className="count">
          Showing {logs.length} unique log{logs.length === 1 ? '' : 's'}, newest first
          {(() => {
            const hidden = logs.reduce((n, l) => n + Math.max((l.repeats ?? 1) - 1, 0), 0);
            return hidden > 0 ? ` · ${hidden} repeated record${hidden === 1 ? '' : 's'} hidden` : '';
          })()}
          {stats?.range?.[0] && stats?.range?.[1]
            ? ` (searched ${fmtDateTime(stats.range[0])} → ${fmtDateTime(stats.range[1])})`
            : ` (${logs[logs.length - 1].timestamp} → ${logs[0].timestamp})`}
          {logs.length >= Number(limit) && ' — limit reached, older matches are hidden. Raise Max results in Settings (gear icon) or narrow the range.'}
        </p>
      )}
      {logs?.map((log, i) => (
        <article key={i} className="log-card">
          <div className="log-main">
            <header>
              <span className={`sev ${log.severity}`}>{log.severity || 'DEFAULT'}</span>
              <time>{log.timestamp}</time>
              {log.repeats > 1 && (
                <span className="repeats" title="Same template and X-Consumer-Username; only the newest is shown">
                  seen {log.repeats}&times;
                </span>
              )}
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
            ) : null}
            <h3 className="trace-title">Triggering Application</h3>
            <table className="trace-table">
              <tbody>
                {[...findHeaderValues(log.message, TRACE_HEADERS), { name: 'Sender', value: findSenderName(log.message) }].map(({ name, value }) => (
                  <tr key={name}>
                    <th scope="row">{name}</th>
                    <td className={value ? '' : 'muted'}>{value ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </aside>
        </article>
      ))}
      </main>
      <footer className="footer">@2026 TELUS</footer>
    </>
  );
}
