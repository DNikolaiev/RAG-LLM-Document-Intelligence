import { describe, expect, it } from 'vitest';
import type { DomainPack } from '@caselens/domain';
import {
  findPolicyCollection,
  resolveActivePolicyPack,
  resolveCompiledPolicyPack,
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
