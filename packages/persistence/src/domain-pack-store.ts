import { createHash } from 'node:crypto';
import { parseDomainPack, resolveCompiledDomainPack, type DomainPack } from '@caselens/domain';
import type postgres from 'postgres';

/** Dimension of every field-dictionary embedding (`embeddinggemma:300m-qat-q4_0`). */
export const FIELD_EMBEDDING_DIMENSIONS = 768;

const SEMANTIC_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const PACK_VERSION_SUFFIX_PATTERN = /_\d+_\d+_\d+$/;

export type FieldProposalKind = 'new_field' | 'alias';
export type FieldProposalStatus = 'proposed' | 'invalid' | 'approved' | 'rejected';
export type FieldProposalType = 'string' | 'number' | 'boolean' | 'date' | 'currency' | 'list';
export type FieldDedupVerdict = 'distinct' | 'duplicate';

export interface FieldProposalCitation {
  chunkId: string;
  page: number;
  quote: string;
}

export interface FieldProposalDedup {
  verdict: FieldDedupVerdict;
  matchedPath: string | null;
  similarity: number | null;
  reason: string;
}

export interface FieldProposalIssue {
  code: string;
  message: string;
}

/**
 * One candidate extraction field proposed by an uploaded policy document. For
 * `kind: 'alias'`, `path` is the existing field's path and `aliases` carries only the new
 * wording to add to it.
 */
export interface FieldProposal {
  id: string;
  tenantId: string;
  domainPackId: string;
  policyDocumentId: string;
  kind: FieldProposalKind;
  documentTypeId: string;
  path: string;
  label: string;
  fieldType: FieldProposalType;
  aliases: string[];
  citation: FieldProposalCitation;
  dedup: FieldProposalDedup;
  status: FieldProposalStatus;
  issues: FieldProposalIssue[];
  embedding: number[];
}

export interface StoredFieldProposal extends FieldProposal {
  reviewedByUserId: string | null;
  reviewReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface FieldProposalCreate extends Omit<
  FieldProposal,
  'aliases' | 'issues' | 'embedding' | 'status'
> {
  status: 'proposed' | 'invalid';
  aliases: readonly string[];
  issues: readonly FieldProposalIssue[];
  embedding: readonly number[];
}

/**
 * What a proposal stage hands to the store. `tenantId` and `domainPackId` are passed to
 * `saveFieldProposals` and may be omitted from each draft.
 */
export type FieldProposalDraft = Omit<FieldProposalCreate, 'tenantId' | 'domainPackId'> &
  Partial<Pick<FieldProposalCreate, 'tenantId' | 'domainPackId'>>;

/** A semantically similar field already known to the tenant's dictionary. */
export interface SimilarFieldMatch {
  path: string;
  label: string;
  aliases: string[];
  similarity: number;
}

/**
 * One indexed field of the tenant's active pack. `field_proposals` is the governance record of
 * what a policy proposed; this is the search index over the vocabulary that actually exists,
 * so a field compiled into the domain pack is recallable even though it was never proposed.
 */
export interface FieldEmbeddingRow {
  path: string;
  label: string;
  aliases: readonly string[];
  fingerprint: string;
  embedding: readonly number[];
}

/** What the index currently holds for one path, so the worker can skip unchanged wording. */
export interface FieldEmbeddingFingerprint {
  path: string;
  fingerprint: string;
}

export interface SavePackVersionInput {
  tenantId: string;
  domainPackId: string;
  definition: DomainPack;
  semanticVersion: string;
  supersedes: string;
  actorUserId?: string | null;
  correlationId?: string | null;
}

/** The versioned pack surface shared with the worker and the governance API. */
export interface PackDefinitionStore {
  getActivePackDefinition(tenantId: string, domainPackId: string): Promise<DomainPack | null>;
  savePackVersion(input: SavePackVersionInput): Promise<{ semanticVersion: string }>;
}

export interface FieldDictionaryStore extends PackDefinitionStore {
  searchSimilarFields(
    tenantId: string,
    domainPackId: string,
    embedding: readonly number[],
    limit?: number,
  ): Promise<SimilarFieldMatch[]>;
  listFieldEmbeddingFingerprints(
    tenantId: string,
    domainPackId: string,
  ): Promise<FieldEmbeddingFingerprint[]>;
  upsertFieldEmbeddings(
    tenantId: string,
    domainPackId: string,
    rows: readonly FieldEmbeddingRow[],
  ): Promise<{ upserted: number }>;
  saveFieldProposals(
    tenantId: string,
    domainPackId: string,
    proposals: readonly FieldProposalDraft[],
  ): Promise<{ saved: number }>;
  listFieldProposals(
    tenantId: string,
    domainPackId: string,
    status?: FieldProposalStatus,
  ): Promise<StoredFieldProposal[]>;
  getFieldProposal(tenantId: string, id: string): Promise<StoredFieldProposal | null>;
  setFieldProposalStatus(
    tenantId: string,
    id: string,
    status: FieldProposalStatus,
    actorUserId: string,
    reason?: string,
  ): Promise<void>;
}

/**
 * A stored `domain_packs.definition` only counts as a persisted pack when it declares a
 * schema version. Rows written before the tenant field dictionary hold a `{ name }` stub,
 * which resolves to the compiled catalog instead of failing.
 */
export function isPersistedPackDefinition(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && 'schemaVersion' in value
  );
}

