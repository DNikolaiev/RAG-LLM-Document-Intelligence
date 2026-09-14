import { describe, expect, it } from 'vitest';
import type { DomainPack } from '@caselens/domain';
import {
  findPolicyCollection,
  resolveActivePolicyPack,
  resolveCompiledPolicyPack,
  resolvePinnedCasePack,
} from '../src/policy/policy-pack.js';

/**
 * The tenant's pack after an administrator created a collection at upload: a new version that
 * exists only in `domain_packs`, never in the compiled catalog.
 */
function mintedWithCollection(): DomainPack {
  const compiled = resolveCompiledPolicyPack('pack_tenant_demo');
  return {
    ...compiled,
    version: '1.1.0',
    policyCollections: [
      ...compiled.policyCollections,
      { id: 'anti-bribery', label: 'Anti-Bribery Policy', chunkSize: 700, overlap: 90 },
    ],
  };
}

describe('policy pack resolution', () => {
  it('cannot find an administrator-created collection in the compiled catalog', () => {
    // The defect, stated directly: this was the worker's only source of truth, so a policy uploaded
    // into a collection created at upload failed processing with exactly this error.
    expect(() =>
      findPolicyCollection(resolveCompiledPolicyPack('pack_tenant_demo'), 'anti-bribery'),
    ).toThrow(/No policy collection anti-bribery exists/);
  });

  it('processes against the tenant pack, where that collection actually lives', async () => {
    const minted = mintedWithCollection();
    const pack = await resolveActivePolicyPack(
      { getActivePackDefinition: async () => minted },
      'tenant_demo',
      'pack_tenant_demo',
    );
    expect(findPolicyCollection(pack, 'anti-bribery')).toMatchObject({
      label: 'Anti-Bribery Policy',
      chunkSize: 700,
    });
  });

  it('hands rule proposals the same tenant pack, so approved fields are visible to them', async () => {
    // The same resolution feeds rule and field proposals. Returning the tenant definition itself,
    // not a compiled copy, is what lets a field approved yesterday be proposed against today.
    const minted = mintedWithCollection();
    const pack = await resolveActivePolicyPack(
      { getActivePackDefinition: async () => minted },
      'tenant_demo',
      'pack_tenant_demo',
    );
    expect(pack).toBe(minted);
    expect(pack.version).toBe('1.1.0');
  });

  it('falls back to the compiled pack for a tenant that never minted a version', async () => {
    const pack = await resolveActivePolicyPack(
      { getActivePackDefinition: async () => null },
      'tenant_demo',
      'pack_tenant_demo',
    );
    expect(pack.version).toBe(resolveCompiledPolicyPack('pack_tenant_demo').version);
    expect(findPolicyCollection(pack, 'insurance').label).toBe('Insurance Requirements');
  });
});

/** The tenant's pack after an administrator approved a field: one more extraction field, in 1.1.0. */
function mintedWithApprovedField(): DomainPack {
  const compiled = resolveCompiledPolicyPack('pack_tenant_demo');
  const [first, ...rest] = compiled.documentTypes;
  return {
    ...compiled,
    version: '1.1.0',
    documentTypes: [
      {
        ...first!,
        extractionFields: [
          ...first!.extractionFields,
          { ...first!.extractionFields[0]!, path: 'facts.newlyApproved.field' },
        ],
      },
      ...rest,
    ],
  };
}

describe('case pack pinning', () => {
  it('extracts with the vocabulary of the version the case is pinned to', async () => {
    // The regression: case extraction used the compiled catalog, so a field approved into 1.1.0 was
    // never extracted, even by a reprocess that explicitly asked for 1.1.0.
    const minted = mintedWithApprovedField();
    const pack = await resolvePinnedCasePack(
      {
        getPackDefinitionVersion: async (_tenant, _pack, version) =>
          version === '1.1.0' ? minted : null,
      },
      'tenant_demo',
      'pack_tenant_demo',
      '1.1.0',
    );
    expect(pack.version).toBe('1.1.0');
    expect(pack.documentTypes[0]!.extractionFields.map((field) => field.path)).toContain(
      'facts.newlyApproved.field',
    );
  });

  it('keeps an older case on its older version when a newer one exists', async () => {
    // Reproducibility: approving a field changes new cases and explicit reprocesses, never an
    // existing case's pinned vocabulary.
    const minted = mintedWithApprovedField();
    const compiled = resolveCompiledPolicyPack('pack_tenant_demo');
    const pack = await resolvePinnedCasePack(
      {
        getPackDefinitionVersion: async (_tenant, _pack, version) =>
          version === '1.1.0' ? minted : version === compiled.version ? compiled : null,
      },
      'tenant_demo',
      'pack_tenant_demo',
      compiled.version,
    );
    expect(pack.documentTypes[0]!.extractionFields.map((field) => field.path)).not.toContain(
      'facts.newlyApproved.field',
    );
  });

  it('uses the compiled pack only when that is the pinned version', async () => {
    const compiled = resolveCompiledPolicyPack('pack_tenant_demo');
    const pack = await resolvePinnedCasePack(
      { getPackDefinitionVersion: async () => null },
      'tenant_demo',
      'pack_tenant_demo',
      compiled.version,
    );
    expect(pack.version).toBe(compiled.version);
  });

  it('refuses to substitute another version for a pinned one it cannot find', async () => {
    await expect(
      resolvePinnedCasePack(
        { getPackDefinitionVersion: async () => null },
        'tenant_demo',
        'pack_tenant_demo',
        '9.9.9',
      ),
    ).rejects.toThrow(/refusing to extract with another version/);
  });
});
