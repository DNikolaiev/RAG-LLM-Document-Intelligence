# Local Production and Multi-Tenancy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a production-like local Docker runtime that uses PostgreSQL, Redis/BullMQ, MinIO, Ollama, local OCR, and a test-only multi-tenant profile switcher with a cross-tenant platform administrator.

**Architecture:** Preserve the deterministic demo while introducing explicit runtime factories for durable providers. The API owns tenant authorization and durable case mutations; BullMQ separates HTTP work from a LangGraph worker; PostgreSQL RLS enforces the selected tenant again. A server-resolved profile cookie drives the test identity context and cannot be enabled accidentally for a future public runtime.

**Tech Stack:** NestJS, Next.js, PostgreSQL 17/pgvector, Redis 8/BullMQ, MinIO/S3, Ollama, Qwen3, EmbeddingGemma, FastAPI/Tesseract, LangGraph.js, Docker Compose, npm, Playwright

**Spec:** `docs/specs/local-production-runtime.md`

## Global Constraints

- Keep `infra/docker-compose.demo.yml` deterministic and independent of durable infrastructure.
- Never accept tenant, role, or platform-admin privilege directly from untrusted browser headers.
- The test identity switcher requires `ENABLE_TEST_IDENTITY_SWITCHER=true` in production mode.
- Every tenant data transaction sets RLS context locally and uses parameterized SQL.
- Model, embedding, OCR, storage, queue, search, and persistence providers remain environment-selected.
- The model produces observations and advisory summaries only; deterministic rules retain decision authority.

---

### Task 1: Runtime configuration and test identities

**Files:**

- Modify: `packages/config/src/index.ts`
- Create: `packages/contracts/src/test-identities.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/config/src/index.test.ts`

**Interfaces:**

- Produces `TestProfile`, `TEST_PROFILES`, `resolveTestProfile(profileId)`, model/embedding names, vector dimension, queue name, and the guarded switcher flag.

