# Platform Scope and Integration Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the platform administrator can inspect every tenant case, and ensure integration tests leave no cases, documents, object-storage files, jobs, vector chunks, or workflow checkpoints behind.

**Architecture:** Keep tenant authorization authoritative in the API and persistence layer. The web profile selector forwards only the selected test profile; the API derives the complete allowed tenant set. Integration fixtures receive unique run identifiers and are removed in teardown through explicit test-only cleanup helpers.

**Tech Stack:** Next.js, NestJS, TypeScript, PostgreSQL with row-level security, MinIO, Redis/BullMQ, Vitest, Playwright

**Spec:** `docs/specs/local-production-runtime.md`

## Global Constraints

- Preserve tenant isolation for every non-platform profile.
- Never trust a client-supplied tenant list.
- Keep PostgreSQL as the durable source of truth.
- Cleanup must run even when assertions fail.
- Document Redis according to its implemented behavior, not as a generic cache.

---

## Task 1: Reproduce and repair platform-wide case visibility

- [x] Trace profile selection from the browser cookie through forwarded headers and API context resolution.
- [x] Add a regression test proving a platform administrator can list and open cases from every tenant.
- [x] Fix the smallest incorrect boundary while preserving normal tenant isolation.

## Task 2: Make integration fixtures self-cleaning

- [x] Inventory every integration suite that writes durable records or objects.
- [x] Add teardown that removes all records and objects created by that test run.
- [x] Add or strengthen assertions that cleanup is tenant-safe and executes after failures.

## Task 3: Explain the production Redis boundary

- [x] Verify queue payloads, retry behavior, progress ownership, and persistence configuration in code.
- [x] Update the README component table and runtime flow with Redis's exact responsibilities and non-responsibilities.

## Task 4: Verify the complete change

- [x] Run focused unit and integration tests for identity scope and cleanup.
- [x] Run the repository verification command.
- [x] Confirm the administrator experience in the running application when the production stack is available.
