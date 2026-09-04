import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_TENANTS } from '@caselens/contracts';

import { PolicyLibrary } from '@/components/policy/policy-library';

const packNames: Record<string, string> = {
  tenant_demo: 'Pharmaceutical supplier qualification',
  tenant_legal: 'Commercial contract review',
};

const uploadableCollectionsFor: Record<string, Array<{ id: string; label: string }>> = {
  tenant_demo: [
    { id: 'insurance', label: 'Insurance Requirements' },
    { id: 'data-protection', label: 'Data Protection Policy' },
  ],
  tenant_legal: [{ id: 'commercial-contract-review-policy', label: 'Commercial contract policy' }],
};

function domainPackFor(tenantId: string) {
  return {
    tenantId,
    domainPack: {
      id: `pack_${tenantId}`,
      key: tenantId,
      name: packNames[tenantId] ?? tenantId,
      version: tenantId === 'tenant_legal' ? '2.1.0' : '1.0.0',
      terminology: { case: 'case', subject: 'supplier', decision: 'decision' },
      // The registry's display grouping carries the synthetic bucket; the uploadable list must
      // not. Keeping them different here is the whole point of the fixture.
      collections: [
        ...(uploadableCollectionsFor[tenantId] ?? []),
        { id: 'general-controls', label: 'General controls' },
      ],
      uploadableCollections: uploadableCollectionsFor[tenantId] ?? [],
      requiredDocuments: [],
      documentTypes: [],
      rules: [],
    },
  };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// `init` is part of the signature so a test can tell the upload POST apart from the GETs and
// read the `FormData` the component actually sent.
function stubFetch() {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/policies/domain-pack') {
        return json(domainPackFor(url.searchParams.get('tenantId') ?? ''));
      }
      if (url.pathname === '/api/policies/field-proposals') return json({ items: [] });
      return json({ items: [] });
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('policy library workspace switcher', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a static workspace label when the profile owns a single workspace', async () => {
    stubFetch();
    render(<PolicyLibrary tenants={[TEST_TENANTS[0]]} administrator />);

    const identity = await screen.findByTestId('workspace-switcher');
    expect(identity).toHaveTextContent('Düsseldorf Health Operations');
    expect(within(identity).queryByRole('combobox')).toBeNull();
    await waitFor(() =>
      expect(identity).toHaveTextContent('Pharmaceutical supplier qualification · v1.0.0'),
    );
    expect(screen.getByText(/Uploading into/)).toHaveTextContent(
      'Uploading into Düsseldorf Health Operations',
    );
  });

  it('re-scopes the page from the panel header when several workspaces are available', async () => {
    const fetchMock = stubFetch();
    render(<PolicyLibrary tenants={TEST_TENANTS} administrator />);

    const identity = await screen.findByTestId('workspace-switcher');
    const switcher = screen.getByRole('combobox', { name: /select the workspace/i });
    expect(switcher).toHaveValue('tenant_demo');
    expect(within(switcher).getAllByRole('option')).toHaveLength(TEST_TENANTS.length);
    await waitFor(() =>
      expect(identity).toHaveTextContent('Pharmaceutical supplier qualification · v1.0.0'),
    );

    fireEvent.change(switcher, { target: { value: 'tenant_legal' } });

    await waitFor(() => expect(identity).toHaveTextContent('Commercial contract review · v2.1.0'));
    expect(switcher).toHaveValue('tenant_legal');
    expect(screen.getByText(/Uploading into/)).toHaveTextContent(
      'Uploading into Rheinland Legal Services',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/policies/domain-pack?tenantId=tenant_legal',
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/policies/field-proposals?tenantId=tenant_legal',
      expect.anything(),
    );
  });
});

/**
 * The collection control. It used to be populated from a hardcoded per-tenant table in the
 * component, which could not reflect a persisted or versioned pack; it is now driven entirely by
 * the domain-pack endpoint's `uploadableCollections`.
 */
