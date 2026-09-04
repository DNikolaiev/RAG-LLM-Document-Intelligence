import { BadRequestException } from '@nestjs/common';
import type { RequestContext } from './request-context.js';

/**
 * Resolves which tenant a mutating request acts against.
 *
 * A non-platform-administrator is locked to their own membership tenant - `context.tenantId` -
 * regardless of anything they pass, so a tenant user can never act cross-tenant even by mistake
 * or by naming another tenant explicitly. A platform administrator carries no default tenant:
 * `context.tenantId` is `profile.activeTenantId ?? profile.tenantIds[0]`
 * (`apps/api/src/context.middleware.ts`), and the platform-admin test profile's `activeTenantId`
 * is `null`, so without this guard a platform administrator's request would silently resolve to
 * the first of their many tenant memberships. Here they must name one from their own `tenantIds`,
 * or the request is refused with `TENANT_REQUIRED` rather than guessing.
 *
 * Originally private to `PoliciesService` (`resolveTenant`, used by the policy-library upload and
 * governance endpoints). Extracted here so `CasesService` and `ProductionCasesService` share the
 * exact same semantic for case intake instead of a second, possibly-drifting copy.
 */
export function resolveTenant(context: RequestContext, requested?: string | undefined): string {
  if (!context.platformAdmin) return context.tenantId;
  if (!requested || !context.tenantIds.includes(requested)) {
    throw new BadRequestException({
      code: 'TENANT_REQUIRED',
      message: 'Platform administrators must choose a tenant.',
    });
  }
  return requested;
}
