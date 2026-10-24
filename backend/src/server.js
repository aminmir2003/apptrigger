import express from 'express';
import { setupCors } from './cors.js';
import { login as portalLogin, status as portalStatus, logout as portalLogout } from './portalSession.js';
import { queryLogs, environments } from './logging.js';
import { extractIds, interpretPrompt } from './fuelix.js';
import { deepAnalyze } from './deepAnalysis.js';
import { getConfig, configSource, chooseKeys } from './githubConfig.js';

const app = express();
app.use(express.json({ limit: '25mb' }));

// The frontend is a separate service: let its address call this API.
setupCors(app);

app.get('/health', (_req, res) => res.json({ ok: true }));

// GET /logs?env=np|pr&search=&insertId=&from=&to=&service=&revision=&severity=&hours=&limit=&filter=
// Each returned message is the complete log entry (capped at MAX_MESSAGE_CHARS, default 100000).
app.get('/logs', async (req, res) => {
  try {
    const { env, search, insertId, resource, service, revision, severity, filter, from, to, hours, limit } = req.query;
    res.json(await queryLogs({ env, search, insertId, resource, service, revision, severity, filter, from, to, hours: Number(hours) || 1, limit }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /interpret { prompt } -> { search, range, env, by }
// Reads a request typed in the chat box ("can you search triggering application of NOTIFY_DATA_ROLLOVER_KOODO")
// and returns what to search for. search is null when the request holds nothing to look for.
app.post('/interpret', async (req, res) => {
  try {
    const { prompt } = req.body ?? {};
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2000) {
      return res.status(400).json({ error: 'prompt must be a non-empty string of at most 2000 characters' });
    }
    res.json(await interpretPrompt(prompt));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /deep-analyze { env, template, from? }
//   -> { template, examined, candidates, name, field, count, confidence, reason, by }
// For a template whose own request names no caller: studies the other logs that mention it and says which application
// most likely triggers it (name is null when there is nothing to go on).
app.post('/deep-analyze', async (req, res) => {
  try {
    const { env, template, from } = req.body ?? {};
    if (typeof template !== 'string' || !template.trim()) return res.status(400).json({ error: 'template must be a non-empty string' });
    res.json(await deepAnalyze({ env, template: template.trim(), from }));
  } catch (err) {
    console.error(err);
    res.status(err.message === 'Invalid template name' ? 400 : 500).json({ error: err.message });
  }
});

// GET /info -> non-secret facts shown in the page's "Cloud logs" details card.
app.get('/info', (_req, res) => {
  res.json({
    environments,
    fuelixModel: process.env.FUELIX_MODEL || null,
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
//   -> { ids: ({key, value}|null)[] }
// Uses FuelIX to find every configured search key (the list lives in GitHub) in each log.
// The value found next to the key (for example "X-Consumer-Username: PaymentManagement") is the consumer.
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
    // Every key found in a log comes back in priority order; the first one is the log's identifier.
    const found = await extractIds(messages, searchKeys);
    res.json({ ids: found.map((list) => list[0] ?? null) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// TELUS portal session (Puppeteer). Login opens a browser window on the machine running this server.
// This API has no sign-in, so these routes are OFF unless PORTAL_ENABLED=true: anyone who can reach the server
// could otherwise open a browser on it or delete the saved portal session. Nothing in the page uses them.
if (process.env.PORTAL_ENABLED === 'true') {
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
}

const port = process.env.PORT || 3000;
// This API has no sign-in, so on a developer machine it only accepts connections from that machine.
// Inside Cloud Run (it sets K_SERVICE) or a container (the Dockerfile sets HOST=0.0.0.0) it listens on every address.
const host = process.env.HOST || (process.env.K_SERVICE ? '0.0.0.0' : '127.0.0.1');
app.listen(port, host, () => console.log(`apptrigger API listening on ${host}:${port}`));
