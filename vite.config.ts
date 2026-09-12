import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Frontend budowany do dist/ i publikowany na Cloudflare Workers (wrangler deploy).
// Backend działa osobno (Bun + Docker, port 2363, domena yeapi.wpme.pl) — patrz server/.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist' },
});
