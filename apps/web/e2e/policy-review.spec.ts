import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import {
  expectHealthyLayout,
  expectNoRuntimeFailures,
  monitorRuntimeFailures,
} from './support/ui-assertions';

const policyPdf = readFileSync(
  new URL(
    '../../../fixtures/documents/pharmacy-supplier/09_insurance_requirements_policy.pdf',
    import.meta.url,
  ),
);

const policy = {
  id: 'policy-test',
  title: 'Supplier insurance requirements',
  policyVersion: '2026.1',
  status: 'under_review',
  version: 3,
  originalName: 'insurance-requirements.pdf',
  pageCount: 1,
  extractionMetadata: {},
  proposals: [
    {
      id: 'proposal-blocked',
      title: 'Minimum product liability cover',
      description: 'Flag suppliers whose cover is below the required minimum.',
      severity: 'major',
      status: 'invalid',
      version: 1,
      condition: { operator: 'lte', path: 'facts.insurance.liabilityLimitEur', value: 1_999_999 },
      validationIssues: [
        {
          code: 'test_result_mismatch',
          path: 'tests.0.expected',
          message: 'Below-threshold match expected true but evaluated to false.',
        },
      ],
      citations: [
        {
          id: 'citation-one',
          page: 1,
          quote:
            'A critical product supplier must maintain product liability cover of at least EUR 2,000,000 per occurrence and in the annual aggregate.',
        },
      ],
      tests: [
        {
          id: 'test-match',
          kind: 'match',
          name: 'Below-threshold match',
          expected: true,
          actual: false,
          passed: false,
        },
        {
          id: 'test-no-match',
          kind: 'no_match',
          name: 'Compliant supplier',
          expected: false,
          actual: false,
          passed: true,
        },
      ],
    },
    {
      id: 'proposal-ready',
      title: 'Insurance evidence required',
      description: 'Flag cases without insurance evidence.',
      severity: 'critical',
      status: 'proposed',
      version: 1,
      condition: { operator: 'exists', path: 'facts.insurance.liabilityLimitEur', value: false },
      validationIssues: [],
      citations: [],
      tests: [],
    },
  ],
};

test('policy review explains blocked rules, highlights citations, and allows dismissal', async ({
  page,
}) => {
  const failures = monitorRuntimeFailures(page);
  let reviewBody: unknown;
  let dismissed = false;
  await page.route('**/api/policies/policy-test/content', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/pdf', body: policyPdf });
  });
  await page.route('**/api/policies/policy-test/proposals/proposal-blocked', async (route) => {
    reviewBody = route.request().postDataJSON();
    dismissed = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/policies/policy-test', async (route) => {
    const response = dismissed
      ? {
          ...policy,
          proposals: policy.proposals.map((proposal) =>
            proposal.id === 'proposal-blocked'
              ? {
                  ...proposal,
                  status: 'rejected',
                  reviewedByUserId: 'profile_mara_stein',
                  reviewReason: 'The generated condition does not match policy intent.',
                }
              : proposal,
          ),
        }
      : policy;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  });

  await page.goto('/policies/policy-test');
  await expect(page.getByRole('heading', { name: 'All generated rules' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Minimum product liability cover' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Insurance evidence required' })).toBeVisible();
  await expect(page.getByText('Why approval is blocked')).toBeVisible();
  await expect(
    page.getByText(/Failed — expected the rule to trigger; it did not trigger/),
  ).toBeVisible();
  await expect(
    page.getByText(/Passed — expected the rule to not trigger; it did not trigger/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve proposal' })).toBeVisible();

  await page.getByRole('button', { name: /Show highlighted clause · page 1/ }).click();
  await expect(page.locator('.evidence-locator')).toContainText('Minimum product liability cover');
  await expect(page.locator('.pdf-evidence-highlight').first()).toBeVisible();

  page.once('dialog', (dialog) =>
    dialog.accept('The generated condition does not match policy intent.'),
  );
  await page.getByRole('button', { name: 'Dismiss blocked rule' }).click();
  await expect(page.locator('.policy-message')).toHaveText('Proposal rejected.');
  expect(reviewBody).toMatchObject({ decision: 'reject', version: 1 });
  await expect(
    page.getByText('The generated condition does not match policy intent.'),
  ).toBeVisible();
  await expect(page.getByText('rejected', { exact: true }).first()).toBeVisible();

  await expectHealthyLayout(page);
  expectNoRuntimeFailures(failures);
});
