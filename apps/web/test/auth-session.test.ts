// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seal, unseal } from '../lib/auth/session';

const SECRET = 'a-local-session-secret-of-at-least-32-characters';
const environment = {
  OIDC_ISSUER: 'http://localhost:8080/realms/caselens',
  OIDC_CLIENT_ID: 'caselens-web',
  OIDC_CLIENT_SECRET: 'client-secret',
  OIDC_REDIRECT_URI: 'http://localhost:3000/auth/callback',
  OIDC_POST_LOGOUT_REDIRECT_URI: 'http://localhost:3000/auth/signed-out',
  SESSION_SECRET: SECRET,
};
const saved = { ...process.env };

beforeEach(() => Object.assign(process.env, environment));
afterEach(() => {
  process.env = { ...saved };
});

describe('encrypted session cookies', () => {
  it('round-trips a session', async () => {
    const sealed = await seal({ accessToken: 'token', expiresAt: 1 }, 'session', 60);
    expect(await unseal(sealed, 'session')).toMatchObject({ accessToken: 'token', expiresAt: 1 });
  });

  it('does not carry the token in readable form', async () => {
    // httpOnly keeps it from page script; encryption keeps it from anything that logs or copies a
    // cookie header. Neither the value nor its base64 encoding may appear in the sealed form.
    const token = 'eyJhbGciOiJSUzI1NiJ9.secret-bearer-token-value';
    const sealed = await seal({ accessToken: token }, 'session', 60);
    expect(sealed).not.toContain('secret-bearer-token-value');
    expect(sealed).not.toContain(Buffer.from(token).toString('base64url'));
  });

  it('refuses a value sealed for a different cookie', async () => {
    // All three cookies share a key. Without purpose binding, an abandoned sign-in transaction
    // could be replayed into the session cookie's slot.
    const transaction = await seal({ state: 's', nonce: 'n' }, 'auth-transaction', 60);
    expect(await unseal(transaction, 'session')).toBeNull();
  });

  it('refuses a tampered value', async () => {
    const sealed = await seal({ accessToken: 'token' }, 'session', 60);
    const flipped = `${sealed.slice(0, -6)}${sealed.slice(-6) === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA'}`;
    expect(await unseal(flipped, 'session')).toBeNull();
  });

  it('refuses a value sealed under another key', async () => {
    const sealed = await seal({ accessToken: 'token' }, 'session', 60);
    process.env.SESSION_SECRET = 'a-different-secret-that-is-also-32-characters-long';
    expect(await unseal(sealed, 'session')).toBeNull();
  });

  it('refuses an expired value', async () => {
    const sealed = await seal({ accessToken: 'token' }, 'session', -60);
    expect(await unseal(sealed, 'session')).toBeNull();
  });

  it('will not key a session with a guessable secret', async () => {
    // The cookie key is derived from this; a short secret is a key an attacker can search for, and
    // with it they could mint a session naming any user.
    process.env.SESSION_SECRET = 'short';
    await expect(seal({}, 'session', 60)).rejects.toThrow(/at least 32 characters/);
  });
});
