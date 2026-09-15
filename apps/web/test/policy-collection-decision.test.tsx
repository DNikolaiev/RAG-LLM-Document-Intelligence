import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The PDF surface needs a real browser; these tests are about the decision around it.
vi.mock('@/components/document-surface-loader', () => ({
  DocumentSurfaceLoader: ({ page }: { page: number }) => (
    <div data-testid="document-surface">page {page}</div>
  ),
}));

import { PolicyReviewWorkspace } from '@/components/policy/policy-review-workspace';

const newSuggestion = {
  decision: 'new',
  label: 'Anti-Bribery',
  rationale: 'The policy governs gifts and payments to officials; no collection covers that.',
  nearestCollectionId: null,
  confidence: 0.64,
  evidence: { quote: 'No employee may offer or accept a payment', page: 2 },
  disposition: 'decision_required',
  reasons: ['new_collection'],
  providerId: 'test-model',
  model: 'test-model-v1',
  packVersion: '1.0.0',
  classifiedAt: '2026-09-14T10:00:00.000Z',
};

function policyDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'policy_wait',
    tenantId: 'tenant_demo',
    title: 'Anti-bribery policy',
    policyVersion: '2026.1',
    status: 'awaiting_collection',
    version: 4,
    originalName: 'anti-bribery.pdf',
    pageCount: 3,
    collectionId: null,
    collectionSuggestion: newSuggestion,
    extractionMetadata: {},
    proposals: [],
    ...overrides,
  };
}

const collections = [
  { id: 'insurance', label: 'Insurance Requirements' },
  { id: 'data-protection', label: 'Data Protection Policy' },
];

/** Serves the policy (the next detail per read) and records each decision posted. */
function serve(
  details: Array<Record<string, unknown>>,
  decision: { status: number; body: unknown } = {
    status: 201,
    body: { policy: { collectionId: 'filed' }, jobId: 'job_1', alreadyDecided: false },
  },
) {
  const posted: Array<Record<string, unknown>> = [];
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const url = String(input);
      if (url.startsWith('/api/policies/domain-pack')) {
        return new Response(
          JSON.stringify({
            tenantId: 'tenant_demo',
            domainPack: { uploadableCollections: collections },
          }),
        );
      }
      if (url === '/api/policies/policy_wait/collection') {
        posted.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(decision.body), { status: decision.status });
      }
      if (url === '/api/policies/policy_wait') {
        const detail = details[Math.min(reads, details.length - 1)];
        reads += 1;
        return new Response(JSON.stringify(detail));
      }
      return new Response('{}', { status: 404 });
    }),
  );
  return posted;
}

async function openPanel() {
  const panel = await screen.findByRole('region', { name: /Choose this policy.s collection/ });
  // The collections arrive separately; wait for the existing-collection choice to be usable.
  await waitFor(() =>
    expect(within(panel).getByLabelText('File into an existing collection')).toBeEnabled(),
  );
  return panel;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the collection decision panel', () => {
  it('shows the suggestion, its quotation and why it waits, and accepts it', async () => {
    const posted = serve([
      policyDetail(),
      policyDetail({ status: 'processing', collectionId: 'anti-bribery', version: 5 }),
    ]);
    render(<PolicyReviewWorkspace policyId="policy_wait" />);
    const panel = await openPanel();

    expect(within(panel).getByText('Anti-Bribery', { selector: 'strong' })).toBeInTheDocument();
    expect(within(panel).getByText(/64% model confidence/)).toBeInTheDocument();
    expect(
      within(panel).getByText('No existing collection fits, so it proposes a new one.'),
    ).toBeInTheDocument();
    // The quotation turns the document to its page.
    fireEvent.click(within(panel).getByRole('button', { name: /Show page 2/ }));
    expect(screen.getByTestId('document-surface')).toHaveTextContent('page 2');

    fireEvent.click(
      within(panel).getByRole('button', { name: 'Create “Anti-Bribery” and file it' }),
    );
    await waitFor(() =>
      expect(posted).toEqual([{ newCollectionLabel: 'Anti-Bribery', version: 4 }]),
    );
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /Choose this policy.s collection/ })).toBeNull(),
    );
    expect(screen.getByRole('status')).toHaveTextContent('Filed into Anti-Bribery');
  });

  it('files into an existing collection chosen instead of the suggestion', async () => {
    const posted = serve([policyDetail(), policyDetail({ status: 'processing' })]);
    render(<PolicyReviewWorkspace policyId="policy_wait" />);
    const panel = await openPanel();

    const existing = within(panel).getByLabelText('File into an existing collection');
    expect(existing).toHaveValue('insurance');
    fireEvent.change(existing, { target: { value: 'data-protection' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'File here' }));
    await waitFor(() => expect(posted).toEqual([{ collectionId: 'data-protection', version: 4 }]));
  });

  it('creates a collection under a name the administrator chooses', async () => {
    const posted = serve([policyDetail(), policyDetail({ status: 'processing' })]);
    render(<PolicyReviewWorkspace policyId="policy_wait" />);
    const panel = await openPanel();

    const name = within(panel).getByLabelText('Or create a new collection');
    expect(name).toHaveValue('Anti-Bribery');
    fireEvent.change(name, { target: { value: 'Gifts and hospitality' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Create and file' }));
    await waitFor(() =>
      expect(posted).toEqual([{ newCollectionLabel: 'Gifts and hospitality', version: 4 }]),
    );
  });

  it('says why when classification was unavailable, and still offers the choice', async () => {
    serve([
      policyDetail({
        collectionSuggestion: null,
        extractionMetadata: {
          collectionClassification: { status: 'unavailable', message: 'model timed out' },
        },
      }),
    ]);
    render(<PolicyReviewWorkspace policyId="policy_wait" />);
    const panel = await openPanel();

    expect(
      within(panel).getByText(/could not classify this policy: model timed out/),
    ).toBeVisible();
    expect(within(panel).queryByRole('button', { name: /and file it|^File into / })).toBeNull();
    expect(within(panel).getByRole('button', { name: 'File here' })).toBeEnabled();
  });

  it("shows the API's reason when a decision is refused, and refreshes the policy", async () => {
    serve([policyDetail(), policyDetail({ version: 5 })], {
      status: 409,
      body: {
        code: 'VERSION_CONFLICT',
        detail: 'The policy changed. Refresh and decide again with version 5.',
      },
    });
    render(<PolicyReviewWorkspace policyId="policy_wait" />);
    const panel = await openPanel();

    fireEvent.click(within(panel).getByRole('button', { name: 'File here' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'The policy changed. Refresh and decide again with version 5.',
    );
  });

  it('says where a policy filed automatically went, and on which quotation', async () => {
    serve([
      policyDetail({
        status: 'under_review',
        collectionId: 'insurance',
        version: 6,
        collectionSuggestion: {
          ...newSuggestion,
          decision: 'existing',
          collectionId: 'insurance',
          disposition: 'filed',
          reasons: [],
          confidence: 0.95,
        },
      }),
    ]);
    render(<PolicyReviewWorkspace policyId="policy_wait" />);

    expect(await screen.findByText('Insurance Requirements', { selector: 'strong' })).toBeVisible();
    expect(screen.getByText(/Filed automatically into/)).toHaveTextContent(
      'Filed automatically into Insurance Requirements by CaseLens, on “No employee may offer or accept a payment” (page 2).',
    );
    expect(screen.queryByRole('region', { name: /Choose this policy.s collection/ })).toBeNull();
  });
});
