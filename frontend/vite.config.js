import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// When VITE_API_URL is empty the page and the API share an address, so API calls are forwarded to the
// backend (default http://localhost:3000). When VITE_API_URL is set the page calls that address directly.
const api = process.env.API_PROXY_TARGET || 'http://localhost:3000';
const proxy = Object.fromEntries(['/logs', '/analyze', '/config', '/info', '/auth', '/portal'].map((p) => [p, api]));

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
});
