import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotificationCenter } from '@/components/notification-center';

const eventBase = {
  tenantId: 'tenant_legal',
  recipientUserId: 'profile_jonas_feld',
  actorUserId: null,
  metadata: {},
  readAt: null,
};

const running = {
  id: 'job_running',
  tenantId: 'tenant_legal',
  caseId: 'case_rheinland',
  targetType: 'case_document',
  targetId: 'document_contract',
  enqueuedByUserId: 'profile_jonas_feld',
  kind: 'process_case',
  status: 'processing',
  progress: 40,
  attempts: 1,
  errorCode: null,
  createdAt: '2026-09-14T10:05:00.000Z',
  updatedAt: '2026-09-14T10:06:00.000Z',
  caseReference: 'CASE-7F2A',
  caseSubjectName: 'Rheinland Logistik GmbH',
  targetName: 'framework-agreement.pdf',
  enqueuedByName: 'Jonas Feld',
  latestEvent: {
    ...eventBase,
    id: 'event_running',
    jobId: 'job_running',
    sequence: 3,
    type: 'job.progress',
    stage: 'fact_extraction',
    status: 'processing',
    progress: 40,
    message: 'Structured facts are being extracted.',
    occurredAt: '2026-09-14T10:06:00.000Z',
  },
};

const waiting = {
  id: 'job_waiting',
  tenantId: 'tenant_legal',
  caseId: null,
  targetType: 'policy_version',
  targetId: 'policy_anti_bribery',
  enqueuedByUserId: 'profile_jonas_feld',
  kind: 'process_policy',
  status: 'paused',
  progress: 30,
  attempts: 1,
  errorCode: null,
  createdAt: '2026-09-13T09:00:00.000Z',
  updatedAt: '2026-09-13T09:01:00.000Z',
  targetName: 'Anti-bribery policy',
  enqueuedByName: 'Jonas Feld',
  latestEvent: {
    ...eventBase,
    id: 'event_waiting',
    jobId: 'job_waiting',
    sequence: 4,
    type: 'policy.collection_decision_required',
    stage: 'collection_classification',
    status: 'paused',
    progress: 30,
    message:
      'CaseLens suggests a new collection, "Anti-Bribery". Accept it, rename it, or choose an existing collection to continue.',
    occurredAt: '2026-09-13T09:01:00.000Z',
  },
};

function serveJobs(items: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      // A response is never faster than the component's zero-delay mount reset, which clears state
      // for a switched profile; an instant mock would land before it and be wiped.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const url = String(input);
      if (url.startsWith('/api/jobs?')) return new Response(JSON.stringify({ items }));
      if (url.endsWith('/events')) return new Response(JSON.stringify({ items: [] }));
      return new Response('{}');
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('processing notifications', () => {
  it('pins a policy waiting for a collection decision above other activity, with a link to decide', async () => {
    // Sent second, as an older job would be: the pin, not the feed order, puts it on top.
    serveJobs([running, waiting]);
    render(<NotificationCenter profileId="profile_jonas_feld" />);

    const trigger = await screen.findByRole('button', { name: /1 needs your decision/ });
    fireEvent.click(trigger);

    const pinned = await screen.findByRole('region', { name: 'Needs your decision' });
    expect(within(pinned).getByText(/suggests a new collection/)).toBeTruthy();
    expect(
      within(pinned).getByRole('link', { name: 'Choose collection' }).getAttribute('href'),
    ).toBe('/policies/policy_anti_bribery#collection-decision');

    // Pinned, not repeated: the ordinary activity list keeps only work that needs nothing.
    const activity = screen.getByRole('list', { name: 'Recent activity' });
    expect(within(activity).getByText('Structured facts are being extracted.')).toBeTruthy();
    expect(within(activity).queryByText(/suggests a new collection/)).toBeNull();
  });

  it('opens the waiting policy timeline from the pin, still offering the decision', async () => {
    serveJobs([waiting]);
    render(<NotificationCenter profileId="profile_jonas_feld" />);
    fireEvent.click(await screen.findByRole('button', { name: /1 needs your decision/ }));

    const pinned = await screen.findByRole('region', { name: 'Needs your decision' });
    fireEvent.click(within(pinned).getByRole('button', { name: /timeline/i }));

    expect(await screen.findByRole('list', { name: 'Job processing timeline' })).toBeTruthy();
    expect(
      screen
        .getAllByRole('link', { name: 'Choose collection' })
        .every(
          (link) =>
            link.getAttribute('href') === '/policies/policy_anti_bribery#collection-decision',
        ),
    ).toBe(true);
  });

  it('leaves the feed as it was when nothing needs a decision', async () => {
    serveJobs([running]);
    render(<NotificationCenter profileId="profile_jonas_feld" />);
    const trigger = await screen.findByRole('button', {
      name: 'Processing notifications, 1 unread',
    });
    fireEvent.click(trigger);
    expect(await screen.findByText('Structured facts are being extracted.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Needs your decision' })).toBeNull();
  });
});
