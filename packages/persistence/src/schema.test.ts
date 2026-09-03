import { describe, expect, it } from 'vitest';
import {
  cases,
  documents,
  fieldEmbeddings,
  fieldProposals,
  findings,
  jobEvents,
  jobs,
  policyChunks,
} from './schema.js';

describe('persistence schema', () => {
  it('exports the tenant-scoped core tables', () => {
    expect(cases.tenantId).toBeDefined();
    expect(documents.sha256).toBeDefined();
    expect(findings.ruleRunId).toBeDefined();
    expect(policyChunks.embedding).toBeDefined();
    expect(jobs.enqueuedByUserId).toBeDefined();
    expect(jobEvents.recipientUserId).toBeDefined();
  });

  it('separates the field governance record from the field search index', () => {
    expect(fieldProposals.status).toBeDefined();
    expect(fieldEmbeddings.fingerprint).toBeDefined();
    expect(fieldEmbeddings.embedding).toBeDefined();
  });
});
