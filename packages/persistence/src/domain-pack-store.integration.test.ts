import { legalContractPack, parseDomainPack } from '@caselens/domain';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { PostgresCaseStore } from './case-store.js';
import {
  fieldEmbeddingFingerprint,
  nextMinorVersion,
  type FieldProposalDraft,
} from './domain-pack-store.js';
import { PostgresPolicyStore } from './policy-store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const adminDatabaseUrl = process.env.TEST_ADMIN_DATABASE_URL;

function embedding(hot: number): number[] {
  return Array.from({ length: 768 }, (_, index) => (index === hot ? 1 : 0));
}

describe.skipIf(!databaseUrl || !adminDatabaseUrl)('tenant field dictionary integration', () => {
  it('versions pack definitions, recalls similar fields, and isolates proposals by tenant', async () => {
    const cases = new PostgresCaseStore(databaseUrl!);
    const policies = new PostgresPolicyStore(databaseUrl!);
    const sql = postgres(adminDatabaseUrl!, { prepare: false });
    const suffix = Date.now().toString(36);
    const tenantId = `tenant_field_it_${suffix}`;
    const otherTenantId = `tenant_field_other_it_${suffix}`;
    const userId = `user_field_it_${suffix}`;
    const domainPackId = `pack_${tenantId}`;
    const policyId = `policy_field_it_${suffix}`;
    const proposal = (
      id: string,
      overrides: Partial<FieldProposalDraft> = {},
    ): FieldProposalDraft => ({
      id,
      policyDocumentId: policyId,
      kind: 'new_field',
      documentTypeId: 'commercial_contract',
      path: 'contract.renewalNoticeDays',
      label: 'Renewal notice days',
      fieldType: 'number',
      aliases: ['renewal period'],
      citation: { chunkId: `chunk_${suffix}`, page: 1, quote: 'renewal notice of 60 days' },
      dedup: {
        verdict: 'distinct',
        matchedPath: null,
        similarity: null,
        reason: 'No similar field above the floor.',
      },
      status: 'proposed',
      issues: [],
      embedding: embedding(0),
      ...overrides,
    });

    try {
      await cases.seed(
        [{ id: tenantId, name: 'Field Dictionary Tenant', domain: 'Commercial contract review' }],
        [
          {
            id: userId,
            displayName: 'Field Administrator',
            email: `${suffix}@example.test`,
            tenantIds: [tenantId],
            role: 'admin',
          },
        ],
        [],
      );
      await cases.seed(
        [
          {
            id: otherTenantId,
            name: 'Other Field Tenant',
            domain: 'Insurance claims assessment',
          },
        ],
        [],
        [],
      );

      // The seed now writes the full pack, so the read round-trips through parseDomainPack.
      expect(await policies.getActivePackDefinition(tenantId, domainPackId)).toEqual(
        parseDomainPack(legalContractPack),
      );

      // A pre-dictionary `{ name }` stub is treated as an absent definition and routed to
      // the compiled catalog, which returns null for an id it does not know rather than
      // failing on the stub. Compiled fallback content is asserted in the unit tests.
      await sql.begin(async (tx) => {
        await tx`select set_config('app.platform_admin', 'true', true)`;
        await tx`update domain_packs set definition = ${tx.json({ name: 'Insurance claims assessment' })}::jsonb
            where id = ${`pack_${otherTenantId}`}`;
      });
      expect(
        await policies.getActivePackDefinition(otherTenantId, `pack_${otherTenantId}`),
      ).toBeNull();

      const next = nextMinorVersion('1.0.0');
      const widened = parseDomainPack({
        ...legalContractPack,
        version: next,
        documentTypes: legalContractPack.documentTypes.map((documentType) => ({
          ...documentType,
          extractionFields: [
            ...documentType.extractionFields,
            {
              path: 'contract.renewalNoticeDays',
              label: 'Renewal notice days',
              type: 'number',
              required: false,
              aliases: ['renewal period'],
            },
          ],
        })),
      });
      const minted = await policies.savePackVersion({
        tenantId,
        domainPackId,
        definition: widened,
        semanticVersion: next,
        supersedes: '1.0.0',
        actorUserId: userId,
      });
      expect(minted).toEqual({ semanticVersion: next });

      // Retrying the same approval is a no-op rather than a second version or audit event.
      expect(
        await policies.savePackVersion({
          tenantId,
          domainPackId,
          definition: widened,
          semanticVersion: next,
          supersedes: '1.0.0',
          actorUserId: userId,
        }),
      ).toEqual({ semanticVersion: next });
      const packRows = await sql<Array<{ semantic_version: string; status: string }>>`
          select semantic_version, status from domain_packs
          where tenant_id = ${tenantId} order by semantic_version`;
      expect(packRows).toEqual([
        { semantic_version: '1.0.0', status: 'superseded' },
        { semantic_version: next, status: 'active' },
      ]);
      const auditRows = await sql<Array<{ count: string }>>`
          select count(*)::text as count from audit_events
          where tenant_id = ${tenantId} and action = 'domain_pack.version_minted'`;
      expect(auditRows[0]?.count).toBe('1');

      // Reading through the original pack id follows the lineage to the active version.
      expect(await policies.getActivePackDefinition(tenantId, domainPackId)).toEqual(widened);

      const policy = await policies.create({
        id: policyId,
        tenantId,
        domainPackId,
        title: 'Renewal policy',
        policyVersion: '1.0',
        collectionId: 'commercial-contract-review-policy',
        storageKey: `${tenantId}/policies/${policyId}.pdf`,
        originalName: 'renewal-policy.pdf',
        mediaType: 'application/pdf',
        sha256: 'b'.repeat(64),
        byteSize: 2048,
        pageCount: 1,
        language: 'en',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: null,
        uploadedByUserId: userId,
      });
      expect(policy.id).toBe(policyId);

      const proposalA = `field_proposal_a_${suffix}`;
      const proposalB = `field_proposal_b_${suffix}`;
      expect(
        await policies.saveFieldProposals(tenantId, domainPackId, [
          proposal(proposalA),
          proposal(proposalB, {
            path: 'contract.governingLaw',
            label: 'Governing law',
            fieldType: 'string',
            aliases: ['applicable law'],
            embedding: embedding(1),
          }),
        ]),
      ).toEqual({ saved: 2 });

      // Reprocessing the same policy re-derives the same ids and upserts in place.
      expect(
        await policies.saveFieldProposals(tenantId, domainPackId, [proposal(proposalA)]),
      ).toEqual({ saved: 1 });
      const stored = await policies.listFieldProposals(tenantId, domainPackId);
      expect(stored).toHaveLength(2);
      expect(stored[0]).toMatchObject({
        id: proposalA,
        path: 'contract.renewalNoticeDays',
        status: 'proposed',
        version: 2,
      });
      expect(stored[0]?.embedding).toHaveLength(768);

      // Recall reads the field embedding index, never the governance record, so no proposal -
      // approved or not - is visible to it.
      expect(await policies.searchSimilarFields(tenantId, domainPackId, embedding(0), 5)).toEqual(
        [],
      );

      await policies.setFieldProposalStatus(
        tenantId,
        proposalA,
        'approved',
        userId,
        'Grounded in the cited renewal clause.',
      );
      // Approving twice is a no-op rather than a second audit event.
      await policies.setFieldProposalStatus(tenantId, proposalA, 'approved', userId);
      const approvalAudit = await sql<Array<{ count: string }>>`
          select count(*)::text as count from audit_events
          where tenant_id = ${tenantId} and action = 'field_proposal.approved'`;
      expect(approvalAudit[0]?.count).toBe('1');
      await expect(
        policies.setFieldProposalStatus(tenantId, proposalA, 'rejected', userId, 'Changed mind.'),
      ).rejects.toThrow(`FIELD_PROPOSAL_STATE_CONFLICT:${proposalA}`);

      expect(await policies.searchSimilarFields(tenantId, domainPackId, embedding(0), 5)).toEqual(
        [],
      );

      // The regression this table exists for: `contract.governingLaw` ships inside the compiled
      // pack and was never proposed, so it has no proposal row at all. Once the index carries it,
      // recall finds it.
      expect(await policies.listFieldEmbeddingFingerprints(tenantId, domainPackId)).toEqual([]);
      expect(
        await policies.upsertFieldEmbeddings(tenantId, domainPackId, [
          {
            path: 'contract.governingLaw',
            label: 'Governing law',
            aliases: ['jurisdiction'],
            fingerprint: fieldEmbeddingFingerprint('Governing law', ['jurisdiction']),
            embedding: embedding(3),
          },
        ]),
      ).toEqual({ upserted: 1 });
      expect(await policies.listFieldEmbeddingFingerprints(tenantId, domainPackId)).toEqual([
        {
          path: 'contract.governingLaw',
          fingerprint: fieldEmbeddingFingerprint('Governing law', ['jurisdiction']),
        },
      ]);

      const matches = await policies.searchSimilarFields(tenantId, domainPackId, embedding(3), 5);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        path: 'contract.governingLaw',
        label: 'Governing law',
        aliases: ['jurisdiction'],
      });
      // Cosine similarity in [0, 1]; higher is more similar.
      expect(matches[0]!.similarity).toBeGreaterThan(0.99);
      expect(
        (await policies.searchSimilarFields(tenantId, domainPackId, embedding(2), 5))[0]!
          .similarity,
      ).toBeLessThan(0.01);

      // Re-indexing the same path updates the row in place rather than adding a second one.
      expect(
        await policies.upsertFieldEmbeddings(tenantId, domainPackId, [
          {
            path: 'contract.governingLaw',
            label: 'Governing law',
            aliases: ['jurisdiction', 'applicable law'],
            fingerprint: fieldEmbeddingFingerprint('Governing law', [
              'jurisdiction',
              'applicable law',
            ]),
            embedding: embedding(4),
          },
        ]),
      ).toEqual({ upserted: 1 });
      const reindexed = await policies.searchSimilarFields(tenantId, domainPackId, embedding(4), 5);
      expect(reindexed).toHaveLength(1);
      expect(reindexed[0]!.aliases).toEqual(['jurisdiction', 'applicable law']);

      // RLS plus tenant scoping keep proposals invisible to another tenant.
      expect(await policies.listFieldProposals(otherTenantId, domainPackId)).toEqual([]);
      expect(await policies.getFieldProposal(otherTenantId, proposalA)).toBeNull();
      expect(await policies.getFieldProposal(tenantId, proposalA)).toMatchObject({
        status: 'approved',
        reviewedByUserId: userId,
      });
    } finally {
      try {
        await sql.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', '', true), set_config('app.user_id', '', true), set_config('app.platform_admin', 'true', true)`;
          await tx`delete from field_embeddings where tenant_id in (${tenantId}, ${otherTenantId})`;
          await tx`delete from field_proposals where tenant_id in (${tenantId}, ${otherTenantId})`;
          await tx`delete from policy_documents where id = ${policyId}`;
          await tx`delete from audit_events where tenant_id in (${tenantId}, ${otherTenantId})`;
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
});
