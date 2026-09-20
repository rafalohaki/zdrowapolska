import { defineConfig } from '@playwright/test';

// playwright szuka własnego chroma w ~/.cache/ms-playwright; na serwerze gdzie
// binarka ma niestandardową ścieżkę, nadpisz przez PLAYWRIGHT_CHROME_PATH
const CHROME = process.env.PLAYWRIGHT_CHROME_PATH;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5179',
    launchOptions: CHROME ? { executablePath: CHROME } : {},
  },
  webServer: {
    command: 'bunx vite preview --port 5179 --strictPort',
    port: 5179,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
