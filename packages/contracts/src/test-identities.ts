export type TenantRole = 'intake' | 'reviewer' | 'approver' | 'auditor' | 'admin';

export interface TestTenant {
  id: string;
  name: string;
  domain: string;
}

export interface TestProfile {
  id: string;
  displayName: string;
  email: string;
  initials: string;
  role: TenantRole | 'platform_admin';
  tenantIds: readonly string[];
  activeTenantId: string | null;
  platformAdmin: boolean;
}

export const TEST_TENANTS = [
  {
    id: 'tenant_demo',
    name: 'Düsseldorf Health Operations',
    domain: 'Pharmaceutical supplier qualification',
  },
  {
    id: 'tenant_legal',
    name: 'Rheinland Legal Services',
    domain: 'Commercial contract review',
  },
  {
    id: 'tenant_insurance',
    name: 'Helios Claims Europe',
    domain: 'Insurance claims assessment',
  },
  {
    id: 'tenant_manufacturing',
    name: 'RuhrWorks Manufacturing',
    domain: 'Supplier quality assurance',
  },
] as const satisfies readonly TestTenant[];

const allTenantIds = TEST_TENANTS.map((tenant) => tenant.id);

export const TEST_PROFILES = [
  {
    id: 'profile_lena_vogt',
    displayName: 'Lena Vogt',
    email: 'lena.vogt@example.test',
    initials: 'LV',
    role: 'admin',
    tenantIds: ['tenant_demo'],
    activeTenantId: 'tenant_demo',
    platformAdmin: false,
  },
  {
    id: 'profile_jonas_feld',
    displayName: 'Jonas Feld',
    email: 'jonas.feld@example.test',
    initials: 'JF',
    role: 'admin',
    tenantIds: ['tenant_legal'],
    activeTenantId: 'tenant_legal',
    platformAdmin: false,
  },
  {
    id: 'profile_amara_okafor',
    displayName: 'Amara Okafor',
    email: 'amara.okafor@example.test',
    initials: 'AO',
    role: 'admin',
    tenantIds: ['tenant_insurance'],
    activeTenantId: 'tenant_insurance',
    platformAdmin: false,
  },
  {
    id: 'profile_mateo_klein',
    displayName: 'Mateo Klein',
    email: 'mateo.klein@example.test',
    initials: 'MK',
    role: 'admin',
    tenantIds: ['tenant_manufacturing'],
    activeTenantId: 'tenant_manufacturing',
    platformAdmin: false,
  },
  {
    id: 'profile_mara_stein',
    displayName: 'Mara Stein',
    email: 'mara.stein@example.test',
    initials: 'MS',
    role: 'platform_admin',
    tenantIds: allTenantIds,
    activeTenantId: null,
    platformAdmin: true,
  },
] as const satisfies readonly TestProfile[];

export const DEFAULT_TEST_PROFILE_ID = TEST_PROFILES[0].id;

export function resolveTestProfile(profileId: string | null | undefined): TestProfile {
  return (
    TEST_PROFILES.find((profile) => profile.id === profileId) ??
    TEST_PROFILES.find((profile) => profile.id === DEFAULT_TEST_PROFILE_ID)!
  );
}

export function resolveTestTenant(tenantId: string | null | undefined): TestTenant | null {
  return TEST_TENANTS.find((tenant) => tenant.id === tenantId) ?? null;
}
