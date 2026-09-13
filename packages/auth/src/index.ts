import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

/**
 * Token verification and claim mapping, shared by every service that accepts a bearer token.
 *
 * Shared rather than copied because the failure mode of two copies is specific and bad: one service
 * quietly accepts a token the other rejects - a missing audience check, a looser algorithm list -
 * and the weaker one becomes the way in. Authentication is centralised in the identity provider;
 * verifying what it issued has to be identical everywhere it is checked.
 *
 * What this deliberately does not do is call the identity provider per request. Signing keys are
 * fetched once from the JWKS endpoint and cached, and every signature is checked in-process. A
 * per-request call to the issuer would make its outage an outage of every service, which is
 * strictly worse than the monolith this system started as.
 */

export type ApplicationRole = 'intake' | 'reviewer' | 'approver' | 'auditor' | 'admin';

/** The identity a service acts on, reduced from token claims to what authorisation needs. */
export interface VerifiedIdentity {
  /** The identity provider's stable subject identifier - not necessarily the application user id. */
  subject: string;
  displayName: string;
  email: string | null;
  tenantIds: string[];
  role: ApplicationRole;
  platformAdmin: boolean;
}

export type AuthFailure =
  | 'MISSING_TOKEN'
  | 'INVALID_TOKEN'
  | 'NO_ROLE'
  | 'NO_TENANT'
  | 'UNKNOWN_SUBJECT'
  | 'KEYS_UNAVAILABLE';

export class AuthError extends Error {
  constructor(
    readonly reason: AuthFailure,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }

  /**
   * 401 when the caller cannot be identified, 403 when they are identified and not allowed, and 503
   * when the service cannot tell - its signing keys are unreachable. Answering 401 for that last
   * case would tell a correctly authenticated user their credentials are wrong during an identity
   * provider outage, which sends them to reset a password that was never the problem.
   */
  get status(): 401 | 403 | 503 {
    if (this.reason === 'KEYS_UNAVAILABLE') return 503;
    if (this.reason === 'NO_ROLE' || this.reason === 'NO_TENANT') return 403;
    if (this.reason === 'UNKNOWN_SUBJECT') return 403;
    return 401;
  }
}

/** Highest first, so a user holding several roles acts with the most capable one. */
const ROLE_PRECEDENCE: readonly ApplicationRole[] = [
  'admin',
  'approver',
  'reviewer',
  'auditor',
  'intake',
];
const PLATFORM_ADMIN_ROLE = 'platform_admin';

/**
 * Reduces verified claims to an application identity.
 *
 * Only ever called on claims whose signature, issuer, audience and lifetime have already been
 * checked - by `createTokenVerifier` for an access token, or by the OIDC client for an ID token it
 * received at login. It maps; it does not trust.
 *
 * Tenant membership arrives as group names. A leading `/` is stripped because Keycloak emits full
 * group paths when its mapper is configured that way, and "is this user in tenant_demo" should not
 * depend on a checkbox in the identity provider's admin console.
 */
export function identityFromClaims(claims: JWTPayload): VerifiedIdentity {
  const subject = typeof claims.sub === 'string' ? claims.sub : '';
  if (!subject) throw new AuthError('INVALID_TOKEN', 'The token names no subject.');

  const realmAccess = claims.realm_access as { roles?: unknown } | undefined;
  const roles = stringList(claims.roles ?? realmAccess?.roles);
  const platformAdmin = roles.includes(PLATFORM_ADMIN_ROLE);
  const role = platformAdmin
    ? 'admin'
    : ROLE_PRECEDENCE.find((candidate) => roles.includes(candidate));
  // Authenticated but unassigned is a real state - a user created in the identity provider before
  // anyone gave them a role - and it must be a refusal, not a default. Defaulting to the least
  // capable role would still grant read access to a tenant nobody chose to give them.
  if (!role) throw new AuthError('NO_ROLE', 'The account has no CaseLens role.');

  const tenantIds = [
    ...new Set(stringList(claims.tenants).map((tenant) => tenant.replace(/^\//, ''))),
  ];
  if (!platformAdmin && tenantIds.length === 0) {
    throw new AuthError('NO_TENANT', 'The account belongs to no tenant workspace.');
  }

  return {
    subject,
    displayName: text(claims.name) ?? text(claims.preferred_username) ?? subject,
    email: text(claims.email) ?? null,
    tenantIds,
    role,
    platformAdmin,
  };
}

export interface TokenVerifierOptions {
  /** The issuer printed in tokens, which is the address the browser uses for the identity provider. */
  issuer: string;
  /**
   * The audience this service requires. Each service names itself, so a token minted for one
   * cannot be replayed against another - audience is how a service knows a token was meant for it.
   */
  audience: string;
  /**
   * Where signing keys are fetched from. Separate from `issuer` because a service on a private
   * network usually reaches the identity provider at a different address than the public one its
   * tokens name - the split-horizon problem, which every containerised deployment meets.
   */
  jwksUrl?: string;
  /** A local key set instead of a network fetch, for tests. */
  keys?: JWTVerifyGetKey;
}

export type TokenVerifier = (token: string) => Promise<VerifiedIdentity>;

export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  if (!options.keys && !options.jwksUrl) {
    throw new Error('A token verifier needs a JWKS URL or a key set.');
  }
  const keys =
    options.keys ??
    createRemoteJWKSet(new URL(options.jwksUrl!), {
      // Keys rotate rarely. Cached for ten minutes, refetched immediately when a token names an
      // unknown key id - which is how a rotation is picked up - but at most every thirty seconds, so
      // a flood of forged tokens with random key ids cannot turn this into a request amplifier
      // aimed at the identity provider.
      cacheMaxAge: 10 * 60_000,
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    });

  return async (token) => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer: options.issuer,
        audience: options.audience,
        // Pinned rather than taken from the token header. Accepting whatever `alg` a token declares
        // is the classic algorithm-confusion hole: a token "signed" with HS256 using the public key
        // as the HMAC secret would verify against a key set that was only ever meant for RS256.
        algorithms: ['RS256'],
        // Containers and the identity provider rarely agree on the time to the second.
        clockTolerance: 30,
      }));
    } catch (error) {
      if (isKeyFetchFailure(error)) {
        throw new AuthError('KEYS_UNAVAILABLE', 'Signing keys are unavailable.');
      }
      throw new AuthError('INVALID_TOKEN', 'The token is not valid for this service.');
    }
    return identityFromClaims(payload);
  };
}

/**
 * Extracts an RFC 6750 bearer token, or null.
 *
 * Strict about the shape on purpose: anything that is not exactly `Bearer <token>` is treated as
 * no credential at all, rather than being handed to the verifier to fail in some less obvious way.
 */
export function bearerToken(header: string | string[] | undefined | null): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(value ?? '');
  return match ? match[1]! : null;
}

function isKeyFetchFailure(error: unknown): boolean {
  if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) return true;
  // A network failure reaching the JWKS endpoint surfaces as the fetch error itself, not a JOSE
  // error. Anything jose raises about the token - bad signature, wrong audience, expired, unknown
  // key id - is a JOSEError subclass with its own code.
  if (!(error instanceof errors.JOSEError)) return true;
  // A non-200 from the JWKS endpoint is the generic JOSE error.
  return error.code === 'ERR_JOSE_GENERIC';
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? [value] : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
