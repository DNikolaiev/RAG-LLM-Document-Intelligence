import Link from 'next/link';
import { BarChart3, BookOpenCheck, LayoutDashboard, ScanSearch } from 'lucide-react';
import { TEST_PROFILES } from '@caselens/contracts';
import { getSelectedProfile, testProfilesEnabled } from '@/lib/session-profile';
import { ProfileSwitcher } from './profile-switcher';
import { NotificationCenter } from './notification-center';

export async function BrandHeader() {
  const profile = await getSelectedProfile();
  const showProfileSwitcher = testProfilesEnabled();
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

      <nav className="primary-navigation" aria-label="Primary navigation">
        <Link href="/">
          <LayoutDashboard aria-hidden="true" size={16} />
          Review queue
          <span>Live</span>
        </Link>
        <Link href="/policies">
          <BookOpenCheck aria-hidden="true" size={16} />
          Policy library
        </Link>
        <Link href="/analytics">
          <BarChart3 aria-hidden="true" size={16} />
          Analytics
        </Link>
      </nav>

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
      </div>
    </header>
  );
}
