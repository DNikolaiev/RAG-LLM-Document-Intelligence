# Playwright UI Regression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add repeatable Playwright coverage proving the containerized CaseLens queue and review workspace render without page overflow, expose their required content, and support every intended navigation and control path on desktop and mobile Chromium.

**Architecture:** A root Playwright configuration targets the already-running Docker demo through `PLAYWRIGHT_BASE_URL`, with separate desktop and mobile projects and failure-only traces, screenshots, and video. Focused specs share layout and runtime-error assertions; browser-side mutation requests are fulfilled with deterministic test responses so repeated test runs never alter the in-memory demo API.

**Tech Stack:** TypeScript, `@playwright/test`, Chromium, Next.js 16, Docker Compose

**Spec:** `docs/specs/caselens.md`

## Global Constraints

- Keep the application in `APP_MODE=demo`; Playwright must not present the in-memory adapters as durable production infrastructure.
- Run tests serially because the Docker demo is a shared process and UI tests exercise stateful client interactions.
- Cover 1440×1000 desktop Chromium and a Pixel 7 mobile viewport.
- Treat a disabled approval button as a required safety state until all open findings are resolved.
- Fail on uncaught page errors, console errors, failed same-origin responses, global horizontal overflow, zero-sized visible controls, controls extending outside the viewport, or enabled visible buttons that fail Playwright's actionability checks.
- Mock only browser-originated mutation calls; initial server-rendered data and read-only downloads must come from the running containers.

---

### Task 1: Playwright workspace integration

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.gitignore`
- Create: `playwright.config.ts`

**Interfaces:**

- Consumes: `PLAYWRIGHT_BASE_URL` with default `http://127.0.0.1:3000`
- Produces: `pnpm test:e2e`, `pnpm test:e2e:headed`, desktop and mobile Chromium projects

- [x] **Step 1: Add the Playwright test dependency and scripts**

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:headed": "playwright test --headed"
  },
  "devDependencies": {
    "@playwright/test": "^1.62.1"
  }
}
```

- [x] **Step 2: Configure deterministic projects and artifacts**

```ts
export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000',
    contextOptions: { reducedMotion: 'reduce' },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
});
```

- [x] **Step 3: Ignore generated artifacts**

```gitignore
playwright-report/
test-results/
```

- [x] **Step 4: Install Chromium and list tests**

Run: `pnpm exec playwright install chromium` then `pnpm exec playwright test --list`

Expected: both projects list the queue and case-workspace specifications.

### Task 2: Shared UI integrity assertions

**Files:**

- Create: `apps/web/e2e/support/ui-assertions.ts`

**Interfaces:**

- Consumes: Playwright `Page`
- Produces: `monitorRuntimeFailures(page)`, `expectNoRuntimeFailures(failures)`, `expectNoPageOverflow(page)`, `expectVisibleControlsFitViewport(page)`, and `expectEnabledButtonsClickable(page)`

- [x] **Step 1: Capture actionable runtime failures**

```ts
export function monitorRuntimeFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (
      response.url().startsWith(page.url().split('/').slice(0, 3).join('/')) &&
      response.status() >= 500
    ) {
      failures.push(`response ${response.status()}: ${response.url()}`);
    }
  });
  return failures;
}
```

- [x] **Step 2: Assert the page and visible controls fit**

```ts
await expect
  .poll(() =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  )
  .toBeLessThanOrEqual(1);