- [x] Add failing configuration tests for production rejection without OIDC or the explicit test-profile flag, and for the complete durable-provider configuration.
- [x] Add the fictional profile/tenant catalog, including four tenant administrators and one `platform_admin` with access to all tenants.
- [x] Add and validate `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `QUEUE_NAME`, and `ENABLE_TEST_IDENTITY_SWITCHER`.
- [x] Run the config/contracts type checks and tests.

### Task 2: Durable tenant-aware case store

**Files:**

- Create: `packages/persistence/src/case-store.ts`
- Create: `packages/persistence/src/case-store.test.ts`
- Modify: `packages/persistence/src/index.ts`
- Modify: `infra/postgres/init/010_schema.sql`
- Modify: `infra/postgres/init/020_rls_grants.sql`
- Create: `infra/postgres/init/030_seed.sql`

**Interfaces:**

- Produces `CaseStore`, `MemoryCaseStore`, and `PostgresCaseStore`; each operation accepts an `AccessScope` containing allowed tenant IDs and `platformAdmin`.
- Stores the UI review projection in `cases.metadata.reviewProjection` while mirroring indexed case columns and using normalized document/job/audit rows for infrastructure operations.

- [x] Add contract tests proving tenant denial, platform-admin aggregation, cursor stability, optimistic conflicts, and idempotent jobs.
- [x] Implement transaction-local RLS context and parameterized queries.
- [x] Extend RLS policies with an explicit platform-admin transaction flag and add missing foreign-key indexes.
- [x] Seed four tenants, fictional users/memberships, domain packs, and one domain-specific case per tenant.
- [x] Run persistence tests and schema validation.

### Task 3: API durable provider composition

**Files:**

- Create: `apps/api/src/runtime.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/cases.service.ts`
- Modify: `apps/api/src/cases.controller.ts`
- Modify: `apps/api/src/jobs.controller.ts`
- Modify: `apps/api/src/health.controller.ts`
- Modify: `apps/api/src/context.middleware.ts`
- Modify: `apps/api/src/request-context.ts`
- Test: `apps/api/test/api.e2e.test.ts`

**Interfaces:**

- Demo composition returns memory case/storage/queue providers; production-like composition returns PostgreSQL, S3-compatible, BullMQ, and pgvector providers.
- `RequestContext` contains `profileId`, `tenantIds`, `activeTenantId`, `role`, and `platformAdmin` resolved from the trusted catalog.

- [x] Add failing API tests for profile resolution, cross-tenant denial, platform aggregation, durable upload keys, and role checks.
- [x] Replace process-local case/job maps with injected stores while retaining current business invariants.
- [x] Persist validated uploads to MinIO before recording the document and enqueue processing through BullMQ.
- [x] Make readiness execute actual provider/database checks.
- [x] Run API tests and type checks.

### Task 4: Free local AI, OCR, and worker processing

**Files:**

- Modify: `packages/providers/src/adapters/http.ts`
- Create: `packages/providers/src/adapters/pdf.ts`
- Modify: `packages/providers/src/index.ts`
- Create: `packages/workflow/src/postgres-checkpoints.ts`
- Modify: `packages/workflow/src/index.ts`
- Create: `apps/worker/src/runtime.ts`
- Modify: `apps/worker/src/case.processor.ts`
- Modify: `apps/worker/src/worker.module.ts`
- Modify: `apps/worker/src/main.ts`
- Create: `services/ocr/app.py`
- Create: `services/ocr/requirements.txt`
- Create: `services/ocr/Dockerfile`
- Test: `packages/providers/test/providers.test.ts`
- Test: `apps/worker/test/case.processor.test.ts`

**Interfaces:**

- The OpenAI-compatible adapter uses separate chat and embedding model names and validates every structured response.
- The worker consumes queue `QUEUE_NAME`, loads documents from storage, runs native extraction/OCR/model/retrieval through `CaseWorkflowRunner`, and saves checkpoint/job/case state.

- [x] Add provider tests for Ollama-compatible JSON mode, embedding dimension validation, native PDF extraction, and OCR response validation.
- [x] Implement PDF text extraction and a local Tesseract HTTP adapter service.
- [x] Implement PostgreSQL workflow checkpoints with optimistic revisions.
- [x] Replace the simulator-only worker bootstrap with a BullMQ consumer and real LangGraph composition while retaining deterministic unit fixtures.
- [x] Persist progress, results, provider provenance, and safe failure state.
- [x] Run provider, workflow, and worker tests.

### Task 5: Test profile switcher and cross-tenant queue

**Files:**

- Create: `apps/web/lib/session-profile.ts`
- Create: `apps/web/app/api/session/profile/route.ts`
- Create: `apps/web/components/profile-switcher.tsx`
- Modify: `apps/web/components/brand-header.tsx`
- Modify: `apps/web/app/api/cases/[...segments]/route.ts`
- Modify: `apps/web/lib/demo-data.ts`
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `apps/web/test/profile-switcher.test.tsx`
- Test: `apps/web/e2e/queue.spec.ts`

**Interfaces:**

- `GET /api/session/profile` returns the selected safe profile and catalog; `POST` validates a profile ID and writes an HTTP-only, same-site cookie.
- Server-side API forwarding converts the resolved profile into trusted internal headers; the queue renders a tenant column only for platform-admin aggregation.

- [x] Add failing component and Playwright tests for keyboard profile selection, tenant switching, role copy, and platform aggregation.
- [x] Implement the server-resolved cookie endpoint and compact accessible profile menu in the existing evidence-led visual language.
- [x] Forward only catalog-derived identity context and invalidate navigation data after a switch.
- [x] Render tenant context on the aggregate board and role/tenant context in the header.
- [x] Run web tests, accessibility assertions, and responsive Playwright coverage.

### Task 6: Full local production Compose topology

**Files:**

- Replace: `infra/docker-compose.prod-infra.yml` with `infra/docker-compose.production-local.yml`
- Modify: `infra/.env.prod-infra.example`
- Create: `infra/docker/ollama-init.sh`
- Modify: `infra/docker/node.Dockerfile`
- Modify: `.github/workflows/ci.yml`
- Modify: `.gitignore`

**Interfaces:**

- One command starts PostgreSQL, Redis, MinIO, bucket initialization, Ollama, model initialization, OCR, API, worker, and web on an internal network; only web, API docs, and development consoles bind to loopback.

- [x] Add the complete Compose graph with health checks, named volumes, non-root application containers, restart behavior, and required secrets from an ignored environment file.
- [x] Pull `qwen3:4b` and `embeddinggemma:300m-qat-q4_0` idempotently before API/worker readiness.
- [x] Create the MinIO bucket idempotently before upload traffic.
- [x] Validate Compose configuration in CI and locally.

### Task 7: Documentation, integration verification, and review

**Files:**

- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/architecture/langgraph-workflow.md`
- Modify: `AGENTS.md`
- Modify: this plan

**Interfaces:**

- Documents exact startup, first model-download expectations, profile matrix, tenant boundary, service URLs, data reset, and model overrides.

- [x] Run `npm run verify`, OCR fixture checks, Compose config validation, and `git diff --check`.
- [x] Start the production-like stack and verify PostgreSQL, Redis, MinIO, Ollama, OCR, API, worker, and web health.
- [x] Run Playwright against the production-like stack and inspect desktop/mobile layouts and the HTML report.
- [x] Review correctness, readability, architecture, security, and performance; resolve all required findings.
- [x] Commit the completed runtime with verification evidence in this plan.

## Completion record — 2026-08-27

- `npm run verify`: passed formatting, lint, type checks, unit/API tests, and production builds.
- Fixture verification: 12 rendered PDFs plus 6 quarantine/duplicate edge cases passed.
- Durable database integration: case-store tenancy, pgvector RLS, and PostgreSQL checkpoints passed (3/3); CI now runs them against pgvector/PostgreSQL.
- Playwright: 14/14 desktop and mobile scenarios passed, including visibility, clickability, navigation, profile switching, and horizontal-overflow assertions.
- Production readiness: persistence, queue, and storage checks are healthy; all local Docker services are running.
- Live AI workflow: legal case `case_85bce97b430b923dc7dbf2d322`, job `job_118bb728a16a087a19654e1571`, reached `needs_review` with a validated `commercial_contract` classification and exact page-cited governing-law fact.
- Production dependency audit: 0 known runtime vulnerabilities.
- Review: all required identity, RLS, provider interchangeability, domain extraction, citation, checkpoint durability, budget, and CI findings resolved.
