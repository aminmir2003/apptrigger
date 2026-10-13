import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy API calls to the log service so the browser avoids CORS.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/logs': 'http://localhost:3000', '/info': 'http://localhost:3000', '/config': 'http://localhost:3000', '/analyze': 'http://localhost:3000', '/auth': 'http://localhost:3000', '/portal': 'http://localhost:3000' } },
});
