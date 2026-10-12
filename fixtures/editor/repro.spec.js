import { readFile, writeFile } from 'node:fs/promises';
import { test, expect } from './preview-auth.js';

const scenario = JSON.parse(await readFile(new URL('./scenario.json', import.meta.url), 'utf8'));
const seed = Number(process.env.RODEO_SEED || '12345');
if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Invalid RODEO_SEED');
const original = [
  { id: 'heading', text: 'Friday demo' },
  { id: 'paragraph', text: 'Bring something that almost works.' },
  { id: 'button', text: 'Join the waitlist' },
];
let observations;
let runtimeErrors;

const caseTitle = id => {
  const definition = scenario.tests.find(item => item.id === id);
  return `${definition.id}: ${definition.title}`;
};

async function readDocument(page) {
  return page.getByTestId('block').evaluateAll(rows => rows.map(row => ({
    id: row.dataset.blockId,
    text: row.querySelector('input').value,
  })));
}

test.beforeEach(async ({ page }) => {
  observations = [];
  runtimeErrors = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('requestfailed', request => runtimeErrors.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on('response', response => {
    if (response.status() >= 400) runtimeErrors.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  const response = await page.goto(scenario.route);
  expect(response.status(), 'The fixture must load successfully').toBe(200);
  await page.getByRole('button', { name: 'Reset demo', exact: true }).click();
  expect(await readDocument(page)).toEqual(original);
});

test.afterEach(async ({ page }, testInfo) => {
  const path = testInfo.outputPath('document-observations.json');
  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    caseId: testInfo.title.split(':')[0],
    seed,
    browserVersion: page.context().browser().version(),
    observations,
    runtimeErrors,
  }, null, 2));
  await testInfo.attach(scenario.verifier.attachment, { path, contentType: 'application/json' });
  expect(runtimeErrors, 'The fixture must run without browser or HTTP errors').toEqual([]);
});

async function saveAndReload(page, expected, reload = 'refresh') {
  const beforeSave = await readDocument(page);
  expect(beforeSave).toEqual(expected);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  const afterSave = await readDocument(page);
  expect(afterSave).toEqual(expected);
  if (reload === 'refresh') {
    const response = await page.reload();
    expect(response.status()).toBe(200);
  } else {
    await page.getByRole('button', { name: 'Reload saved', exact: true }).click();
  }
  await expect(page.getByRole('status')).toHaveText('Loaded saved draft');
  const actual = await readDocument(page);
  observations.push({ expected, beforeSave, afterSave, actual, reload });
  // Keep this a real failing assertion. The independent verifier examines the
  // recorded documents AND this failure, never just the subprocess exit code.
  expect(actual, scenario.verifier.assertion).toEqual(expected);
}

for (const [id, reload] of [['button-refresh', 'refresh'], ['button-reload', 'control']]) {
  test(caseTitle(id), async ({ page }) => {
    await page.getByRole('button', { name: 'Move Join the waitlist up', exact: true }).click();
    await page.getByRole('button', { name: 'Move Join the waitlist up', exact: true }).click();
    await saveAndReload(page, [original[2], original[0], original[1]], reload);
  });
}

test(caseTitle('original-order'), async ({ page }) => {
  await saveAndReload(page, original);
});

test(caseTitle('edited-text'), async ({ page }) => {
  const edited = [
    { id: 'heading', text: '' },
    { id: 'paragraph', text: 'A longer note with <markup>, & punctuation, and a changed plan.' },
    { id: 'button', text: 'Remind me next Friday' },
  ];
  for (const block of edited) await page.locator(`#block-${block.id}`).fill(block.text);
  for (let cycle = 0; cycle < 3; cycle += 1) await saveAndReload(page, edited);
});

test(caseTitle('reset-isolation'), async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('repo-rodeo-unrelated-check', 'keep me'));
  await page.getByLabel('Heading text', { exact: true }).fill('Changed heading');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Reset demo', exact: true }).click();
  await page.reload();
  expect(await readDocument(page)).toEqual(original);
  expect(await page.evaluate(() => localStorage.getItem('repo-rodeo-unrelated-check'))).toBe('keep me');
});

test(caseTitle('holdout'), async ({ page }) => {
  let state = seed;
  const random = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let sample = 0; sample < scenario.holdout.documents; sample += 1) {
    await page.getByRole('button', { name: 'Reset demo', exact: true }).click();
    const order = original.map(block => ({ ...block }));
    for (let index = order.length - 1; index > 0; index -= 1) {
      const target = Math.floor(random() * (index + 1));
      [order[index], order[target]] = [order[target], order[index]];
    }
    for (let index = 0; index < order.length; index += 1) {
      const block = order[index];
      block.text = index === sample % 3 ? '' : `${seed}/${sample}/${Math.floor(random() * 0xffffffff).toString(16)} — 雨 <&> " ' ${'long '.repeat(Math.floor(random() * 24))}`;
      await page.locator(`#block-${block.id}`).fill(block.text);
      let position = (await readDocument(page)).findIndex(item => item.id === block.id);
      while (position > index) {
        await page.locator(`[data-block-id="${block.id}"]`).getByRole('button', { name: / up$/ }).click();
        position -= 1;
      }
    }
    for (let cycle = 0; cycle < scenario.holdout.reloadsPerDocument; cycle += 1) {
      await saveAndReload(page, order, cycle % 2 ? 'control' : 'refresh');
    }
  }
});
