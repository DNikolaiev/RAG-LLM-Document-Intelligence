import { cookies } from 'next/headers';
import {
  DEFAULT_TEST_PROFILE_ID,
  resolveTestProfile,
  resolveTestTenant,
  type TestProfile,
} from '@caselens/contracts';

export const PROFILE_COOKIE = 'caselens_test_profile';

export function testProfilesEnabled(): boolean {
  return (
    (process.env.APP_MODE ?? 'demo') === 'demo' ||
    (process.env.AUTH_MODE === 'test-profiles' &&
      process.env.ENABLE_TEST_IDENTITY_SWITCHER === 'true')
  );
}

export async function getSelectedProfile(): Promise<
  TestProfile & { activeTenantName: string; aggregate: boolean }
> {
  const store = await cookies();
  const profile = resolveTestProfile(store.get(PROFILE_COOKIE)?.value ?? DEFAULT_TEST_PROFILE_ID);
  return {
    ...profile,
    activeTenantName: profile.platformAdmin
      ? 'All tenant workspaces'
      : (resolveTestTenant(profile.activeTenantId)?.name ?? 'Unknown workspace'),
    aggregate: profile.platformAdmin,
  };
}
