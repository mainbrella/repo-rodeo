import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './repro',
  testMatch: '*.spec.js',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20_000,
  expect: { timeout: 3_000 },
  reporter: 'list',
  use: {
    baseURL: process.env.REPRO_BASE_URL || 'http://127.0.0.1:4175',
    browserName: 'chromium',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
