import { defineConfig } from '@playwright/test';

const CHROME = '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5179',
    launchOptions: { executablePath: CHROME },
  },
  webServer: {
    command: 'bunx vite preview --port 5179 --strictPort',
    port: 5179,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