/**
 * Resolution order for every pack read: the persisted definition first, the compiled catalog
 * as fallback. A definition that claims to be a pack but does not validate fails loudly.
 */
export function resolvePackDefinition(
  domainPackId: string,
  definition: unknown,
): DomainPack | null {
  if (!isPersistedPackDefinition(definition)) return resolveCompiledDomainPack(domainPackId);
  try {
    return parseDomainPack(definition);
  } catch (cause) {
    throw new Error(`DOMAIN_PACK_DEFINITION_INVALID:${domainPackId}`, { cause });
  }
}

/** Bumps the minor component, as an approval mints one new pack version. */
export function nextMinorVersion(semanticVersion: string): string {
  const parsed = SEMANTIC_VERSION_PATTERN.exec(semanticVersion);
  if (!parsed) throw new Error(`INVALID_SEMANTIC_VERSION:${semanticVersion}`);
  return `${parsed[1]}.${Number(parsed[2]) + 1}.0`;
}

/**
 * Deterministic row id for a pack version, so a retried `savePackVersion` targets the same
 * row. Mirrors the `pack_<tenant>_<major>_<minor>_<patch>` identifiers the API and worker
 * already normalize away when resolving a compiled pack.
 */
export function packVersionRowId(domainPackId: string, semanticVersion: string): string {
  if (!SEMANTIC_VERSION_PATTERN.test(semanticVersion))
    throw new Error(`INVALID_SEMANTIC_VERSION:${semanticVersion}`);
  const base = domainPackId.replace(PACK_VERSION_SUFFIX_PATTERN, '');
  return `${base}_${semanticVersion.replaceAll('.', '_')}`;
}

/** Stable serialization used to tell a retry apart from a conflicting write. */
export function canonicalPackDefinition(pack: DomainPack): string {
  return JSON.stringify(parseDomainPack(pack));
}

/**
 * Every dictionary row and every query carries a full-width vector, so a truncated or
 * absent embedding is a defect rather than a silently empty result.
 */
export function toEmbeddingLiteral(embedding: readonly number[], subject: string): string {
  if (embedding.length !== FIELD_EMBEDDING_DIMENSIONS)
    throw new Error(`EMBEDDING_DIMENSION_MISMATCH:${subject}:${embedding.length}`);
  if (embedding.some((value) => !Number.isFinite(value)))
    throw new Error(`EMBEDDING_NOT_FINITE:${subject}`);
  return JSON.stringify([...embedding]);
}

/**
 * Stable hash of a field's label plus its sorted aliases, and the whole basis on which the
 * worker decides whether to re-embed. Reordering aliases leaves it unchanged; adding, removing
 * or rewording one changes it, so the field is embedded again on the next sync.
 */
