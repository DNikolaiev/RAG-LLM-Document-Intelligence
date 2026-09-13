import { expect, test } from '@playwright/test';

import { expectHealthyLayout, monitorRuntimeFailures } from './support/ui-assertions';

/** The widest viewport that collapses. Measured: the full inline header needs 1196px, and 1066px
 * without the runtime pill, so the menu only appears below 1080px. */
const COLLAPSE_BREAKPOINT = 1079;

test.describe('header navigation', () => {
  test('keeps the links clear of the workspace context when they are inline', async ({
    page,
    viewport,
  }) => {
    test.skip((viewport?.width ?? 0) <= COLLAPSE_BREAKPOINT, 'The inline layout starts at 1080px');
    await page.goto('/');

    // The navigation used to be positioned absolutely and centred on the header, so nothing
    // separated it from the workspace context - adding a third link simply grew into it.
    const clearance = await page.evaluate(() => {
      const nav = document.querySelector('.primary-navigation');
      const context = document.querySelector('.header-context');
      if (!nav || !context) return -1;
      return context.getBoundingClientRect().left - nav.getBoundingClientRect().right;
    });
    expect(clearance).toBeGreaterThanOrEqual(24);
  });

  test('keeps the links inline at medium widths, making room by dropping the runtime pill', async ({
    page,
    viewport,
  }) => {
    // The regression this guards: the menu used to take over at 1180px, a breakpoint inherited from
    // an older layout, so a 1120px window showed a burger beside a header with space to spare.
    test.skip(
      (viewport?.width ?? 0) <= COLLAPSE_BREAKPOINT,
      'Runs in the desktop project, resized to a medium width',
    );
    await page.setViewportSize({ width: 1120, height: 900 });
    await page.goto('/');

    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
    await expect(page.locator('.environment-mark')).toBeHidden();

    const clearance = await page.evaluate(() => {
      const links = [...document.querySelectorAll('.primary-navigation a')];
      const context = document.querySelector('.header-context');
      if (!links.length || !context) return -1;
      return context.getBoundingClientRect().left - links.at(-1)!.getBoundingClientRect().right;
    });
    expect(clearance).toBeGreaterThanOrEqual(24);
    await expectHealthyLayout(page);
  });

  test('collapses behind a toggle on narrow viewports', async ({ page, viewport }) => {
    test.skip((viewport?.width ?? 0) > COLLAPSE_BREAKPOINT, 'The collapsed layout is below 1080px');
    const failures = monitorRuntimeFailures(page);
    await page.goto('/');

    const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
    const toggle = page.getByRole('button', { name: 'Open navigation' });
    await expect(navigation).toBeHidden();
    await expect(toggle).toBeVisible();

    await toggle.click();
    await expect(navigation).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close navigation' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    for (const label of ['Review queue', 'Policy library', 'Analytics']) {
      await expect(navigation.getByRole('link', { name: label })).toBeVisible();
    }

    // Escape closes it, because a panel covering the page with no visible way out is a trap.
    await page.keyboard.press('Escape');
    await expect(navigation).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // Selecting a destination closes it too: on a phone the panel would otherwise sit over the page
    // it just navigated to, and nothing else would dismiss it.
    await toggle.click();
    await navigation.getByRole('link', { name: 'Policy library' }).click();
    await expect(page).toHaveURL(/\/policies$/);
    await expect(navigation).toBeHidden();

    await expectHealthyLayout(page);
    expect(failures).toEqual([]);
  });
});
