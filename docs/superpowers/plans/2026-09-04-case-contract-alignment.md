# Case Contract Alignment Implementation Plan

**Goal:** Make the case and document API responses match the schemas `packages/contracts` already declares for them, so that package becomes prescriptive rather than descriptive.

**Background:** `CaseSummarySchema`, `CaseDetailSchema` and `DocumentSchema` describe a model the API has never returned. Neither `CasesService` nor `ProductionCasesService` imports them — grep finds references only in tests. The wire sends `subjectName`, `domain` and `findingCounts` where the contract declares `title`, `domainPackId`, `domainPackVersion`, `openFindings` and `version`, and every field `DocumentSchema` declares beyond `id`/`fileName`/`status` is simply absent. Nothing could catch the drift because nothing validated against it.

**Decision (user, 2026-09-04):** correct the API, not the contract.

**Tech Stack:** TypeScript, Zod, NestJS, Next.js 16, Vitest, Playwright.

## The one exception, and why

`CaseIdSchema` and friends require a bare 26-character Crockford ULID. Real identifiers are `tenant_demo`, `case_manufacturing_001` and `case_01J67Y7HFXCQ1D78Y09N8ZABPV`. Correcting the API here would mean migrating every tenant id to a ULID, which breaks object-storage prefixes (`tenant_legal/…`), the tenant RLS policies, the test identity catalogue, every fixture, the seeded case ids, existing URLs, and the `inbox/<tenantId>/…` scheme agreed for blob ingestion.

The prefixed convention is deliberate and load-bearing; the pattern is what is wrong. So `idPattern` in `packages/contracts/src/ids.ts` is relaxed to accept it — a lowercase, underscore-delimited prefix followed by the existing identifier body — and nothing else in the contract moves.

## Global Constraints

- **Additive on the wire.** The schemas are not `.strict()`, so the existing fields the review console reads (`subjectName`, `domain`, `findingCounts`, `progress`, `documentCount`, `assignedTo`, `dueAt`, `tenantName`) stay. Add what the contract requires; remove nothing. Renaming a field the UI reads would break the console for no gain.
- Both `CasesService` (demo) and `ProductionCasesService` (durable) must return the same shape, as `reprocess` and `intake` already do.
- Preserve tenant scoping, idempotency, optimistic concurrency and audit behaviour exactly.
- The API is the only thing that changes shape. Do not adjust the review console to compensate; if it needs changing, that is a finding to report.

## Work

1. **Relax `idPattern`** in `packages/contracts/src/ids.ts` to accept the prefixed identifiers the system actually issues, keeping the branded types intact.

2. **Case summary** — both services emit, in addition to what they already send:
   - `title` (the subject the console shows, currently `subjectName`)
   - `domainPackId` and `domainPackVersion` (currently collapsed into `domain`)
   - `openFindings` (currently inside `findingCounts`)
   - `version` (already tracked for optimistic concurrency; simply not surfaced)

3. **Case detail** — as above, plus `documents`, `facts` and `findings` satisfying `DocumentSchema`, `ExtractedFactSchema` and `FindingSchema`.

4. **Document responses** — `POST /v1/cases/:id/documents` and the documents inside a case detail must carry `tenantId`, `caseId`, `mediaType`, `byteSize`, `sha256`, `classification`, `classificationConfidence`, `duplicateOf`, `versionOf`, `warnings` and `createdAt`. The durable path already computes `sha256` and holds the media type and byte length at upload; the demo path may need to record them.

5. **Turn the parked test back on.** `apps/api/test/api.e2e.test.ts` carries an `it.fails` test named "case responses do not match their declared contract schema", which documents this divergence and passes only while it exists. Delete it and assert the schemas for real, in the flow tests, using `expectMatchesSchema` / `expectCursorPageMatchesSchema` from `apps/api/test/support/contract.ts`.

## Verification

`npm run verify`, then `npm run test:e2e` against the running production-local stack — the console reads these payloads, so a regression shows up there rather than in a unit test.

## Self-Review

- Additive changes mean the review console keeps working unchanged; the contract stops being fiction.
- The id relaxation is the single concession, argued above, and is scoped to the pattern.
