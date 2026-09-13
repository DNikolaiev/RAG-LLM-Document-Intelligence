// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TEST_PROFILES } from '@caselens/contracts';

interface RealmUser {
  id: string;
  username: string;
  email: string;
  realmRoles: string[];
  groups: string[];
  credentials: Array<{ value: string; temporary: boolean }>;
}
interface RealmClient {
  clientId: string;
  publicClient: boolean;
  secret: string;
  standardFlowEnabled: boolean;
  implicitFlowEnabled: boolean;
  directAccessGrantsEnabled: boolean;
  serviceAccountsEnabled: boolean;
  redirectUris: string[];
  attributes: Record<string, string>;
  protocolMappers: Array<{ protocolMapper: string; config: Record<string, string> }>;
}

const realm = JSON.parse(
  readFileSync(new URL('../../../infra/keycloak/caselens-realm.json', import.meta.url), 'utf8'),
) as {
  bruteForceProtected: boolean;
  registrationAllowed: boolean;
  users: RealmUser[];
  clients: RealmClient[];
};
const consoleClient = realm.clients.find((client) => client.clientId === 'caselens-web')!;

/**
 * The realm file and the test profiles describe the same people in two places, so this is the drift
 * guard between them - and a guard on the client settings whose silent regression would matter.
 */
describe('Keycloak realm', () => {
  it('provisions every test profile as the same user, tenants and role', () => {
    for (const profile of TEST_PROFILES) {
      const user = realm.users.find((candidate) => candidate.id === profile.id);
      // The user id is pinned to the profile id, which the database seeds as users.external_subject.
      // That is what makes a token's `sub` resolve to an application user.
      expect(user, profile.id).toBeDefined();
      expect(user!.email).toBe(profile.email);
      expect(user!.groups.map((group) => group.replace(/^\//, '')).sort()).toEqual(
        [...profile.tenantIds].sort(),
      );
      expect(user!.realmRoles).toEqual([profile.platformAdmin ? 'platform_admin' : profile.role]);
    }
  });

  it('holds no user the application does not know', () => {
    // An extra realm user would authenticate perfectly and then be refused as unprovisioned.
    expect(realm.users.map((user) => user.id).sort()).toEqual(
      TEST_PROFILES.map((profile) => profile.id).sort(),
    );
  });

  it('commits no secrets, only placeholders substituted at import', () => {
    expect(consoleClient.secret).toBe('${OIDC_CLIENT_SECRET}');
    for (const user of realm.users) {
      expect(user.credentials.map((credential) => credential.value)).toEqual([
        '${KEYCLOAK_TEST_USER_PASSWORD}',
      ]);
    }
  });

  it('lets the console use only the authorisation code flow, with PKCE', () => {
    expect(consoleClient.publicClient).toBe(false);
    expect(consoleClient.standardFlowEnabled).toBe(true);
    // No implicit flow: it returns tokens in the URL fragment, where history and referrers leak them.
    expect(consoleClient.implicitFlowEnabled).toBe(false);
    // No password grant: the console must never handle a user's password - that is what delegating
    // authentication to an identity provider is for.
    expect(consoleClient.directAccessGrantsEnabled).toBe(false);
    expect(consoleClient.serviceAccountsEnabled).toBe(false);
    expect(consoleClient.attributes['pkce.code.challenge.method']).toBe('S256');
  });

  it('redirects only to the exact callback, never a pattern', () => {
    // A wildcard redirect URI is how an authorisation code gets delivered to a page an attacker
    // controls on an otherwise trusted host.
    expect(consoleClient.redirectUris).toEqual(['http://localhost:3000/auth/callback']);
  });

  it('names each service as an audience of the access token, and only the access token', () => {
    const audiences = consoleClient.protocolMappers
      .filter((mapper) => mapper.protocolMapper === 'oidc-audience-mapper')
      .map((mapper) => mapper.config);
    expect(audiences.map((config) => config['included.custom.audience']).sort()).toEqual([
      'caselens-analytics',
      'caselens-api',
    ]);
    for (const config of audiences) {
      expect(config['access.token.claim']).toBe('true');
      expect(config['id.token.claim']).toBe('false');
    }
  });

  it('slows password guessing and offers no self-registration', () => {
    expect(realm.bruteForceProtected).toBe(true);
    expect(realm.registrationAllowed).toBe(false);
  });
});
