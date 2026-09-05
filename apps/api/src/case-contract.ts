/**
 * Shared mapping from the internal case/document/fact/finding shape both `CasesService` (demo)
 * and `ProductionCasesService` (durable) already use, to the fields `packages/contracts`'
 * `CaseSummarySchema`, `CaseDetailSchema`, `DocumentSchema`, `ExtractedFactSchema` and
 * `FindingSchema` additionally require.
 *
 * Every function here is additive: it never removes or renames a property the review console
 * reads (`subjectName`, `domain`, `findingCounts`, `progress`, `documentCount`, `assignedTo`,
 * `dueAt`, `tenantName`, `warning`, `type`, `confidence`, `ruleKey`, `reviewStatus`, `value`,
 * `rawValue`) - it only adds the contract's differently-named or previously-absent fields
 * alongside them, following `docs/superpowers/plans/2026-09-04-case-contract-alignment.md`.
 *
 * One field is deliberately left unresolved here: `DocumentSchema.status` and (for a decided
 * case) `CaseSummarySchema.status` collide on the wire with values the console already depends on
 * that the contract's own enums do not include (`'ready'`/`'missing'` for documents,
 * `'approved'`/`'rejected'`/`'request_information'` for a decided case). Recoding those values
 * would break `apps/web/lib/demo-data.ts`'s literal checks (`document.status === 'ready'`,
 * `mapStatus`'s switch), which this task may not edit. Both `status` fields are therefore passed
 * through unchanged via the spreads below - see the implementation report for the full
 * accounting of which fields could and could not be produced honestly.
 */
import type { DemoDocument, DemoFact, DemoFinding } from './demo-data.js';

/** The subset of `DemoCase` / `PersistedCaseProjection` the summary-level contract fields need. */
export interface ContractCaseSummarySource {
  id: string;
  tenantId: string;
  domain: string;
  domainPackId?: string | undefined;
  domainPackVersion: string;
  subjectName: string;
  version: number;
}

/**
 * `CaseSummarySchema` requires `domainPackId` as its own field. `ProductionCasesService`'s store
 * attaches the real one (`pack_<tenantId>`, the durable `domain_pack_id` column) whenever a case
 * is loaded via `get`/`list`/`mutable`; immediately after `insert`, before any re-fetch, it falls
 * back to the same `pack_<tenantId>` default the service itself uses elsewhere (`reprocess`,
 * `intake`). `CasesService`'s in-memory `DemoCase` never has a separate column for it at all, so
 * `domain` - which those same two write paths (`create`, `intake`) already set to the requested
 * domain-pack id - is the most accurate value available.
 */
export function resolveDomainPackId(item: ContractCaseSummarySource): string {
  return item.domainPackId?.trim() || item.domain.trim() || `pack_${item.tenantId}`;
}

/** The five `CaseSummarySchema` fields neither service currently surfaces. `openFindings` is
 *  taken as a parameter, rather than computed from `item`, so this works uniformly whether the
 *  caller's findings array is a properly-typed `DemoFinding[]` or a `PersistedCaseProjection`'s
 *  `unknown[]` that has already been cast once by the caller. */
export function contractCaseSummaryFields(
  item: ContractCaseSummarySource,
  openFindings: number,
): {
  title: string;
  domainPackId: string;
  domainPackVersion: string;
  openFindings: number;
  version: number;
} {
  return {
    title: item.subjectName,
    domainPackId: resolveDomainPackId(item),
    domainPackVersion: item.domainPackVersion,
    openFindings,
    version: item.version,
  };
}

export interface ContractRecordContext {
  tenantId: string;
  caseId: string;
  /** Neither documents, facts, nor findings carry their own creation timestamp in this model; the
   *  case's own `createdAt` is the most accurate real timestamp available for all three. */
  createdAt: string;
}

/**
 * Maps a `DemoDocument` onto `DocumentSchema`'s additional fields, in place alongside every field
 * already there. `classification`/`classificationConfidence` reuse `type`/`confidence` - `type`
 * is literally `'unknown'` for a not-yet-classified document (set by both `intake` and
 * `uploadDocument`), so that already carries the "not yet classified" signal `classification`
 * needs. `mediaType`/`byteSize`/`sha256` are read from the document itself (see `DemoDocument`)
 * rather than invented here - they stay absent, honestly, when the service has no real bytes to
 * hash. `status` is passed through unchanged; see this file's top comment.
 */
export function toContractDocument(
  document: DemoDocument,
  context: ContractRecordContext,
  // `duplicateOf` is omitted from the base and redeclared below: the demo record types it as an
  // optional `string`, and intersecting that with `string | null` narrows back to `string`, which
  // the contract's nullable field cannot satisfy.
): Omit<DemoDocument, 'duplicateOf'> & {
  tenantId: string;
  caseId: string;
  classification: string | null;
  classificationConfidence: number | null;
  duplicateOf: string | null;
  versionOf: null;
  warnings: string[];
  createdAt: string;
} {
  return {
    ...document,
    tenantId: context.tenantId,
    caseId: context.caseId,
    classification: document.type && document.type !== 'unknown' ? document.type : null,
    classificationConfidence: document.confidence,
    duplicateOf: document.duplicateOf ?? null,
    // No document has ever been recorded as a new version of a prior one in this model.
    versionOf: null,
    warnings: document.warning ? [document.warning] : [],
    // Prefer the document's own real creation time (set at upload/intake) over the case's,
    // which is the only fallback available for a seeded fixture with no per-document timestamp.
    createdAt: document.createdAt ?? context.createdAt,
  };
}

