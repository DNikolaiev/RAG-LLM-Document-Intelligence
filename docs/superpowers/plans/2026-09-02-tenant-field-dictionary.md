# Tenant Field Dictionary Implementation Plan

**Goal:** Let an uploaded policy propose new extraction fields, deduplicated by meaning rather than wording, so a tenant's fact vocabulary can grow through governed review instead of a developer editing a compiled domain pack.

**Architecture:** `domain_packs.definition` becomes the authoritative, versioned, per-tenant pack — the seam the schema was built for but which nothing currently reads. The policy pipeline gains a field-proposal stage: qwen proposes a candidate field with an exact citation, `embeddinggemma` recalls semantically similar existing fields from pgvector, and qwen rules same-or-different on that short list. A "same" verdict is converted into an alias addition on the existing field instead of a new path. An administrator approves, which mints a new pack version.

**Tech Stack:** TypeScript, Zod, PostgreSQL/pgvector, NestJS, Next.js 16, Vitest, Playwright, Ollama (`qwen3:4b`, `embeddinggemma:300m-qat-q4_0`, 768 dims).

**Decisions taken by the user (2026-09-02):**

1. A duplicate proposal auto-aliases onto the existing field rather than minting a new path.
2. Approving a field does not re-extract automatically; a case gets an explicit per-case reprocess action.
3. Dedup is embeddings-recall then model-judgment, not model-only.
4. The dictionary lives in `domain_packs.definition`; approval mints a new pack version.

## Global Constraints

- **The closed vocabulary invariant holds.** Extraction still runs only against an approved catalog. A policy PDF may _propose_; only an administrator may _approve_. Document content never silently widens the extraction surface.
- Never trust a model-supplied path, type, or dedup verdict as final — each passes a deterministic gate.
- A proposed field must be grounded in an exact citation from its policy document, matching the existing rule-proposal gate.
- Preserve tenant scoping, RLS, optimistic concurrency, and append-only audit on every new table and mutation.
- Pack resolution must fall back to the compiled catalog when a tenant has no persisted definition, so existing volumes keep working with no migration dance.
- The catalog is serialized into every extraction prompt. Growth is a real cost — dedup is a correctness _and_ a performance feature.

**Assumption flagged for review:** an auto-aliased duplicate still requires administrator approval before it changes extraction. "Auto" refers to the system choosing alias-over-new-field, not to bypassing governance. Say so if you intended aliases to apply without review.

---

## Shared contract

### Persisted pack definition

`domain_packs.definition` currently holds a `{ name }` stub written by `case-store.ts:155`. It becomes the full `DomainPack` JSON, validated by `parseDomainPack` on read.

```ts
// packages/persistence — provided by Track A, consumed by Tracks B and C
interface PackDefinitionStore {
  getActivePackDefinition(tenantId: string, domainPackId: string): Promise<DomainPack | null>;
  savePackVersion(input: {
    tenantId: string;
    domainPackId: string;
    definition: DomainPack;
    semanticVersion: string;
    supersedes: string;
  }): Promise<{ semanticVersion: string }>;
}
```

Resolution order everywhere: persisted definition first, compiled `resolvePersistedDomainPack` as fallback.

### Field proposals

New table `field_proposals`, tenant-scoped with RLS, one row per candidate:

```ts
interface FieldProposal {
  id: string;
  tenantId: string;
  domainPackId: string;
  policyDocumentId: string;
  kind: 'new_field' | 'alias';
  documentTypeId: string;
  path: string;
  label: string;
  fieldType: 'string' | 'number' | 'boolean' | 'date' | 'currency' | 'list';
  aliases: string[];
  citation: { chunkId: string; page: number; quote: string };
  dedup: {
    verdict: 'distinct' | 'duplicate';
    matchedPath: string | null;
    similarity: number | null;
    reason: string;
  };
  status: 'proposed' | 'invalid' | 'approved' | 'rejected';
  issues: Array<{ code: string; message: string }>;
  embedding: number[];
}
```

For `kind: 'alias'`, `path` is the **existing** field's path and `aliases` holds only the new wording to add.

### HTTP surface

```
GET    /v1/policies/field-proposals?tenantId=…        -> { items: FieldProposal[] }
POST   /v1/policies/field-proposals/:id/approve       -> { semanticVersion }
POST   /v1/policies/field-proposals/:id/reject        -> { status: 'rejected' }
POST   /v1/cases/:caseId/reprocess                    -> { jobId }
```

Approve is administrator-only, idempotent by proposal id, and mints one new pack version per approval.

---

### Track A — persistence, migration, pack resolution

**Files owned:** `packages/persistence/**`, `packages/domain/src/domain-catalog.ts`, `packages/domain/test/**`

