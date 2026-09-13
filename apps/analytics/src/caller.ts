import type { IncomingHttpHeaders } from 'node:http';
import { AuthError, bearerToken, type TokenVerifier } from '@caselens/auth';
import { resolveTestProfile } from '@caselens/contracts';

/**
 * Who is asking, reduced to the only two things the projection needs to scope a query.
 *
 * Every projection row carries `tenant_id`, copied from the event, so scoping is trivial. This
 * service has no notion of an application user and needs none - it keeps no foreign keys to users,
 * so unlike the API it has nothing to map a token's subject onto.
 */
export interface CallerContext {
  tenantIds: readonly string[];
  platformAdmin: boolean;
}

export type CallerResolver = (
  headers: IncomingHttpHeaders,
) => CallerContext | Promise<CallerContext>;

/**
 * The only place in this service that knows how a caller is identified.
 *
 * Under verified identity the answer comes from a bearer token checked against the identity
 * provider's published keys, and from nothing else: the test-profile header is never read on that
 * path, because a header that names a user is a way to become them without a signature. The token
 * must carry this service's own audience, so a token minted only for the API is refused here too.
 *
 * Otherwise it resolves the local test profile from the same helper the API uses, so the two cannot
 * drift.
 */
export function createCallerResolver(options: { verify?: TokenVerifier | null }): CallerResolver {
  const verify = options.verify;
  if (verify) {
    return async (headers) => {
      const token = bearerToken(headers.authorization);
      if (!token) throw new AuthError('MISSING_TOKEN', 'A bearer token is required.');
      const identity = await verify(token);
      return { tenantIds: identity.tenantIds, platformAdmin: identity.platformAdmin };
    };
  }
  return (headers) => {
    const header = headers['x-test-profile-id'];
    return resolveCaller(Array.isArray(header) ? header[0] : header);
  };
}

/** The local test-profile identity. Never reachable once verified identity is configured. */
export function resolveCaller(profileHeader: string | undefined): CallerContext {
  const profile = resolveTestProfile(profileHeader);
  return { tenantIds: profile.tenantIds, platformAdmin: profile.platformAdmin };
}