describe('policy library collection selection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function uploadForm(container: HTMLElement) {
    return container.querySelector('form.policy-form') as HTMLFormElement;
  }

  function fillRequiredFields() {
    fireEvent.change(screen.getByLabelText('Policy title'), {
      target: { value: 'Product recall handling' },
    });
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '1.0' } });
  }

  function postCalls(fetchMock: ReturnType<typeof stubFetch>) {
    return fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    );
  }

  it("offers the tenant's real collections and never the synthetic display bucket", async () => {
    stubFetch();
    render(<PolicyLibrary tenants={[TEST_TENANTS[0]]} administrator />);

    const select = await screen.findByLabelText('Collection');
    await waitFor(() => expect(select).toBeEnabled());
    expect(
      within(select as HTMLSelectElement)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Insurance Requirements', 'Data Protection Policy', 'Create a new collection…']);
    expect(select).toHaveValue('insurance');
    // The registry shows `general-controls`; the upload form must never offer it.
    expect(
      within(select as HTMLSelectElement).queryByRole('option', { name: 'General controls' }),
    ).toBeNull();
    expect(screen.queryByLabelText('New collection name')).toBeNull();
  });

  it('re-reads the collections from the API when the workspace changes', async () => {
    stubFetch();
    render(<PolicyLibrary tenants={TEST_TENANTS} administrator />);

    await waitFor(() => expect(screen.getByLabelText('Collection')).toHaveValue('insurance'));

    fireEvent.change(screen.getByRole('combobox', { name: /select the workspace/i }), {
      target: { value: 'tenant_legal' },
    });

    await waitFor(() =>
      expect(screen.getByLabelText('Collection')).toHaveValue('commercial-contract-review-policy'),
    );
    expect(
      within(screen.getByLabelText('Collection'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Commercial contract policy', 'Create a new collection…']);
  });

  it('reveals a name field when the administrator chooses to create a collection', async () => {
    stubFetch();
    render(<PolicyLibrary tenants={[TEST_TENANTS[0]]} administrator />);

    const select = await screen.findByLabelText('Collection');
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.change(select, { target: { value: '__create__' } });

    const name = screen.getByLabelText('New collection name');
    expect(name).toBeVisible();
    expect(name).toHaveAttribute('name', 'newCollectionLabel');
  });

  it('refuses to submit a blank new-collection name and says so inline', async () => {
    const fetchMock = stubFetch();
    const { container } = render(<PolicyLibrary tenants={[TEST_TENANTS[0]]} administrator />);

    const select = await screen.findByLabelText('Collection');
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.change(select, { target: { value: '__create__' } });
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText('New collection name'), { target: { value: '   ' } });
    fireEvent.submit(uploadForm(container));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Name the new collection before uploading into it.',
    );
    expect(postCalls(fetchMock)).toHaveLength(0);

    // Typing clears the error without a second submit.
    fireEvent.change(screen.getByLabelText('New collection name'), {
      target: { value: 'Product recall handling' },
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  /**
   * Stands in for the API, which mints the collection BEFORE it stores anything: once the upload
   * has been posted, the domain-pack endpoint declares the new collection whether the upload
   * itself then succeeded or failed.
   */
  function stubUploadThatMintsACollection(uploadStatus: 200 | 503) {
    let minted = false;
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/policies/domain-pack') {
        const pack = domainPackFor(url.searchParams.get('tenantId') ?? '');
        if (minted) {
          pack.domainPack.uploadableCollections = [
            ...pack.domainPack.uploadableCollections,
            { id: 'product-recall-handling', label: 'Product Recall Handling' },
          ];
        }
        return json(pack);
      }
      if (url.pathname === '/api/policies/field-proposals') return json({ items: [] });
      if (url.pathname === '/api/policies' && init?.method === 'POST') {
        minted = true;
        return uploadStatus === 200
          ? json({ id: 'policy_new', collectionId: 'product-recall-handling' })
          : new Response(JSON.stringify({ message: 'The queue is unavailable.' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            });
      }
      return json({ items: [] });
    });
    return fetchMock;
  }

  async function submitNewCollection(container: HTMLElement) {
    const select = await screen.findByLabelText('Collection');
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.change(select, { target: { value: '__create__' } });
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText('New collection name'), {
      target: { value: 'Product recall handling' },
    });
    fireEvent.submit(uploadForm(container));
    return select;
  }

  it('sends a new collection as a name to create, and keeps it selected afterwards', async () => {
    const fetchMock = stubUploadThatMintsACollection(200);
    const { container } = render(<PolicyLibrary tenants={[TEST_TENANTS[0]]} administrator />);

    const select = await submitNewCollection(container);

    await waitFor(() => expect(postCalls(fetchMock)).toHaveLength(1));
    const body = postCalls(fetchMock)[0]![1]!.body as FormData;
    expect(body.get('newCollectionLabel')).toBe('Product recall handling');
    expect(body.get('collectionId')).toBeNull();
    expect(body.get('tenantId')).toBe('tenant_demo');

    // The collection the API confirmed is offered and selected, and the reveal is put away.
    await waitFor(() => expect(select).toHaveValue('product-recall-handling'));
    expect(
      within(select as HTMLSelectElement).getByRole('option', {
        name: 'Product Recall Handling',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('New collection name')).toBeNull();
  });

  it('leaves a collection minted by a failed upload selectable, so the retry lands in it', async () => {
    stubUploadThatMintsACollection(503);
    const { container } = render(<PolicyLibrary tenants={[TEST_TENANTS[0]]} administrator />);

    const select = await submitNewCollection(container);

    // The upload failed and says so, but the collection the attempt created is now a real option
    // rather than a name the administrator has to type again and be told already exists.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('queue is unavailable'),
    );
    await waitFor(() =>
      expect(
        within(select as HTMLSelectElement).queryByRole('option', {
          name: 'Product Recall Handling',
        }),
      ).toBeInTheDocument(),
    );
  });

  it('sends an existing collection as an id, with no name to create', async () => {
    const fetchMock = stubFetch();
    const { container } = render(<PolicyLibrary tenants={[TEST_TENANTS[0]]} administrator />);

    const select = await screen.findByLabelText('Collection');
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.change(select, { target: { value: 'data-protection' } });
    fillRequiredFields();
    fireEvent.submit(uploadForm(container));

    await waitFor(() => expect(postCalls(fetchMock)).toHaveLength(1));
    const body = postCalls(fetchMock)[0]![1]!.body as FormData;
    expect(body.get('collectionId')).toBe('data-protection');
    expect(body.get('newCollectionLabel')).toBeNull();
  });
});
