# Test strategy

Unit tests cover schemas, every condition operator, normalization, reconciliation, confidence aggregation, chunking, ranking filters, provider factories, idempotency, and optimistic concurrency. Provider contract tests run the same success/error/capability suite against every adapter.

Workflow tests cover native text, OCR fallback, mixed/rotated/multilingual pages, missing and ambiguous types, conflicts, missing policies, low confidence, provider timeout/rate limit/invalid JSON, repair exhaustion, retry after worker crash, duplicate delivery, cancellation, and human resume.

API tests cover tenant isolation, roles, RFC-style problem details, validation, cursor pagination, idempotency keys, uploads, corrections with reasons, final decisions, export, liveness, and readiness. UI tests cover keyboard review, focus visibility, narrow layouts, reduced motion, loading/empty/error recovery, evidence navigation, and the expected MediSupply recommendation.

PDF verification regenerates fixtures deterministically, checks hashes/page counts/phrases, renders pages through Poppler, inspects layout, and confirms fixture copies. MCP tests verify structured/text parity, tenant headers, pagination, errors, and stable evaluation questions.
