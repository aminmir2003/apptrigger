// TELUS portal session via Puppeteer, following the JiraSense pattern: a person completes TELUS SSO
// by hand in a visible browser window, the session is kept (persistent browser profile plus a saved
// copy of the cookies), and later requests reuse it in a headless browser.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const PROFILE_DIR = process.env.BROWSER_PROFILE_PATH || root('data/browser-profile');
const SESSION_FILE = process.env.PORTAL_SESSION_FILE || root('.session/portal.json');
const SESSION_TTL_MS = Number(process.env.SSO_SESSION_TTL_SECONDS || 28800) * 1000; // 8 hours, like JiraSense
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

// Hosts that must not go through the corporate proxy (it can't tunnel to the internal SSO host).
const DEFAULT_PROXY_BYPASS = '*.tsl.telus.com;*.telus.com;localhost;127.*;[::1];<-loopback>';

// The persistent profile can only be opened by one browser at a time.
let busy = false;

export function portalUrl() {
  const url = process.env.PORTAL_URL;
  if (!url) throw new Error('PORTAL_URL is not set (the address of the TELUS portal, in .env)');
  return new URL(url);
}

async function browserPath() {
  const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.BROWSER_PATH, ...BROWSER_CANDIDATES];
  for (const p of candidates.filter(Boolean)) {
    try {
      await fs.access(p);
      return p;
    } catch {}
  }
  throw new Error('No Edge or Chrome found. Set BROWSER_PATH in .env to its executable.');
}

async function launch({ headless }) {
  const args = [];
  // Optional explicit proxy, e.g. PORTAL_PROXY_SERVER=http://198.161.14.25:8080
  if (process.env.PORTAL_PROXY_SERVER) {
    args.push(`--proxy-server=${process.env.PORTAL_PROXY_SERVER}`);
    args.push(`--proxy-bypass-list=${(process.env.PUPPETEER_PROXY_BYPASS || DEFAULT_PROXY_BYPASS).trim()}`);
  }
  if (!headless) args.push('--start-maximized');
  await fs.mkdir(PROFILE_DIR, { recursive: true });
  return puppeteer.launch({
    executablePath: await browserPath(),
    headless,
    defaultViewport: headless ? undefined : null,
    userDataDir: PROFILE_DIR,
    args,
  });
}

async function exclusive(fn) {
  if (busy) throw new Error('Another portal browser action is already running');
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

const looksLikeLogin = (url) => /\/(login|authenticate|saml|sso)\b/i.test(url);

// Resolves once the page is back on the portal host and no longer on a login page.
async function waitForLogin(page, target) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = page.url();
    if (new URL(url).host === target.host && !looksLikeLogin(url)) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Login timeout. Please try again.');
}

async function saveSession(cookies) {
  await fs.mkdir(path.dirname(SESSION_FILE), { recursive: true });
  const now = Date.now();
  await fs.writeFile(
    SESSION_FILE,
    JSON.stringify({ savedAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_TTL_MS).toISOString(), cookies }, null, 2),
  );
}

async function readSession() {
  try {
    return JSON.parse(await fs.readFile(SESSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// Cookie fields Puppeteer accepts when setting cookies.
const toCookieData = (c) => ({
  name: c.name,
  value: c.value,
  domain: c.domain,
  path: c.path,
  secure: c.secure,
  httpOnly: c.httpOnly,
  sameSite: c.sameSite,
  ...(c.session || !(c.expires > 0) ? {} : { expires: c.expires }),
});

/**
 * Open a visible browser on the portal and wait for the person to finish TELUS SSO.
 * The browser opens on the machine running this server.
 */
export function login() {
  return exclusive(async () => {
    const target = portalUrl();
    const browser = await launch({ headless: false });
    try {
      const page = (await browser.pages())[0] ?? (await browser.newPage());
      // The page may navigate away mid-load while SSO redirects; that's expected.
      await page.goto(target.href, { waitUntil: 'networkidle2', timeout: 180_000 }).catch(() => {});
      await waitForLogin(page, target);
      const cookies = await browser.cookies();
      await saveSession(cookies);
      return { success: true, cookieCount: cookies.length };
    } finally {
      await browser.close().catch(() => {});
    }
  });
}

/** Run fn(page) in a headless browser that carries the saved session. */
export function withPortalPage(fn) {
  return exclusive(async () => {
    const target = portalUrl();
    const saved = await readSession();
    if (!saved) throw new Error('Not signed in to the portal. Sign in first.');
    if (Date.parse(saved.expiresAt) < Date.now()) throw new Error('Portal session expired. Sign in again.');

    const browser = await launch({ headless: true });
    try {
      await browser.setCookie(...saved.cookies.map(toCookieData));
      const page = await browser.newPage();
      const response = await page.goto(target.href, { waitUntil: 'networkidle2', timeout: 60_000 });
      // Sent back to the SSO provider (a different host or a login page) means the session is gone.
      if (new URL(page.url()).host !== target.host || looksLikeLogin(page.url()) || response?.status() === 401) {
        throw new Error('Portal session expired. Sign in again.');
      }
      return await fn(page);
    } finally {
      await browser.close().catch(() => {});
    }
  });
}

/** Whether the saved session still gets into the portal. */
export async function status() {
  const saved = await readSession();
  if (!saved) return { signedIn: false };
  try {
    const title = await withPortalPage((page) => page.title());
    return { signedIn: true, savedAt: saved.savedAt, expiresAt: saved.expiresAt, title };
  } catch (err) {
    return { signedIn: false, error: err.message };
  }
}

/** Forget the session: delete the saved cookies and the browser profile. */
export async function logout() {
  await fs.rm(SESSION_FILE, { force: true });
  await fs.rm(PROFILE_DIR, { recursive: true, force: true });
}