export function fieldEmbeddingFingerprint(label: string, aliases: readonly string[]): string {
  const wording = [...new Set(aliases.map((alias) => alias.trim()).filter(Boolean))].sort();
  return createHash('sha256')
    .update(JSON.stringify([label.trim(), wording]))
    .digest('hex')
    .slice(0, 32);
}

export async function getActivePackDefinitionInTransaction(
  tx: postgres.TransactionSql,
  tenantId: string,
  domainPackId: string,
): Promise<DomainPack | null> {
  const rows = await tx<Array<Record<string, unknown>>>`
    select definition from domain_packs
    where tenant_id = ${tenantId}
      and domain_key = (
        select domain_key from domain_packs
        where id = ${domainPackId} and tenant_id = ${tenantId} limit 1
      )
      and status = 'active'
    order by activated_at desc nulls last, created_at desc, semantic_version desc, id desc
    limit 1`;
  return resolvePackDefinition(domainPackId, rows[0]?.definition ?? null);
}

export async function savePackVersionInTransaction(
  tx: postgres.TransactionSql,
  input: SavePackVersionInput,
): Promise<{ semanticVersion: string }> {
  if (!SEMANTIC_VERSION_PATTERN.test(input.semanticVersion))
    throw new Error(`INVALID_SEMANTIC_VERSION:${input.semanticVersion}`);
  if (input.supersedes === input.semanticVersion)
    throw new Error(`INVALID_PACK_SUPERSEDES:${input.supersedes}`);
  const definition = parseDomainPack({ ...input.definition, version: input.semanticVersion });
  const canonical = canonicalPackDefinition(definition);

  const lineage = await tx<Array<Record<string, unknown>>>`
    select id, domain_key, semantic_version, status, definition from domain_packs
    where tenant_id = ${input.tenantId}
      and domain_key = (
        select domain_key from domain_packs
        where id = ${input.domainPackId} and tenant_id = ${input.tenantId} limit 1
      )
    order by created_at, id
    for update`;
  if (!lineage.length) throw new Error(`DOMAIN_PACK_NOT_FOUND:${input.domainPackId}`);
  const domainKey = String(lineage[0]!.domain_key);
  if (!lineage.some((row) => String(row.semantic_version) === input.supersedes))
    throw new Error(`PACK_SUPERSEDES_NOT_FOUND:${input.supersedes}`);

  const existing = lineage.find((row) => String(row.semantic_version) === input.semanticVersion);
  const rowId = existing
    ? String(existing.id)
    : packVersionRowId(input.domainPackId, input.semanticVersion);
  if (existing) {
    assertSameDefinition(existing.definition, canonical, input.semanticVersion);
  } else {
    const inserted = await tx<Array<{ id: string }>>`
      insert into domain_packs (
        id, tenant_id, domain_key, semantic_version, status, definition, activated_at
      ) values (
        ${rowId}, ${input.tenantId}, ${domainKey}, ${input.semanticVersion}, 'active',
        ${tx.json(asJson(definition))}::jsonb, now()
      )
      on conflict do nothing
      returning id`;
    if (!inserted.length) {
      // A concurrent approval reached this version first. Accept it only when it wrote the
      // same definition, so a competing approval is never silently dropped.
      const raced = await tx<Array<Record<string, unknown>>>`
        select definition from domain_packs
        where tenant_id = ${input.tenantId} and domain_key = ${domainKey}
          and semantic_version = ${input.semanticVersion} limit 1`;
      assertSameDefinition(raced[0]?.definition ?? null, canonical, input.semanticVersion);
    }
  }

  await tx`
    update domain_packs set status = 'superseded', updated_at = now(), version = version + 1
    where tenant_id = ${input.tenantId} and domain_key = ${domainKey}
      and status = 'active' and semantic_version <> ${input.semanticVersion}`;
  await tx`
    insert into audit_events (
      id, tenant_id, case_id, actor_type, actor_id, action, resource_type, resource_id,
      correlation_id, details
    ) values (
      ${`audit_${rowId}`}, ${input.tenantId}, null, ${input.actorUserId ? 'user' : 'system'},
      ${input.actorUserId ?? null}, 'domain_pack.version_minted', 'domain_pack', ${rowId},
      ${input.correlationId ?? `domain-pack:${rowId}`},
      ${tx.json(
        asJson({
          domainPackId: input.domainPackId,
          semanticVersion: input.semanticVersion,
          supersedes: input.supersedes,
        }),
      )}::jsonb
    )
    on conflict (id) do nothing`;
  return { semanticVersion: input.semanticVersion };
}

