import { z } from 'zod';

/**
 * Every id this system actually issues is one of two shapes:
 *
 * - A bare 26-character Crockford ULID (`01J67X4Q7B5E6QG4S9CY0F7R2K`), the original shape this
 *   pattern validated and still the one `packages/document-pipeline` mints and round-trips through
 *   these branded schemas directly (see `DocumentIdSchema.parse('01K6...')` in its dedup test).
 * - A lowercase, underscore-delimited prefix naming the resource, followed by the identifier body
 *   the running application actually assigns there: a bare ULID (`case_01J67Y7HFXCQ1D78Y09N8ZABPV`),
 *   a deterministic hex hash (`ProductionCasesService`'s `stableId`), or a short human-readable slug
 *   (`tenant_demo`, `case_manufacturing_001`, `profile_lena_vogt`, `fact_contract_party`).
 *
 * The prefixed convention is deliberate and load-bearing - it's what makes `tenant_legal/…` object
 * storage prefixes, tenant RLS policies, the test identity catalogue, seeded case ids, and the
 * `inbox/<tenantId>/…` blob-ingestion scheme all readable at a glance - so this pattern is relaxed
 * to accept it rather than forcing every tenant/case/document id to be migrated to a bare ULID.
 * This is the one deliberate concession `docs/superpowers/plans/2026-09-04-case-contract-alignment.md`
 * makes to the contract; nothing else about these schemas moves.
 */
const idPattern = /^(?:[0-9A-HJKMNP-TV-Z]{26}|[a-z]+(?:_[A-Za-z0-9]+)+)$/;

export const TenantIdSchema = z.string().regex(idPattern).brand<'TenantId'>();
export const UserIdSchema = z.string().regex(idPattern).brand<'UserId'>();
export const CaseIdSchema = z.string().regex(idPattern).brand<'CaseId'>();
export const DocumentIdSchema = z.string().regex(idPattern).brand<'DocumentId'>();
export const EvidenceIdSchema = z.string().regex(idPattern).brand<'EvidenceId'>();
export const FactIdSchema = z.string().regex(idPattern).brand<'FactId'>();
export const FindingIdSchema = z.string().regex(idPattern).brand<'FindingId'>();
export const JobIdSchema = z.string().regex(idPattern).brand<'JobId'>();
export const AuditEventIdSchema = z.string().regex(idPattern).brand<'AuditEventId'>();

export type TenantId = z.infer<typeof TenantIdSchema>;
export type UserId = z.infer<typeof UserIdSchema>;
export type CaseId = z.infer<typeof CaseIdSchema>;
export type DocumentId = z.infer<typeof DocumentIdSchema>;
export type EvidenceId = z.infer<typeof EvidenceIdSchema>;
export type FactId = z.infer<typeof FactIdSchema>;
export type FindingId = z.infer<typeof FindingIdSchema>;
export type JobId = z.infer<typeof JobIdSchema>;
export type AuditEventId = z.infer<typeof AuditEventIdSchema>;
