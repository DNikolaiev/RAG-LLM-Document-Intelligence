import { resolveTestProfile } from '@caselens/contracts';
import { PROFILE_COOKIE, testProfilesEnabled } from '@/lib/session-profile';
import { authMode } from './config';
import { readSession, type CookieReader } from './session';

/**
 * The identity a server-side call to another CaseLens service carries.
 *
 * One function for every upstream call - the API proxies, the analytics proxy, server components
 * fetching data - so there is exactly one place that decides what identifies the caller. Before
 * this, each proxy route built its own header, and six copies of "which header proves who you are"
 * is six chances for one of them to be wrong.
 *
 * Under verified identity it is the access token from the encrypted session, and nothing else.
 * The test-profile header is never sent in that mode, so even a mis-configured upstream still in
 * test-profile mode cannot be steered by the console into trusting it.
 */
export async function upstreamIdentity(read: CookieReader): Promise<Record<string, string>> {
  if (authMode() === 'oidc') {
    const session = await readSession(read);
    // No session reaches here only if the proxy was bypassed. Sending nothing makes the upstream
    // answer 401, which is the right answer.
    return session ? { authorization: `Bearer ${session.accessToken}` } : {};
  }
  if (!testProfilesEnabled()) return {};
  return { 'x-test-profile-id': resolveTestProfile(read(PROFILE_COOKIE)).id };
}