function assertSameDefinition(stored: unknown, canonical: string, semanticVersion: string): void {
  const current = isPersistedPackDefinition(stored)
    ? canonicalPackDefinition(parseDomainPack(stored))
    : null;
  if (current !== canonical) throw new Error(`PACK_VERSION_CONFLICT:${semanticVersion}`);
}

/**
 * Cosine recall over the tenant's field vocabulary, mirroring how policy chunks are searched
 * rather than extending the policy-chunk shaped `VectorSearchProvider`. Similarity is cosine in
 * [0, 1] where higher means more similar.
 *
 * The corpus is `field_embeddings`, not `field_proposals`: a field compiled into the domain pack
 * was never proposed, so recalling from the governance record would leave a fresh tenant with an
 * empty corpus and mint a duplicate for every wording of an existing field. The whole lineage of
 * the pack is searched, because a minted version carries a new `domain_packs` row id while a
 * policy still names the id it was uploaded against; rows are deduplicated by path, keeping each
 * path's closest match.
 */
export async function searchSimilarFieldsInTransaction(
  tx: postgres.TransactionSql,
  tenantId: string,
  domainPackId: string,
  embedding: readonly number[],
  limit = 5,
): Promise<SimilarFieldMatch[]> {
  const literal = toEmbeddingLiteral(embedding, 'query');
  const rows = await tx<Array<Record<string, unknown>>>`
    select path, label, aliases, similarity from (
      select distinct on (entry.path)
        entry.path, entry.label, entry.aliases,
        greatest(0, 1 - (entry.embedding <=> ${literal}::vector)) as similarity
      from field_embeddings entry
      where entry.tenant_id = ${tenantId}
        and (
          entry.domain_pack_id = ${domainPackId}
          or entry.domain_pack_id in (
            select pack.id from domain_packs pack
            where pack.tenant_id = ${tenantId}
              and pack.domain_key = (
                select domain_key from domain_packs
                where id = ${domainPackId} and tenant_id = ${tenantId} limit 1
              )
          )
        )
      order by entry.path, (entry.embedding <=> ${literal}::vector) asc
    ) ranked
    order by similarity desc, path
    limit ${Math.max(1, Math.trunc(limit))}`;
  return rows.map((row) => ({
    path: String(row.path),
    label: String(row.label),
    aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : [],
    similarity: Number(row.similarity),
  }));
}

/**
 * What the index already holds for this pack. The worker compares each fingerprint against the
 * pack definition to decide which fields are missing or stale, so an unchanged field is never
 * embedded twice.
 */
export async function listFieldEmbeddingFingerprintsInTransaction(
  tx: postgres.TransactionSql,
  tenantId: string,
  domainPackId: string,
): Promise<FieldEmbeddingFingerprint[]> {
  const rows = await tx<Array<Record<string, unknown>>>`
    select path, fingerprint from field_embeddings
    where tenant_id = ${tenantId} and domain_pack_id = ${domainPackId}
    order by path`;
  return rows.map((row) => ({ path: String(row.path), fingerprint: String(row.fingerprint) }));
}

/**
 * Upserts indexed fields by `(tenant_id, domain_pack_id, path)`. The store never embeds anything
 * itself - the worker owns the embedding provider and hands finished vectors here.
 */
