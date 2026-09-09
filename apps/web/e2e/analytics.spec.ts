import { expect, test } from '@playwright/test';

import {
  expectHealthyLayout,
  expectNoRuntimeFailures,
  monitorRuntimeFailures,
} from './support/ui-assertions';

/**
 * The analytics read model is a separate service and is not part of the demo profile, so these
 * specs stub its responses. That is the honest boundary to test from a browser: what the console
 * does with what the service says, including when it says nothing at all.
 */
const throughput = {
  days: [
    {
      day: '2026-09-09',
      domainPackId: 'pack_pharma',
      created: 2,
      decided: 1,
      approved: 1,
      rejected: 0,
      informationRequested: 0,
    },
  ],
};
const rules = {
  rules: [
    {
      ruleKey: 'expired-certificate',
      severity: 'critical',
      timesRaised: 412,
      thenApproved: 400,
      thenRejected: 0,
      thenInformationRequested: 0,
      decided: 400,
    },
    {
      ruleKey: 'missing-insurance',
      severity: 'major',
      timesRaised: 30,
      thenApproved: 4,
      thenRejected: 26,
      thenInformationRequested: 0,
      decided: 30,
    },
  ],
};
const cycleTime = {
  decided: 4,
  medianSeconds: 145_800,
  p90Seconds: 259_200,
  approved: 3,
  rejected: 1,
  informationRequested: 0,
};

test.describe('decision analytics', () => {
  test('renders the projection it is given', async ({ page }) => {
    const failures = monitorRuntimeFailures(page);
    await page.route('**/api/analytics/throughput*', (route) =>
      route.fulfill({ json: throughput }),
    );
    await page.route('**/api/analytics/cycle-time*', (route) => route.fulfill({ json: cycleTime }));
    await page.route('**/api/analytics/rules*', (route) => route.fulfill({ json: rules }));
    await page.route('**/api/analytics/state*', (route) =>
      route.fulfill({ json: { lastProjectedSequence: 42 } }),
    );
    await page.route('**/api/events/state*', (route) =>
      route.fulfill({ json: { lastRecordedSequence: 45 } }),
    );

    await page.goto('/analytics');
    await expect(page.getByRole('heading', { name: 'Decision analytics' })).toBeVisible();
    // 145800s is 40.5 hours, which is what a reviewer should read rather than a raw second count.
    await expect(page.getByText('40.5 h')).toBeVisible();
    await expect(page.getByText('2026-09-09')).toBeVisible();

    // A rule raised 412 times whose every decided case was approved anyway is the finding worth
    // reading, so the table calls it out rather than leaving it to be spotted in a column of digits.
    const noisy = page.getByRole('row', { name: /expired-certificate/ });
    await expect(noisy).toBeVisible();
    await expect(noisy.locator('.analytics-flag')).toHaveText('400');
    await expect(
      page.getByRole('row', { name: /missing-insurance/ }).locator('.analytics-flag'),
    ).toHaveCount(0);

    // Lag is the gap between the two services, and neither can compute it alone.
    await expect(page.getByText('3 events behind')).toBeVisible();

    await expectHealthyLayout(page);
    expectNoRuntimeFailures(failures);
  });

  test('hides the lag from a reviewer who may not see cross-tenant counts', async ({ page }) => {
    // The two watermarks count every fact across every tenant, so a single-tenant reviewer reading
    // them would learn how much work everybody else is doing. A 403 is a reviewer looking at the
    // page, not an outage, so the rest of it must still render.
    const failures = monitorRuntimeFailures(page);
    await page.route('**/api/analytics/throughput*', (route) =>
      route.fulfill({ json: throughput }),
    );
    await page.route('**/api/analytics/cycle-time*', (route) => route.fulfill({ json: cycleTime }));
    await page.route('**/api/analytics/rules*', (route) => route.fulfill({ json: rules }));
    await page.route('**/api/analytics/state*', (route) =>
      route.fulfill({
        status: 403,
        json: { detail: 'Only a platform administrator can read this' },
      }),
    );
    await page.route('**/api/events/state*', (route) =>
      route.fulfill({ status: 403, json: { detail: 'forbidden' } }),
    );

    await page.goto('/analytics');
    await expect(page.getByText('Decisions recorded')).toBeVisible();
    await expect(page.getByText('Read model lag')).toHaveCount(0);
    await expect(
      page.getByText('The analytics read model is not answering right now.'),
    ).toHaveCount(0);

    expectNoRuntimeFailures(failures);
  });

  test('is offered in the primary navigation at any width', async ({ page }) => {
    // Asserts the link and its destination rather than a click from another page. Starting anywhere
    // else is unreliable here: `app/error.tsx` is the root boundary, it fires intermittently under
    // Playwright's network interception on both the review queue and the policy library, and once
    // it is up a header link changes the document title without replacing the content - so the
    // click appears to do nothing. Both are real problems and neither is this test's subject.
    const failures = monitorRuntimeFailures(page);
    // Each endpoint gets its own shape. Fulfilling them all with one body was how this spec
    // discovered that the dashboard trusted the response shape and threw during render.
    await page.route('**/api/analytics/throughput*', (route) =>
      route.fulfill({ json: throughput }),
    );
    await page.route('**/api/analytics/cycle-time*', (route) => route.fulfill({ json: cycleTime }));
    await page.route('**/api/analytics/rules*', (route) => route.fulfill({ json: rules }));
    await page.route('**/api/analytics/state*', (route) =>
      route.fulfill({ status: 403, json: {} }),
    );
    await page.route('**/api/events/state*', (route) => route.fulfill({ status: 403, json: {} }));

    await page.goto('/analytics');
    await expect(page.getByRole('heading', { name: 'Decision analytics' })).toBeVisible();

    // Below 1180px the links live behind a toggle. Opening it here rather than skipping is the
    // point of the collapsed layout: every destination has to be reachable on a phone.
    const toggle = page.getByRole('button', { name: 'Open navigation' });
    if (await toggle.isVisible()) await toggle.click();

    const link = page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('link', { name: 'Analytics' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/analytics');

    expectNoRuntimeFailures(failures);
  });

  test('says it cannot answer rather than rendering an outage as zero', async ({ page }) => {
    // A dashboard that shows zeroes while the read model is unreachable looks like a quiet business
    // day, which is the most expensive way for this page to be wrong.
    const failures = monitorRuntimeFailures(page);
    await page.route('**/api/analytics/**', (route) =>
      route.fulfill({ status: 503, json: { detail: 'Analytics service unavailable' } }),
    );

    await page.goto('/analytics');
    await expect(
      page.getByText('The analytics read model is not answering right now.'),
    ).toBeVisible();
    await expect(page.getByText('Decisions recorded')).toHaveCount(0);

    await expectHealthyLayout(page);
    // The 503s are this test's subject, so they are not evidence of a fault. Everything else the
    // monitor watches - page errors, console errors, unmocked server faults - still has to be clean.
    expectNoRuntimeFailures(failures.filter((failure) => !failure.startsWith('response 503:')));
  });
});
