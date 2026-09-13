import { NextResponse, type NextRequest } from 'next/server';
import * as client from 'openid-client';
import { authMode, oidcSettings } from '@/lib/auth/config';
import { oidcConfiguration } from '@/lib/auth/oidc';
import { safeReturnTo } from '@/lib/auth/return-to';
import {
  cookieOptions,
  seal,
  TRANSACTION_COOKIE,
  TRANSACTION_MAX_AGE_SECONDS,
  type AuthTransaction,
} from '@/lib/auth/session';

/**
 * Starts the authorisation code flow.
 *
 * Three values are bound to this one sign-in, and each closes a different hole:
 *
 * - `state` ties the callback to the browser that started it. Without it, an attacker can complete
 *   *their* sign-in in the victim's browser - login CSRF - and the victim then works, and uploads
 *   documents, inside the attacker's account.
 * - PKCE ties the authorisation code to a secret that never leaves this server, so a code
 *   intercepted on its way back through the browser is worthless on its own.
 * - `nonce` ties the ID token to this sign-in, so a token captured from an earlier one cannot be
 *   replayed into it.
 *
 * All three are kept in an encrypted, short-lived cookie until the callback.
 */
export async function GET(request: NextRequest): Promise<Response> {
  if (authMode() !== 'oidc') return new Response(null, { status: 404 });
  const settings = oidcSettings();

  let config: client.Configuration;
  try {
    config = await oidcConfiguration();
  } catch {
    return NextResponse.redirect(
      new URL('/auth/signed-out?reason=unavailable', settings.redirectUri),
    );
  }

  const transaction: AuthTransaction = {
    codeVerifier: client.randomPKCECodeVerifier(),
    state: client.randomState(),
    nonce: client.randomNonce(),
    returnTo: safeReturnTo(request.nextUrl.searchParams.get('returnTo')),
  };
  const authorization = client.buildAuthorizationUrl(config, {
    redirect_uri: settings.redirectUri.href,
    scope: 'openid profile email',
    code_challenge: await client.calculatePKCECodeChallenge(transaction.codeVerifier),
    code_challenge_method: 'S256',
    state: transaction.state,
    nonce: transaction.nonce,
  });

  const response = NextResponse.redirect(authorization);
  response.cookies.set(
    TRANSACTION_COOKIE,
    await seal(transaction, 'auth-transaction', TRANSACTION_MAX_AGE_SECONDS),
    cookieOptions(TRANSACTION_MAX_AGE_SECONDS),
  );
  return response;
}
