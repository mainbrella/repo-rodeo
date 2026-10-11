import { test, expect } from '@playwright/test';

const original = [
  { id: 'heading', text: 'Friday demo' },
  { id: 'paragraph', text: 'Bring something that almost works.' },
  { id: 'button', text: 'Join the waitlist' },
];

async function readDocument(page) {
  return page.getByTestId('block').evaluateAll(rows => rows.map(row => ({
    id: row.dataset.blockId,
    text: row.querySelector('input').value,
  })));
}

async function expectDocument(page, expected) {
  await expect.poll(() => readDocument(page), {
    message: 'Saving and reloading must preserve every block, its text, and its order',
  }).toEqual(expected);
}

test.beforeEach(async ({ page }) => {
  // Playwright supplies a new browser context per test. Reset only this fixture.
  await page.goto('/repo-rodeo-bug');
  await page.getByRole('button', { name: 'Reset demo', exact: true }).click();
  await expectDocument(page, original);
});

for (const reload of ['browser refresh', 'Reload saved']) {
  test(`moving the button first preserves the document after ${reload}`, async ({ page }) => {
    await page.getByRole('button', { name: 'Move Join the waitlist up', exact: true }).click();
    await page.getByRole('button', { name: 'Move Join the waitlist up', exact: true }).click();
    const reordered = [original[2], original[0], original[1]];
    await expectDocument(page, reordered);

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Saved');
    await expectDocument(page, reordered);

    if (reload === 'browser refresh') await page.reload();
    else await page.getByRole('button', { name: 'Reload saved', exact: true }).click();

    // This fails on the seeded bug. Do not replace it with an assertion of loss.
    await expectDocument(page, reordered);
  });
}

test('saving without reordering preserves the heading', async ({ page }) => {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await expectDocument(page, original);
});

test('edited text and empty text survive repeated saves', async ({ page }) => {
  await page.getByLabel('Heading text', { exact: true }).fill('');
  await page.getByLabel('Paragraph text', { exact: true }).fill('A longer note with <markup>, & punctuation, and a changed plan.');
  await page.getByLabel('Button text', { exact: true }).fill('Remind me next Friday');
  const edited = await readDocument(page);
  for (let save = 0; save < 3; save += 1) {
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.reload();
    await expectDocument(page, edited);
  }
});

test('reset restores the demo without clearing unrelated browser data', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('repo-rodeo-unrelated-check', 'keep me'));
  await page.getByLabel('Heading text', { exact: true }).fill('Changed heading');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Reset demo', exact: true }).click();
  await page.reload();
  await expectDocument(page, original);
  expect(await page.evaluate(() => localStorage.getItem('repo-rodeo-unrelated-check'))).toBe('keep me');
});
