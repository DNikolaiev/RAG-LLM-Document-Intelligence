# CaseLens Product and Architecture Specification

## Product outcome

CaseLens turns mixed business documents into an evidence-backed review case. The portfolio demo evaluates a pharmaceutical supplier, but every domain rule, document type, extraction schema, policy source, and AI provider is selected through configuration rather than embedded in the user interface or workflow.

The demo answer is deliberately non-trivial: MediSupply GmbH must receive **Request information** because its GDP certificate is missing, its insurance limit is below policy, and its legal name conflicts across documents. Reviewers can inspect the supporting page and text span, correct extracted values, rerun deterministic rules, and export a complete audit package.

## Users and permissions

| Role                | Responsibilities                                 | Allowed actions                                                     |
| ------------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| Intake analyst      | Creates a case and uploads documents             | Create, upload, view processing state                               |
| Compliance reviewer | Resolves low-confidence and conflicting evidence | Edit extracted fields, accept/reject findings, request information  |
| Approver            | Owns the final decision                          | Approve, reject, return for review, export                          |
| Auditor             | Verifies historical decisions                    | Read-only case, evidence, model/rule versions, and audit trail      |
| Administrator       | Configures domain packs and providers            | Validate/activate configuration; no silent edits to historical runs |

Every resource is scoped by tenant. Authorization is checked in the application service and enforced again with PostgreSQL row-level security in the production persistence adapter.

## Primary workflow

1. Create a case from an active domain-pack version.
2. Upload one or more files using an idempotency key.
3. Validate MIME signature, size, page count, encryption state, and malware-scan result.
4. Hash and de-duplicate the binary while retaining the new upload event.
5. Extract embedded text; use OCR only on pages whose text quality is insufficient.
6. Classify each document, preserving alternatives and confidence.
7. Extract schema-constrained fields with normalized values, confidence, page, bounding box/text quote, and provider metadata.
8. Reconcile identities and facts across documents without silently overwriting conflicts.
9. Retrieve the applicable policy passages using tenant/domain/version filters.
10. Evaluate deterministic rules and create evidence-linked findings.
11. Pause for a human when evidence is missing, conflicting, or below confidence thresholds.
12. Produce a recommendation; a human records the final decision.
13. Export the case, evidence, configuration versions, and immutable audit events.

## Architecture

```text
Next.js review console
        |
        v
NestJS REST API  ---- PostgreSQL + pgvector
        |                    |
        v                    +-- cases, documents, evidence, findings, audit
Redis/BullMQ
        |
        v
NestJS worker -> document/OCR/model/storage/search provider ports
        |
        v
LangGraph orchestration + deterministic rule engine

MCP server -> read-only application-service facade -> same authorization/audit rules
```

This is a modular monolith plus a separately scalable worker, not a collection of premature microservices. The API owns business invariants. Next.js contains presentation and server-side API calls only. The worker imports the same application/domain packages and runs independently so CPU-heavy extraction and unreliable external providers cannot block HTTP requests.

## Interchangeability boundaries

Provider selection is environment-driven and validated at startup. Application services depend only on ports:

- `ModelProvider`: schema-constrained generation, embeddings, health and capability metadata.
- `DocumentTextProvider`: native PDF/Office text extraction per page.
- `OcrProvider`: OCR with page geometry and language hints.
- `ObjectStorageProvider`: immutable binary and derived-artifact storage.
- `VectorSearchProvider`: index and retrieve policy chunks with mandatory scope filters.
- `JobQueueProvider`: enqueue, retry, cancel, and observe idempotent jobs.
- `VirusScannerProvider`: clean, infected, unavailable, or inconclusive result.
- `CaseRepository`, `DomainPackRepository`, and `AuditRepository`: memory and PostgreSQL implementations.

Adapters include deterministic local providers for a zero-credential demo, an OpenAI-compatible chat/embedding adapter, an Anthropic-style message adapter, generic HTTP OCR, S3-compatible storage, PostgreSQL/pgvector, and BullMQ. New providers register through a typed factory; provider-specific types never cross a port.

## Domain packs

A versioned domain pack is data, not executable code. It defines:

- domain metadata and UI terminology;
- document taxonomy and extraction JSON Schemas;
- required-document rules;
- normalized entity/fact fields and reconciliation keys;
- policy collections and chunking hints;
- deterministic rules expressed in a safe JSON condition DSL;
- thresholds, severity labels, decision mapping, and reviewer checklists.

The condition DSL supports `all`, `any`, `not`, `exists`, `eq`, `neq`, `in`, `contains`, `gte`, `lte`, `before`, and `after`. It has no `eval`, script, network, or filesystem capability. Pack activation requires schema validation and deterministic fixture tests. Historical cases retain the exact activated pack version.

## Data model

Primary identifiers are time-ordered text IDs (ULID) to avoid random-index fragmentation. All mutable records use optimistic version numbers and `timestamptz`. Core tables are tenants, users, memberships, domain_packs, cases, case_participants, documents, document_pages, extraction_runs, extracted_facts, evidence_spans, policy_documents, policy_chunks, rule_runs, findings, decisions, jobs, and audit_events.

Tenant columns and foreign keys are indexed. Partial indexes cover active jobs and unresolved findings. GIN indexes serve JSONB metadata and full-text search; HNSW indexes serve vector retrieval. Production uses transaction pooling, short transactions, cursor pagination, atomic idempotency-key upserts, least-privilege roles, RLS, and `FORCE ROW LEVEL SECURITY`.

## API surface

