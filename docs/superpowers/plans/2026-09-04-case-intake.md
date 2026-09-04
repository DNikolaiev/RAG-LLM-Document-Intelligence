# Case Intake Implementation Plan

**Goal:** Let a reviewer create a case by uploading its documents, with a tenant administrator confined to their own workspace and a platform administrator able to file into any of theirs.

**Architecture:** One multipart endpoint composes what today takes three calls — create the case, attach every document, queue processing — and validates every file before the case exists, so a rejected upload leaves nothing behind. Tenant selection reuses `resolveTenant`, the helper the policy service already uses, which locks a tenant user to their own tenant and refuses a platform administrator who did not choose one.

**Tech Stack:** TypeScript, Zod, NestJS, Next.js 16, Vitest, Playwright.

**Decisions taken by the user (2026-09-04):**

1. Documents first: a case is created from the files, not created empty and filled in afterwards.
2. The browser path ships first; blob-storage ingestion follows on the foundations it proves.
3. For later blob ingestion, a dropped object is attributed to a tenant by an `inbox/<tenantId>/…` key prefix.
4. For later blob ingestion, MinIO publishes a notification onto the existing BullMQ queue rather than polling or a webhook.

## Two defects this must fix

- **There is no way to create a case in the browser.** `POST /v1/cases` exists and the workspace can attach a document to a case that already exists, but nothing creates one. Every case in the system came from the seed.
- **A platform administrator silently files into the wrong tenant.** `context.tenantId` resolves as `profile.activeTenantId ?? profile.tenantIds[0]`, and the platform admin's `activeTenantId` is `null`, so today a case they create lands in `tenant_demo` with no choice offered and no error raised.

## Global Constraints

- Validate every file before creating anything. A rejected document must not leave a half-built case, mirroring the ordering the policy upload path already enforces.
- Uploaded bytes stay untrusted: existing signature, MIME, size, page-count and scanner checks apply unchanged to every file.
- Preserve tenant scoping, idempotency and append-only audit. Re-sending an intake with the same idempotency key returns the same case rather than creating a second one.
- Do not weaken the role gate: intake stays `['intake', 'reviewer', 'admin']`.
- A platform administrator must choose a tenant explicitly; never infer one.

---

## Shared contract

```
POST /v1/cases/intake            multipart/form-data
  subjectName   required, 2..200 chars
  tenantId      required for a platform administrator, rejected for anyone else
  domainPackId  optional, defaults to the tenant's active pack
  file          1..N PDFs, repeated field
  idempotency-key header, as elsewhere

  -> 201 { caseId, reference, documentIds: string[], jobIds: string[] }
```

Failure modes, all before any write: `TENANT_REQUIRED` when a platform administrator names no tenant; `FILE_REQUIRED` when no file is attached; `TOO_MANY_DOCUMENTS` above the per-case ceiling; and the existing per-file validation codes, which must name the offending filename so a reviewer knows which of five files was refused.

---

### Track A — intake endpoint and tenant resolution

**Files owned:** `apps/api/src/**`, `apps/api/test/**`, `packages/contracts/src/core.ts`

1. Adopt `resolveTenant(context, requestedTenantId)` semantics for case creation, replacing the silent `context.tenantId` fallback. A tenant user may not pass `tenantId` at all; passing someone else's is refused, not ignored.
2. Add `POST /v1/cases/intake` per the contract. Order: resolve tenant, validate every file, then create the case, then attach documents, then queue. Nothing is written until the last file has passed.
3. Idempotent on the key: a replay returns the original case and does not re-attach or re-queue.
4. Implement in both `CasesService` (demo) and `ProductionCasesService` (durable), as `reprocess` already is.
5. Tests, as exported pure functions plus the durable HTTP harness in `apps/api/test/policies.endpoint.test.ts` (which composes in-memory stores — the demo-mode harness cannot reach durable paths): a tenant user cannot file into another tenant; a platform administrator without `tenantId` gets `TENANT_REQUIRED`; one bad file among several aborts the whole intake with nothing created; a replay returns the same case id.

### Track B — intake UI

**Files owned:** `apps/web/components/**`, `apps/web/app/**`, `apps/web/e2e/**`, `apps/web/test/**`

1. An intake entry point from the case queue — the queue is where someone looks when a new dossier arrives.
2. One screen: choose files (multiple), name the subject, and for a platform administrator choose the workspace. A single-workspace user sees their workspace as a label, never a one-option dropdown, matching the Policy Library switcher.
3. Show each selected file by name with a way to remove one before submitting, since the whole intake fails as a unit.
4. Validate before submitting: no files, or an empty subject, shows an inline error and does not submit.
5. On success, navigate to the created case. On failure, keep the selection and name the file that was refused.
6. Browser coverage: a single-workspace profile sees no workspace dropdown; a platform administrator must pick one; a successful intake lands on the new case. Intercept the endpoint the way the existing policy-library specs do.

### Phase two, not in this plan

Blob ingestion: MinIO publishes a bucket notification onto the BullMQ queue; the worker consumes it, resolves the tenant from the `inbox/<tenantId>/…` prefix, rejects any key that does not resolve to a known tenant, and runs the same validation the intake endpoint does. Two things to design then: what groups several objects into one case, and a reconciler for notifications that are missed or delivered twice — coupling ingestion to MinIO's notification support means a dropped event otherwise strands a file silently.
