import { expect, test, type Page } from '@playwright/test';

import {
  expectHealthyLayout,
  expectNoRuntimeFailures,
  monitorRuntimeFailures,
} from './support/ui-assertions';

async function mockBrowserMutations(page: Page): Promise<void> {
  await page.route('**/api/cases/**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: 2, caseVersion: 2 }),
    });
  });
}

async function openReviewCase(page: Page): Promise<void> {
  await page.goto('/');
  const preferredCase = page.getByRole('link', { name: /MediSupply GmbH/ }).first();
  const caseLink = (await preferredCase.count())
    ? preferredCase
    : page.getByRole('link', { name: 'Review', exact: true }).first();

  await expect(caseLink).toBeVisible();
  await caseLink.click();
  await expect(page).toHaveURL(/\/cases\//);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Request information' })).toBeVisible();
}

async function selectWorkspaceTabIfVisible(page: Page, name: string): Promise<void> {
  const tab = page.getByRole('tab', { name, exact: true });
  if (await tab.isVisible()) await tab.click();
}

test.describe('case review workspace', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrowserMutations(page);
  });

  test('navigates the dossier, verifies source files, zooms, and uploads', async ({ page }) => {
    const failures = monitorRuntimeFailures(page);
    await openReviewCase(page);

    const workspaceTabs = page.getByRole('tablist', { name: 'Case workspace views' });
    if (await workspaceTabs.isVisible()) {
      for (const name of ['Dossier', 'Document', 'Review'] as const) {
        const tab = page.getByRole('tab', { name, exact: true });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
      }
      await page.getByRole('tab', { name: 'Document', exact: true }).click();
    } else {
      await expect(page.getByRole('navigation', { name: 'Case dossier' })).toBeVisible();
      await expect(page.getByRole('article')).toBeVisible();
      await expect(page.getByRole('complementary', { name: 'Case review' })).toBeVisible();
    }

    const zoom = page.locator('output');
    await expect(zoom).toHaveText('92%');
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(zoom).toHaveText('102%');
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await expect(zoom).toHaveText('92%');

    const pdfLink = page.getByRole('link', { name: 'Open verified PDF' });
    await expect(pdfLink).toBeVisible();
    const pdfHref = await pdfLink.getAttribute('href');
    expect(pdfHref).toBeTruthy();
    const pdfResponse = await page.request.get(new URL(pdfHref!, page.url()).toString());
    expect(pdfResponse.ok()).toBe(true);
    expect(pdfResponse.headers()['content-type']).toContain('application/pdf');

    await selectWorkspaceTabIfVisible(page, 'Dossier');
    const dossier = page.getByRole('navigation', { name: 'Case dossier' });
    await expect(dossier).toBeVisible();
    expect(await dossier.locator('.document-link').count()).toBeGreaterThanOrEqual(7);

    await dossier.getByRole('link', { name: /Supplier questionnaire/ }).click();
    await expect(page).toHaveURL(/document=questionnaire/);
    await selectWorkspaceTabIfVisible(page, 'Dossier');
    await page
      .getByRole('navigation', { name: 'Case dossier' })
      .getByRole('link', { name: /GDP certificate/ })
      .click();
    await expect(page).toHaveURL(/document=gdp/);
    await selectWorkspaceTabIfVisible(page, 'Document');
    await expect(
      page.getByRole('heading', { name: 'GDP certificate was not supplied' }),
    ).toBeVisible();

    await selectWorkspaceTabIfVisible(page, 'Dossier');
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Add document' }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: 'playwright-evidence.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('CaseLens Playwright upload fixture'),
    });
    await expect(page.locator('.upload-message')).toContainText('accepted and queued for review');

    await expectHealthyLayout(page);
    expectNoRuntimeFailures(failures);
  });

  test('exercises findings, guarded decisions, and export', async ({ page }) => {
    const failures = monitorRuntimeFailures(page);
    await openReviewCase(page);
    await selectWorkspaceTabIfVisible(page, 'Review');

    const review = page.getByRole('complementary', { name: 'Case review' });
    await expect(review).toBeVisible();
    await expect(review.getByRole('heading', { name: 'Material findings' })).toBeVisible();

    const requestInformation = review.getByRole('button', { name: 'Request information' });
    const recordDecision = review.getByRole('button', { name: 'Record decision' });
    const exportButton = review.getByRole('button', { name: 'Export' });
    await expect(requestInformation).toBeEnabled();
    await expect(recordDecision).toBeDisabled();
    await expect(exportButton).toBeEnabled();

    await requestInformation.click();
    await expect(review.getByRole('status')).toHaveText('Information request recorded.');

    const acceptFollowUp = review.getByRole('button', { name: 'Accept follow-up' }).first();
    await expect(acceptFollowUp).toBeVisible();
    await acceptFollowUp.click();
    await expect(review.getByText('accepted', { exact: true }).first()).toBeVisible();

    const markResolved = review.getByRole('button', { name: 'Mark resolved' });
    while ((await markResolved.count()) > 0) {
      await markResolved.first().click();
    }
    await expect(recordDecision).toBeEnabled();
    await recordDecision.click();
    await expect(review.getByRole('status')).toHaveText(
      'Decision recorded: approved with reviewer override.',
    );

    const downloadPromise = page.waitForEvent('download');
    await exportButton.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^SUP-.*-audit-export\.json$/);
    const stream = await download.createReadStream();
    let bytes = 0;
    for await (const chunk of stream) bytes += chunk.length;
    expect(bytes).toBeGreaterThan(100);
    await expect(review.getByRole('status')).toHaveText('Audit package exported as JSON.');

    await expectHealthyLayout(page);
    expectNoRuntimeFailures(failures);
  });

  test('switches review sections and completes or cancels corrections', async ({ page }) => {
    const failures = monitorRuntimeFailures(page);
    await openReviewCase(page);
    await selectWorkspaceTabIfVisible(page, 'Review');

    const review = page.getByRole('complementary', { name: 'Case review' });
    const factsTab = review.getByRole('tab', { name: /^Facts/ });
    await factsTab.click();
    await expect(factsTab).toHaveAttribute('aria-selected', 'true');
    await expect(review.getByRole('heading', { name: 'Material facts' })).toBeVisible();

    await review.getByRole('button', { name: 'Correct value' }).first().click();
    let dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save correction' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    await review.getByRole('button', { name: 'Correct value' }).first().click();
    dialog = page.getByRole('dialog');
    const valueInput = dialog.getByLabel('Corrected value');
    const reasonInput = dialog.getByLabel('Reason for correction');
    await valueInput.fill(`${await valueInput.inputValue()} · verified`);
    await reasonInput.fill('Verified against the original source document.');
    const saveCorrection = dialog.getByRole('button', { name: 'Save correction' });
    await expect(saveCorrection).toBeEnabled();
    await saveCorrection.click();
    await expect(dialog).toBeHidden();
    await expect(review.getByRole('status')).toHaveText('Correction saved with its review reason.');

    const auditTab = review.getByRole('tab', { name: 'Audit', exact: true });
    await auditTab.click();
    await expect(auditTab).toHaveAttribute('aria-selected', 'true');
    await expect(review.getByRole('heading', { name: 'Audit trail' })).toBeVisible();

    await expectHealthyLayout(page);
    expectNoRuntimeFailures(failures);
  });
});
