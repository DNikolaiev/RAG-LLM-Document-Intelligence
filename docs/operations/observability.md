# Observability and reliability

Emit JSON logs with `timestamp`, `level`, `service`, `tenantId`, `caseId`, `jobId`, `correlationId`, `traceId`, `event`, and safe metadata. Propagate W3C trace context across HTTP and queue jobs.

Track API latency/error rate, queue age/depth/retries/dead letters, page processing duration, OCR fallback rate, classification/extraction confidence, schema repair rate, human-review rate, retrieval abstention, provider latency/errors/tokens/estimated cost, and case time-to-decision. Do not use document text, names, or email addresses as metric labels.

Liveness proves that the process loop runs. Readiness checks selected persistence, queue, storage, and provider capabilities with bounded timeouts. A dependency outage removes readiness while in-flight jobs retain checkpoints. Graceful shutdown stops accepting HTTP/queue work, waits for a bounded drain window, and then releases connections.

Back up PostgreSQL and object storage together using a recorded consistency point. Test restoration quarterly into an isolated environment, verify hash provenance, tenant isolation, policy/vector indexes, and a complete case export before declaring the restore successful.
