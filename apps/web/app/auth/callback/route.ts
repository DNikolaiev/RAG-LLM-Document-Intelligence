import { NextResponse, type NextRequest } from 'next/server';
import * as client from 'openid-client';
import { AuthError, identityFromClaims, type VerifiedIdentity } from '@caselens/auth';
import { authMode, oidcSettings } from '@/lib/auth/config';
import { oidcConfiguration } from '@/lib/auth/oidc';
import {
  cookieOptions,
  REFRESH_COOKIE,
  seal,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  TRANSACTION_COOKIE,
  unseal,
  type AuthTransaction,
} from '@/lib/auth/session';

/**
 * Completes the authorisation code flow and opens a session.
 *
 * The code is exchanged server-to-server, authenticated with the client secret, and the tokens go
 * straight into encrypted `httpOnly` cookies. At no point does page JavaScript see a token.
 */
export async function GET(request: NextRequest): Promise<Response> {
  if (authMode() !== 'oidc') return new Response(null, { status: 404 });
  const settings = oidcSettings();
  const signedOut = (reason: string) => {
    const response = NextResponse.redirect(
      new URL(`/auth/signed-out?reason=${reason}`, settings.redirectUri),
    );
    response.cookies.set(TRANSACTION_COOKIE, '', cookieOptions(0));
    return response;
  };

  // No transaction means this browser did not start this sign-in - it expired, or the callback URL
  // was delivered to it by someone else. Completing it anyway is exactly the login CSRF that
  // `state` exists to stop, so it is refused rather than retried.
  const transaction = await unseal<AuthTransaction>(
    request.cookies.get(TRANSACTION_COOKIE)?.value,
    'auth-transaction',
  );
  if (!transaction) return signedOut('expired');

  // Rebuilt from configuration rather than taken from the request. The redirect URI sent to the
  // token endpoint must match the registered one exactly, and trusting the incoming Host header to
  // produce it would let a forged header decide it.
  const currentUrl = new URL(settings.redirectUri);
  currentUrl.search = request.nextUrl.search;

  let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
  try {
    tokens = await client.authorizationCodeGrant(await oidcConfiguration(), currentUrl, {
      pkceCodeVerifier: transaction.codeVerifier,
      expectedState: transaction.state,
      expectedNonce: transaction.nonce,
      idTokenExpected: true,
    });
  } catch {
    return signedOut('failed');
  }
  if (!tokens.refresh_token) return signedOut('failed');

  let identity: VerifiedIdentity;
  try {
    identity = identityFromClaims(tokens.claims() ?? {});
  } catch (error) {
    // Authenticated, but with no role or no workspace. That is a provisioning gap, not a failed
    // sign-in, and the page says so rather than implying a wrong password.
    return signedOut(error instanceof AuthError ? 'no-access' : 'failed');
  }

  // A second check at the point of use. `returnTo` was reduced to a path at sign-in, but the one
  // property that matters is that the redirect stays on this site, so that is asserted directly
  // rather than trusted to have survived every earlier transformation.
  const destination = new URL(transaction.returnTo, settings.redirectUri);
  const response = NextResponse.redirect(
    destination.origin === settings.redirectUri.origin
      ? destination
      : new URL('/', settings.redirectUri),
  );
  // A fresh session every sign-in, never an existing cookie upgraded in place: a session value
  // planted before authentication must not become an authenticated one - session fixation.
  response.cookies.set(
    SESSION_COOKIE,
    await seal(
      {
        identity,
        accessToken: tokens.access_token,
        expiresAt: Date.now() + (tokens.expiresIn() ?? 300) * 1000,
      },
      'session',
      SESSION_MAX_AGE_SECONDS,
    ),
    cookieOptions(SESSION_MAX_AGE_SECONDS),
  );
  response.cookies.set(
    REFRESH_COOKIE,
    await seal(
      { refreshToken: tokens.refresh_token, idToken: tokens.id_token },
      'session-refresh',
      SESSION_MAX_AGE_SECONDS,
    ),
    cookieOptions(SESSION_MAX_AGE_SECONDS),
  );
  response.cookies.set(TRANSACTION_COOKIE, '', cookieOptions(0));
  return response;
}
