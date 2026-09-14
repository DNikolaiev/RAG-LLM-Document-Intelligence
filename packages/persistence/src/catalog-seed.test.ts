import { describe, expect, it } from 'vitest';
import {
  compareSemanticVersions,
  planCatalogSeed,
  type CatalogLineageRow,
} from './domain-pack-store.js';

function row(overrides: Partial<CatalogLineageRow> = {}): CatalogLineageRow {
  return {
    id: 'pack_tenant_a',
    semanticVersion: '1.0.0',
    status: 'active',
    origin: 'catalog',
    persisted: true,
    matchesCatalog: true,
    ...overrides,
  };
}

describe('compareSemanticVersions', () => {
  it('orders numerically, not as text', () => {
    expect(compareSemanticVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareSemanticVersions('1.1.0', '1.1.0')).toBe(0);
    expect(compareSemanticVersions('1.0.9', '1.1.0')).toBe(-1);
  });

  it('rejects a malformed version rather than guessing', () => {
    expect(() => compareSemanticVersions('1.1', '1.0.0')).toThrow(/INVALID_SEMANTIC_VERSION/);
  });
});

describe('planCatalogSeed', () => {
  it('installs a tenant that has no pack yet', () => {
    expect(planCatalogSeed([], '1.0.0')).toEqual({ action: 'install' });
  });

  it('upgrades a tenant still on the catalog line when the catalog is newer', () => {
    expect(planCatalogSeed([row()], '1.1.0')).toEqual({ action: 'upgrade', supersedes: '1.0.0' });
  });

  it('never writes over a tenant version that shares the catalog number', () => {
    // The old upsert matched on (tenant, domain, version), so this administrator-approved
    // definition would have been replaced by the catalog's.
    const lineage = [
      row({ status: 'superseded' }),
      row({ id: 'pack_tenant_a_1_1_0', semanticVersion: '1.1.0', origin: 'tenant' }),
    ];
    expect(planCatalogSeed(lineage, '1.1.0')).toEqual({
      action: 'keep',
      reason: 'tenant_owns_version',
    });
  });

  it('leaves a tenant that governs its own version alone', () => {
    const lineage = [
      row({ status: 'superseded' }),
      row({ id: 'pack_tenant_a_1_1_0', semanticVersion: '1.1.0', origin: 'tenant' }),
    ];
    expect(planCatalogSeed(lineage, '1.2.0')).toEqual({ action: 'keep', reason: 'diverged' });
  });

  it('is a no-op for a tenant already on the catalog version', () => {
    expect(planCatalogSeed([row()], '1.0.0')).toEqual({ action: 'keep', reason: 'current' });
  });

  it('refuses a compiled pack that changed without a new version', () => {
    // Editing 1.0.0 in place would change what every case pinned to 1.0.0 is extracted with.
    expect(planCatalogSeed([row({ matchesCatalog: false })], '1.0.0')).toEqual({
      action: 'keep',
      reason: 'changed_without_version',
    });
  });

  it('replaces a pre-dictionary stub with the full definition', () => {
    expect(planCatalogSeed([row({ persisted: false, matchesCatalog: false })], '1.0.0')).toEqual({
      action: 'replace_stub',
      rowId: 'pack_tenant_a',
    });
  });

  it('never downgrades', () => {
    expect(planCatalogSeed([row({ semanticVersion: '1.2.0' })], '1.1.0')).toEqual({
      action: 'keep',
      reason: 'catalog_older',
    });
  });

  it('does not bring back a catalog version the tenant has moved past', () => {
    const lineage = [
      row({ status: 'superseded' }),
      row({ id: 'pack_tenant_a_1_1_0', semanticVersion: '1.1.0' }),
    ];
    expect(planCatalogSeed(lineage, '1.0.0')).toEqual({ action: 'keep', reason: 'superseded' });
  });
});
