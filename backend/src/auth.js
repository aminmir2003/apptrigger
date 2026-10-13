// TELUS SSO via OpenID Connect (authorization code flow + PKCE).
// Everything except /health requires a signed-in session. Configure with the OIDC_* values in .env.

import session from 'express-session';
import * as client from 'openid-client';
import { frontendBase, frontendOrigins } from './cors.js';

const REQUIRED = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI', 'SESSION_SECRET'];

// Where to send the person after sign-in. Only the frontend may be the target: a path on it, or a full
// address whose origin is one of FRONTEND_ORIGIN. Anything else goes to the frontend's home page.
export function safeReturnTo(value) {
  const base = frontendBase();
  const home = base || '/';
  if (typeof value !== 'string') return home;
  if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/auth/')) return base + value;
  try {
    const url = new URL(value);
    if (frontendOrigins().includes(url.origin)) return url.href;
  } catch {
    // not a URL: fall through
  }
  return home;
}

export async function setupAuth(app) {
  if (process.env.AUTH_DISABLED === 'true') {
    console.warn('AUTH_DISABLED=true: SSO is OFF, anyone who can reach this server can use it');
    return;
  }

  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`SSO is not configured, missing in .env: ${missing.join(', ')} (or set AUTH_DISABLED=true for local development)`);
  }

  const redirectUri = new URL(process.env.OIDC_REDIRECT_URI);
  const secure = redirectUri.protocol === 'https:';
  // The sign-in cookie must be sent on calls from the frontend. Same site (for example app.x.com and api.x.com):
  // 'lax' works. Different sites need SESSION_SAMESITE=none, which browsers only accept over https.
  const sameSite = (process.env.SESSION_SAMESITE || 'lax').toLowerCase();
  if (!['lax', 'strict', 'none'].includes(sameSite)) throw new Error('SESSION_SAMESITE must be lax, strict or none');
  if (sameSite === 'none' && !secure) throw new Error('SESSION_SAMESITE=none needs https: set OIDC_REDIRECT_URI to an https address');
  const scope = process.env.OIDC_SCOPE || 'openid profile email';

  // Discovery goes through HTTPS_PROXY when the server is started with --use-env-proxy.
  const config = await client.discovery(new URL(process.env.OIDC_ISSUER), process.env.OIDC_CLIENT_ID, process.env.OIDC_CLIENT_SECRET);

  if (secure) app.set('trust proxy', 1);
  // In-memory sessions: fine for a single instance, but everyone is signed out on restart.
  app.use(
    session({
      name: 'logsearch.sid',
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite, secure, maxAge: 8 * 3600 * 1000 },
    }),
  );

  app.get('/auth/login', async (req, res, next) => {
    try {
      const codeVerifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const nonce = client.randomNonce();
      req.session.oidc = { codeVerifier, state, nonce, returnTo: safeReturnTo(req.query.returnTo) };
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri.href,
        scope,
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        state,
        nonce,
      });
      res.redirect(url.href);
    } catch (err) {
      next(err);
    }
  });

  app.get('/auth/callback', async (req, res) => {
    const pending = req.session.oidc;
    if (!pending) return res.redirect('/auth/login');
    try {
      const currentUrl = new URL(req.originalUrl, redirectUri.origin);
      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: pending.codeVerifier,
        expectedState: pending.state,
        expectedNonce: pending.nonce,
      });
      const claims = tokens.claims();
      const user = {
        sub: claims.sub,
        name: claims.name || claims.preferred_username || claims.email || claims.sub,
        email: claims.email,
        idToken: tokens.id_token,
      };
      // New session id after login to prevent session fixation.
      req.session.regenerate((err) => {
        if (err) return res.status(500).send('Sign-in failed');
        req.session.user = user;
        req.session.save(() => res.redirect(pending.returnTo));
      });
    } catch (err) {
      console.error('SSO callback failed:', err);
      res.status(401).send('Sign-in failed. <a href="/auth/login">Try again</a>');
    }
  });

  app.get('/auth/me', (req, res) => {
    const u = req.session?.user;
    if (!u) return res.status(401).json({ error: 'Not signed in' });
    res.json({ name: u.name, email: u.email });
  });

  app.get('/auth/logout', (req, res) => {
    const idToken = req.session?.user?.idToken;
    req.session.destroy(() => {
      res.clearCookie('logsearch.sid');
      // Also end the session at the identity provider when it supports that.
      if (config.serverMetadata().end_session_endpoint) {
        const url = client.buildEndSessionUrl(config, {
          post_logout_redirect_uri: frontendBase() || redirectUri.origin,
          ...(idToken ? { id_token_hint: idToken } : {}),
        });
        return res.redirect(url.href);
      }
      res.redirect(frontendBase() || '/auth/login');
    });
  });

  // Gate: everything below this requires a signed-in user. This service only serves an API, so callers get a
  // 401 they can handle; the frontend sends the browser to /auth/login when it sees one.
  app.use((req, res, next) => {
    if (req.session?.user) return next();
    return res.status(401).json({ error: 'Not signed in' });
  });
}
