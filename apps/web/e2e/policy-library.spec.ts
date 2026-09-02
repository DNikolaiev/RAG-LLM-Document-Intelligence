import { expect, test } from '@playwright/test';

import {
  expectHealthyLayout,
  expectNoRuntimeFailures,
  monitorRuntimeFailures,
} from './support/ui-assertions';

test('policy library explains what conditions can become governed rules', async ({ page }) => {
  const failures = monitorRuntimeFailures(page);
  const response = await page.goto('/policies');

  expect(response?.ok()).toBe(true);
  await expect(page.getByRole('heading', { name: 'What can become a rule' })).toBeVisible();
  await expect(
    page.getByText('Exact PDF citation + four deterministic checks are required before approval.'),
  ).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Supported policy condition categories' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What a policy may become' })).toBeVisible();
  await expect(page.getByText('Evidence gates', { exact: true })).toBeVisible();
  await expect(page.getByText('Fact vocabulary', { exact: true })).toBeVisible();
  await expect(page.getByText('Installed controls', { exact: true })).toBeVisible();
  await expect(page.getByText('Policy collections', { exact: true })).toBeVisible();
  const domainPack = page.getByTestId('domain-pack-configuration');
  await expect(domainPack.getByText(/Pharmaceutical supplier qualification/)).toBeVisible();
  const factVocabulary = domainPack.locator('.domain-fact-vocabulary');
  await expect(factVocabulary).not.toHaveAttribute('open', '');
  await factVocabulary.locator('summary').click();
  await expect(factVocabulary).toHaveAttribute('open', '');
  await expect(factVocabulary.getByText('Supplier questionnaire', { exact: true })).toBeVisible();
  await domainPack.getByRole('button', { name: 'View installed controls' }).click();
  const controlsDialog = page.getByRole('dialog', { name: 'Installed controls' });
  await expect(controlsDialog).toBeVisible();
  await expect(
    controlsDialog.getByText('Liability coverage below policy', { exact: true }),
  ).toBeVisible();
  await controlsDialog.getByRole('button', { name: 'Close collection rules' }).click();
  await expect(
    domainPack.getByRole('button', { name: /Insurance Requirements.*\d+ policy rules/ }),
  ).toBeVisible();
  await domainPack
    .getByRole('button', { name: /Insurance Requirements.*\d+ policy rules/ })
    .click();
  const ruleDialog = page.getByRole('dialog', {
    name: 'Rules discovered from Insurance Requirements',
  });
  await expect(ruleDialog).toBeVisible();
  await ruleDialog.getByRole('button', { name: 'Close collection rules' }).click();
  await expect(ruleDialog).not.toBeVisible();
  await expect(page.getByText('Time & limits', { exact: true })).toBeVisible();
  await expect(page.getByText('Combinations', { exact: true })).toBeVisible();
  await expectHealthyLayout(page);
  expectNoRuntimeFailures(failures);
});
