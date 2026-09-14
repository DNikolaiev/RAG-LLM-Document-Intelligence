import { resolvePersistedDomainPack, type DomainPack } from '@caselens/domain';

/** Where a tenant's governed pack definitions live - the policy store, in production. */
export interface ActivePackSource {
  getActivePackDefinition(tenantId: string, domainPackId: string): Promise<DomainPack | null>;
}

const COMPILED_ALIASES: Readonly<Record<string, string>> = {
  demo: 'pharmacy-supplier',
  legal: 'commercial-contract-review',
  insurance: 'insurance-claims-assessment',
  manufacturing: 'supplier-quality-assurance',
};

/**
 * The compiled pack a persisted pack id derives from - the catalog shipped with the code.
 *
 * Only a fallback. It knows nothing an administrator has done since the tenant was seeded: no
 * collection created at upload, no field approved from a proposal. Treating it as the answer is
 * the defect this module exists to remove.
 */
export function resolveCompiledPolicyPack(domainPackId: string): DomainPack {
  const direct = resolvePersistedDomainPack(domainPackId);
  if (direct) return direct;
  const key = domainPackId.startsWith('pack_tenant_')
    ? domainPackId.replace(/^pack_tenant_/, '').replaceAll('_', '-')
    : domainPackId
        .replace(/^pack_/, '')
        .replace(/_\d+_\d+_\d+$/, '')
        .replaceAll('_', '-');
  const pack = resolvePersistedDomainPack(COMPILED_ALIASES[key] ?? key);
  if (!pack) throw new Error(`No installed domain pack matches ${domainPackId}`);
  return pack;
}

/**
 * The pack a policy is processed against: the tenant's active definition.
 *
 * That definition is where governance lands. A collection an administrator names at upload and a
 * field approved from a proposal both exist only as a new pack version in `domain_packs`, never in
 * the compiled catalog. Processing against the compiled pack meant a policy uploaded into a
 * freshly created collection could not be processed at all, and rule proposals could not see a
 * field an administrator had just approved - the approval loop the policy lab exists for, silently
 * broken.
 *
 * Falls back to the compiled catalog only for a tenant that has never minted a version.
 */
export async function resolveActivePolicyPack(
  source: ActivePackSource,
  tenantId: string,
  domainPackId: string,
): Promise<DomainPack> {
  return (
    (await source.getActivePackDefinition(tenantId, domainPackId)) ??
    resolveCompiledPolicyPack(domainPackId)
  );
}

export function findPolicyCollection(
  pack: DomainPack,
  collectionId: string,
): DomainPack['policyCollections'][number] {
  const collection = pack.policyCollections.find((candidate) => candidate.id === collectionId);
  if (!collection) {
    throw new Error(`No policy collection ${collectionId} exists in ${pack.id} ${pack.version}`);
  }
  return collection;
}
