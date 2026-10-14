// The frontend is a separate service from the API. VITE_API_URL says where the API is.
// Leave it empty when the page and the API share an address (for example the Vite dev proxy).
export const API_URL = String(import.meta.env.VITE_API_URL ?? '')
  .trim()
  .replace(/\/+$/, '');

/** fetch() against the API. */
export const apiFetch = (path, init) => fetch(API_URL + path, init);
