# CaseLens Agent Guide

This file is the repository-level guide for coding agents and contributors. Keep the public README concise; put implementation-specific navigation, constraints, and verification guidance here. A more specific `AGENTS.md` overrides this file within its directory.

## Explaining the work

This repository doubles as a learning base for its owner, so the explanation is part of the deliverable rather than a courtesy. Whenever a change introduces a technology, a service, a protocol, a data structure, or a pattern that was not already here, explain it in the reply — not only in code comments.

An explanation that does the job:

- **Says why this and not the obvious alternative.** Name what was rejected and what it would have cost. "RabbitMQ because it is a message broker" is not a reason; "RabbitMQ has no retention, so the outbox stays the log" is.
- **Is grounded in this repository.** Quote the real file and line, the real configuration value, the real command output. Generic documentation prose teaches nothing about this system.
- **Shows the artifact instead of asserting it.** Run the query and paste the plan. List the keys the library actually created. Revert the fix and paste the failing assertion. A measured result outranks a confident claim.
- **Separates the layers.** Which part is the infrastructure, which is the library, which is code in this repository. Conflating them is where most of the confusion starts.
- **States the caveat.** What the change does not solve, what is still missing, and whether something simpler would have been enough. Overselling a change is worse than not explaining it.
- **Corrects a wrong premise in the question** before answering it.

Define a term the first time it appears, in a clause rather than a paragraph. Skip all of this for routine work — a rename, a bug fix inside an existing pattern, another test in an existing suite. The rule is for what is new.

## Keeping the documentation true

`README.md` and `ARCHITECTURE.md` describe the system as it is now. Update them in the same change that would otherwise make them wrong — automatically, without being asked, and never deferred to a follow-up.

This applies to a new service, container, broker, datastore, or external dependency; a change in how components communicate; a new workspace package; a schema change that adds or removes a table or alters a relationship; adopting, rejecting, or removing a technology; and any change to a runtime profile.

Where each thing belongs:

- `README.md` — the components table, "what is stored where", and the runtime narrative.
- `ARCHITECTURE.md` — the system-shape diagram, the design boundaries, the schema section, and the every-table list.
- The living plan under `docs/superpowers/plans/` — the decision itself, the options rejected, and why.

A decision that is later reversed stays in the plan with its reasoning intact. The record of why something was _not_ done is worth as much as the record of what was.

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
npm install
npm run dev
npm run format:check
npm run lint
npm run typecheck
npm run test:e2e:typecheck
npm test
npm run build
npm run verify
python scripts/verify-fixtures.py
```

Run the full containerized demo with:

```bash
docker compose -f infra/docker-compose.demo.yml up --build -d
```

When it is running, execute browser coverage with `npm run test:e2e`. The default Playwright target is `http://127.0.0.1:3000`; override it with `PLAYWRIGHT_BASE_URL`. Tests run serially against desktop Chromium and a Pixel 7 profile. They intentionally mock browser-originated mutations so repeated runs do not alter shared demo state.

The complete local production profile is `infra/docker-compose.production-local.yml`. Copy `infra/.env.production-local.example` to ignored `infra/.env.production-local`, then start it with the matching `--env-file`. It composes durable repositories, BullMQ consumption, MinIO, Ollama, OCR, and dependency-backed readiness. The test identity switcher is local-only and does not replace public authentication.

## Change expectations

- Preserve existing user changes and keep edits scoped to the requested behavior.
- Explain anything new in the reply, and update `README.md` and `ARCHITECTURE.md` in the same change. See [Explaining the work](#explaining-the-work) and [Keeping the documentation true](#keeping-the-documentation-true); neither is optional and neither waits to be asked for.
- Reuse canonical contracts, ports, and helpers instead of creating near-duplicates.
- Add or update tests at the narrowest useful layer; add a regression test for every bug fix.
- UI changes must remain usable at desktop and mobile widths, with no horizontal overflow, clipped controls, console errors, or inaccessible enabled buttons.
- Schema changes require the PostgreSQL best-practices guidance, a migration, tenant/RLS consideration, and tests.
- Provider changes require configuration validation, capability checks, contract tests, and updates to the provider-switching guide.
- Domain changes belong in a versioned domain pack and require fixture/evaluation coverage.
- Security-sensitive changes must follow the security guide and receive an explicit security review.

Before handing off a completed change, run the relevant focused tests and then `npm run verify`. Run `python scripts/verify-fixtures.py` for fixture/document changes and `npm run test:e2e` for user-visible or navigation changes. Record any intentionally deferred production work in the living implementation plan rather than implying it is complete.
