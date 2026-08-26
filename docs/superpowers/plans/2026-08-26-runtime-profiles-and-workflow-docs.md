# Runtime Profiles and LangGraph Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate the zero-credential demo from PostgreSQL/Redis/MinIO infrastructure and document every application component plus the implemented LangGraph workflow in the README.

**Architecture:** `infra/docker-compose.demo.yml` will run only the API and web application with deterministic in-memory providers. `infra/docker-compose.prod-infra.yml` will run PostgreSQL/pgvector, password-protected Redis, and MinIO as a separate production-infrastructure development stack; it will not claim that the still-guarded production application composition is complete. The README will use Mermaid diagrams generated from the actual edges in `packages/workflow/src/workflow.ts` and explicitly distinguish implemented/tested workflow code from the current demo worker wiring.

**Tech Stack:** Docker Compose, PostgreSQL 17 with pgvector, Redis 8, MinIO/S3, Next.js, NestJS, LangGraph.js, Mermaid, npm

**Spec:** `ARCHITECTURE.md`, `docs/specs/caselens.md`, and `packages/workflow/src/workflow.ts`

## Global Constraints

- Keep `APP_MODE=demo` deterministic, zero-credential, and independent of PostgreSQL, Redis, and MinIO.
- Do not weaken the production startup guard or imply that durable repositories, OIDC, BullMQ consumption, S3 storage, or readiness composition are complete.
- Do not run the unused demo worker as though its process-local memory queue communicated with the API.
- Keep infrastructure secrets outside committed Compose files; commit only a clearly non-production example environment file.
- Derive the LangGraph diagram from the actual graph nodes and conditional edges in `packages/workflow/src/workflow.ts`.

---

### Task 1: Split Docker runtime definitions

**Files:**

- Create: `infra/docker-compose.demo.yml`
- Create: `infra/docker-compose.prod-infra.yml`
- Create: `infra/.env.prod-infra.example`
- Delete: `infra/docker-compose.yml`
- Modify: `infra/postgres/init/001_roles_extensions.sql`

**Interfaces:**

- Consumes: the existing multi-stage Node image and PostgreSQL initialization scripts.
- Produces: `docker compose -f infra/docker-compose.demo.yml up --build -d` for the application demo and `docker compose --env-file infra/.env.prod-infra -f infra/docker-compose.prod-infra.yml up -d` for infrastructure development.

- [x] **Step 1: Create the minimal demo Compose file**

Define only `api` and `web`. Configure the API with memory persistence, queue, storage, and search plus deterministic model/OCR/scanner providers. Retain API and web health/dependency behavior without infrastructure dependencies.

- [x] **Step 2: Create the production-infrastructure Compose file**

Define PostgreSQL/pgvector, Redis, and MinIO with health checks, persistent named volumes, localhost port bindings, and values supplied through `infra/.env.prod-infra`.

- [x] **Step 3: Add the environment template and remove the ambiguous Compose file**

Provide explicit local-development examples for database, Redis, and MinIO credentials, remove the combined `infra/docker-compose.yml` so no command accidentally starts unused services with the demo, and replace the hard-coded database login password with a `NOLOGIN` least-privilege group role for deployment-time credential provisioning.

### Task 2: Update operational references and validation

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/plans/2026-08-26-caselens.md`
- Modify: `docs/superpowers/plans/2026-08-26-npm-migration.md`

**Interfaces:**

- Consumes: the two new Compose files.
- Produces: CI syntax validation and accurate contributor commands.

- [x] **Step 1: Validate both Compose definitions in CI**

Run `docker compose ... config --quiet` for the demo and production-infrastructure files using CI-only environment values for required secrets.

- [x] **Step 2: Update agent and implementation documentation**

Replace references to the old combined demo stack and remove the claim that MinIO credentials belong to the demo runtime.

### Task 3: Document components and the real LangGraph flow

**Files:**

- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Create: `docs/architecture/langgraph-workflow.md`

**Interfaces:**

- Consumes: current application/package boundaries and the graph in `packages/workflow/src/workflow.ts`.
- Produces: a concise README component-purpose table and LangGraph diagram, plus a durable node-by-node workflow reference and honest wiring-status notes.

- [x] **Step 1: Document the two runtime commands and components**

Explain web, API, worker, MCP, shared packages, PostgreSQL, Redis, and MinIO, including which runtime actually uses them.

- [x] **Step 2: Add the current LangGraph Mermaid diagram**

Show `START → validate → extract → classify → reconcile → retrieve → evaluate`, failure exits after the first four provider-backed stages, the review branch, the summarize/complete branch, and the human resume path that re-evaluates corrected facts.

- [x] **Step 3: Document current wiring limitations**

State that `CaseWorkflowRunner` is implemented and tested but the current `apps/worker` demo runner is a deterministic progress simulator, while production worker/BullMQ/checkpoint composition remains backlog.

### Task 4: Verify and review

**Files:**

- Test: Compose files, Markdown, repository quality gates

**Interfaces:**

- Consumes: all changed runtime and documentation files.
- Produces: a clean, reviewable commit with verification evidence.

- [x] **Step 1: Run static and repository checks**

Run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check`.

- [x] **Step 2: Validate Compose where Docker is available**

Run `docker compose -f infra/docker-compose.demo.yml config --quiet` and the production-infrastructure equivalent with the example environment file. If Docker remains unavailable on PATH, record that exact limitation rather than claiming validation.

- [x] **Step 3: Review the final diff**

Confirm the demo has no SQL/Redis/MinIO dependency, production infrastructure contains no committed real secret, the Mermaid graph matches the TypeScript edges, and no old Compose command remains.

## Verification evidence

- `npm run verify` passed: formatting, lint, TypeScript checks, Playwright test type-checking, unit tests, and all package/application builds.
- Docker Compose 29.7.2 parsed both files successfully with `config --quiet`; the production-infrastructure check used `infra/.env.prod-infra.example`. The daemon was not required for this syntax/configuration validation.
- `git diff --check` passed.
- Final five-axis review found and removed the existing hard-coded `caselens_runtime` password. The bootstrap now creates a least-privilege `NOLOGIN` role for deployment-time credential provisioning.
- Repository search found no operational reference to the removed combined Compose command and no old local-only MinIO/database passwords; its two remaining `infra/docker-compose.yml` mentions are intentional migration-history entries in this plan.
