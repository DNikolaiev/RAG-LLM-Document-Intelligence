# npm Package Manager Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CaseLens installable and runnable with standard npm commands, without requiring pnpm or pnpm-specific configuration.

**Architecture:** Convert the monorepo to npm workspaces, replace `workspace:*` dependency ranges with the repository's current `0.1.0` workspace version, and generate a committed `package-lock.json`. Update Docker, CI, scripts, docs, and agent guidance to use npm while keeping Turbo, Playwright, and all application boundaries unchanged.

**Tech Stack:** Node.js 24+, npm 11+, npm workspaces, Turbo, Next.js, NestJS, Playwright, Docker Compose, GitHub Actions

**Spec:** `README.md`, `AGENTS.md`, and the existing workspace/package manifests

## Global Constraints

- npm is the only documented and canonical package manager after this migration.
- Keep all workspace package names, versions, scripts, dependency versions, and runtime behavior unchanged unless npm requires a syntax change.
- Keep `APP_MODE=demo` deterministic and in-memory; do not imply that package-manager migration makes persistence production-ready.
- Do not hand-edit `package-lock.json`; generate it with npm after manifest changes.
- Verify from a clean npm install, the Docker build, unit tests, and both Playwright projects.

---

### Task 1: Convert root workspace configuration

**Files:**

- Modify: `package.json`
- Delete: `.npmrc`
- Delete: `pnpm-workspace.yaml`
- Delete: `pnpm-lock.yaml`
- Create: `package-lock.json`

**Interfaces:**

- Consumes: the four explicit app workspaces and `packages/*` package manifests.
- Produces: npm workspace discovery and a reproducible npm lockfile.

- [x] **Step 1: Add npm workspace metadata and npm-native scripts**

Add explicit npm workspace directories for the four apps and shared packages, set `packageManager` to `npm@11.16.0`, and replace every root package-manager script invocation with the equivalent `npm run` or `npm exec` form. Explicit app directories prevent generated folders such as `apps/web/.next` from being treated as workspaces.

- [x] **Step 2: Replace internal workspace protocol ranges**

Change every internal dependency from `"workspace:*"` to `"0.1.0"`, matching the package manifests' current versions so npm can link the local workspaces.

- [x] **Step 3: Remove pnpm-only files and generate the npm lockfile**

Delete `.npmrc`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml`, then run `npm install --package-lock-only` from the repository root to create `package-lock.json`.

### Task 2: Update runtime and CI entry points

**Files:**

- Modify: `infra/docker/node.Dockerfile`
- Modify: `.github/workflows/ci.yml`
- Modify: `.gitignore`
- Modify: `.dockerignore`
- Modify: `.prettierignore`

**Interfaces:**

- Consumes: npm workspace metadata and `package-lock.json`.
- Produces: npm-based container builds and CI installs.

- [x] **Step 1: Use npm in the multi-stage Docker image**

Copy `package-lock.json`, run `npm ci`, build with `npm run build`, and start the selected workspace with `npm run start --workspace="${PACKAGE}"`. Remove Corepack and pnpm-specific Docker inputs.

- [x] **Step 2: Use npm in GitHub Actions**

Use `actions/setup-node` with `cache: npm`, run `npm ci`, and replace all pnpm command invocations with `npm run` equivalents.

- [x] **Step 3: Remove pnpm-generated paths from ignore files**

Stop ignoring `.pnpm-store` and `pnpm-lock.yaml`; retain `node_modules` and other generated output ignores.

### Task 3: Rewrite human and agent instructions

**Files:**

- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/plans/2026-08-26-caselens.md`
- Modify: `docs/superpowers/plans/2026-08-26-playwright-ui-regression.md`

**Interfaces:**

- Consumes: npm commands and the generated lockfile.
- Produces: consistent startup, verification, troubleshooting, and contributor guidance.

- [x] **Step 1: Replace all documented package commands**

Use `npm install`, `npm run`, `npm exec`, and `npm run --workspace` consistently. Keep Docker, Playwright, report, and MinIO instructions intact.

- [x] **Step 2: Document the canonical workspace commands**

Document examples for API/web/worker development, verification, Playwright report viewing, and the Docker demo using npm syntax.

- [x] **Step 3: Remove stale pnpm guidance**

Scan tracked files outside generated directories and leave no pnpm-specific instructions or package-manager references.

### Task 4: Verify clean npm installation and runtime

**Files:**

- Test: all workspace manifests, Docker Compose, unit tests, and Playwright tests

**Interfaces:**

- Consumes: the npm workspace and lockfile.
- Produces: evidence that npm install, CI, Docker, and browser workflows remain functional.

- [x] **Step 1: Install and run repository gates with npm**

Run `npm ci`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run test:e2e:typecheck`, `npm test`, and `npm run build`.

- [ ] **Step 2: Rebuild and test the Docker demo**

Run `docker compose -f infra/docker-compose.demo.yml build` and `docker compose -f infra/docker-compose.demo.yml up -d`, then verify the web/API health endpoints.

- [x] **Step 3: Run Playwright and inspect the report**

Run `npm run test:e2e`, confirm both desktop and mobile projects pass, and verify `npm exec playwright show-report playwright-report` can open the report.

- [x] **Step 4: Review and commit**

Run `git diff --check`, inspect the lockfile and manifest diff, confirm no stale package-manager references remain, then commit with `build: migrate workspace to npm`.

### Verification evidence

- `npm ci` completed successfully from the generated lockfile (665 packages added).
- `npm run verify` passed formatting, lint, typecheck, Playwright typecheck, unit tests, and production build.
- `npm run test:e2e` passed all 12 desktop and mobile scenarios against the running demo.
- Docker rebuild was attempted but could not run in this environment because the `docker` CLI is not available on PATH; the Dockerfile and Compose references now use npm.
- Code-quality review found no correctness, architecture, security, or performance issues in the migration diff.
