const PLACEHOLDER_ORIGIN = 'http://return-to.invalid';

/**
 * Where to send someone after sign-in, reduced to a path on this site.
 *
 * `returnTo` arrives in a URL anyone can craft, and the callback redirects to it with a fresh
 * session attached. Accepting an absolute URL would make the console's login an open redirect: a
 * link to the genuine CaseLens sign-in that lands, after a real login, on a lookalike asking for the
 * password again. The victim did everything right and still typed it into the wrong page.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value) return '/';
  // A single-slash path only. `//evil.example` is protocol-relative - an absolute URL in disguise -
  // and several browsers treat `/\evil.example` the same way.
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  try {
    // Parsed against a placeholder origin: anything that moves it off that origin was never a path.
    // This also catches tabs and newlines, which the URL parser strips - `/\t/evil.example`
    // becomes `//evil.example` once parsed, and the origin check sees it.
    const parsed = new URL(value, PLACEHOLDER_ORIGIN);
    if (parsed.origin !== PLACEHOLDER_ORIGIN) return '/';
    // Checked again after parsing, because the parser resolves dot segments: `/.//evil.example`
    // passes every check on the raw string and comes out as `//evil.example` - protocol-relative,
    // and off-site the moment the callback resolves it. Found by the security review of this code.
    if (parsed.pathname.startsWith('//')) return '/';
    // Never back into the sign-in routes, or a stale value could loop sign-in indefinitely.
    if (parsed.pathname.startsWith('/auth/')) return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}
