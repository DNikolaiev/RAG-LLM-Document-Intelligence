# Policy Library and Rule Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let authorised administrators upload immutable policy documents, index their cited clauses for tenant-scoped retrieval, review AI-generated rule proposals, test them, and explicitly activate safe deterministic rules.

**Architecture:** The API owns policy lifecycle and approval invariants, MinIO owns immutable originals, the worker owns extraction/OCR/embedding and proposal generation, PostgreSQL owns versioned metadata and audit history, and pgvector owns scoped policy-chunk retrieval. Policy text is untrusted evidence: AI may propose a constrained condition tree, but only a validated, human-approved rule version can be activated.

**Tech Stack:** NestJS 11, TypeScript 6, Zod 4, BullMQ/Redis, PostgreSQL 17, Drizzle ORM, pgvector, MinIO/S3, Ollama-compatible structured generation and embeddings, Next.js 16, React 19, Vitest, Playwright

**Spec:** `docs/specs/caselens.md`

## Global Constraints

- Tenant administrators can manage only their own tenant; the platform administrator can manage all tenants.
- The first release accepts PDF policy sources in English, German, or mixed-language documents.
- Original files and activated versions are immutable; active versions are superseded or revoked, never deleted.
- AI output is advisory and schema-constrained. Uploaded text cannot execute instructions, code, tools, or rules.
- Rule activation requires supported fact paths, compatible operators/value types, exact policy citations, deterministic test cases, and explicit human approval.
- Existing case evaluations remain pinned to the policy and rule versions used; re-evaluation is explicit.
- Shared provider boundaries remain vendor-neutral.
- All writes are tenant-scoped, idempotent, optimistic where mutable, and append an audit event.

---

### Task 1: Safe rule-proposal governance

**Files:**

- Create: `packages/domain/src/policies/governance.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/policy-governance.test.ts`

**Interfaces:**

- Consumes: `DomainPack`, `Condition`, and the existing allowlisted rule DSL.
- Produces: `PolicyRuleProposal`, `validateRuleProposal(proposal, pack)`, `assertPolicyTransition(from, to)`, and `assertProposalTransition(from, to)`.

- [ ] Write tests proving unknown fact paths, incompatible values, missing citations, missing boundary tests, self-approval, and illegal lifecycle transitions are rejected.
- [ ] Implement recursive condition validation against the domain-pack extraction-field catalog.
- [ ] Require exact source citations and four deterministic test categories: match, no-match, missing-value, and boundary.
- [ ] Implement explicit policy and proposal transition graphs.
- [ ] Run `npm test -w @caselens/domain` and commit the passing slice.

### Task 2: Canonical policy persistence

**Files:**

- Modify: `packages/persistence/src/schema.ts`
- Create: `packages/persistence/migrations/0005_policy_library.sql`
- Create: `packages/persistence/src/policy-store.ts`
- Modify: `packages/persistence/src/index.ts`
- Test: `packages/persistence/src/policy-store.integration.test.ts`

**Interfaces:**

- Consumes: tenant/user/domain-pack identifiers and validated governance values from Task 1.
- Produces: `PostgresPolicyStore` methods for create/list/get/record-processing/proposals/approval/activation/revocation.

- [ ] Add immutable policy-version, page, clause/chunk, proposal, approved-rule, rule-test, and citation tables with indexed foreign keys.
- [ ] Consolidate `policy_search_chunks` into canonical version-owned chunks, retaining HNSW, full-text, validity, tenant, domain, collection, and version filters.
- [ ] Enable and force RLS on every tenant table; add tenant/platform-admin policies using transaction-local request settings.
- [ ] Add constraints for lifecycle state, page ranges, version uniqueness, effective dates, proposal approval, and rule-test categories.
- [ ] Write integration tests for tenant isolation, platform-admin visibility, immutable activation, conflicts, and rollback.
- [ ] Run the database integration suite and commit the passing slice.

### Task 3: Policy upload API

**Files:**

- Create: `apps/api/src/policies/policies.controller.ts`
- Create: `apps/api/src/policies/policies.service.ts`
- Create: `apps/api/src/policies/policy-runtime.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/policies.e2e.test.ts`

**Interfaces:**

- Consumes: `PostgresPolicyStore`, `ObjectStorageProvider`, `JobQueueProvider`, request identity, and PDF validation.
- Produces: list/detail/upload/review/approve/activate/revoke endpoints under `/v1/policies`.

- [ ] Test tenant and role gates before implementing endpoints.
- [ ] Validate PDF signature, encryption, page/size limits, malware status, dates, version label, domain pack, and policy collection.
- [ ] Store the original under a tenant-scoped immutable key and persist its SHA-256 before enqueueing.
- [ ] Enqueue `process_policy` with the database policy-version/job IDs, uploader ID, tenant, domain, collection, and idempotency key.
- [ ] Add RFC 9457 errors for invalid upload, conflict, unavailable storage/queue, invalid transition, and stale version.
- [ ] Test duplicate idempotency requests and partial-failure cleanup behavior.
- [ ] Run `npm test -w @caselens/api` and commit the passing slice.

### Task 4: Worker policy ingestion and indexing

**Files:**

- Create: `apps/worker/src/policy/policy.processor.ts`
- Create: `apps/worker/src/policy/policy-pipeline.ts`
- Modify: `apps/worker/src/production-runtime.ts`
- Test: `apps/worker/test/policy-pipeline.test.ts`
- Test: `packages/providers/test/pgvector.integration.test.ts`

