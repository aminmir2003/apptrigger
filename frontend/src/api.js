// The frontend is a separate service from the API. VITE_API_URL says where the API is.
// Leave it empty when the page and the API share an address (for example the Vite dev proxy).
export const API_URL = String(import.meta.env.VITE_API_URL ?? '')
  .trim()
  .replace(/\/+$/, '');

let redirecting = false;

/**
 * fetch() against the API. Sends the sign-in cookie, and if the API answers "not signed in" (401)
 * it sends the browser to the API's sign-in page, which brings the person back here afterwards.
 */
export async function apiFetch(path, init = {}) {
  const res = await fetch(API_URL + path, { credentials: API_URL ? 'include' : 'same-origin', ...init });
  if (res.status === 401 && !redirecting) {
    redirecting = true;
    const back = API_URL ? window.location.href : window.location.pathname + window.location.search;
    window.location.assign(`${API_URL}/auth/login?returnTo=${encodeURIComponent(back)}`);
  }
  return res;
}
