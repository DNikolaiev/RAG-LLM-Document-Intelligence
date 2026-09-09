import { resolveTestProfile } from '@caselens/contracts';

/**
 * Who is asking, reduced to the only two things the projection needs to scope a query.
 *
 * Every projection row carries `tenant_id`, copied from the event, so scoping is trivial. What this
 * service does not have is any notion of a user - it has never seen a login and never will.
 */
export interface CallerContext {
  tenantIds: readonly string[];
  platformAdmin: boolean;
}

/**
 * The interim identity adapter, and deliberately the only place in this service that knows how a
 * caller is identified.
 *
 * Today it resolves the same local test profile `apps/api` resolves, from the same helper, so the
 * two cannot drift - duplicating the profile table here would be a silent-divergence bug waiting to
 * happen. That is a real dependency on the identity half of `@caselens/contracts`, and it is the
 * one coupling this service accepts.
 *
 * When Keycloak arrives (see the production backlog) this function becomes a JWT verification
 * against cached JWKS and the dependency goes away. Nothing else in the service changes, because
 * nothing else in the service asks who the caller is: the queries take a `CallerContext` parameter.
 * Note what this must never become - a call to the issuer per request. That would make an outage of
 * the auth service an outage of everything, which is strictly worse than the monolith it replaced.
 */
export function resolveCaller(profileHeader: string | undefined): CallerContext {
  const profile = resolveTestProfile(profileHeader);
  return { tenantIds: profile.tenantIds, platformAdmin: profile.platformAdmin };
}
