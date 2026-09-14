import { resolveCompiledDomainPack, type DomainPack } from '@caselens/domain';

/** Where a tenant's governed pack definitions live - the policy store, in production. */
export interface ActivePackSource {
  getActivePackDefinition(tenantId: string, domainPackId: string): Promise<DomainPack | null>;
}

export interface PinnedPackSource {
  getPackDefinitionVersion(
    tenantId: string,
    domainPackId: string,
    semanticVersion: string,
  ): Promise<DomainPack | null>;
}

/**
 * The compiled pack a persisted pack id derives from - the catalog shipped with the code.
 *
 * Only a fallback. It knows nothing an administrator has done since the tenant was seeded: no
 * collection created at upload, no field approved from a proposal. Treating it as the answer is
 * the defect this module exists to remove.
 */
export function resolveCompiledPolicyPack(domainPackId: string): DomainPack {
  const pack = resolveCompiledDomainPack(domainPackId);
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

/**
 * The pack a case is extracted against: the exact version it is pinned to.
 *
 * Case extraction read the compiled catalog, so a field an administrator approved - which exists
 * only as a new pack version - was never extracted from a case document, and a rule written
 * against it saw the fact as permanently missing. Reprocessing, whose whole purpose is to apply a
 * newly approved field to an existing case, asked for the new version and was handed the old
 * vocabulary regardless.
 *
 * Falls back to the compiled catalog only when the pinned version is the compiled one, which is a
 * tenant that never minted a version. Any other miss is an error rather than a quiet substitution:
 * extracting a case pinned to 1.1.0 with the 1.0.0 vocabulary would drop exactly the fields 1.1.0
 * added, while the rule run went on recording 1.1.0.
 */
export async function resolvePinnedCasePack(
  source: PinnedPackSource,
  tenantId: string,
  domainPackId: string,
  semanticVersion: string,
): Promise<DomainPack> {
  const pinned = await source.getPackDefinitionVersion(tenantId, domainPackId, semanticVersion);
  if (pinned) return pinned;
  const compiled = resolveCompiledPolicyPack(domainPackId);
  if (compiled.version === semanticVersion) return compiled;
  throw new Error(
    `Pack ${domainPackId} ${semanticVersion} is not installed for ${tenantId}; refusing to extract with another version`,
  );
}
