import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  DEFAULT_TEST_PROFILE_ID,
  resolveTestProfile,
  resolveTestTenant,
  type TestProfile,
} from '@caselens/contracts';
import { authMode } from './auth/config';
import { readSession } from './auth/session';

export const PROFILE_COOKIE = 'caselens_test_profile';

export type ConsoleProfile = TestProfile & { activeTenantName: string; aggregate: boolean };

export function testProfilesEnabled(): boolean {
  // Never alongside verified identity, whatever else is set. The switcher is an unsigned way to
  // become any user, and it is only safe where nothing is real.
  if (authMode() === 'oidc') return false;
  return (
    (process.env.APP_MODE ?? 'demo') === 'demo' ||
    (process.env.AUTH_MODE === 'test-profiles' &&
      process.env.ENABLE_TEST_IDENTITY_SWITCHER === 'true')
  );
}

/**
 * Who is using the console, or null when nobody is signed in.
 *
 * Under verified identity this is read from the encrypted session, which was filled from ID token
 * claims the OIDC client validated at sign-in. It drives presentation only - the header, which
 * tenants a form offers. What a user may actually do is decided by the API from the access token,
 * never from this.
 */
export async function getCurrentProfile(): Promise<ConsoleProfile | null> {
  const store = await cookies();
  if (authMode() === 'oidc') {
    const session = await readSession((name) => store.get(name)?.value);
    if (!session) return null;
    const { identity } = session;
    const activeTenantId = identity.platformAdmin ? null : (identity.tenantIds[0] ?? null);
    return {
      id: identity.subject,
      displayName: identity.displayName,
      email: identity.email ?? '',
      initials: initialsOf(identity.displayName),
      role: identity.platformAdmin ? 'platform_admin' : identity.role,
      tenantIds: identity.tenantIds,
      activeTenantId,
      platformAdmin: identity.platformAdmin,
      activeTenantName: identity.platformAdmin
        ? 'All tenant workspaces'
        : (resolveTestTenant(activeTenantId)?.name ?? activeTenantId ?? 'Unknown workspace'),
      aggregate: identity.platformAdmin,
    };
  }
  const profile = resolveTestProfile(store.get(PROFILE_COOKIE)?.value ?? DEFAULT_TEST_PROFILE_ID);
  return {
    ...profile,
    activeTenantName: profile.platformAdmin
      ? 'All tenant workspaces'
      : (resolveTestTenant(profile.activeTenantId)?.name ?? 'Unknown workspace'),
    aggregate: profile.platformAdmin,
  };
}

/**
 * The current profile for a page that needs one. The proxy redirects unauthenticated requests
 * before any page renders, so the redirect here is a backstop rather than the gate.
 */
export async function getSelectedProfile(): Promise<ConsoleProfile> {
  return (await getCurrentProfile()) ?? redirect('/auth/login');
}

function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase());
  return (letters.length > 1 ? `${letters[0]}${letters.at(-1)}` : (letters[0] ?? '?')).slice(0, 2);
}
