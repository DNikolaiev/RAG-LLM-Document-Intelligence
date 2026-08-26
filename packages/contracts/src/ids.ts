import { z } from 'zod';

const idPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;

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
