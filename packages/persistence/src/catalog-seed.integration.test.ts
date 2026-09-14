import { legalContractPack, parseDomainPack } from '@caselens/domain';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { PostgresCaseStore } from './case-store.js';
import { PostgresPolicyStore } from './policy-store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const adminDatabaseUrl = process.env.TEST_ADMIN_DATABASE_URL;

describe.skipIf(!databaseUrl || !adminDatabaseUrl)('catalog pack seeding', () => {
  it('upgrades a tenant on the catalog line and never writes over a governed one', async () => {
    const cases = new PostgresCaseStore(databaseUrl!);
    const policies = new PostgresPolicyStore(databaseUrl!);
    const sql = postgres(adminDatabaseUrl!, { prepare: false });
    const suffix = Date.now().toString(36);
    const onCatalog = `tenant_catalog_it_${suffix}`;
    const governed = `tenant_governed_it_${suffix}`;
    const domain = 'Commercial contract review';
    const tenants = [
      { id: onCatalog, name: 'On The Catalog Line', domain },
      { id: governed, name: 'Governed By Its Administrators', domain },
    ];
    const catalog = parseDomainPack(legalContractPack);
    // Both tenants are made to look installed by an older catalog release, so the compiled pack
    // is the newer one - which is exactly the situation a catalog release creates.
    const older = '0.9.0';

    try {
      expect((await cases.seed(tenants, [], [])).map((outcome) => outcome.plan)).toEqual([
        { action: 'install' },
        { action: 'install' },
      ]);
      await sql.begin(async (tx) => {
        await tx`select set_config('app.platform_admin', 'true', true)`;
        await tx`update domain_packs
          set semantic_version = ${older},
              definition = ${tx.json(JSON.parse(JSON.stringify({ ...catalog, version: older })))}::jsonb
          where tenant_id in (${onCatalog}, ${governed})`;
      });

      // The worst case for the old seed: an administrator minted a version with exactly the
      // number the catalog is about to ship, holding a collection the catalog does not have.
      const governedDefinition = parseDomainPack({
        ...catalog,
        policyCollections: [
          ...catalog.policyCollections,
          { id: 'anti-bribery', label: 'Anti-Bribery Policy', chunkSize: 700, overlap: 90 },
        ],
      });
      await policies.savePackVersion({
        tenantId: governed,
        domainPackId: `pack_${governed}`,
        definition: governedDefinition,
        semanticVersion: catalog.version,
        supersedes: older,
      });

      expect(await cases.seed(tenants, [], [])).toEqual([
        {
          tenantId: onCatalog,
          catalogVersion: catalog.version,
          plan: { action: 'upgrade', supersedes: older },
        },
        {
          tenantId: governed,
          catalogVersion: catalog.version,
          plan: { action: 'keep', reason: 'tenant_owns_version' },
        },
      ]);

      // The catalog tenant moved forward by minting, not by editing: a new row, the old one
      // superseded, both marked as the catalog's, and a system audit event for the change.
      const catalogRows = await sql<
        Array<{ id: string; semantic_version: string; status: string; origin: string }>
      >`select id, semantic_version, status, origin from domain_packs
          where tenant_id = ${onCatalog} order by semantic_version`;
      expect(catalogRows).toEqual([
        {
          id: `pack_${onCatalog}`,
          semantic_version: older,
          status: 'superseded',
          origin: 'catalog',
        },
        {
          id: `pack_${onCatalog}_${catalog.version.replaceAll('.', '_')}`,
          semantic_version: catalog.version,
          status: 'active',
          origin: 'catalog',
        },
      ]);
      expect(await policies.getActivePackDefinition(onCatalog, `pack_${onCatalog}`)).toEqual(
        catalog,
      );
      const audit = await sql<Array<{ actor_type: string }>>`
          select actor_type from audit_events
          where tenant_id = ${onCatalog} and action = 'domain_pack.version_minted'`;
      expect(audit).toEqual([{ actor_type: 'system' }]);

      // The governed tenant keeps its administrator's definition, collection and all.
      expect(await policies.getActivePackDefinition(governed, `pack_${governed}`)).toEqual(
        governedDefinition,
      );

      // Starting again changes nothing.
      expect((await cases.seed(tenants, [], [])).map((outcome) => outcome.plan)).toEqual([
        { action: 'keep', reason: 'current' },
        { action: 'keep', reason: 'tenant_owns_version' },
      ]);
    } finally {
      try {
        await sql.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', '', true), set_config('app.user_id', '', true), set_config('app.platform_admin', 'true', true)`;
          await tx`delete from audit_events where tenant_id in (${onCatalog}, ${governed})`;
          await tx`delete from domain_packs where tenant_id in (${onCatalog}, ${governed})`;
          await tx`delete from tenants where id in (${onCatalog}, ${governed})`;
        });
      } finally {
        await Promise.all([sql.end({ timeout: 5 }), policies.close(), cases.close()]);
      }
    }
  });
});
