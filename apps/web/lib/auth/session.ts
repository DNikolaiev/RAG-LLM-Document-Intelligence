import { createHash } from 'node:crypto';
import { EncryptJWT, jwtDecrypt, type JWTPayload } from 'jose';
import type { VerifiedIdentity } from '@caselens/auth';
import { oidcSettings } from './config';

/**
 * The console's session, held in encrypted cookies - the backend-for-frontend pattern.
 *
 * Tokens never reach browser JavaScript. The console's server exchanges the authorisation code,
 * keeps the tokens in `httpOnly` cookies the page cannot read, and attaches the access token itself
 * when it calls the API. A token held in `localStorage` is readable by any script that runs on the
 * page, so one XSS bug would hand an attacker a bearer credential that works from anywhere until it
 * expires. Here the same bug gets them nothing they can take away.
 *
 * Encrypted as well as `httpOnly`, so a cookie that leaks through a log, a proxy or a support
 * screenshot is not a usable credential either.
 *
 * Split across two cookies because browsers cap one at 4096 bytes, and an access token, refresh
 * token and ID token together - encrypted and base64url-encoded - exceed it. The refresh cookie is
 * only read when the access token is about to expire.
 */

export const SESSION_COOKIE = 'caselens_session';
export const REFRESH_COOKIE = 'caselens_session_refresh';
export const TRANSACTION_COOKIE = 'caselens_auth_transaction';

/** The session outlives any single access token; it ends when the identity provider's session does. */
export const SESSION_MAX_AGE_SECONDS = 10 * 60 * 60;
/** A sign-in that has not come back within ten minutes has been abandoned. */
export const TRANSACTION_MAX_AGE_SECONDS = 10 * 60;

export type SessionIdentity = VerifiedIdentity;

export interface Session {
  identity: SessionIdentity;
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface RefreshSession {
  refreshToken: string;
  /** Kept for the `id_token_hint` that lets the identity provider end its session without asking. */
  idToken?: string;
}

export interface AuthTransaction {
  codeVerifier: string;
  state: string;
  nonce: string;
  returnTo: string;
}

/**
 * Each cookie is sealed for one purpose, recorded as the encrypted token's audience. All three share
 * a key, so without this a value lifted from one cookie could be replayed into another's slot - an
 * abandoned sign-in transaction presented as a session, say. The audience check makes that fail.
 */
type Purpose = 'session' | 'session-refresh' | 'auth-transaction';

function key(): Uint8Array {
  return createHash('sha256').update(oidcSettings().sessionSecret).digest();
}

export async function seal(
  payload: object,
  purpose: Purpose,
  maxAgeSeconds: number,
): Promise<string> {
  return new EncryptJWT({ ...(payload as JWTPayload) })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setAudience(purpose)
    .setIssuedAt()
    .setExpirationTime(`${maxAgeSeconds}s`)
    .encrypt(key());
}

/** The payload, or null for anything missing, tampered with, expired, or sealed for another purpose. */
export async function unseal<T>(value: string | undefined, purpose: Purpose): Promise<T | null> {
  if (!value) return null;
  try {
    const { payload } = await jwtDecrypt(value, key(), { audience: purpose });
    return payload as T;
  } catch {
    return null;
  }
}

export type CookieReader = (name: string) => string | undefined;

export function readSession(read: CookieReader): Promise<Session | null> {
  return unseal<Session>(read(SESSION_COOKIE), 'session');
}

export function readRefresh(read: CookieReader): Promise<RefreshSession | null> {
  return unseal<RefreshSession>(read(REFRESH_COOKIE), 'session-refresh');
}

/**
 * `httpOnly` so page script cannot read it; `SameSite=Lax` so it rides the top-level redirect back
 * from the identity provider - `Strict` would drop it on exactly that cross-site navigation and the
 * sign-in would fail - while still being withheld from cross-site POSTs, which is the CSRF
 * protection the mutating routes rely on.
 */
export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: oidcSettings().secureCookies,
    path: '/',
    maxAge,
  };
}
