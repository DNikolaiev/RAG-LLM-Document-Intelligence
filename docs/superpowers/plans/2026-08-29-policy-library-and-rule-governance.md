# Policy Library and Rule Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven development or execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an administrator-managed, versioned policy library whose indexed passages support RAG and whose reviewed rule proposals become safe deterministic rules.

**Architecture:** The API owns policy lifecycle and approval invariants, the worker owns extraction/OCR/embedding/proposal jobs, MinIO owns immutable source bytes, and PostgreSQL/pgvector owns metadata, pages, chunks, proposals, tests, and active rule bundles. AI output is proposal-only and cannot bypass the domain-pack field catalog or human approval.

**Tech Stack:** NestJS, TypeScript, Zod, PostgreSQL 17, pgvector, Drizzle, BullMQ, Redis, MinIO, Ollama-compatible model and embedding ports, Next.js 16, Vitest, Playwright.

**Spec:** `docs/specs/policy-evidence-and-job-feedback.md`

## Global Constraints

- Preserve tenant scoping, optimistic concurrency, idempotency, immutable versions, and append-only audit history.
- Policy document text is untrusted and never executable.
- Provider-specific SDK types cannot cross capability ports.
- Active rules must be deterministic, schema validated, cited, tested, and explicitly approved.
- Existing cases remain pinned to their evaluated policy and rule versions.

---

### Task 1: Canonical policy persistence

**Files:**
- Modify: `packages/persistence/src/schema.ts`
- Modify: `infra/postgres/init/010_schema.sql`
- Modify: `infra/postgres/init/020_rls_grants.sql`
- Modify: `packages/persistence/migrations/9999_post_drizzle.sql`
- Test: `packages/persistence/src/schema.test.ts`

**Interfaces:**
- Produces immutable policy documents/versions/pages/chunks, rule proposals, rule proposal citations, rule tests, approved policy rules, tenant indexes, and RLS coverage.
- Retires `policy_search_chunks` as a duplicate write model; `policy_chunks` becomes canonical.

- [ ] Write schema assertions for version uniqueness, indexed foreign keys, vector dimensions, lifecycle constraints, and tenant RLS inclusion.
- [ ] Run the schema test and confirm it fails on the absent tables/columns.
- [ ] Add the Drizzle schema and idempotent SQL migration with `timestamptz`, text check constraints, indexed foreign keys, HNSW/GIN indexes, and tenant/user scoping.
- [ ] Migrate existing search rows into canonical chunks without activating incomplete policies.
- [ ] Run schema and database integration tests.
- [ ] Commit the persistence slice.

### Task 2: Shared lifecycle and rule contracts

**Files:**
- Modify: `packages/contracts/src/core.ts`
- Modify: `packages/contracts/src/ids.ts`
- Modify: `packages/domain/src/domain-pack/schema.ts`
- Create: `packages/domain/src/rules/policy-rule-validator.ts`
- Test: `packages/domain/test/policy-rule-validator.test.ts`

**Interfaces:**
- Produces `PolicyLifecycleStatus`, `RuleProposal`, `PolicyRule`, `PolicyRuleTestCase`, and a validator that accepts only the existing condition DSL and known extraction fields.

- [ ] Write tests rejecting unknown paths, wrong operators, script-like payloads, missing citations, and missing boundary fixtures.
- [ ] Run focused tests and confirm the new cases fail.
- [ ] Add Zod contracts and a deterministic validator that returns structured activation blockers.
- [ ] Add conflict/priority metadata without silently replacing domain-pack rules.
- [ ] Run contracts and domain tests.
- [ ] Commit the contract slice.

### Task 3: Policy repository and API lifecycle

**Files:**
- Create: `packages/persistence/src/policy-store.ts`
- Create: `apps/api/src/policies.controller.ts`
- Create: `apps/api/src/policies.service.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/policies.service.test.ts`
- Test: `apps/api/test/api.e2e.test.ts`

**Interfaces:**
- Produces list/detail/upload/process/proposal-edit/test/approve/activate/revoke endpoints with cursor pagination and RFC 9457 errors.

- [ ] Write service tests for tenant access, platform access, idempotent upload, version conflict, self-approval warning, activation blockers, superseding, and revocation.
- [ ] Implement repository transactions and API schemas.
- [ ] Store source bytes before enqueueing and compensate failed persistence without exposing a partially active version.
- [ ] Require explicit actor identity for every mutation and append audit events.
- [ ] Run API unit and integration tests.
- [ ] Commit the API slice.

### Task 4: Policy ingestion worker

**Files:**
- Create: `apps/worker/src/policy.processor.ts`
- Modify: `apps/worker/src/production-runtime.ts`
- Modify: `packages/retrieval/src/chunking.ts`
- Modify: `packages/providers/src/adapters/infrastructure.ts`
- Test: `apps/worker/test/policy.processor.test.ts`
- Test: `packages/providers/test/pgvector.integration.test.ts`

**Interfaces:**
- Consumes policy-version job payloads and produces extracted pages, canonical chunks, embeddings, constrained proposals, citations, progress events, and review status.

- [ ] Write tests covering native text, OCR fallback, German/English sections, empty pages, tables, prompt injection text, provider failure, retry, and vector-scope isolation.
- [ ] Implement structure-aware page/heading chunking while preserving page citations.
- [ ] Generate embeddings through `ModelProvider` and index only the version being processed.
- [ ] Generate schema-constrained proposals and route invalid/unsupported proposals to review rather than activation.
- [ ] Persist stage transitions and complete the job atomically with version status.
- [ ] Run worker, retrieval, provider, and database tests.
- [ ] Commit the worker slice.

### Task 5: Policy administration workspace

**Files:**
- Create: `apps/web/app/policies/page.tsx`
- Create: `apps/web/app/policies/[policyId]/page.tsx`
- Create: `apps/web/components/policies/policy-library.tsx`
- Create: `apps/web/components/policies/policy-review-workspace.tsx`
- Create: `apps/web/components/policies/rule-proposal-editor.tsx`
- Create: `apps/web/app/policies.css`
- Test: `apps/web/test/policy-library.test.tsx`
- Test: `apps/web/e2e/policies.spec.ts`

**Interfaces:**
- Consumes policy APIs and job events; produces upload, source comparison, proposal review, deterministic test results, approval, activation, superseding, and revocation UI.

- [ ] Write component and browser tests for empty, processing, review, blocked, scheduled, active, superseded, revoked, and failed states.
- [ ] Implement role-aware policy navigation and tenant/platform scope.
- [ ] Implement original-source and proposal comparison with concrete validation messages.
- [ ] Keep advanced JSON read-only and perform edits through the structured condition builder.
- [ ] Verify keyboard navigation, reduced motion, mobile flow, and zero horizontal overflow.
- [ ] Commit the web slice.

### Task 6: Historical pinning and documentation

**Files:**
- Modify: `packages/workflow/src/state.ts`
- Modify: `apps/worker/src/production-runtime.ts`
- Modify: `ARCHITECTURE.md`
- Modify: `README.md`
- Modify: `docs/architecture/domain-pack-authoring.md`
- Modify: `docs/operations/provider-switching.md`

- [ ] Record the exact active policy/version/rule bundle on every rule run and finding.
- [ ] Require explicit case re-evaluation to adopt a newer bundle.
- [ ] Document policy ownership, storage, retrieval, activation, and provider replacement.
- [ ] Run focused tests, `npm run verify`, fixture verification, database integration, and policy Playwright coverage.
- [ ] Commit the completed policy feature.

