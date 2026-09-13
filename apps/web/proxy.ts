import { NextResponse, type NextRequest } from 'next/server';
import * as client from 'openid-client';
import { identityFromClaims } from '@caselens/auth';
import { authMode } from '@/lib/auth/config';
import { oidcConfiguration } from '@/lib/auth/oidc';
import {
  cookieOptions,
  readRefresh,
  readSession,
  REFRESH_COOKIE,
  seal,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  type Session,
} from '@/lib/auth/session';

/** Refresh a minute early, so a token never expires between this check and the upstream call. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * The console's authentication gate, and the only place a session is refreshed.
 *
 * Next's proxy (formerly middleware) runs before every route renders, and - unlike a server
 * component - it can set cookies. That is why refresh lives here: a server component that found an
 * expired token could fetch a new one but would have no way to hand it back to the browser.
 *
 * This is the gate for presentation, not the security boundary. The API verifies every token
 * itself, so a request that somehow slipped past here would still be refused where it matters.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (authMode() !== 'oidc') return NextResponse.next();

  const read = (name: string) => request.cookies.get(name)?.value;
  const session = await readSession(read);
  if (!session) return unauthenticated(request);
  if (session.expiresAt - Date.now() > REFRESH_MARGIN_MS) return NextResponse.next();

  const refresh = await readRefresh(read);
  if (!refresh) return unauthenticated(request);

  let tokens: Awaited<ReturnType<typeof client.refreshTokenGrant>>;
  try {
    tokens = await client.refreshTokenGrant(await oidcConfiguration(), refresh.refreshToken);
  } catch {
    // The identity provider's session is over - it timed out, or someone ended it. Signing in
    // again is the correct response; retrying the same refresh token is not.
    return unauthenticated(request);
  }

  // Identity is re-read from the fresh ID token, not carried over. This is how a role removed or a
  // workspace revoked in the identity provider reaches the console: within one access-token
  // lifetime, on the next refresh, without anyone having to sign out.
  let identity = session.identity;
  const claims = tokens.claims();
  if (claims) {
    try {
      identity = identityFromClaims(claims);
    } catch {
      return unauthenticated(request);
    }
  }

  const next: Session = {
    identity,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + (tokens.expiresIn() ?? 300) * 1000,
  };
  const sealedSession = await seal(next, 'session', SESSION_MAX_AGE_SECONDS);
  const sealedRefresh = await seal(
    {
      refreshToken: tokens.refresh_token ?? refresh.refreshToken,
      idToken: tokens.id_token ?? refresh.idToken,
    },
    'session-refresh',
    SESSION_MAX_AGE_SECONDS,
  );

  // The new tokens have two readers. The render happening in this same request reads cookies from
  // the request, so the request is rewritten; the browser keeps them for next time, so the response
  // sets them too. Setting only the response would leave this one render calling the API with the
  // token that just expired.
  request.cookies.set(SESSION_COOKIE, sealedSession);
  request.cookies.set(REFRESH_COOKIE, sealedRefresh);
  const response = NextResponse.next({ request: { headers: request.headers } });
  response.cookies.set(SESSION_COOKIE, sealedSession, cookieOptions(SESSION_MAX_AGE_SECONDS));
  response.cookies.set(REFRESH_COOKIE, sealedRefresh, cookieOptions(SESSION_MAX_AGE_SECONDS));
  return response;
}

function unauthenticated(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  // An API call gets a 401 it can act on. Redirecting it to the sign-in page would have `fetch`
  // follow the redirect and hand the page's HTML to code expecting JSON.
  const response = pathname.startsWith('/api/')
    ? NextResponse.json(
        { code: 'UNAUTHENTICATED', detail: 'Sign in to continue.' },
        { status: 401 },
      )
    : NextResponse.redirect(
        new URL(`/auth/login?returnTo=${encodeURIComponent(`${pathname}${search}`)}`, request.url),
      );
  // Whatever was there is no longer good. Clearing it stops every following request from retrying
  // a refresh token the identity provider has already refused.
  response.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  response.cookies.set(REFRESH_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
}

export const config = {
  // Everything except the sign-in routes themselves and static assets. Auth logic that also ran on
  // `_next/static` would redirect the page's own JavaScript and CSS to the login screen.
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|auth/|healthz|demo-documents/|.*\\.(?:png|svg|jpg|jpeg|gif|webp|ico|woff2?|pdf)$).*)',
  ],
};
