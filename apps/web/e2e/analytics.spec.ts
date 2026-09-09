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
    await page.route('**/api/analytics/state*', (route) =>
      route.fulfill({ json: { lastProjectedSequence: 42 } }),
    );

    await page.goto('/analytics');
    await expect(page.getByRole('heading', { name: 'Decision analytics' })).toBeVisible();
    // 145800s is 40.5 hours, which is what a reviewer should read rather than a raw second count.
    await expect(page.getByText('40.5 h')).toBeVisible();
    await expect(page.getByText('2026-09-09')).toBeVisible();

    await expectHealthyLayout(page);
    expectNoRuntimeFailures(failures);
  });

  test('is reachable from the primary navigation', async ({ page, viewport }) => {
    // `.primary-navigation` is hidden below 1180px and this console has no mobile menu, so every
    // secondary destination - the policy library as much as this one - is unreachable from the
    // header on a phone. Pre-existing, and recorded here rather than silently skipped.
    test.skip(
      (viewport?.width ?? 0) <= 1180,
      'The header navigation is hidden below 1180px; there is no mobile menu yet',
    );
    const failures = monitorRuntimeFailures(page);
    await page.route('**/api/analytics/**', (route) => route.fulfill({ json: throughput }));

    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('link', { name: 'Analytics' })
      .click();
    await expect(page.getByRole('heading', { name: 'Decision analytics' })).toBeVisible();

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