**Interfaces:**

- Consumes: immutable object bytes, page extraction/OCR, embedding/model providers, `PostgresPolicyStore`, and the canonical vector adapter.
- Produces: versioned policy pages/chunks and reviewable rule proposals with provenance.

- [ ] Validate stored bytes again and extract page-aware native text with OCR fallback.
- [ ] Detect headings, numbered clauses, tables, and appendices without crossing significant clause boundaries.
- [ ] Persist page/heading/range provenance before embedding.
- [ ] Index only successfully embedded chunks and persist embedding provider/model/version.
- [ ] Ask the model for constrained proposals using untrusted-document delimiters and a strict output schema.
- [ ] Verify every proposed citation is an exact normalized quote on the claimed page.
- [ ] Validate proposed conditions with Task 1; invalid proposals remain visible but cannot enter review.
- [ ] Make every step idempotent and resumable, then test crash/retry, partial OCR, provider outage, stale model, empty policy, and cross-tenant isolation.
- [ ] Run worker, retrieval, provider, and database integration tests and commit the passing slice.

### Task 5: Review, testing, and activation API

**Files:**

- Modify: `apps/api/src/policies/policies.controller.ts`
- Modify: `apps/api/src/policies/policies.service.ts`
- Test: `apps/api/test/policies.e2e.test.ts`

**Interfaces:**

- Consumes: processed policy version, proposals, source citations, current identity, and optimistic version.
- Produces: reviewed proposals, deterministic dry-run results, and an atomic active version/rule bundle.

- [ ] Add proposal accept/edit/reject actions with reasons and optimistic versions.
- [ ] Accept only the structured rule DSL; never accept source code or arbitrary expressions.
- [ ] Require deterministic positive, negative, missing-value, and boundary cases and execute them with the existing evaluator.
- [ ] Surface conflicting active policies and require an explicit priority decision.
- [ ] Atomically approve/activate the version and rules; supersede the previous active version without rewriting historical runs.
- [ ] Add explicit re-evaluation request creation rather than automatically changing existing cases.
- [ ] Test role gates, self-approval warning in local mode, production four-eyes enforcement, failed tests, conflicts, scheduling, superseding, and revocation.
- [ ] Run the API suite and commit the passing slice.

### Task 6: Policy library UI

**Files:**

- Create: `apps/web/app/policies/page.tsx`
- Create: `apps/web/app/policies/[policyId]/page.tsx`
- Create: `apps/web/app/api/policies/[...segments]/route.ts`
- Create: `apps/web/components/policy/policy-upload.tsx`
- Create: `apps/web/components/policy/policy-review-workspace.tsx`
- Create: `apps/web/components/policy/rule-builder.tsx`
- Create: `apps/web/app/policies.css`
- Modify: `apps/web/components/brand-header.tsx`
- Modify: `apps/web/app/layout.tsx`
- Test: `apps/web/test/policy-review.test.tsx`
- Test: `apps/web/e2e/policies.spec.ts`

**Interfaces:**

- Consumes: `/v1/policies` DTOs and the selected local test identity.
- Produces: tenant-scoped library, upload status, source/proposal comparison, rule tests, approval, activation, superseding, and revocation interactions.

- [ ] Add a primary navigation entry visible to tenant/platform administrators.
- [ ] Build a library grouped by tenant/domain with clear status, active version, effective period, processing state, and next action.
- [ ] Build an accessible PDF upload form with version, collection, validity, and language fields.
- [ ] Build a source-first review workspace showing the original clause beside the proposed condition and test outcomes.
- [ ] Use a structured condition builder; expose JSON read-only in an advanced disclosure.
- [ ] Keep the quality-control docket visual language, visible focus, reduced motion, and 360px responsiveness.
- [ ] Test role visibility, profile/tenant switching, upload, processing failure, proposal validation, approval, activation, and no horizontal overflow.
- [ ] Run web unit, type, build, and Playwright tests and commit the passing slice.

### Task 7: Seed data, documentation, and release verification

**Files:**

- Modify: `scripts/generate-fixtures.py`
- Modify: `fixtures/documents/*/manifest.json`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/architecture/domain-pack-authoring.md`
- Modify: `docs/operations/provider-switching.md`
- Modify: `docs/operations/security-and-privacy.md`
- Modify: `docs/operations/observability.md`
- Modify: `docs/testing/strategy.md`
- Modify: `infra/docker-compose.production-local.yml`

**Interfaces:**

- Consumes: completed policy workflow and local-production topology.
- Produces: reproducible policy fixtures, startup instructions, technology/schema/process documentation, and verified production-local behavior.

- [ ] Seed English, German, mixed-language, scanned, rotated, table-heavy, conflicting, future-effective, revoked, corrupt, encrypted, duplicate, and prompt-injection policy samples.
- [ ] Document every technology and the complete processing/action timeline from browser through API, object storage, PostgreSQL, BullMQ/Redis, worker, OCR/model, pgvector, review, activation, and case evaluation.
- [ ] Document policy/rule schemas, lifecycle diagrams, provider boundaries, audit fields, RLS scope, retention, and failure recovery.
- [ ] Start the production-local profile, migrate, ingest sample policies, approve rules, retrieve citations, and evaluate a pinned case.
- [ ] Run `npm run verify`, database integration tests, fixture verification, and Playwright.
- [ ] Commit the verified documentation and fixture slice.
