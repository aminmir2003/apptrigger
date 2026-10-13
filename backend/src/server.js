import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupAuth } from './auth.js';
import { login as portalLogin, status as portalStatus, logout as portalLogout } from './portalSession.js';
import { queryLogs } from './logging.js';
import { extractIds } from './fuelix.js';
import { pickTeams, cmdbRowCount } from './cmdb.js';
import { getConfig, configSource, chooseKeys } from './githubConfig.js';

const app = express();
app.use(express.json({ limit: '25mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

// TELUS SSO: everything registered below this line requires a signed-in user.
await setupAuth(app);

// GET /logs?search=&from=&to=&service=&revision=&severity=&hours=&limit=&filter=
// Each returned message is the complete log entry (capped at MAX_MESSAGE_CHARS, default 100000).
app.get('/logs', async (req, res) => {
  try {
    const { search, resource, service, revision, severity, filter, from, to, hours, limit } = req.query;
    res.json(await queryLogs({ search, resource, service, revision, severity, filter, from, to, hours: Number(hours) || 1, limit }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /info -> non-secret facts shown in the page's "Cloud logs" details card.
app.get('/info', async (_req, res) => {
  let cmdbRows = null;
  try {
    cmdbRows = await cmdbRowCount();
  } catch {
    // a missing or unreadable sheet is reported as unknown, not as an error
  }
  res.json({
    project: process.env.GCP_PROJECT_ID ?? null,
    fuelixModel: process.env.FUELIX_MODEL || null,
    sso: process.env.AUTH_DISABLED !== 'true',
    cmdbRows,
  });
});

// GET /config -> the search keys and display labels kept in GitHub (never a token).
app.get('/config', async (_req, res) => {
  try {
    const { searchKeys, labels } = await getConfig();
    res.json({ searchKeys, labels, source: configSource() });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message, source: configSource() });
  }
});

// POST /analyze { messages: string[], keys?: string[] }
//   -> { ids: ({key, value}|null)[], teams: (string|null)[] }
// Uses FuelIX to find every configured search key (the list lives in GitHub) in each log.
// The value found next to the key (for example "X-Consumer-Username: PaymentManagement") is the consumer;
// its Description in CMDBID.xlsx is the team.
app.post('/analyze', async (req, res) => {
  try {
    const { messages, keys } = req.body ?? {};
    if (!Array.isArray(messages) || messages.length > 500 || !messages.every((m) => typeof m === 'string')) {
      return res.status(400).json({ error: 'messages must be an array of at most 500 strings' });
    }
    const config = await getConfig();
    let searchKeys;
    try {
      searchKeys = chooseKeys(keys, config.searchKeys);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    // Every key found in a log is tried in priority order; the first one the sheet knows wins.
    const picked = await pickTeams(await extractIds(messages, searchKeys));
    res.json({ ids: picked.map((p) => p.id), teams: picked.map((p) => p.team) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// TELUS portal session (Puppeteer). Login opens a browser window on the machine running this server
// and resolves once TELUS SSO is complete.
app.post('/portal/login', async (_req, res) => {
  try {
    res.json(await portalLogin());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
app.get('/portal/status', async (_req, res) => {
  try {
    res.json(await portalStatus());
  } catch (err) {
    res.json({ signedIn: false, error: err.message });
  }
});
app.post('/portal/logout', async (_req, res) => {
  await portalLogout();
  res.json({ signedIn: false });
});

// Serve the built UI (frontend/dist) from the same origin, behind the SSO gate.
const dist = fileURLToPath(new URL('../../frontend/dist', import.meta.url));
app.use(express.static(dist));
app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(dist, 'index.html')) : next()));

const port = process.env.PORT || 3000;
// With SSO off, only accept connections from this machine.
const host = process.env.AUTH_DISABLED === 'true' ? '127.0.0.1' : undefined;
app.listen(port, host, () => console.log(`Log service listening on ${host ?? ''}:${port}`));
