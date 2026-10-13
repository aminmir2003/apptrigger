// The frontend is a separate service, so it can be served from a different address than this API.
// Browsers only let it call the API (and send the sign-in cookie) if the API allows that address.
//
//   FRONTEND_ORIGIN   address(es) the page is served from, comma separated, e.g. https://apptrigger.example.com
//                     Leave empty when the page and the API share an address (for example the Vite dev proxy).
//   FRONTEND_URL      where to send people after sign-in / sign-out (default: the first FRONTEND_ORIGIN)

const clean = (s) => s.trim().replace(/\/+$/, '');

export const frontendOrigins = () =>
  (process.env.FRONTEND_ORIGIN || '')
    .split(',')
    .map(clean)
    .filter(Boolean);

/** Base address of the frontend, or '' when it shares the API's address. */
export const frontendBase = () => clean(process.env.FRONTEND_URL || frontendOrigins()[0] || '');

/** Allow the configured frontend address to call this API with cookies, including the preflight request. */
export function setupCors(app) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && frontendOrigins().includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.append('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');
        return res.sendStatus(204);
      }
    }
    return next();
  });
}
