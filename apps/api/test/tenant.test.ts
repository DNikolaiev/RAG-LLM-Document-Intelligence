import { describe, expect, it } from 'vitest';
import { resolveTenant } from '../src/tenant.js';
import type { RequestContext } from '../src/request-context.js';

const tenantUser: RequestContext = {
  profileId: 'profile_lena_vogt',
  tenantId: 'tenant_demo',
  tenantIds: ['tenant_demo'],
  userId: 'reviewer_1',
  role: 'reviewer',
  platformAdmin: false,
  correlationId: 'cor_test',
};

const platformAdmin: RequestContext = {
  profileId: 'profile_platform_admin',
  // A platform administrator's `tenantId` is `activeTenantId ?? tenantIds[0]`
  // (`context.middleware.ts`) - always the FIRST of their memberships, never `null`, which is
  // exactly why `resolveTenant` must not fall back to it for a mutation.
  tenantId: 'tenant_demo',
  tenantIds: ['tenant_demo', 'tenant_legal', 'tenant_insurance'],
  userId: 'platform_admin',
  role: 'admin',
  platformAdmin: true,
  correlationId: 'cor_platform_admin_test',
};

describe('resolveTenant', () => {
  it('locks a non-platform-administrator to their own membership tenant', () => {
    expect(resolveTenant(tenantUser)).toBe('tenant_demo');
  });

  it('ignores any tenant a non-platform-administrator names, including another real tenant', () => {
    expect(resolveTenant(tenantUser, 'tenant_legal')).toBe('tenant_demo');
  });

  it('requires a platform administrator to name a tenant', () => {
    expect(() => resolveTenant(platformAdmin)).toThrow();
    try {
      resolveTenant(platformAdmin);
      throw new Error('expected the call to throw');
    } catch (error) {
      expect((error as { getResponse: () => { code: string } }).getResponse().code).toBe(
        'TENANT_REQUIRED',
      );
    }
  });

  it('refuses a platform administrator naming a tenant outside their own memberships', () => {
    try {
      resolveTenant(platformAdmin, 'tenant_manufacturing');
      throw new Error('expected the call to throw');
    } catch (error) {
      expect((error as { getResponse: () => { code: string } }).getResponse().code).toBe(
        'TENANT_REQUIRED',
      );
    }
  });

  it('lets a platform administrator choose any tenant they belong to', () => {
    expect(resolveTenant(platformAdmin, 'tenant_legal')).toBe('tenant_legal');
    expect(resolveTenant(platformAdmin, 'tenant_insurance')).toBe('tenant_insurance');
  });

  it('treats an empty string the same as naming no tenant', () => {
    try {
      resolveTenant(platformAdmin, '');
      throw new Error('expected the call to throw');
    } catch (error) {
      expect((error as { getResponse: () => { code: string } }).getResponse().code).toBe(
        'TENANT_REQUIRED',
      );
    }
  });
});
