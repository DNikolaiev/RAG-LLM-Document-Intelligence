import { NextResponse, type NextRequest } from 'next/server';
import * as client from 'openid-client';
import { authMode, oidcSettings } from '@/lib/auth/config';
import { oidcConfiguration } from '@/lib/auth/oidc';
import { cookieOptions, readRefresh, REFRESH_COOKIE, SESSION_COOKIE } from '@/lib/auth/session';

/**
 * Ends the console session and the identity provider's session.
 *
 * Both, because ending only ours is a sign-out that does not sign out: the identity provider still
 * holds a live single-sign-on session, so the next "Sign in" completes silently without a password
 * - on a shared machine, as the previous person.
 *
 * POST only, and only from this origin. `SameSite=Lax` already withholds the session cookie from a
 * cross-site POST, but the cookie deletions below would still be honoured, so without the origin
 * check any other site could sign people out of CaseLens at will.
 */
export async function POST(request: NextRequest): Promise<Response> {
  if (authMode() !== 'oidc') return new Response(null, { status: 404 });
  const settings = oidcSettings();
  if (request.headers.get('origin') !== settings.redirectUri.origin) {
    return new Response(null, { status: 403 });
  }

  const refresh = await readRefresh((name) => request.cookies.get(name)?.value);
  let destination = new URL('/auth/signed-out', settings.redirectUri);
  try {
    destination = client.buildEndSessionUrl(await oidcConfiguration(), {
      post_logout_redirect_uri: settings.postLogoutRedirectUri.href,
      // The ID token proves which session to end, so the provider can end it without an
      // "are you sure?" page. Without it, the client id at least lets it validate the redirect.
      ...(refresh?.idToken ? { id_token_hint: refresh.idToken } : { client_id: settings.clientId }),
    });
  } catch {
    // The provider is unreachable. The local session still ends; leaving someone signed in because
    // a different system is down would be the wrong way round.
  }

  // 303 so the browser follows with a GET rather than re-sending the POST to the provider.
  const response = NextResponse.redirect(destination, 303);
  response.cookies.set(SESSION_COOKIE, '', cookieOptions(0));
  response.cookies.set(REFRESH_COOKIE, '', cookieOptions(0));
  return response;
}