- `GET /v1/health/live`, `GET /v1/health/ready`
- `GET /v1/domain-packs`, `POST /v1/domain-packs/validate`
- `GET /v1/cases`, `POST /v1/cases`, `GET /v1/cases/:id`
- `POST /v1/cases/:id/documents`, `POST /v1/cases/:id/process`
- `PATCH /v1/cases/:id/facts/:factId`, `POST /v1/cases/:id/re-evaluate`
- `PATCH /v1/cases/:id/findings/:findingId`
- `POST /v1/cases/:id/decisions`, `GET /v1/cases/:id/export`
- `GET /v1/cases/:id/audit`, `GET /v1/jobs/:id`

Mutation endpoints accept an idempotency key. Validation uses shared schemas. Errors follow RFC 9457-style problem details with a stable code, correlation ID, safe message, and optional field issues. List endpoints use opaque cursor pagination.

## AI and workflow safety

- Prompt and model versions are stored with each run.
- All model output is schema-validated; invalid output retries once with repair instructions, then routes to human review.
- Retrieved text is untrusted evidence, never an instruction. Delimiters and prompt policy prevent document-level prompt injection.
- Evidence is required for material extracted facts and every AI-assisted finding.
- Deterministic rules own policy thresholds and final eligibility gates; the model may summarize but cannot override them.
- Provider timeouts, retry budgets, circuit-breaker states, token usage, and cost estimates are recorded.
- Redaction hooks protect configured PII fields before external model calls.
- Final decisions remain human-owned.

## Edge-case matrix

| Area                  | Cases covered                                                                                           | Expected behavior                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| File safety           | wrong extension/MIME, encrypted, corrupt, empty, oversized, too many pages, malware scanner unavailable | Quarantine or reject with actionable status; never enqueue unsafe content  |
| Page extraction       | native text, scan, mixed PDF, rotated page, low contrast, tables, handwriting, blank page, multilingual | Per-page strategy, orientation/language metadata, warnings and confidence  |
| Classification        | one file containing multiple document types, unknown type, ambiguous type                               | Split suggestion or reviewer task; alternatives retained                   |
| Structured extraction | missing field, malformed date/currency, checkbox, merged table cell, contradictory pages                | Null rather than invention; normalized and raw value retained              |
| Identity              | trading vs legal name, transliteration, historical address, registration-number mismatch                | Reconciliation record; no silent merge                                     |
| Time                  | expiry at timezone boundary, open-ended policy, future-issued certificate                               | UTC comparison with domain timezone and explicit inclusivity               |
| Duplicates            | identical binary, revised version, same document in a combined PDF                                      | Hash duplicate, semantic-version relation, or page-level duplicate warning |
| Retrieval             | no policy result, stale policy, revoked policy, cross-tenant candidate, conflicting policies            | Strict filters; abstain or escalate; never cross tenant/domain/version     |
| Model/provider        | timeout, rate limit, invalid JSON, context overflow, unavailable embedding model                        | Bounded retry, chunking/fallback, resumable job, human route               |
| Workflow              | repeated webhook/job, worker crash, cancellation, rule version changes                                  | Idempotent steps, checkpoints, compensation, immutable prior run           |
| Human review          | concurrent edits, correction without reason, decision without required evidence                         | Optimistic lock, reason required, invariant rejection                      |
| Accessibility         | keyboard-only, reduced motion, narrow screen, zoom, screen reader                                       | Semantic controls, focus states, motion disabled, responsive reading order |

## UX design direction

CaseLens resembles a precise quality-control docket rather than a generic analytics dashboard.

- Palette: porcelain `#F5F7F8`, ink `#172126`, blueprint `#315E72`, evidence cyan `#2A8D9C`, inspection amber `#D78B2B`, fault rose `#C65363`.
- Typography: Newsreader for case titles and decisions, IBM Plex Sans for interface text, IBM Plex Mono for IDs and extracted values.
- Desktop case layout: 236px dossier rail, fluid document canvas, 360px evidence/findings panel. Tablet collapses the rail; mobile uses ordered tabs.
- Signature element: an evidence rail connects each finding to numbered page anchors and uses the same severity color at both ends.
- Motion: restrained 160–240ms reveal and state changes; none when `prefers-reduced-motion` is set.
- Copy: concrete actions such as “Open page 2”, “Confirm legal name”, and “Request GDP certificate”.

The deliberate critique is that cards, gradients, and abstract AI sparkle would make the product feel interchangeable with every SaaS demo. The implementation instead emphasizes document surfaces, editorial typography, indexed evidence, ruled separators, and inspection marks.

## Demo fixtures and expected result

The pharmacy pack includes a supplier questionnaire, commercial-register extract, ISO 13485 certificate, insurance certificate, data-processing agreement, supply contract, four policy documents, a multilingual catalog, and a rotated low-contrast delivery note. A GDP certificate is intentionally absent. Additional non-PDF fixtures exercise corruption, unsupported MIME, encryption, duplication, and empty input.

Expected facts include `legalName=MediSupply GmbH`, a conflicting `contractParty=MediSupply Europe GmbH`, and `liabilityLimitEur=1000000`. Applicable policy requires GDP evidence and `liabilityLimitEur>=2000000`. The expected recommendation is `request_information` with one critical and two major findings.

## Non-functional requirements

- Demo mode starts without cloud credentials and returns deterministic, reproducible results.
- Production adapters are selected without changing application or domain code.
- P95 synchronous API latency under 400ms excluding uploads; document processing is asynchronous.
- At-least-once jobs are safe through idempotency and checkpoints.
- OpenTelemetry-compatible logs, metrics, and traces share a correlation ID.
- WCAG 2.2 AA target, responsive from 360px, keyboard-accessible review workflow.
- Unit, integration, contract, workflow, API, UI, and end-to-end tests cover success, abstention, and failure paths.
