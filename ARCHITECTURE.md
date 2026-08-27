# CaseLens Architecture

CaseLens is a domain-neutral document intelligence and compliance-review platform. The included pharmacy supplier workflow is a reference domain, not a hard-coded product boundary.

## System shape

```text
Next.js review console
        |
        v
NestJS application API <---- read-only MCP server
        |
        +---- case and document services
        +---- versioned domain packs and deterministic rules
        +---- provider registry and typed ports
        |
        v
NestJS workflow worker
        |
        +---- validation and malware scan gate
        +---- native text extraction / OCR fallback
        +---- schema-constrained fact extraction
        +---- reconciliation and conflict detection
        +---- scoped policy retrieval
        +---- deterministic evaluation
        +---- human-review checkpoint
```

Production adapters are defined for PostgreSQL/pgvector, Redis/BullMQ, S3-compatible storage, HTTP OCR, and configurable model APIs. Demo mode binds deterministic in-memory adapters so the complete review experience runs without credentials.

The production-local worker consumes BullMQ jobs and runs the LangGraph state machine with PostgreSQL checkpoints, MinIO sources, PyMuPDF/Tesseract extraction, Ollama models, and pgvector retrieval. Demo mode retains the deterministic progress simulator; see [`docs/architecture/langgraph-workflow.md`](docs/architecture/langgraph-workflow.md).

## Design boundaries

- `apps/web` contains presentation and interaction logic; the API remains authoritative.
- `apps/api` exposes tenant-scoped application operations and audit-safe mutations.
- `apps/worker` owns long-running document and workflow execution.
- `apps/mcp` provides a read-only agent interface over the application API.
- `packages/domain` contains versioned domain packs and an allowlisted rule DSL.
- `packages/providers` isolates model, OCR, storage, retrieval, queue, scanner, and persistence vendors behind typed ports.
- `packages/document-pipeline` preserves document, page, extraction, confidence, and evidence provenance.
- `packages/retrieval` enforces tenant, domain, pack-version, validity, and revocation scope before ranking evidence.
- `packages/workflow` owns resumable orchestration and human-review pauses.
- `packages/persistence` defines the PostgreSQL/pgvector schema, indexes, and tenant RLS policies.

## Provider interchangeability

Application and domain code depend on capabilities rather than SDK-specific types. Providers are selected through validated configuration and a capability-aware registry. Replacing a model or infrastructure service therefore requires an adapter plus configuration, not changes to business rules or the review UI.

## Domain interchangeability

A domain pack versions its document taxonomy, extraction schemas, thresholds, policy metadata, rules, decision mapping, and reviewer checklist. New legal, insurance, or manufacturing workflows can be introduced as new packs while sharing ingestion, evidence, workflow, audit, and provider infrastructure.

## Safety model

- Uploaded bytes are validated by signature, MIME, size, page count, encryption state, and scanner result before processing.
- Document text is always treated as untrusted data; it cannot introduce executable rules or tool instructions.
- Material facts and findings retain source evidence references.
- Long documents are extracted in bounded page-aware chunks, and model-produced citations are accepted only when their normalized quote is present on the claimed page.
- Structured model responses are validated against application-owned schemas before entering workflow state.
- Deterministic rules own thresholds and approval gates; model output remains advisory.
- Tenant scope is enforced in contracts, retrieval filters, repository design, and PostgreSQL RLS.
- Corrections and decisions use optimistic concurrency and append audit events.

## Runtime profiles

The repository has two deliberately separate application profiles:

- `infra/docker-compose.demo.yml` starts only the API and web application with deterministic, process-local memory providers. It is the implemented portfolio runtime and requires no infrastructure credentials.
- `infra/docker-compose.production-local.yml` starts the complete local production topology: web, API, worker, PostgreSQL/pgvector, Redis/BullMQ, MinIO, Ollama/model provisioning, and the OCR service.

The PostgreSQL bootstrap creates `caselens_runtime` as a `NOLOGIN` least-privilege group role. A one-shot local provisioner creates `caselens_app`, sets its ignored environment-file password, and grants only that group role.

`APP_MODE=production` requires durable providers and normally verified OIDC. The local topology is the explicit exception: `AUTH_MODE=test-profiles` is accepted only with `ENABLE_TEST_IDENTITY_SWITCHER=true`. That switch must never be used for a public deployment.

For deeper detail, see:

- [`docs/specs/caselens.md`](docs/specs/caselens.md) — product and architecture specification
- [`docs/architecture/domain-pack-authoring.md`](docs/architecture/domain-pack-authoring.md) — adding or changing business domains
- [`docs/operations/provider-switching.md`](docs/operations/provider-switching.md) — changing AI and infrastructure providers
- [`docs/operations/security-and-privacy.md`](docs/operations/security-and-privacy.md) — threat assumptions and operational safeguards
- [`docs/superpowers/plans/2026-08-26-caselens.md`](docs/superpowers/plans/2026-08-26-caselens.md) — implementation record and remaining production backlog
