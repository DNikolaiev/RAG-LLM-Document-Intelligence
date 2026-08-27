import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ulid } from 'ulid';
import { resolveTestProfile } from '@caselens/contracts';
import { loadConfig } from '@caselens/config';
import type { RequestContext } from './request-context.js';

const roles = new Set(['intake', 'reviewer', 'approver', 'auditor', 'admin']);

@Injectable()
export class ContextMiddleware implements NestMiddleware {
  private readonly config = loadConfig();

  use(request: Request, response: Response, next: NextFunction): void {
    const correlationId = request.header('x-correlation-id') ?? `cor_${ulid()}`;
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
    (request as Request & { context: RequestContext }).context = {
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
    response.setHeader('x-correlation-id', correlationId);
    next();
  }
}
