# Test strategy

Unit tests cover schemas, every condition operator, normalization, reconciliation, confidence aggregation, chunking, ranking filters, provider factories, idempotency, and optimistic concurrency. Provider contract tests run the same success/error/capability suite against every adapter.

Workflow tests cover native text, OCR fallback, mixed/rotated/multilingual pages, missing and ambiguous types, conflicts, missing policies, low confidence, provider timeout/rate limit/invalid JSON, repair exhaustion, retry after worker crash, duplicate delivery, cancellation, and human resume.

API tests cover tenant isolation, roles, RFC-style problem details, validation, cursor pagination, idempotency keys, uploads, corrections with reasons, final decisions, export, liveness, and readiness. UI tests cover keyboard review, focus visibility, narrow layouts, reduced motion, loading/empty/error recovery, evidence navigation, and the expected MediSupply recommendation.

PDF verification regenerates fixtures deterministically, checks hashes/page counts/phrases, renders pages through Poppler, inspects layout, and confirms fixture copies. `scripts/verify-fixtures.py` applies those checks to every manifest-described corpus: the pharmacy corpus with its quarantine and duplicate dispositions, the multi-tenant policy/evidence pack, and the policy-lab pack behind [`policy-lab-upload-runbook.md`](policy-lab-upload-runbook.md); the latter two additionally generate twice into scratch directories and assert identical SHA-256 values. MCP tests verify structured/text parity, tenant headers, pagination, errors, and stable evaluation questions.

## Disposable databases

`TEST_DATABASE_URL`, `TEST_ADMIN_DATABASE_URL` and `TEST_ANALYTICS_DATABASE_URL` must point at
databases that can be emptied. Most integration suites clean up only the rows they created, but the
analytics rebuild test exercises `AnalyticsStore.reset`, whose entire purpose is to truncate the
projection so a replay can rebuild it. Aimed at a running local stack it will empty that stack's
read model. Replaying the outbox restores it.

## Classification evaluation

[`fixtures/evaluation/policy-collection-classification.json`](../../fixtures/evaluation/policy-collection-classification.json) holds every policy-lab policy plus adversarial text-only cases: policies that fit no collection, and one carrying an injected filing instruction. Each case names the collection a careful administrator would choose and any others that would be defensible. Filing anywhere else is a misclassification; asking an administrator is always allowed.

The page text of each PDF case is copied into the file so CI needs no extraction service, and `scripts/verify-fixtures.py` checks the copy still matches the PDF with the same `pdfplumber` extraction the corpus checks use.

- **Deterministic, gated in CI:** `apps/worker/test/collection-classification.eval.test.ts` runs the lexical classifier. It asserts that nothing is filed outside the acceptable set, and the exact recorded outcome of every case, so a change to the classifier, a collection description or a threshold appears as a diff to that table.
- **Model, reported only:** `apps/worker/scripts/evaluate-collection-classification.mjs` runs the configured model inside the worker container and prints each pick, its confidence, the lexical reading and the outcome. A local model is not deterministic, so its accuracy is measured, not gated; the script exits non-zero only if a case was filed wrongly.

```bash
docker compose -f infra/docker-compose.production-local.yml --env-file infra/.env.production-local exec worker node scripts/evaluate-collection-classification.mjs
```
