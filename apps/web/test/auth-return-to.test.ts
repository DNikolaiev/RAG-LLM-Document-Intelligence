// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { safeReturnTo } from '../lib/auth/return-to';

describe('post sign-in destination', () => {
  it('keeps a path on this site, with its query and fragment', () => {
    expect(safeReturnTo('/')).toBe('/');
    expect(safeReturnTo('/cases/case_1?tab=evidence#page-2')).toBe(
      '/cases/case_1?tab=evidence#page-2',
    );
  });

  it('falls back home when there is nothing to return to', () => {
    expect(safeReturnTo(null)).toBe('/');
    expect(safeReturnTo(undefined)).toBe('/');
    expect(safeReturnTo('')).toBe('/');
  });

  it('refuses every way of smuggling in another site', () => {
    // Each of these would turn a genuine CaseLens sign-in into a redirect to a lookalike page that
    // asks for the password again - after the victim did everything right.
    for (const hostile of [
      'https://evil.example/login',
      '//evil.example/login',
      '/\\evil.example/login',
      '/\t/evil.example/login',
      '/\n/evil.example/login',
      'javascript:alert(document.cookie)',
      'evil.example/login',
      // Dot segments, resolved by the URL parser into a protocol-relative path after the raw checks
      // had already passed. The security review found these; they are the regression guard.
      '/.//evil.example/login',
      '/%2e//evil.example',
      '/%2E%2E//evil.example',
      '/x/..//evil.example',
      '/..//evil.example',
      '/./\\evil.example',
    ]) {
      expect(safeReturnTo(hostile), hostile).toBe('/');
    }
  });

  it('never returns into the sign-in routes', () => {
    // A stale returnTo pointing back at /auth could loop sign-in indefinitely.
    expect(safeReturnTo('/auth/login?returnTo=%2F')).toBe('/');
    expect(safeReturnTo('/auth/callback?code=x')).toBe('/');
  });
});