1. Write the full pack definition into `domain_packs.definition` instead of the `{ name }` stub (`case-store.ts:155`).
2. Add `getActivePackDefinition` and `savePackVersion` per the contract. `savePackVersion` bumps the semver minor, inserts a new row, marks the prior version superseded, and writes an audit event. The unique index on `(tenant_id, domain_key, semantic_version)` already supports this.
3. Add the `field_proposals` migration: table, tenant RLS policy, a `vector(768)` embedding column, and an index for cosine search.
4. Add `searchSimilarFields(tenantId, domainPackId, embedding, limit)` returning `{ path, label, aliases, similarity }`, cosine-ordered. Mirror how `policy_chunks` already does pgvector search rather than extending `VectorSearchProvider`, which is shaped for policy chunks.
5. Tests: pack round-trips through `parseDomainPack`; a tenant with no persisted row falls back to the compiled pack; `savePackVersion` is idempotent under retry; RLS blocks cross-tenant reads of proposals.

### Track B — proposal generation and semantic dedup

**Files owned:** `apps/worker/src/policy/**`, `apps/worker/test/**`

1. After clause chunking, add a field-proposal stage. qwen returns schema-constrained candidates: `documentTypeId`, `path`, `label`, `fieldType`, `aliases`, and an exact `quote`.
2. Deterministic gates, all blocking, mirroring `validateConditionGrounding`:
   - `path` matches `PathSchema` and is not already in the catalog;
   - `fieldType` is one of the six allowed types;
   - the citation quote genuinely appears in the cited chunk — reuse `evidenceContainsQuote`;
   - the label or one alias occurs in the cited quote.
3. Dedup, in this order:
   - embed `label + aliases + quote` via the existing `EmbeddingProvider.embed`;
   - `searchSimilarFields` for the top 5 candidates;
   - if the best similarity is below a configurable floor, verdict is `distinct` with no model call;
   - otherwise ask qwen, schema-constrained, to pick the matching existing path or answer "none", over that short list only.
4. A `duplicate` verdict rewrites the proposal to `kind: 'alias'` against the matched path, carrying only the new wording. A `distinct` verdict stays `new_field`.
5. Persist proposals with their embedding, dedup verdict, similarity, and any issues.
6. Tests: an ungrounded citation is rejected; a colliding path is rejected; a wrong-type value is rejected; "cover amount" against an existing "coverage" field yields an alias proposal, not a new field; a genuinely new concept yields `new_field`; the model is not called when similarity is below the floor.

### Track C — governance API _(hold until the contract refactor lands)_

**Files owned:** `apps/api/src/policies/**`, `apps/api/src/cases.service.ts`, `apps/api/test/**`

1. Implement the four endpoints above, administrator-gated via the existing `requireAdministrator`.
2. Approve semantics: `new_field` appends to the named document type's `extractionFields`; `alias` appends the wording to the existing field's `aliases`. Both re-validate through `parseDomainPack` before writing, then call `savePackVersion` and append an audit event.
3. Reject records the actor and reason; neither approve nor reject mutates the source policy or existing rules.
4. Case reprocess enqueues a fresh extraction job for one case against the current active pack version, idempotent per `(caseId, packVersion)`.
5. Tests: approving mints exactly one version; approving twice is a no-op; a non-administrator gets 403; approving a proposal whose path now collides fails cleanly.

### Track D — review UI _(hold until the contract refactor lands)_

**Files owned:** `apps/web/components/policy/**`, `apps/web/app/policies/**`, `apps/web/e2e/**`

1. Extend the Policy Library "Fact vocabulary" section with a proposals queue.
2. Each proposal shows the field, its type, the citation quote with a link to the source policy, and the dedup verdict — for an alias, name the existing field and show the similarity that drove it.
3. Approve and reject controls, administrator-only, with optimistic update and rollback on failure.
4. Reuse the origin-badge vocabulary from the rule registry so a field's provenance reads the same way a rule's does.
5. Add a per-case reprocess control surfacing the job in the existing notification feed.
6. Browser coverage: proposals render, an alias proposal names its matched field, approve removes it from the queue, desktop and mobile, no horizontal overflow.

## Sequencing

Tracks A and B run first and in parallel; they share no files and B builds against the contract above. Tracks C and D are blocked on the in-flight contract refactor, which currently holds `apps/api/src/policies/policies.service.ts` and `apps/web/components/policy/policy-library.tsx`.

## Self-Review

- The user's four decisions map to: decision 4 is Track A steps 1–2, decision 3 is Track B step 3, decision 1 is Track B step 4, decision 2 is Track C step 4 plus Track D step 5.
- The closed-vocabulary invariant survives: nothing in Track B writes to the pack; only Track C's administrator-gated approve does.
- Open question for the user: whether an alias needs approval, or may apply on a confident duplicate verdict.
