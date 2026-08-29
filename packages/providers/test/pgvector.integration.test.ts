import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { PgVectorSearchProvider } from '../src/index.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('PgVectorSearchProvider tenant integration', () => {
  it('sets RLS context for indexing and searching each tenant', async () => {
    const suffix = Date.now().toString(36);
    const tenantA = `tenant_vector_a_${suffix}`;
    const tenantB = `tenant_vector_b_${suffix}`;
    const sql = postgres(databaseUrl!, { prepare: false });
    let provider: PgVectorSearchProvider | undefined;
    try {
      await sql`insert into tenants (id, name) values (${tenantA}, 'Vector A'), (${tenantB}, 'Vector B')`;
      provider = new PgVectorSearchProvider({
        id: 'integration-pgvector',
        connectionString: databaseUrl!,
        dimensions: 768,
      });
      const firstEmbedding = Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0));
      const secondEmbedding = Array.from({ length: 768 }, (_, index) => (index === 1 ? 1 : 0));
      const now = new Date().toISOString();
      const indexed = await provider.index([
        makeChunk(`chunk_a_${suffix}`, tenantA, 'alpha policy', firstEmbedding, now),
        makeChunk(`chunk_b_${suffix}`, tenantB, 'beta policy', secondEmbedding, now),
      ]);
      expect(indexed.ok).toBe(true);
      const result = await provider.search({
        text: 'policy',
        embedding: firstEmbedding,
        limit: 5,
        scope: {
          tenantId: tenantA,
          domainId: 'integration-domain',
          packVersion: '1.0.0',
          at: now,
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.map((hit) => hit.chunk.tenantId)).toEqual([tenantA]);
      }
    } finally {
      try {
        await sql.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', '', true), set_config('app.platform_admin', 'true', true)`;
          await tx`delete from policy_search_chunks where id in (${`chunk_a_${suffix}`}, ${`chunk_b_${suffix}`})`;
          await tx`delete from tenants where id in (${tenantA}, ${tenantB})`;
        });
      } finally {
        try {
          await provider?.close();
        } finally {
          await sql.end({ timeout: 5 });
        }
      }
    }
  });
});

function makeChunk(
  id: string,
  tenantId: string,
  text: string,
  embedding: number[],
  validFrom: string,
) {
  return {
    id,
    tenantId,
    domainId: 'integration-domain',
    packVersion: '1.0.0',
    documentId: `document_${id}`,
    documentVersion: '1',
    collectionId: 'integration-policy',
    text,
    embedding,
    validFrom,
    validTo: null,
    revokedAt: null,
    tags: ['integration'],
  };
}
