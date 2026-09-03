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

/** The seeded dossier these assertions describe. Findings and decision state belong to this case. */
const REVIEW_CASE_REFERENCE = 'SUP-2026-0142';

/**
 * Opens the seeded review case through the queue's own search, so the target does not depend on
 * queue ordering or length. This used to prefer a supplier-name link and silently fall back to
 * "the first Review link" — on the durable local stack, which accumulates cases across runs, that
 * resolved to a leftover approved case with no findings, and the guarded-decision assertions below
 * then measured the wrong dossier. A missing fixture must fail loudly here instead.
 */
async function openReviewCase(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('searchbox', { name: 'Find a subject or case' }).fill(REVIEW_CASE_REFERENCE);
  await page.getByRole('button', { name: 'Filter cases' }).click();

  const caseLink = page.getByRole('link', { name: new RegExp(REVIEW_CASE_REFERENCE) }).first();
  await expect(
    caseLink,
    `The ${REVIEW_CASE_REFERENCE} dossier must be present for these assertions.`,
  ).toBeVisible();
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
      await expect(page.getByText('Original source')).toBeVisible();
      await expect(page.getByRole('complementary', { name: 'Case review' })).toBeVisible();
    }

    const zoom = page.getByRole('group', { name: 'Document zoom' }).locator('output');
    await expect(zoom).toHaveText('100%');
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(zoom).toHaveText('110%');
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await expect(zoom).toHaveText('100%');

    const pdfLink = page.getByRole('link', { name: 'Open original in a new tab' });
    await expect(pdfLink).toBeVisible();
    const pdfHref = await pdfLink.getAttribute('href');
    expect(pdfHref).toBeTruthy();
    const pdfResponse = await page.request.get(new URL(pdfHref!, page.url()).toString());
    expect(pdfResponse.ok()).toBe(true);
    expect(pdfResponse.headers()['content-type']).toContain('application/pdf');

    const documentScrollRegion = page.getByTestId('document-scroll-region');
    await expect(documentScrollRegion).toBeVisible();
    const documentCanScroll = await documentScrollRegion.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return {
        canScroll: element.scrollHeight > element.clientHeight,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      };
    });
    expect(
      documentCanScroll.canScroll,
      'The document canvas must keep its vertical scroll area.',
    ).toBe(true);
    expect(
      documentCanScroll.scrollTop,
      'The document canvas must scroll downward.',
    ).toBeGreaterThan(0);
    await documentScrollRegion.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect.poll(() => documentScrollRegion.evaluate((element) => element.scrollTop)).toBe(0);

    await selectWorkspaceTabIfVisible(page, 'Dossier');
    const dossier = page.getByRole('navigation', { name: 'Case dossier' });
    await expect(dossier).toBeVisible();
    expect(await dossier.locator('.document-link').count()).toBeGreaterThanOrEqual(7);
    const unclippedDocumentTitles = await dossier
      .locator('.document-label strong')
      .evaluateAll((titles) =>
        titles.flatMap((title) => {
          const style = getComputedStyle(title);
          return style.overflow === 'hidden' && style.textOverflow === 'ellipsis'
            ? []
            : [title.textContent ?? 'untitled document'];
        }),
      );
    expect(
      unclippedDocumentTitles,
      'Long dossier labels must truncate inside their document cards.',
    ).toEqual([]);

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
    const profileResponse = await page.request.post('/api/session/profile', {
      data: { profileId: 'profile_mara_stein' },
    });
    expect(profileResponse.ok()).toBe(true);
    await openReviewCase(page);
    await selectWorkspaceTabIfVisible(page, 'Review');

    const review = page.getByRole('complementary', { name: 'Case review' });
    await expect(review).toBeVisible();
    await expect(review.getByRole('heading', { name: 'Material findings' })).toBeVisible();

    const requestInformation = review.getByRole('button', { name: 'Request information' });
    const recordDecision = review.getByRole('button', { name: 'Record decision' });
    const exportButton = review.getByRole('button', { name: 'Export' });
    await expect(recordDecision).toBeDisabled();
    await expect(exportButton).toBeEnabled();

    const acceptFollowUp = review.getByRole('button', { name: 'Add to follow-up' }).first();
    if (await acceptFollowUp.isVisible()) await acceptFollowUp.click();
    await expect(review.getByText('Included in follow-up', { exact: true }).first()).toBeVisible();
    await expect(requestInformation).toBeEnabled();
    await expect(requestInformation.getByLabel(/\d+ selected/)).toBeVisible();
    await requestInformation.click();
    const followUpDialog = page.getByRole('dialog', { name: 'Review the information request' });
    await expect(followUpDialog).toBeVisible();
    await expect(followUpDialog.getByLabel(/Message covering \d+ follow-up points?/)).toContainText(
      'Requested action:',
    );
    await expect(followUpDialog.getByLabel(/Message covering \d+ follow-up points?/)).toContainText(
      'Kind regards,\nMara Stein',
    );
    await expect(
      followUpDialog.getByRole('button', { name: 'Record and open email' }),
    ).toBeEnabled();
    await followUpDialog.getByRole('button', { name: 'Close information request' }).click();
    await expect(followUpDialog).toBeHidden();

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
    await expect(review.getByRole('status')).toHaveText(
      /^(Audit package exported as JSON|Offline demo package exported as non-authoritative JSON)\.$/,
    );

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

    const openEvidence = review.getByRole('link', { name: 'Open in document' }).first();
    await openEvidence.click();
    await expect(page).toHaveURL(/[?&]document=[^&]+.*[?&]evidence=[^&]+.*[?&]page=\d+/);
    await expect(page.locator('.evidence-locator')).toBeVisible();
    await selectWorkspaceTabIfVisible(page, 'Review');

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
