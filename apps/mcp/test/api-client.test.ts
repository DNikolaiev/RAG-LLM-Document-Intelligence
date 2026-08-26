import { describe, expect, it, vi } from 'vitest';
import { CaseLensApiClient, CaseLensApiError } from '../src/api-client.js';

describe('CaseLensApiClient', () => {
  it('always sends tenant-scoped, read-only headers', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = new CaseLensApiClient({
      baseUrl: 'https://api.example.test',
      tenantId: 'tenant_a',
      fetcher: fetcher as typeof fetch,
    });
    await client.listCases({ limit: 10 });
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-tenant-id': 'tenant_a', 'x-role': 'auditor' }),
      }),
    );
  });

  it('turns API problem details into actionable errors', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'CASE_NOT_FOUND', detail: 'Case not found.' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = new CaseLensApiClient({
      baseUrl: 'https://api.example.test',
      tenantId: 'tenant_a',
      fetcher: fetcher as typeof fetch,
    });
    await expect(client.getCase('missing')).rejects.toMatchObject({
      status: 404,
      code: 'CASE_NOT_FOUND',
    });
  });

  it('filters evidence without inventing matches', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            facts: [{ label: 'Coverage', quote: 'EUR 1,000,000' }],
            findings: [{ title: 'GDP missing' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const client = new CaseLensApiClient({
      baseUrl: 'https://api.example.test',
      tenantId: 'tenant_a',
      fetcher: fetcher as typeof fetch,
    });
    await expect(client.searchEvidence('case_1', 'GDP', 10)).resolves.toMatchObject({ count: 1 });
  });
});
