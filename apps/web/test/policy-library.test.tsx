import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_TENANTS } from '@caselens/contracts';

import { PolicyLibrary } from '@/components/policy/policy-library';

const packNames: Record<string, string> = {
  tenant_demo: 'Pharmaceutical supplier qualification',
  tenant_legal: 'Commercial contract review',
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
      collections: [],
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

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/policies/domain-pack') {
      return json(domainPackFor(url.searchParams.get('tenantId') ?? ''));
    }
    if (url.pathname === '/api/policies/field-proposals') return json({ items: [] });
    return json({ items: [] });
  });
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
