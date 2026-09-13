/**
 * Which identity mode the console runs in, and the settings verified identity needs.
 *
 * Read at request time rather than import time: `next build` evaluates modules without the runtime
 * environment, and a missing secret should fail the first sign-in loudly rather than the build.
 */
export type AuthMode = 'oidc' | 'test-profiles' | 'demo';

export function authMode(): AuthMode {
  if (process.env.AUTH_MODE === 'oidc') return 'oidc';
  return process.env.AUTH_MODE === 'test-profiles' ? 'test-profiles' : 'demo';
}

export interface OidcSettings {
  /** The issuer as the browser reaches it, and as it is printed in every token. */
  issuer: URL;
  /**
   * The same issuer as this server reaches it. Inside a container network the identity provider
   * has a private address, but tokens name the public one - so server-to-server calls are rewritten
   * to the private address while every identifier stays public. Null when both are the same.
   */
  internalIssuer: URL | null;
  clientId: string;
  clientSecret: string;
  redirectUri: URL;
  postLogoutRedirectUri: URL;
  sessionSecret: string;
  secureCookies: boolean;
}

export function oidcSettings(): OidcSettings {
  const read = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required when AUTH_MODE=oidc`);
    return value;
  };
  const sessionSecret = read('SESSION_SECRET');
  // The session cookie key is derived from this. A short secret is a guessable key, and a guessed
  // key lets anyone mint a session cookie naming any user.
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  const internal = process.env.OIDC_INTERNAL_ISSUER;
  return {
    issuer: new URL(read('OIDC_ISSUER')),
    internalIssuer: internal ? new URL(internal) : null,
    clientId: read('OIDC_CLIENT_ID'),
    clientSecret: read('OIDC_CLIENT_SECRET'),
    redirectUri: new URL(read('OIDC_REDIRECT_URI')),
    postLogoutRedirectUri: new URL(read('OIDC_POST_LOGOUT_REDIRECT_URI')),
    sessionSecret,
    secureCookies: process.env.COOKIE_SECURE === 'true',
  };
}

/** The console's own origin, taken from configuration rather than the request's Host header. */
export function appOrigin(): string {
  return oidcSettings().redirectUri.origin;
}
