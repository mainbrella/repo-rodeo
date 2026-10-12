import { defineConfig } from '@playwright/test';

const baseURL = process.env.REPRO_BASE_URL || 'http://127.0.0.1:4175';

export default defineConfig({
  testDir: './fixtures/editor',
  testMatch: 'repro.spec.js',
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 20_000,
  expect: { timeout: 3_000 },
  outputDir: process.env.RODEO_TEST_OUTPUT || 'test-results',
  reporter: process.env.RODEO_JSON_REPORT
    ? [['list'], ['json', { outputFile: process.env.RODEO_JSON_REPORT }]]
    : 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    viewport: { width: 1280, height: 800 },
    trace: 'on',
    screenshot: 'on',
  },
  webServer: process.env.REPRO_BASE_URL ? undefined : {
    command: 'node fixtures/editor/app/server.mjs',
    url: `${baseURL}/repo-rodeo-bug`,
    reuseExistingServer: false,
    timeout: 10_000,
  },
});
