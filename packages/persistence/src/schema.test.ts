import { describe, expect, it } from 'vitest';
import { cases, documents, findings, policyChunks } from './schema.js';

describe('persistence schema', () => {
  it('exports the tenant-scoped core tables', () => {
    expect(cases.tenantId).toBeDefined();
    expect(documents.sha256).toBeDefined();
    expect(findings.ruleRunId).toBeDefined();
    expect(policyChunks.embedding).toBeDefined();
  });
});
