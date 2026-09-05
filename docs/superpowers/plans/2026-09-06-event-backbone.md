# Event Backbone and Analytics Read Model

**Goal:** Give CaseLens a real event backbone — domain facts published from an outbox, delivered over RabbitMQ — and a first independent service that consumes them into its own database as a CQRS read model.

**Why this shape:** The application already processes work asynchronously, but it is not event-driven. `apps/api` and `apps/worker` both hold direct connections to the same PostgreSQL and both write `cases`, so neither can be deployed or evolved independently. BullMQ carries _commands_ ("process this case") addressed to one known consumer, not _facts_ ("this case was decided") broadcast to whoever cares. `job_events` looks like a stream but is a progress log written and read by the same process. Nothing today can react to a business fact.

**Decisions (user, 2026-09-06):** an analytics read model first; RabbitMQ as the transport; the new service owns its own database.

## The tension these choices create, and the resolution

RabbitMQ is a broker, not a log: an acknowledged message is gone. A read model needs **replay** — drop the projection, rebuild it from history — which is what makes a projection safe to change. A broker alone cannot provide that.

So the **outbox table is the log and RabbitMQ is the delivery mechanism**. Events are appended to PostgreSQL in the same transaction as the business change they describe; a relay publishes them to RabbitMQ for live consumers; rebuilding a projection replays from the table. This is the pattern the system would want anyway, and it makes the difference between a broker and a log concrete rather than theoretical.

## Concepts this is built to demonstrate

| Concept                | Where it shows up                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| Command versus event   | BullMQ keeps carrying commands; the new exchange carries facts                                        |
| Dual-write problem     | Writing business state and publishing separately can lose events; the outbox removes the second write |
| Transactional outbox   | The event row and the business row commit or roll back together                                       |
| At-least-once delivery | The relay may publish a row twice; that is expected, not a bug                                        |
| Idempotent consumer    | The projector dedupes on event id, so redelivery is harmless                                          |
| Topic routing          | `caselens.events` topic exchange, routing key = event type, bindings choose                           |
| Dead lettering         | A poison message goes to a DLX rather than blocking the queue                                         |
| Eventual consistency   | The read model lags the write model, visibly                                                          |
| CQRS                   | Analytics answers questions the transactional schema is a poor shape for                              |
| Replay                 | Projections rebuild from the event log without touching the source services                           |

## Architecture

```
apps/api ──(same tx)──> domain_events (outbox, append-only, in the main database)
                              │
                        relay (polls unpublished, in sequence)
                              │  publish
                              v
                  RabbitMQ topic exchange  caselens.events
                     routing key = event type, e.g. case.decided
                              │  binding
                              v
                  queue analytics.events ──> apps/analytics ──> its OWN database
                              │ (on repeated failure)
                              v
                  analytics.events.dlq
```

## Event contract

A new workspace package `packages/events` holds the envelope and payload schemas, shared by publisher and consumer so the wire format has one definition. Every event carries:

- `id` — unique; the consumer's idempotency key
- `type` — e.g. `case.decided`; also the routing key
- `tenantId` — every fact belongs to a tenant
- `aggregateType` / `aggregateId` — what it happened to
- `occurredAt` — when it happened, not when it was delivered
- `sequence` — monotonic per the outbox, so a replay is ordered
- `payload` — typed per event

First three events, chosen because they are what a throughput read model needs: `case.created`, `case.decided`, `finding.raised`.

## Phases

**Phase 1 — the outbox.** Add the `domain_events` table and write those three events from `apps/api` inside the existing transactions. No broker yet. The test that matters: a rolled-back business change leaves no event.

**Phase 2 — transport and the read model.** Add RabbitMQ to the production-local profile, a relay that drains the outbox to the topic exchange, and `apps/analytics` consuming into its own database with dedupe on event id. One question answered end to end: cases decided per tenant per day, and median time from creation to decision.

**Phase 3 — the hard parts.** Replay to rebuild projections from the outbox, a dead-letter queue with a poison-message test, and deliberate demonstration of consumer lag.

**Phase 4 — retire the second broker (user, 2026-09-06).** Redis exists in this system for exactly one reason: BullMQ. Nothing else opens a connection to it. And BullMQ is a thin transport here — the durable job record, its progress, its status transitions and the notification feed all live in `jobs` and `job_events` in PostgreSQL, written by the worker. What BullMQ actually contributes is claims, stall detection, attempt counting and exponential backoff.

So `process_case` and `process_policy` move onto RabbitMQ and Redis is removed. Deliberately last: migrating the critical work path to a broker that has not yet carried real traffic would be the wrong risk, so RabbitMQ earns that trust on the new event path first.

What has to be rebuilt, and how:

- **Retry with backoff.** RabbitMQ has no native delayed redelivery. Use a retry queue whose messages have a per-message TTL and dead-letter back to the work queue, so an expired message returns for another attempt. Attempt counts travel in a header.
- **Attempt ceiling and dead lettering.** After the configured attempts, route to a dead-letter queue rather than requeuing forever. BullMQ's `attempts: 3` and `backoff: exponential 1s` are the behaviour to preserve.
- **Claims and stall detection.** RabbitMQ redelivers an unacknowledged message when a consumer dies, which covers the claim. Long-running work needs the consumer to hold the delivery rather than ack early, and the connection heartbeat has to outlast a slow model call — with a five-minute model timeout, that setting matters.
- **Idempotency.** Already handled by the deterministic job id and the `jobs` row; redelivery must remain safe, which it is today.

## Constraints

- The existing BullMQ path is untouched. Commands stay commands; this adds a parallel fact channel rather than replacing the work queue.
- No consumer reads another service's tables. Analytics owns its database and learns everything from events.
- Events are facts in the past tense, named for what happened, never instructions.
- An event payload carries what a consumer needs, not a database row. Leaking the internal shape recreates the coupling this removes.
- Publishing is at-least-once and consumers must be idempotent. Exactly-once is not offered and should not be assumed.
