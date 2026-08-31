import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { PostgresCaseStore } from './case-store.js';
import { PostgresPolicyStore } from './policy-store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const adminDatabaseUrl = process.env.TEST_ADMIN_DATABASE_URL;

describe.skipIf(!databaseUrl || !adminDatabaseUrl)(
  'PostgresPolicyStore lifecycle integration',
  () => {
    it('activates a tested rule and returns it only for the owning tenant and pack', async () => {
      const cases = new PostgresCaseStore(databaseUrl!);
      const policies = new PostgresPolicyStore(databaseUrl!);
      const sql = postgres(adminDatabaseUrl!, { prepare: false });
      const suffix = Date.now().toString(36);
      const tenantId = `tenant_policy_it_${suffix}`;
      const otherTenantId = `tenant_policy_other_it_${suffix}`;
      const userId = `user_policy_it_${suffix}`;
      const domainPackId = `pack_${tenantId}`;
      const policyId = `policy_it_${suffix}`;
      const proposalId = `proposal_it_${suffix}`;
      const invalidProposalId = `proposal_invalid_it_${suffix}`;
      try {
        await cases.seed(
          [
            {
              id: tenantId,
              name: 'Policy Integration Tenant',
              domain: 'Commercial contract review',
            },
            {
              id: otherTenantId,
              name: 'Other Policy Integration Tenant',
              domain: 'Insurance claims assessment',
            },
          ],
          [
            {
              id: userId,
              displayName: 'Policy Administrator',
              email: `${suffix}@example.test`,
              tenantIds: [tenantId],
              role: 'admin',
            },
          ],
          [],
        );
        expect(await policies.getDomainPackDescriptor(tenantId, domainPackId)).toMatchObject({
          id: domainPackId,
        });
        expect(
          await policies.getDomainPackDescriptor(tenantId, `pack_${otherTenantId}`),
        ).toBeNull();
        let policy = await policies.create({
          id: policyId,
          tenantId,
          domainPackId,
          title: 'Termination notice policy',
          policyVersion: '1.0',
          collectionId: 'commercial-contract-review-policy',
          storageKey: `${tenantId}/policies/${policyId}.pdf`,
          originalName: 'termination-policy.pdf',
          mediaType: 'application/pdf',
          sha256: 'a'.repeat(64),
          byteSize: 1024,
          pageCount: 1,
          language: 'en',
          validFrom: '2026-01-01T00:00:00.000Z',
          validTo: null,
          uploadedByUserId: userId,
        });
        policy = await policies.updateStatus({
          tenantId,
          id: policyId,
          expectedVersion: policy.version,
          status: 'processing',
        });
        const chunkId = `policy_chunk_it_${suffix}`;
        await policies.replaceExtractedContent({
          tenantId,
          policyDocumentId: policyId,
          pages: [
            {
              id: `policy_page_it_${suffix}`,
              page: 1,
              extractionMethod: 'native',
              language: 'en',
              rotation: 0,
              text: 'Termination requires at least 30 days notice.',
              quality: 1,
              blocks: [],
              warnings: [],
            },
          ],
          chunks: [
            {
              id: chunkId,
              ordinal: 0,
              pageFrom: 1,
              pageTo: 1,
              heading: 'Termination',
              headingPath: ['Termination'],
              content: 'Termination requires at least 30 days notice.',
              sourceQuote: 'at least 30 days notice',
              embedding: Array.from({ length: 768 }, () => 0.01),
              embeddingProvider: 'integration',
              embeddingModel: 'integration-768',
              tags: ['termination'],
              metadata: {},
            },
          ],
        });
        await policies.saveProposal(tenantId, policyId, {
          proposal: {
            id: proposalId,
            title: 'Short termination notice',
            description: 'Flag termination notice periods shorter than 30 days.',
            severity: 'major',
            condition: { operator: 'lte', path: 'facts.contract.terminationNoticeDays', value: 29 },
            policyTags: ['termination'],
            confidence: 0.97,
            providerId: 'integration',
            model: 'integration',
            promptVersion: 'integration-v1',
            validationIssues: [],
            proposedByUserId: userId,
            status: 'proposed',
          },
          citations: [
            {
              id: `citation_it_${suffix}`,
              policyChunkId: chunkId,
              page: 1,
              quote: 'at least 30 days notice',
            },
          ],
          tests: (['match', 'no_match', 'missing_value', 'boundary'] as const).map(
            (kind, index) => ({
              id: `test_it_${kind}_${suffix}`,
              kind,
              name: `${kind} fixture`,
              input: {},
              expected: index === 0,
              actual: index === 0,
            }),
          ),
        });
        await policies.saveProposal(tenantId, policyId, {
          proposal: {
            id: invalidProposalId,
            title: 'Unusable generated rule',
            description: 'This proposal intentionally fails validation.',
            severity: 'major',
            condition: { operator: 'lte', path: 'facts.contract.terminationNoticeDays', value: 29 },
            policyTags: ['termination'],
            confidence: 0.4,
            providerId: 'integration',
            model: 'integration',
            promptVersion: 'integration-v1',
            validationIssues: [
              {
                code: 'test_result_mismatch',
                path: 'tests.0.expected',
                message: 'Expected true but evaluated to false.',
              },
            ],
            proposedByUserId: userId,
            status: 'invalid',
          },
          citations: [],
          tests: [],
        });
        policy = (await policies.get({ tenantIds: [tenantId], platformAdmin: false }, policyId))!;
        policy = await policies.updateStatus({
          tenantId,
          id: policyId,
          expectedVersion: policy.version,
          status: 'under_review',
        });
        await policies.reviewProposal({
          tenantId,
          policyDocumentId: policyId,
          proposalId,
          expectedVersion: 1,
          reviewerUserId: userId,
          status: 'approved',
          reason: 'Validated against cited source and fixtures.',
        });
        const dismissed = await policies.reviewProposal({
          tenantId,
          policyDocumentId: policyId,
          proposalId: invalidProposalId,
          expectedVersion: 1,
          reviewerUserId: userId,
          status: 'rejected',
          reason: 'Dismissed because the generated condition failed deterministic validation.',
        });
        expect(dismissed).toMatchObject({
          id: invalidProposalId,
          status: 'rejected',
          reviewedByUserId: userId,
        });
        policy = (await policies.get({ tenantIds: [tenantId], platformAdmin: false }, policyId))!;
        await policies.activate({
          tenantId,
          policyDocumentId: policyId,
          expectedVersion: policy.version,
          approverUserId: userId,
          rules: [
            {
              id: `rule_it_${suffix}`,
              proposalId,
              ruleKey: 'termination-short-notice',
              priority: 10,
            },
          ],
        });

        const active = await policies.listActiveRules(
          tenantId,
          domainPackId,
          '2026-08-31T00:00:00.000Z',
        );
        expect(active).toHaveLength(1);
        expect(active[0]).toMatchObject({
          ruleKey: 'termination-short-notice',
          ruleVersion: 1,
          policyDocumentId: policyId,
          policyVersion: '1.0',
          priority: 10,
        });
        expect(await policies.listActiveRules(tenantId, 'missing-pack')).toEqual([]);
      } finally {
        try {
          await sql.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', '', true), set_config('app.user_id', '', true), set_config('app.platform_admin', 'true', true)`;
            await tx`delete from policy_rules where policy_document_id = ${policyId}`;
            await tx`delete from policy_rule_proposal_tests where proposal_id = ${proposalId}`;
            await tx`delete from policy_rule_proposal_citations where proposal_id = ${proposalId}`;
            await tx`delete from policy_rule_proposals where policy_document_id = ${policyId}`;
            await tx`delete from policy_chunks where policy_document_id = ${policyId}`;
            await tx`delete from policy_document_pages where policy_document_id = ${policyId}`;
            await tx`delete from policy_documents where id = ${policyId}`;
            await tx`delete from memberships where tenant_id in (${tenantId}, ${otherTenantId})`;
            await tx`delete from domain_packs where tenant_id in (${tenantId}, ${otherTenantId})`;
            await tx`delete from users where id = ${userId}`;
            await tx`delete from tenants where id in (${tenantId}, ${otherTenantId})`;
          });
        } finally {
          await Promise.all([sql.end({ timeout: 5 }), policies.close(), cases.close()]);
        }
      }
    });
  },
);