export async function upsertFieldEmbeddingsInTransaction(
  tx: postgres.TransactionSql,
  tenantId: string,
  domainPackId: string,
  rows: readonly FieldEmbeddingRow[],
): Promise<{ upserted: number }> {
  let upserted = 0;
  for (const row of rows) {
    if (!row.fingerprint.trim()) throw new Error(`FIELD_EMBEDDING_FINGERPRINT_MISSING:${row.path}`);
    const embedding = toEmbeddingLiteral(row.embedding, row.path);
    const written = await tx<Array<{ path: string }>>`
      insert into field_embeddings (
        tenant_id, domain_pack_id, path, label, aliases, embedding, fingerprint, updated_at
      ) values (
        ${tenantId}, ${domainPackId}, ${row.path}, ${row.label}, ${[...row.aliases]},
        ${embedding}::vector, ${row.fingerprint}, now()
      )
      on conflict (tenant_id, domain_pack_id, path) do update set
        label = excluded.label, aliases = excluded.aliases, embedding = excluded.embedding,
        fingerprint = excluded.fingerprint, updated_at = now()
      returning path`;
    if (written.length) upserted += 1;
  }
  return { upserted };
}

/**
 * Upserts a batch of proposals by id, so reprocessing the same policy document re-derives the
 * same rows instead of duplicating them. A row an administrator already reviewed is left
 * untouched.
 */
export async function saveFieldProposalsInTransaction(
  tx: postgres.TransactionSql,
  tenantId: string,
  domainPackId: string,
  proposals: readonly FieldProposalDraft[],
): Promise<{ saved: number }> {
  let saved = 0;
  for (const draft of proposals) {
    if (draft.tenantId && draft.tenantId !== tenantId)
      throw new Error(`FIELD_PROPOSAL_TENANT_MISMATCH:${draft.id}`);
    const embedding = toEmbeddingLiteral(draft.embedding, draft.id);
    const rows = await tx<Array<{ id: string }>>`
      insert into field_proposals (
        id, tenant_id, domain_pack_id, policy_document_id, kind, document_type_id, path, label,
        field_type, aliases, citation_chunk_id, citation_page, citation_quote, dedup_verdict,
        dedup_matched_path, dedup_similarity, dedup_reason, status, issues, embedding
      ) values (
        ${draft.id}, ${tenantId}, ${draft.domainPackId ?? domainPackId},
        ${draft.policyDocumentId}, ${draft.kind}, ${draft.documentTypeId}, ${draft.path},
        ${draft.label}, ${draft.fieldType}, ${[...draft.aliases]}, ${draft.citation.chunkId},
        ${draft.citation.page}, ${draft.citation.quote}, ${draft.dedup.verdict},
        ${draft.dedup.matchedPath}, ${draft.dedup.similarity}, ${draft.dedup.reason},
        ${draft.status}, ${tx.json(asJson(draft.issues))}::jsonb, ${embedding}::vector
      )
      on conflict (id) do update set
        domain_pack_id = excluded.domain_pack_id,
        policy_document_id = excluded.policy_document_id, kind = excluded.kind,
        document_type_id = excluded.document_type_id, path = excluded.path,
        label = excluded.label, field_type = excluded.field_type, aliases = excluded.aliases,
        citation_chunk_id = excluded.citation_chunk_id, citation_page = excluded.citation_page,
        citation_quote = excluded.citation_quote, dedup_verdict = excluded.dedup_verdict,
        dedup_matched_path = excluded.dedup_matched_path,
        dedup_similarity = excluded.dedup_similarity, dedup_reason = excluded.dedup_reason,
        status = excluded.status, issues = excluded.issues, embedding = excluded.embedding,
        updated_at = now(), version = field_proposals.version + 1
      where field_proposals.status in ('proposed', 'invalid')
      returning id`;
    if (rows.length) saved += 1;
  }
  return { saved };
}

export async function listFieldProposalsInTransaction(
  tx: postgres.TransactionSql,
  tenantId: string,
  domainPackId: string,
  status?: FieldProposalStatus,
): Promise<StoredFieldProposal[]> {
  const rows = await tx<Array<Record<string, unknown>>>`
    select * from field_proposals
    where tenant_id = ${tenantId} and domain_pack_id = ${domainPackId}
      and (${status ?? null}::text is null or status = ${status ?? null})
    order by created_at, id`;
  return rows.map(mapFieldProposal);
}

