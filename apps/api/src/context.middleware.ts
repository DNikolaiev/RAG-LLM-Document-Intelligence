import {
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  type NestMiddleware,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ulid } from 'ulid';
import { AuthError, bearerToken, createTokenVerifier, type TokenVerifier } from '@caselens/auth';
import { resolveTestProfile } from '@caselens/contracts';
import { loadConfig } from '@caselens/config';
import { CASES_RUNTIME, type CasesRuntime } from './cases-runtime.js';
import type { RequestContext } from './request-context.js';

const roles = new Set(['intake', 'reviewer', 'approver', 'auditor', 'admin']);

/** The workspace the console has selected. Honoured only inside what the token already grants. */
export const ACTIVE_TENANT_HEADER = 'x-caselens-tenant';

/** How long a resolved subject is trusted before it is looked up again. */
const SUBJECT_CACHE_MS = 5 * 60_000;

@Injectable()
export class ContextMiddleware implements NestMiddleware {
  private readonly config = loadConfig();
  private readonly verify: TokenVerifier | null;
  // Positive results only. Caching "not provisioned" would keep refusing a user for five minutes
  // after an administrator fixed the problem, which reads as the fix not working.
  private readonly subjects = new Map<string, { userId: string; until: number }>();

  constructor(@Inject(CASES_RUNTIME) private readonly cases: CasesRuntime) {
    this.verify =
      this.config.AUTH_MODE === 'oidc'
        ? createTokenVerifier({
            issuer: this.config.OIDC_ISSUER!,
            audience: this.config.OIDC_AUDIENCE!,
            jwksUrl: this.config.OIDC_JWKS_URL!,
          })
        : null;
  }

  async use(request: Request, response: Response, next: NextFunction): Promise<void> {
    const correlationId = request.header('x-correlation-id') ?? `cor_${ulid()}`;
    response.setHeader('x-correlation-id', correlationId);

    if (this.verify) {
      // Probes carry no identity and must not need one: a container orchestrator asking whether the
      // process is alive is not a user, and making it authenticate would tie the API's liveness to
      // the identity provider's.
      if (request.originalUrl.startsWith('/v1/health/')) return next();
      try {
        (request as Request & { context: RequestContext }).context = await this.verifiedContext(
          request,
          correlationId,
        );
      } catch (error) {
        throw toHttpError(error, response);
      }
      return next();
    }

    (request as Request & { context: RequestContext }).context = this.trustedContext(
      request,
      correlationId,
    );
    next();
  }

  /**
   * Identity from a verified bearer token, and from nothing else.
   *
   * No header other than `Authorization` contributes to who the caller is. `x-test-profile-id`,
   * `x-user-id`, `x-role` and `x-tenant-id` are never read on this path - any of them would be a way
   * to name yourself someone else without a signature, which is the whole thing verification exists
   * to prevent.
   */
  private async verifiedContext(request: Request, correlationId: string): Promise<RequestContext> {
    const token = bearerToken(request.header('authorization'));
    if (!token) throw new AuthError('MISSING_TOKEN', 'A bearer token is required.');
    const identity = await this.verify!(token);
    const userId = await this.userIdFor(identity.subject);

    // The active workspace is a choice the console makes, so it arrives as a header. It can narrow
    // what the token allows and never widen it: a tenant the token does not grant is ignored rather
    // than honoured, so the header cannot be used to step into somebody else's workspace.
    const requested = request.header(ACTIVE_TENANT_HEADER);
    const tenantId =
      requested && (identity.platformAdmin || identity.tenantIds.includes(requested))
        ? requested
        : (identity.tenantIds[0] ?? '');

    return {
      profileId: userId,
      tenantId,
      tenantIds: identity.tenantIds,
      userId,
      role: identity.role,
      platformAdmin: identity.platformAdmin,
      correlationId,
    };
  }

  /**
   * Maps the identity provider's subject to the application user it was provisioned as.
   *
   * The demo runtime has no user table, so there the subject is the user. Under PostgreSQL the
   * mapping goes through `users.external_subject`, and an unmapped subject is refused: it
   * authenticated, but nobody provisioned it here, and passing its id through would satisfy
   * authentication and then fail a foreign key on the first write.
   */
  private async userIdFor(subject: string): Promise<string> {
    if (!('resolveSubject' in this.cases)) return subject;
    const cached = this.subjects.get(subject);
    if (cached && cached.until > Date.now()) return cached.userId;
    const userId = await (
      this.cases as { resolveSubject: (subject: string) => Promise<string | null> }
    ).resolveSubject(subject);
    if (!userId) {
      throw new AuthError('UNKNOWN_SUBJECT', 'This account is not provisioned in CaseLens.');
    }
    this.subjects.set(subject, { userId, until: Date.now() + SUBJECT_CACHE_MS });
    return userId;
  }

  /** The local test-profile and demo identity. Unchanged, and never reachable under `oidc`. */
  private trustedContext(request: Request, correlationId: string): RequestContext {
    const profileHeader = request.header('x-test-profile-id');
    const useProfiles =
      (this.config.APP_MODE === 'demo' && profileHeader !== undefined) ||
      (this.config.AUTH_MODE === 'test-profiles' && this.config.ENABLE_TEST_IDENTITY_SWITCHER);
    const profile = resolveTestProfile(profileHeader);
    const legacyRoleHeader =
      this.config.APP_MODE === 'demo' ? (request.header('x-role') ?? 'reviewer') : 'reviewer';
    const legacyTenantId =
      this.config.APP_MODE === 'demo'
        ? (request.header('x-tenant-id') ?? this.config.DEMO_TENANT_ID)
        : this.config.DEMO_TENANT_ID;
    return {
      profileId: useProfiles ? profile.id : 'legacy-demo-profile',
      tenantId: useProfiles ? (profile.activeTenantId ?? profile.tenantIds[0]!) : legacyTenantId,
      tenantIds: useProfiles ? profile.tenantIds : [legacyTenantId],
      userId: useProfiles
        ? profile.id
        : this.config.APP_MODE === 'demo'
          ? (request.header('x-user-id') ?? 'user_demo_reviewer')
          : 'unverified-production-user',
      role: useProfiles
        ? profile.role === 'platform_admin'
          ? 'admin'
          : profile.role
        : roles.has(legacyRoleHeader)
          ? (legacyRoleHeader as 'intake' | 'reviewer' | 'approver' | 'auditor' | 'admin')
          : 'reviewer',
      platformAdmin: useProfiles && profile.platformAdmin,
      correlationId,
    };
  }
}

/**
 * Turns an authentication failure into the right problem response.
 *
 * A 401 carries `WWW-Authenticate`, as RFC 6750 requires, so a client can tell "authenticate" from
 * "you may not". The error code is omitted when no credential was presented at all, which is what
 * the RFC prescribes for that case.
 */
function toHttpError(error: unknown, response: Response): HttpException {
  if (!(error instanceof AuthError)) {
    return error instanceof HttpException
      ? error
      : new ServiceUnavailableException({
          code: 'AUTHENTICATION_UNAVAILABLE',
          message: 'Identity could not be established.',
        });
  }
  const body = { code: error.reason, message: error.message };
  if (error.status === 401) {
    response.setHeader(
      'www-authenticate',
      error.reason === 'MISSING_TOKEN'
        ? 'Bearer realm="caselens"'
        : 'Bearer realm="caselens", error="invalid_token"',
    );
    return new UnauthorizedException(body);
  }
  if (error.status === 403) return new ForbiddenException(body);
  return new ServiceUnavailableException(body);
}