const invalid = await page.locator('a, button, input, select, textarea').evaluateAll((elements) =>
  elements
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        (rect.width <= 0 || rect.height <= 0 || rect.left < -1 || rect.right > innerWidth + 1)
      );
    })
    .map((element) => element.outerHTML.slice(0, 160)),
);
expect(invalid).toEqual([]);
```

Action-check each visible, enabled button with a Playwright trial click so obscured or otherwise unclickable controls fail without invoking their behavior.

### Task 3: Queue navigation and responsive coverage

**Files:**

- Create: `apps/web/e2e/queue.spec.ts`

**Interfaces:**

- Consumes: queue page semantic roles and the shared integrity assertions
- Produces: coverage for queue content, filter submission, clear-filter navigation, empty state, responsive cards, and case navigation

- [x] **Step 1: Assert required queue content and controls are visible**

```ts
await page.goto('/');
await expect(page.getByRole('heading', { name: 'Cases that need a human eye' })).toBeVisible();
await expect(page.getByRole('searchbox', { name: 'Find a subject or case' })).toBeVisible();
await expect(page.getByRole('combobox', { name: 'Status' })).toBeVisible();
await expect(page.getByRole('button', { name: 'Filter cases' })).toBeEnabled();
```

- [x] **Step 2: Exercise filtering and clearing through real navigation**

```ts
await page.getByRole('searchbox', { name: 'Find a subject or case' }).fill('no-match-case');
await page.getByRole('button', { name: 'Filter cases' }).click();
await expect(page).toHaveURL(/query=no-match-case/);
await expect(page.getByRole('heading', { name: 'No cases match these filters' })).toBeVisible();
await page.getByRole('link', { name: 'Show every case' }).click();
await expect(page).toHaveURL(/\/$/);
```

- [x] **Step 3: Open the first review-needed case and run integrity checks**

Run: `pnpm exec playwright test apps/web/e2e/queue.spec.ts`

Expected: desktop and mobile projects pass without page overflow or runtime failures.

### Task 4: Case workspace controls and safe mutations

**Files:**

- Create: `apps/web/e2e/case-workspace.spec.ts`

**Interfaces:**

- Consumes: first review-case link discovered from `/`, relative mutation routes, source PDF links
- Produces: coverage for workspace tabs, dossier navigation, upload, zoom, evidence, findings, corrections, audit, decision safety, approval transition, and export

- [x] **Step 1: Discover and open the current review case**

```ts
await page.goto('/');
await page.getByRole('link', { name: 'Review' }).first().click();
await expect(page).toHaveURL(/\/cases\//);
await expect(page.getByRole('region', { name: 'Request information' })).toBeVisible();
```

- [x] **Step 2: Exercise document and responsive workspace controls**

```ts
await page.getByRole('button', { name: 'Zoom in' }).click();
await expect(page.locator('output')).toHaveText('102%');
await page.getByRole('button', { name: 'Zoom out' }).click();
await expect(page.locator('output')).toHaveText('92%');
await page.getByRole('link', { name: /GDP certificate/ }).click();
await expect(page.getByRole('heading', { name: 'GDP certificate was not supplied' })).toBeVisible();
```

- [x] **Step 3: Fulfill browser mutations without changing the demo API**

```ts
await page.route('**/api/cases/**', async (route) => {
  if (route.request().method() === 'GET') return route.continue();
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ version: 2, caseVersion: 2 }),
  });
});
```

- [x] **Step 4: Exercise findings, correction dialog, decisions, upload, and export**

Run: `pnpm exec playwright test apps/web/e2e/case-workspace.spec.ts`

Expected: every enabled button produces its intended visible state; approval starts disabled, becomes enabled only after all findings are resolved, and the JSON export downloads successfully.

### Task 5: Verification and handoff

**Files:**

- Modify: `docs/superpowers/plans/2026-08-26-caselens.md`
- Modify: this plan

**Interfaces:**

- Consumes: Dockerized CaseLens at ports 3000 and 4100
- Produces: recorded E2E evidence and a clean Git commit

- [x] **Step 1: Run Playwright and repository gates**

Run: `pnpm test:e2e`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm test`

Expected: every command exits zero and Playwright reports both desktop and mobile projects passing.

- [x] **Step 2: Fix any product defects exposed by the suite**

Use the failing locator, trace, screenshot, or overflow diagnostic to make the smallest app-side correction, then rerun the failed spec followed by the full suite.

- [x] **Step 3: Record evidence and commit**

```bash
git add package.json pnpm-lock.yaml .gitignore playwright.config.ts apps/web/e2e docs/superpowers/plans
git commit -m "test: add Playwright UI regression coverage"
```

## Completion evidence

- Chromium v1234 was installed and `pnpm exec playwright test --list` discovered 12 scenarios across the desktop and mobile projects.
- The first full run found a real client-navigation defect: clearing filters changed the URL but left the uncontrolled status selector showing its prior value. Keying the filter form by its server-derived query state fixed the stale UI and is covered by the queue regression test.
- The final `pnpm test:e2e` run passed all 12 scenarios in 14.3 seconds. Every integrity checkpoint also passed runtime-error, HTTP 5xx, horizontal-overflow, clipped-control, and visible enabled-button actionability assertions.
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:e2e:typecheck`, `pnpm test`, and `pnpm build` passed. The repository suite retained 92 passing Vitest tests and the Next.js production build completed successfully.
- Five-axis review found no unresolved correctness, readability, architecture, security, or performance issues. A broad role-based button sweep was refined to exclude the intentionally hidden file input while continuing to action-check every user-facing button.