export async function getFieldProposalInTransaction(
  tx: postgres.TransactionSql,
  tenantId: string,
  id: string,
): Promise<StoredFieldProposal | null> {
  const rows = await tx<Array<Record<string, unknown>>>`
    select * from field_proposals where id = ${id} and tenant_id = ${tenantId} limit 1`;
  return rows[0] ? mapFieldProposal(rows[0]) : null;
}

/**
 * Governed status transition for one proposal, with an append-only audit event. Idempotent:
 * re-applying the status a proposal already carries is a no-op, and moving between two
 * different terminal statuses is refused.
 */
export async function setFieldProposalStatusInTransaction(
  tx: postgres.TransactionSql,
  input: {
    tenantId: string;
    id: string;
    status: FieldProposalStatus;
    actorUserId: string;
    reason?: string | undefined;
  },
): Promise<void> {
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  const reviewed = input.status === 'approved' || input.status === 'rejected';
  const rows = await tx<Array<Record<string, unknown>>>`
    update field_proposals set status = ${input.status},
      reviewed_by_user_id = case when ${reviewed} then ${input.actorUserId}
        else reviewed_by_user_id end,
      review_reason = case when ${reviewed} then ${reason} else review_reason end,
      reviewed_at = case when ${reviewed} then now() else reviewed_at end,
      updated_at = now(), version = version + 1
    where id = ${input.id} and tenant_id = ${input.tenantId}
      and status in ('proposed', 'invalid')
    returning id`;
  if (!rows[0]) {
    const current = await getFieldProposalInTransaction(tx, input.tenantId, input.id);
    if (!current) throw new Error(`FIELD_PROPOSAL_NOT_FOUND:${input.id}`);
    if (current.status !== input.status)
      throw new Error(`FIELD_PROPOSAL_STATE_CONFLICT:${input.id}`);
    return;
  }
  await tx`
    insert into audit_events (
      id, tenant_id, case_id, actor_type, actor_id, action, resource_type, resource_id,
      correlation_id, details
    ) values (
      ${`audit_${input.id}_${input.status}`}, ${input.tenantId}, null, 'user',
      ${input.actorUserId}, ${`field_proposal.${input.status}`}, 'field_proposal',
      ${input.id}, ${`field-proposal:${input.id}`},
      ${tx.json(asJson({ status: input.status, reason }))}::jsonb
    )
    on conflict (id) do nothing`;
}

export function mapFieldProposal(row: Record<string, unknown>): StoredFieldProposal {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    domainPackId: String(row.domain_pack_id),
    policyDocumentId: String(row.policy_document_id),
    kind: row.kind as FieldProposalKind,
    documentTypeId: String(row.document_type_id),
    path: String(row.path),
    label: String(row.label),
    fieldType: row.field_type as FieldProposalType,
    aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : [],
    citation: {
      chunkId: String(row.citation_chunk_id),
      page: Number(row.citation_page),
      quote: String(row.citation_quote),
    },
    dedup: {
      verdict: row.dedup_verdict as FieldDedupVerdict,
      matchedPath: row.dedup_matched_path === null ? null : String(row.dedup_matched_path),
      similarity: row.dedup_similarity === null ? null : Number(row.dedup_similarity),
      reason: String(row.dedup_reason),
    },
    status: row.status as FieldProposalStatus,
    issues: Array.isArray(row.issues) ? (row.issues as FieldProposalIssue[]) : [],
    embedding: typeof row.embedding === 'string' ? (JSON.parse(row.embedding) as number[]) : [],
    reviewedByUserId: row.reviewed_by_user_id === null ? null : String(row.reviewed_by_user_id),
    reviewReason: row.review_reason === null ? null : String(row.review_reason),
    reviewedAt:
      row.reviewed_at === null || row.reviewed_at === undefined
        ? null
        : new Date(row.reviewed_at as string | Date).toISOString(),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
    version: Number(row.version),
  };
}

function asJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
