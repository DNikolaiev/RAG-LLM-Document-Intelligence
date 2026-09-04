import { expect, type Page } from '@playwright/test';

export function monitorRuntimeFailures(page: Page): string[] {
  const failures: string[] = [];

  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // Chrome logs "Failed to load resource" for every non-2xx response, including ones a test
    // mocks on purpose to exercise an error path. It says nothing the application did wrong, and
    // a genuine server fault is already caught by the response listener below, so counting it
    // here would only make deliberate failure coverage impossible to write.
    if (message.text().startsWith('Failed to load resource:')) return;
    failures.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() < 500) return;
    const url = new URL(response.url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      failures.push(`response ${response.status()}: ${response.url()}`);
    }
  });

  return failures;
}

export function expectNoRuntimeFailures(failures: string[]): void {
  expect(failures, `Unexpected browser failures:\n${failures.join('\n')}`).toEqual([]);
}

export async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    return Math.max(root.scrollWidth - root.clientWidth, body.scrollWidth - root.clientWidth);
  });

  expect(overflow, `The document is ${overflow}px wider than its viewport.`).toBeLessThanOrEqual(1);
}

export async function expectVisibleControlsFitViewport(page: Page): Promise<void> {
  const offenders = await page
    .locator('a, button, input, select, textarea')
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const hidden =
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number(style.opacity) === 0 ||
          rect.width === 0 ||
          rect.height === 0;
        if (hidden) return [];

        const outsideHorizontally = rect.left < -1 || rect.right > window.innerWidth + 1;
        const invalidSize = rect.width < 1 || rect.height < 1;
        if (!outsideHorizontally && !invalidSize) return [];

        return [
          {
            element: element.outerHTML.slice(0, 180),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
            viewportWidth: window.innerWidth,
          },
        ];
      }),
    );

  expect(offenders, `Visible controls outside the viewport: ${JSON.stringify(offenders)}`).toEqual(
    [],
  );
}

export async function expectEnabledButtonsClickable(page: Page): Promise<void> {
  const buttons = page.locator(
    'button:visible, input[type="button"]:visible, input[type="submit"]:visible',
  );
  const buttonCount = await buttons.count();

  for (let index = 0; index < buttonCount; index += 1) {
    const button = buttons.nth(index);
    if (await button.isEnabled()) await button.click({ trial: true });
  }
}

export async function expectHealthyLayout(page: Page): Promise<void> {
  await expectNoPageOverflow(page);
  await expectVisibleControlsFitViewport(page);
  await expectEnabledButtonsClickable(page);
}
