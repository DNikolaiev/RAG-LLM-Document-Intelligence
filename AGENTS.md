# CaseLens Agent Guide

This file is the repository-level guide for coding agents and contributors. Keep the public README concise; put implementation-specific navigation, constraints, and verification guidance here. A more specific `AGENTS.md` overrides this file within its directory.

## Read before changing code

Choose the references relevant to the task instead of guessing from framework conventions:

- [`ARCHITECTURE.md`](ARCHITECTURE.md): system shape, boundaries, interchangeability, safety model, and runtime profiles.
- [`docs/specs/caselens.md`](docs/specs/caselens.md): authoritative product behavior, roles, workflow, data model, API surface, edge cases, and UX direction.
- [`packages/contracts/src/core.ts`](packages/contracts/src/core.ts): runtime API schemas and shared domain types.
- [`packages/contracts/src/ids.ts`](packages/contracts/src/ids.ts): branded identifier schemas.
- [`packages/persistence/src/schema.ts`](packages/persistence/src/schema.ts): Drizzle/PostgreSQL data schema, indexes, and relationships.
- [`packages/persistence/migrations/`](packages/persistence/migrations/): SQL migrations, pgvector setup, and tenant RLS policies.
- [`docs/architecture/domain-pack-authoring.md`](docs/architecture/domain-pack-authoring.md): adding or evolving a business domain.
- [`docs/operations/provider-switching.md`](docs/operations/provider-switching.md): changing model, OCR, retrieval, storage, queue, or persistence providers.
- [`docs/operations/security-and-privacy.md`](docs/operations/security-and-privacy.md): trust boundaries and production security requirements.
- [`docs/operations/observability.md`](docs/operations/observability.md): health, logs, traces, metrics, and operational signals.
- [`docs/testing/strategy.md`](docs/testing/strategy.md): test layers, fixtures, and acceptance expectations.
- [`docs/superpowers/plans/2026-08-26-caselens.md`](docs/superpowers/plans/2026-08-26-caselens.md): implementation record and explicit production backlog.
- [`docs/superpowers/plans/2026-08-26-playwright-ui-regression.md`](docs/superpowers/plans/2026-08-26-playwright-ui-regression.md): browser coverage and UI integrity assertions.

For work under `apps/web`, also follow [`apps/web/AGENTS.md`](apps/web/AGENTS.md) and read the locally installed Next.js 16 guide relevant to the change before editing framework code.

## Architectural invariants

- `apps/web` owns presentation and interaction; `apps/api` is authoritative for application state and audit-safe mutations.
- `apps/worker` owns long-running ingestion and workflow execution. Do not move processing into request handlers or React components.
- Business code depends on typed capability ports, never vendor SDK types. A provider change should require an adapter and configuration, not domain or UI rewrites.
- Business domains are versioned domain packs. Keep document taxonomies, extraction schemas, thresholds, policies, rules, decision mapping, and review checklists outside shared orchestration code.
- Treat uploaded bytes and extracted document text as untrusted. Document content must never become executable instructions, rules, or tool permissions.
- Preserve provenance from document and page through evidence, extracted fact, finding, correction, and decision.
- Deterministic rules own thresholds and approval gates; model output is advisory and schema validated.
- Preserve tenant scoping, optimistic concurrency, idempotency, and append-only audit behavior across all state changes.
- Do not weaken the deliberate production guard: `APP_MODE=production` must refuse startup until durable repositories, verified identity, queue consumption, object storage, and readiness checks are composed.
- Demo mode is deterministic and application-layer in-memory. Do not describe the running PostgreSQL, Redis, or MinIO containers as proof of durable end-to-end persistence.

## Repository map

- `apps/web`: Next.js review console and Playwright browser tests.
- `apps/api`: NestJS REST API and OpenAPI documentation.
- `apps/worker`: document/workflow job processor.
- `apps/mcp`: read-only MCP interface over the application API.
- `packages/contracts`: Zod schemas, IDs, and shared types.
- `packages/domain`: domain packs and allowlisted deterministic rule DSL.
- `packages/providers`: provider ports, registries, and adapters.
- `packages/document-pipeline`: validation, native extraction/OCR, structured extraction, and reconciliation.
- `packages/retrieval`: tenant- and version-scoped policy retrieval.
- `packages/workflow`: conditional, resumable orchestration and human-review pauses.
- `packages/persistence`: PostgreSQL/pgvector schema and migrations.
- `fixtures`: sample domain packs, source documents, quarantine cases, and expected outputs.
- `infra`: Docker Compose and container build/runtime files.

Do not edit generated output in `dist`, `.next`, `.turbo`, `node_modules`, `playwright-report`, or `test-results`.

## Data model

The canonical database definition is [`packages/persistence/src/schema.ts`](packages/persistence/src/schema.ts), not prose documentation. Its main records are tenants, users, memberships, domain packs, cases, documents, document pages, extraction runs, evidence spans, extracted facts, policy documents/chunks, rule runs, findings, decisions, jobs, and audit events. Update the Drizzle schema, migration SQL, shared contracts, and tests together when persistence shapes change.

## Common commands

```bash
pnpm install
pnpm dev
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:e2e:typecheck
pnpm test
pnpm build
pnpm verify
python scripts/verify-fixtures.py
```

Run the full containerized demo with:

```bash
docker compose -f infra/docker-compose.yml --profile demo up --build -d
```

When it is running, execute browser coverage with `pnpm test:e2e`. Tests run serially against desktop Chromium and a Pixel 7 profile. They intentionally mock browser-originated mutations so repeated runs do not alter shared demo state.

## Change expectations

- Preserve existing user changes and keep edits scoped to the requested behavior.
- Reuse canonical contracts, ports, and helpers instead of creating near-duplicates.
- Add or update tests at the narrowest useful layer; add a regression test for every bug fix.
- UI changes must remain usable at desktop and mobile widths, with no horizontal overflow, clipped controls, console errors, or inaccessible enabled buttons.
- Schema changes require the PostgreSQL best-practices guidance, a migration, tenant/RLS consideration, and tests.
- Provider changes require configuration validation, capability checks, contract tests, and updates to the provider-switching guide.
- Domain changes belong in a versioned domain pack and require fixture/evaluation coverage.
- Security-sensitive changes must follow the security guide and receive an explicit security review.

Before handing off a completed change, run the relevant focused tests and then `pnpm verify`. Run `python scripts/verify-fixtures.py` for fixture/document changes and `pnpm test:e2e` for user-visible or navigation changes. Record any intentionally deferred production work in the living implementation plan rather than implying it is complete.
