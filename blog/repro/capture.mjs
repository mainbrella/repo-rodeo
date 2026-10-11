import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const assets = new URL('../assets/', import.meta.url);
await mkdir(assets, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 520, height: 740 }, deviceScaleFactor: 2 });
  await page.goto(new URL('/repo-rodeo-bug', process.env.REPRO_BASE_URL || 'http://127.0.0.1:4175').href);
  await page.getByRole('button', { name: 'Reset demo', exact: true }).click();
  await page.getByRole('button', { name: 'Move Join the waitlist up', exact: true }).click();
  await page.getByRole('button', { name: 'Move Join the waitlist up', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await expect(page.getByTestId('block')).toHaveCount(3);
  await page.screenshot({ path: fileURLToPath(new URL('before-reload.png', assets)), fullPage: true });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Loaded saved draft');
  await page.screenshot({ path: fileURLToPath(new URL('after-reload.png', assets)), fullPage: true });
  console.log(`Captured ${await page.getByTestId('block').count()} blocks after reload.`);
} finally {
  await browser.close();
}
