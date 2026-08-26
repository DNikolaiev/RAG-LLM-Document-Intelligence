export interface CaseLensApiClientOptions {
  baseUrl: string;
  tenantId: string;
  fetcher?: typeof fetch;
}

export class CaseLensApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CaseLensApiError';
  }
}

export class CaseLensApiClient {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: CaseLensApiClientOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  listCases(input: {
    status?: string | undefined;
    query?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  }) {
    const params = new URLSearchParams();
    if (input.status) params.set('status', input.status);
    if (input.query) params.set('q', input.query);
    if (input.cursor) params.set('cursor', input.cursor);
    params.set('limit', String(input.limit ?? 20));
    return this.get(`/v1/cases?${params.toString()}`);
  }

  getCase(caseId: string) {
    return this.get(`/v1/cases/${encodeURIComponent(caseId)}`);
  }

  getAudit(caseId: string) {
    return this.get(`/v1/cases/${encodeURIComponent(caseId)}/audit`);
  }

  exportCase(caseId: string) {
    return this.get(`/v1/cases/${encodeURIComponent(caseId)}/export`);
  }

  async searchEvidence(caseId: string, query: string, limit: number) {
    const item = (await this.getCase(caseId)) as { facts?: unknown[]; findings?: unknown[] };
    const needle = query.toLocaleLowerCase();
    const candidates = [...(item.facts ?? []), ...(item.findings ?? [])];
    const matches = candidates
      .filter((candidate) => JSON.stringify(candidate).toLocaleLowerCase().includes(needle))
      .slice(0, limit);
    return { caseId, query, matches, count: matches.length, truncated: candidates.length > limit };
  }

  async listFindings(caseId: string, severity?: string | undefined, status?: string | undefined) {
    const item = (await this.getCase(caseId)) as { findings?: Array<Record<string, unknown>> };
    const findings = (item.findings ?? []).filter(
      (finding) =>
        (!severity || finding.severity === severity) && (!status || finding.status === status),
    );
    return { caseId, findings, count: findings.length };
  }

  private async get(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.options.baseUrl), {
        headers: {
          'x-tenant-id': this.options.tenantId,
          'x-role': 'auditor',
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw new CaseLensApiError(
        503,
        'API_UNAVAILABLE',
        `CaseLens API is unavailable: ${error instanceof Error ? error.message : 'network failure'}`,
      );
    }
    const body = (await response.json().catch(() => undefined)) as
      { code?: string; detail?: string } | undefined;
    if (!response.ok) {
      throw new CaseLensApiError(
        response.status,
        body?.code ?? 'API_ERROR',
        body?.detail ?? `CaseLens API returned ${response.status}`,
      );
    }
    return body;
  }
}
