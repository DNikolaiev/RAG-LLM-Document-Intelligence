# User-Scoped Job Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven development or execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and display a detailed BullMQ processing timeline while ensuring a tenant user sees only jobs they personally enqueued and the platform administrator may inspect all.

**Architecture:** PostgreSQL stores the job snapshot and append-only lifecycle events; BullMQ/Redis remains transport only. The API filters events by actor scope and streams them with SSE, while the UI combines concise toasts, a persistent notification centre, and contextual timelines.

**Tech Stack:** PostgreSQL, Drizzle, NestJS, BullMQ, Redis, SSE, Next.js 16, React 19, Vitest, Playwright.

**Spec:** `docs/specs/policy-evidence-and-job-feedback.md`

## Global Constraints

- `enqueuedByUserId` is mandatory for user-created jobs.
- Tenant membership alone never grants visibility to another user's notifications.
- The platform administrator aggregate scope is explicit and audited.
- Queue claim, completion, cancellation, and retention cleanup remain distinct.
- PostgreSQL is authoritative; Redis restart or cleanup cannot erase notification history.

---

### Task 1: Durable job actor and event schema

**Files:**

- Modify: `packages/contracts/src/core.ts`
- Modify: `packages/persistence/src/schema.ts`
- Modify: `infra/postgres/init/010_schema.sql`
- Modify: `infra/postgres/init/020_rls_grants.sql`
- Modify: `packages/persistence/migrations/9999_post_drizzle.sql`
- Test: `packages/persistence/src/schema.test.ts`

- [ ] Write schema tests for actor foreign keys, event sequence uniqueness, tenant/user/time indexes, safe event types, RLS inclusion, and append-only grants.
- [ ] Add `jobs.enqueued_by_user_id` and append-only `job_events` with target resource, progress, attempt, safe error, admin diagnostics, correlation, and timestamps.
- [ ] Add composite indexes matching tenant-user feeds and platform-admin pagination.
- [ ] Backfill existing jobs to a system actor or known audit actor without granting them to arbitrary tenant users.
- [ ] Run schema/database tests and commit.

### Task 2: Repository and authorization

**Files:**

- Modify: `packages/persistence/src/case-store.ts`
- Create: `packages/persistence/src/job-event-store.ts`
- Modify: `apps/api/src/jobs.controller.ts`
- Create: `apps/api/src/jobs.service.ts`
- Test: `packages/persistence/src/case-store.integration.test.ts`
- Test: `apps/api/test/api.e2e.test.ts`

- [ ] Write tests proving user1 cannot list/get/stream user2's job events, including after profile switching; platform admin can inspect both.
- [ ] Add cursor-paginated job/event queries and current-snapshot lookup.
- [ ] Add cancel/retry authorization and append audit events.
- [ ] Return RFC 9457 not-found semantics instead of revealing that a hidden job exists.
- [ ] Run API/database tests and commit.

### Task 3: BullMQ lifecycle instrumentation

**Files:**

- Modify: `packages/providers/src/adapters/infrastructure.ts`
- Modify: `apps/api/src/production-cases.service.ts`
- Modify: `apps/worker/src/production-runtime.ts`
- Test: `packages/providers/test/providers.test.ts`
- Test: `apps/worker/test/production-runtime.test.ts`

- [ ] Write tests for enqueue requested/enqueued, duplicate suppression, worker claim, stages, retry, completion, failure, cancellation, and explicit queue-record removal.
- [ ] Persist API events only after the corresponding transition succeeds.
- [ ] Emit bounded worker-stage events and update job snapshots transactionally where possible.
- [ ] Make retention cleanup explicit and record `queue.record_removed`; do not call worker claim a deletion.
- [ ] Sanitize user messages and keep provider diagnostics admin-only.
- [ ] Run provider/worker tests and commit.

### Task 4: SSE feed and polling fallback

**Files:**

- Modify: `apps/api/src/jobs.controller.ts`
- Modify: `apps/web/app/api/cases/[...segments]/route.ts`
- Create: `apps/web/app/api/job-events/stream/route.ts`
- Test: `apps/api/test/api.e2e.test.ts`

- [ ] Write tests for actor filtering, `Last-Event-ID`, reconnect, heartbeat, ordering, duplicate suppression, and stream cleanup.
- [ ] Implement SSE from the durable event store with a bounded poll interval and cursor resumption.
- [ ] Add JSON polling endpoints as the fallback path.
- [ ] Run API tests and commit.

### Task 5: Notification centre and contextual timeline

**Files:**

- Create: `apps/web/components/job-notification-provider.tsx`
- Create: `apps/web/components/notification-centre.tsx`
- Create: `apps/web/components/job-timeline.tsx`
- Modify: `apps/web/components/brand-header.tsx`
- Modify: `apps/web/components/document-upload.tsx`
- Modify: `apps/web/components/dossier-nav.tsx`
- Modify: `apps/web/app/foundation.css`
- Test: `apps/web/test/notification-centre.test.tsx`
- Test: `apps/web/e2e/queue.spec.ts`

- [ ] Write tests for queued/claimed/stage/completed/failed/cancelled/removed messages, unread state, reconnect, profile switching, admin aggregation, and no cross-user leakage.
- [ ] Add concise important-event toasts, a persistent notification centre, and case/policy timelines.
- [ ] Reset the active stream and cached feed immediately when profile changes.
- [ ] Keep retention cleanup in technical detail rather than an alarming toast.
- [ ] Verify keyboard, screen-reader, mobile, reduced-motion, and overflow behavior.
- [ ] Run component and browser tests and commit.

### Task 6: Operations and retention documentation

**Files:**

- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/operations/observability.md`
- Modify: `docs/operations/security-and-privacy.md`

- [ ] Document every technology, ownership boundary, durable/ephemeral record, lifecycle event, actor-visibility rule, retry/cancellation behavior, and 90-day retention default.
- [ ] Document operational queries without exposing secrets or document text.
- [ ] Run `npm run verify`, database integration, and Playwright coverage.
- [ ] Commit the completed job-feedback feature.
