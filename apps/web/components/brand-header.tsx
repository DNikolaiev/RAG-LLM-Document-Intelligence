import Link from 'next/link';
import { ScanSearch } from 'lucide-react';
import { TEST_PROFILES } from '@caselens/contracts';
import { authMode } from '@/lib/auth/config';
import { getCurrentProfile, testProfilesEnabled } from '@/lib/session-profile';
import { PrimaryNavigation } from './primary-navigation';
import { ProfileSwitcher } from './profile-switcher';
import { NotificationCenter } from './notification-center';

export async function BrandHeader() {
  // Null on the signed-out page, which renders this header too. It must not redirect from here,
  // or signing out would bounce straight back into signing in.
  const profile = await getCurrentProfile();
  const showProfileSwitcher = testProfilesEnabled();
  const verifiedIdentity = authMode() === 'oidc';
  return (
    <header className="brand-header">
      <Link className="brand-lockup" href="/" aria-label="CaseLens case queue">
        <span className="brand-mark" aria-hidden="true">
          <ScanSearch size={20} strokeWidth={1.8} />
          <i />
        </span>
        <span>
          <strong>CaseLens</strong>
          <small>Decision intelligence</small>
        </span>
      </Link>

      {profile ? <PrimaryNavigation /> : null}

      {profile ? (
        <div className="header-context" aria-label="Current workspace">
          <span className="environment-mark">
            {(process.env.APP_MODE ?? 'demo') === 'demo' ? 'Demo' : 'Local production'}
          </span>
          <span className="header-divider" aria-hidden="true" />
          <span className="tenant-name">
            <strong>{profile.activeTenantName}</strong>
            <small>{profile.platformAdmin ? 'Cross-tenant oversight' : 'Full tenant access'}</small>
          </span>
          <NotificationCenter profileId={profile.id} aggregate={profile.platformAdmin} />
          {showProfileSwitcher ? (
            <ProfileSwitcher selected={profile} profiles={TEST_PROFILES} />
          ) : null}
          {verifiedIdentity ? (
            // A form, not a link: signing out changes state, so it is a POST, and a POST is what the
            // logout route's origin check can defend against cross-site forgery.
            <form className="session-controls" action="/auth/logout" method="post">
              <span className="session-initials" title={`Signed in as ${profile.displayName}`}>
                {profile.initials}
              </span>
              <button className="button button-secondary session-sign-out" type="submit">
                Sign out
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
