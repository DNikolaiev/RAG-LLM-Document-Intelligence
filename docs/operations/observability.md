# Observability and reliability

Emit JSON logs with `timestamp`, `level`, `service`, `tenantId`, `caseId`, `jobId`, `correlationId`, `traceId`, `event`, and safe metadata. Propagate W3C trace context across HTTP and queue jobs.

Track API latency/error rate, queue age/depth/retries/dead letters, page processing duration, OCR fallback rate, classification/extraction confidence, schema repair rate, human-review rate, retrieval abstention, provider latency/errors/tokens/estimated cost, and case time-to-decision. Do not use document text, names, or email addresses as metric labels.

The user-facing processing ledger is durable operational feedback, not a substitute for logs. `jobs` holds the latest snapshot; append-only `job_events` records creation, enqueue request/result, worker claim/start, bounded stage progress, retry, cancellation, terminal result, and queue-record cleanup. Feed queries are scoped to `recipient_user_id = app.user_id`; the explicit platform-admin context is the only aggregate bypass.

Policy observability includes pages extracted, OCR fallbacks, chunk count, embedding provider/model, proposal provider/model, proposal validation failures, approvals/rejections, activation, and rule versions used by each case run. Never log raw policy clauses, document text, model prompts, or object-store credentials.

Liveness proves that the process loop runs. Readiness checks selected persistence, queue, storage, and provider capabilities with bounded timeouts. A dependency outage removes readiness while in-flight jobs retain checkpoints. Graceful shutdown stops accepting HTTP/queue work, waits for a bounded drain window, and then releases connections.

Back up PostgreSQL and object storage together using a recorded consistency point. Test restoration quarterly into an isolated environment, verify hash provenance, tenant isolation, policy/vector indexes, and a complete case export before declaring the restore successful.
