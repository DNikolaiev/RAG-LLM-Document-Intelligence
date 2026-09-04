import { expect, test, type Route } from '@playwright/test';

import {
  expectHealthyLayout,
  expectNoRuntimeFailures,
  monitorRuntimeFailures,
} from './support/ui-assertions';

function pdf(name: string) {
  return { name, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4 ${name} fixture`) };
}

const intakeUrl = (url: URL) => url.pathname === '/api/cases/intake';

async function switchToPlatformAdministrator(page: import('@playwright/test').Page) {
  const response = await page.request.post('/api/session/profile', {
    data: { profileId: 'profile_mara_stein' },
  });
  expect(response.ok()).toBe(true);
}

test('a single-workspace profile files into its own tenant without a workspace dropdown', async ({
  page,
}) => {
  const failures = monitorRuntimeFailures(page);
  let intakeRequests = 0;
  await page.route(
    (url) => intakeUrl(url),
    async (route: Route) => {
      intakeRequests += 1;
      const body = JSON.stringify({
        caseId: 'case_01J67X4Q7B5E6QG4S9CY0F7R2K',
        reference: 'SUP-2026-0142',
        documentIds: ['doc_new_1'],
        jobIds: ['job_new_1'],
      });
      await route.fulfill({ status: 201, contentType: 'application/json', body });
    },
  );

  const response = await page.goto('/cases/new');
  expect(response?.ok()).toBe(true);
  await expect(page.getByRole('heading', { name: 'Start a new case' })).toBeVisible();

  const identity = page.getByTestId('intake-workspace');
  await expect(identity).toContainText('Düsseldorf Health Operations');
  await expect(identity.getByRole('combobox')).toHaveCount(0);

  await page.getByLabel('Subject name').fill('Meridian Pharma GmbH');
  await page
    .getByLabel('Documents')
    .setInputFiles([pdf('insurance-certificate.pdf'), pdf('supplier-questionnaire.pdf')]);

  const fileList = page.getByRole('list', { name: 'Selected documents' });
  await expect(fileList.getByText('insurance-certificate.pdf')).toBeVisible();
  await expect(fileList.getByText('supplier-questionnaire.pdf')).toBeVisible();

  await fileList.getByRole('button', { name: 'Remove insurance-certificate.pdf' }).click();
  await expect(fileList.getByText('insurance-certificate.pdf')).toHaveCount(0);
  await expect(fileList.getByText('supplier-questionnaire.pdf')).toBeVisible();

  await expectHealthyLayout(page);

  await page.getByRole('button', { name: 'Create case' }).click();

  await expect(page).toHaveURL(/\/cases\/case_01J67X4Q7B5E6QG4S9CY0F7R2K$/);
  await expect(page.getByRole('heading', { level: 1, name: 'MediSupply GmbH' })).toBeVisible();
  expect(intakeRequests).toBe(1);
  await expectHealthyLayout(page);
  expectNoRuntimeFailures(failures);
});

test('submitting with no files or a blank subject shows an inline error and sends nothing', async ({
  page,
}) => {
  const failures = monitorRuntimeFailures(page);
  let intakeRequests = 0;
  await page.route(
    (url) => intakeUrl(url),
    async (route: Route) => {
      intakeRequests += 1;
      await route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
    },
  );

  const response = await page.goto('/cases/new');
  expect(response?.ok()).toBe(true);

  // Neither field is filled in: both inline errors appear together, and nothing is sent.
  await page.getByRole('button', { name: 'Create case' }).click();
  await expect(
    page.getByText('Attach at least one document before creating the case.'),
  ).toBeVisible();
  await expect(page.getByText('Name the subject before creating the case.')).toBeVisible();
  expect(intakeRequests).toBe(0);

  // Editing the subject clears only its own error.
  await page.getByLabel('Subject name').fill('Meridian Pharma GmbH');
  await expect(page.getByText('Name the subject before creating the case.')).toHaveCount(0);
  await expect(
    page.getByText('Attach at least one document before creating the case.'),
  ).toBeVisible();

  // Picking a file clears the remaining error, still with no request issued.
  await page.getByLabel('Documents').setInputFiles([pdf('insurance-certificate.pdf')]);
  await expect(
    page.getByText('Attach at least one document before creating the case.'),
  ).toHaveCount(0);
  expect(intakeRequests).toBe(0);

  await expectHealthyLayout(page);
  expectNoRuntimeFailures(failures);
});

test('a platform administrator must choose a workspace before the case can be created', async ({
  page,
}) => {
  const failures = monitorRuntimeFailures(page);
  await switchToPlatformAdministrator(page);
  let intakeRequests = 0;
  await page.route(
    (url) => intakeUrl(url),
    async (route: Route) => {
      intakeRequests += 1;
      const body = JSON.stringify({
        caseId: 'case_01J67Y7HFXCQ1D78Y09N8ZABPV',
        reference: 'SUP-2026-0141',
        documentIds: ['doc_new_2'],
        jobIds: ['job_new_2'],
      });
      await route.fulfill({ status: 201, contentType: 'application/json', body });
    },
  );

  const response = await page.goto('/cases/new');
  expect(response?.ok()).toBe(true);

  const identity = page.getByTestId('intake-workspace');
  const workspaceSelect = identity.getByRole('combobox', { name: /select which tenant/i });
  await expect(workspaceSelect).toBeVisible();
  await expect(workspaceSelect).toHaveValue('');
  await expect(workspaceSelect.locator('option')).toHaveText([
    'Select a workspace…',
    'Düsseldorf Health Operations',
    'Rheinland Legal Services',
    'Helios Claims Europe',
    'RuhrWorks Manufacturing',
  ]);

  await page.getByLabel('Subject name').fill('Nordkontor Distribution GmbH');
  await page.getByLabel('Documents').setInputFiles([pdf('contract.pdf')]);

  // No workspace chosen yet: the endpoint is never reached.
  await page.getByRole('button', { name: 'Create case' }).click();
  await expect(page.getByText('Choose the workspace this case belongs to.')).toBeVisible();
  expect(intakeRequests).toBe(0);

  await expectHealthyLayout(page);

  await workspaceSelect.selectOption('tenant_legal');
  await expect(page.getByText('Choose the workspace this case belongs to.')).toHaveCount(0);

  await page.getByRole('button', { name: 'Create case' }).click();
  await expect(page).toHaveURL(/\/cases\/case_01J67Y7HFXCQ1D78Y09N8ZABPV$/);
  expect(intakeRequests).toBe(1);
  // `toHaveURL` resolves the moment the URL changes, so the destination may still be rendering.
  // Measuring layout mid-transition reports overflow that is not there once the page settles.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectHealthyLayout(page);
  expectNoRuntimeFailures(failures);
});

test('a refused document keeps the selection and names the failing file', async ({ page }) => {
  const failures = monitorRuntimeFailures(page);
  let intakeRequests = 0;
  await page.route(
    (url) => intakeUrl(url),
    async (route: Route) => {
      intakeRequests += 1;
      await route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'https://caselens.dev/problems/422',
          title: 'Unprocessable Entity',
          status: 422,
          code: 'UNSUPPORTED_DOCUMENT',
          detail: 'supplier-questionnaire.pdf could not be read as a PDF.',
        }),
      });
    },
  );

  const response = await page.goto('/cases/new');
  expect(response?.ok()).toBe(true);

  await page.getByLabel('Subject name').fill('Meridian Pharma GmbH');
  await page
    .getByLabel('Documents')
    .setInputFiles([pdf('insurance-certificate.pdf'), pdf('supplier-questionnaire.pdf')]);
  await page.getByRole('button', { name: 'Create case' }).click();

  await expect(
    page.getByText('supplier-questionnaire.pdf could not be read as a PDF.'),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/cases\/new$/);
  await expect(page.getByLabel('Subject name')).toHaveValue('Meridian Pharma GmbH');
  const fileList = page.getByRole('list', { name: 'Selected documents' });
  await expect(fileList.getByText('insurance-certificate.pdf')).toBeVisible();
  await expect(fileList.getByText('supplier-questionnaire.pdf')).toBeVisible();
  expect(intakeRequests).toBe(1);

  await expectHealthyLayout(page);
  expectNoRuntimeFailures(failures);
});

test('the case queue links to intake', async ({ page }) => {
  const failures = monitorRuntimeFailures(page);
  const response = await page.goto('/');
  expect(response?.ok()).toBe(true);

  await page.getByRole('link', { name: 'New case' }).click();
  await expect(page).toHaveURL(/\/cases\/new$/);
  await expect(page.getByRole('heading', { name: 'Start a new case' })).toBeVisible();

  await expectHealthyLayout(page);
  expectNoRuntimeFailures(failures);
});
