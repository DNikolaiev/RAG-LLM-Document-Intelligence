import { expect, test, type Page } from '@playwright/test';

import {
  expectHealthyLayout,
  expectNoPageOverflow,
  expectNoRuntimeFailures,
  expectVisibleControlsFitViewport,
  monitorRuntimeFailures,
} from './support/ui-assertions';

const job = {
  id: 'job_notification_test',
  tenantId: 'tenant_demo',
  caseId: 'case_demo_001',
  targetType: 'case_document',
  targetId: 'document_notification_test',
  enqueuedByUserId: 'profile_lena_vogt',
  correlationId: 'correlation_notification_test',
  queueJobId: 'queue_notification_test',
  status: 'processing',
  progress: 40,
  attempts: 1,
  error: null,
  kind: 'process_case',
  idempotencyKey: 'notification-test',
  createdAt: '2026-08-31T08:00:00.000Z',
  updatedAt: '2026-08-31T08:01:00.000Z',
  caseReference: 'SUP-2026-0142',
  caseSubjectName: 'MediSupply GmbH',
  targetName: 'supplier-questionnaire.pdf',
  enqueuedByName: 'Lena Vogt',
  latestEvent: {
    id: 'job_event_notification_test',
    jobId: 'job_notification_test',
    tenantId: 'tenant_demo',
    recipientUserId: 'profile_lena_vogt',
    actorUserId: null,
    sequence: 3,
    type: 'job.progress',
    stage: 'fact_extraction',
    status: 'processing',
    progress: 40,
    message: 'Structured facts are being extracted.',
    metadata: {},
    occurredAt: '2026-08-31T08:01:00.000Z',
    readAt: null,
  },
};

async function mockNotifications(
  page: Page,
  options?: { toastFromStream?: boolean },
): Promise<void> {
  const initialJob = {
    ...job,
    latestEvent: {
      ...job.latestEvent,
      id: 'job_event_notification_initial',
      sequence: 2,
      type: 'queue.enqueued',
      message: 'Request queued and waiting for a worker.',
      stage: 'queue',
      progress: 0,
    },
  };
  const startedJob = {
    ...job,
    latestEvent: {
      ...job.latestEvent,
      id: 'job_event_notification_started',
      sequence: 3,
      type: 'worker.started',
      message: 'A worker started processing this document.',
      stage: 'document_processing',
      progress: 8,
    },
  };
  await page.route('**/api/job-events/stream', async (route) => {
    const nextJob = options?.toastFromStream ? startedJob : job;
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body:
        `event: jobs\ndata: ${JSON.stringify({ items: [initialJob], nextCursor: null })}\n\n` +
        `event: jobs\ndata: ${JSON.stringify({ items: [nextJob], nextCursor: null })}\n\n`,
    });
  });
  await page.route('**/api/jobs?limit=30', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [job] }),
    });
  });
  await page.route('**/api/jobs/job_notification_test/events', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [job.latestEvent], nextCursor: null }),
    });
  });
  await page.route('**/api/jobs/events/read', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test.describe('processing notification bell', () => {
  test('opens a usable ledger, shows unread work, and closes with Escape', async ({ page }) => {
    await mockNotifications(page);
    const failures = monitorRuntimeFailures(page);
    await page.goto('/');

    const trigger = page.getByRole('button', { name: /Processing notifications, 1 unread/ });
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();

    const panel = page.getByRole('dialog', { name: 'Processing notifications' });
    await expect(panel).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.getByText('Structured facts are being extracted.')).toBeVisible();
    await expect(panel.getByText('SUP-2026-0142 · supplier-questionnaire.pdf')).toBeVisible();
    await expectHealthyLayout(page);

    await panel.getByRole('listitem').click();
    await expect(panel.getByRole('list', { name: 'Job processing timeline' })).toBeVisible();
    await expect(panel.getByText(/fact_extraction/i)).toBeVisible();
    await expect(panel.getByText('Enqueued by Lena Vogt')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    expectNoRuntimeFailures(failures);
  });

  test('fits the viewport and closes from its explicit control', async ({ page }) => {
    await mockNotifications(page, { toastFromStream: true });
    const failures = monitorRuntimeFailures(page);
    await page.goto('/');
    const trigger = page.getByRole('button', { name: /Processing notifications/ });
    await trigger.click();
    const panel = page.getByRole('dialog', { name: 'Processing notifications' });
    await expect(panel).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: 'A worker started processing this document.' }),
    ).toBeVisible({ timeout: 7_000 });
    await expect(
      page.getByRole('status').filter({ hasText: 'SUP-2026-0142 · supplier-questionnaire.pdf' }),
    ).toBeVisible();
    await expectNoPageOverflow(page);
    await expectVisibleControlsFitViewport(page);
    await page.getByRole('button', { name: 'Dismiss processing update' }).click({ trial: true });
    await panel.getByRole('button', { name: 'Close notifications' }).click();
    await expect(panel).toBeHidden();
    await expectHealthyLayout(page);
    expectNoRuntimeFailures(failures);
  });
});

test.describe('decisions waiting on a person', () => {
  test('pins a policy awaiting its collection above the ledger, with a link to decide', async ({
    page,
  }) => {
    const waiting = {
      ...job,
      id: 'job_collection_decision',
      caseId: null,
      targetType: 'policy_version',
      targetId: 'policy_anti_bribery',
      status: 'paused',
      progress: 30,
      kind: 'process_policy',
      caseReference: null,
      caseSubjectName: null,
      targetName: 'Anti-bribery policy',
      latestEvent: {
        ...job.latestEvent,
        id: 'job_event_collection_decision',
        jobId: 'job_collection_decision',
        type: 'policy.collection_decision_required',
        stage: 'collection_classification',
        status: 'paused',
        progress: 30,
        message:
          'CaseLens suggests a new collection, "Anti-Bribery". Accept it, rename it, or choose an existing collection to continue.',
      },
    };
    const page_ = { items: [job, waiting], nextCursor: null };
    await page.route('**/api/job-events/stream', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `event: jobs\ndata: ${JSON.stringify(page_)}\n\n`,
      });
    });
    await page.route('**/api/jobs?limit=30', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(page_),
      });
    });
    const failures = monitorRuntimeFailures(page);
    await page.goto('/');

    const trigger = page.getByRole('button', { name: /1 needs your decision/ });
    await expect(trigger).toBeVisible();
    await trigger.click();
    const pinned = page.getByRole('region', { name: 'Needs your decision' });
    await expect(pinned).toBeVisible();
    await expect(pinned.getByRole('link', { name: 'Choose collection' })).toHaveAttribute(
      'href',
      '/policies/policy_anti_bribery#collection-decision',
    );
    await expectNoPageOverflow(page);
    await expectVisibleControlsFitViewport(page);
    await expectHealthyLayout(page);
    expectNoRuntimeFailures(failures);
  });
});
