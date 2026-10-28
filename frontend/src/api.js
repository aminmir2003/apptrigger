// The frontend is a separate service from the API. VITE_API_URL says where the API is.
// Leave it empty when the page and the API share an address (for example the Vite dev proxy).
export const API_URL = String(import.meta.env.VITE_API_URL ?? '')
  .trim()
  .replace(/\/+$/, '');

/**
 * fetch() against the API. With timeoutMs, a call that has not finished by then is stopped and fails with a
 * TimeoutError, so the page never waits for ever on a stuck server.
 */
export const apiFetch = (path, init = {}, timeoutMs = 0) =>
  fetch(API_URL + path, timeoutMs ? { ...init, signal: AbortSignal.timeout(timeoutMs) } : init);

/** A short, plain message for a failed call (the page shows it as is). */
export const apiError = (err, what) =>
  err?.name === 'TimeoutError'
    ? `${what} is taking too long, so I stopped waiting. Check the terminal the backend runs in to see what it is doing.`
    : err?.message || `${what} failed`;
