import { expect, test } from '@playwright/test';

import {
  expectHealthyLayout,
  expectNoRuntimeFailures,
  monitorRuntimeFailures,
} from './support/ui-assertions';

test.describe('case queue', () => {
  test('renders its required content and navigates to a case', async ({ page }) => {
    const failures = monitorRuntimeFailures(page);
    const response = await page.goto('/');

    expect(response?.ok()).toBe(true);
    await expect(page.getByRole('heading', { name: 'Cases that need a human eye' })).toBeVisible();
    await expect(page.locator('[aria-label="Case totals"]')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Case queue' })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'Find a subject or case' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Status' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Filter cases' })).toBeEnabled();
    await expect(page.getByRole('table')).toBeVisible();
    expect(await page.locator('tbody tr').count()).toBeGreaterThan(0);
    await expectHealthyLayout(page);

    const reviewLink = page.getByRole('link', { name: 'Review', exact: true }).first();
    await expect(reviewLink).toBeVisible();
    await reviewLink.click();

    await expect(page).toHaveURL(/\/cases\//);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Request information' })).toBeVisible();
    await expectHealthyLayout(page);
    expectNoRuntimeFailures(failures);
  });

  test('filters by status and clears through navigation', async ({ page }) => {
    const failures = monitorRuntimeFailures(page);
    await page.goto('/');

    await page.getByRole('combobox', { name: 'Status' }).selectOption('processing');
    await page.getByRole('button', { name: 'Filter cases' }).click();

    await expect(page).toHaveURL(/status=processing/);
    await expect(page.getByRole('combobox', { name: 'Status' })).toHaveValue('processing');
    await expect(page.getByText('Processing', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Clear filters' })).toBeVisible();
    await expectHealthyLayout(page);

    await page.getByRole('link', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('combobox', { name: 'Status' })).toHaveValue('all');
    expectNoRuntimeFailures(failures);
  });

  test('shows a usable empty state for unmatched searches', async ({ page }) => {
    const failures = monitorRuntimeFailures(page);
    await page.goto('/');

    await page
      .getByRole('searchbox', { name: 'Find a subject or case' })
      .fill('supplier-that-does-not-exist');
    await page.getByRole('button', { name: 'Filter cases' }).click();

    await expect(page).toHaveURL(/query=supplier-that-does-not-exist/);
    await expect(page.getByRole('heading', { name: 'No cases match these filters' })).toBeVisible();
    const showEveryCase = page.getByRole('link', { name: 'Show every case' });
    await expect(showEveryCase).toBeVisible();
    await expectHealthyLayout(page);

    await showEveryCase.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('tbody tr').first()).toBeVisible();
    expectNoRuntimeFailures(failures);
  });

  test('switches the trusted local profile and workspace context', async ({ page }) => {
    const failures = monitorRuntimeFailures(page);
    await page.goto('/');

    await page.getByLabel(/Switch profile\. Signed in as/).click();
    const platformAdministrator = page.getByRole('button', { name: /Mara Stein/ });
    await expect(platformAdministrator).toBeVisible();
    await platformAdministrator.click();

    await expect(page.getByLabel('Current workspace')).toContainText('All tenant workspaces');
    await expect(page.getByLabel(/Switch profile\. Signed in as Mara Stein/)).toBeVisible();
    await expectHealthyLayout(page);
    expectNoRuntimeFailures(failures);
  });
});