/**
 * A fact's own value tells us its `valueType` honestly: `boolean` typeof is unambiguous, a
 * `YYYY-MM-DD` string is a `date`, and a number whose field path reads as a monetary amount is
 * `currency` rather than a bare `number`. Everything else defaults to `string`, which every demo
 * fact's remaining values (names, quotes) already are.
 */
function inferFactValueType(
  path: string,
  value: unknown,
): 'string' | 'number' | 'boolean' | 'date' | 'currency' | 'list' | 'object' {
  if (Array.isArray(value)) return 'list';
  if (value !== null && typeof value === 'object') return 'object';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') {
    return /eur|usd|gbp|cost|price|amount|limit/i.test(path) ? 'currency' : 'number';
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
  return 'string';
}

/**
 * `ExtractedFactSchema.status` has no `'needs_review'` member - a fact still awaiting reviewer
 * confirmation has simply been `'extracted'`, not yet `'confirmed'` or `'corrected'`.
 */
function mapFactStatus(
  reviewStatus: DemoFact['reviewStatus'],
): 'extracted' | 'confirmed' | 'corrected' | 'conflicting' {
  if (reviewStatus === 'confirmed') return 'confirmed';
  if (reviewStatus === 'corrected') return 'corrected';
  return 'extracted';
}

/**
 * Maps a `DemoFact` onto `ExtractedFactSchema`'s additional fields. `evidenceIds` is left `[]`:
 * this model tracks a fact's supporting quote/page/document inline on the fact itself rather than
 * as separately addressable `EvidenceSpan` records, and there is no endpoint that would resolve an
 * `EvidenceId` to anything - minting one here would reference a resource that does not exist.
 * `provider` is a plain, clearly-synthetic identifier (`context.providerId`); neither service
 * tracks a real extraction provider/model per fact today.
 */
export function toContractFact(
  fact: DemoFact,
  context: ContractRecordContext & { providerId: string },
): DemoFact & {
  tenantId: string;
  caseId: string;
  normalizedValue: string | number | boolean | null;
  valueType: 'string' | 'number' | 'boolean' | 'date' | 'currency' | 'list' | 'object';
  evidenceIds: string[];
  sourceDocumentIds: string[];
  status: 'extracted' | 'confirmed' | 'corrected' | 'conflicting';
  provider: { id: string };
  createdAt: string;
} {
  return {
    ...fact,
    tenantId: context.tenantId,
    caseId: context.caseId,
    normalizedValue: fact.value,
    valueType: inferFactValueType(fact.path, fact.value),
    evidenceIds: [],
    sourceDocumentIds: [fact.documentId],
    status: mapFactStatus(fact.reviewStatus),
    provider: { id: context.providerId },
    createdAt: context.createdAt,
  };
}

/**
 * Maps a `DemoFinding` onto `FindingSchema`'s additional fields. `evidenceIds`/`policyChunkIds`
 * are left empty for the same reason as `toContractFact`'s `evidenceIds` - the finding's own
 * `evidence` (documentId/page/quote) is not a separately addressable record. `deterministic` is
 * `true` for every finding this model produces: every one is keyed by `ruleKey` from the
 * deterministic rules engine (see `AGENTS.md`'s "Deterministic rules own thresholds and approval
 * gates" invariant), not a bare model suggestion.
 */
export function toContractFinding(
  finding: DemoFinding,
  context: ContractRecordContext,
): DemoFinding & {
  tenantId: string;
  caseId: string;
  ruleId: string;
  evidenceIds: string[];
  policyChunkIds: string[];
  deterministic: boolean;
  createdAt: string;
} {
  return {
    ...finding,
    tenantId: context.tenantId,
    caseId: context.caseId,
    ruleId: finding.ruleKey,
    evidenceIds: [],
    policyChunkIds: [],
    deterministic: true,
    createdAt: context.createdAt,
  };
}

/**
 * Builds the full `CaseDetailSchema`-additive response for `GET /v1/cases/:id`: the summary-level
 * fields plus `documents`/`facts`/`findings` mapped through the three functions above. `item`'s
 * own fields (id, tenantId, reference, subjectName, domain, status, recommendation, updatedAt,
 * progress, documentCount-equivalents, assignedTo, dueAt, contact, audit, decision, …) all pass
 * through via the spread, unchanged. `documents`/`facts`/`findings` are taken as explicit
 * parameters, already cast to their `DemoCase` shape by the caller, rather than read off `item`
 * itself - `PersistedCaseProjection` types them as `unknown[]`, so this sidesteps forcing that
 * cast into the generic constraint below.
 */
export function toContractCaseDetail<T extends ContractCaseSummarySource>(
  item: T,
  documents: readonly DemoDocument[],
  facts: readonly DemoFact[],
  findings: readonly DemoFinding[],
  createdAt: string,
  providerId: string,
): T & {
  title: string;
  domainPackId: string;
  domainPackVersion: string;
  openFindings: number;
  version: number;
  documents: ReturnType<typeof toContractDocument>[];
  facts: ReturnType<typeof toContractFact>[];
  findings: ReturnType<typeof toContractFinding>[];
} {
  const context: ContractRecordContext = { tenantId: item.tenantId, caseId: item.id, createdAt };
  const openFindings = findings.filter((finding) => finding.status === 'open').length;
  return {
    ...item,
    ...contractCaseSummaryFields(item, openFindings),
    documents: documents.map((document) => toContractDocument(document, context)),
    facts: facts.map((fact) => toContractFact(fact, { ...context, providerId })),
    findings: findings.map((finding) => toContractFinding(finding, context)),
  };
}
