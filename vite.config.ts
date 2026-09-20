import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Frontend budowany do dist/ i publikowany na Cloudflare Workers (wrangler deploy).
// Backend działa osobno (Bun + Docker, port 2363, domena yeapi.wpme.pl) — patrz server/.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 5174 — README i playwright.config.ts zakładają ten port
  server: { port: 5174 },
  build: { outDir: 'dist' },
});
