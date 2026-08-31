import type { Metadata } from 'next';
import { TEST_TENANTS } from '@caselens/contracts';
import { PolicyLibrary } from '@/components/policy/policy-library';
import { getSelectedProfile } from '@/lib/session-profile';
import './policies.css';

export const metadata: Metadata = { title: 'Policy library' };

export default async function PoliciesPage() {
  const profile = await getSelectedProfile();
  const tenants = TEST_TENANTS.filter((tenant) => profile.tenantIds.includes(tenant.id));
  return <PolicyLibrary tenants={tenants} />;
}
