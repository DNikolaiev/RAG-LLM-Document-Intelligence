'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { TestProfile } from '@caselens/contracts';

export function ProfileSwitcher({
  selected,
  profiles,
}: {
  selected: TestProfile;
  profiles: readonly TestProfile[];
}) {
  const router = useRouter();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function selectProfile(profileId: string): Promise<void> {
    if (profileId === selected.id || pendingId) return;
    setPendingId(profileId);
    const response = await fetch('/api/session/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileId }),
    });
    setPendingId(null);
    if (!response.ok) return;
    if (detailsRef.current) detailsRef.current.open = false;
    router.push('/');
    router.refresh();
  }

  return (
    <details className="profile-switcher" ref={detailsRef}>
      <summary
        className="user-avatar"
        aria-label={`Switch profile. Signed in as ${selected.displayName}`}
      >
        {selected.initials}
      </summary>
      <div className="profile-menu" aria-label="Test profiles">
        <p>Local test identity</p>
        {profiles.map((profile) => (
          <button
            className={profile.id === selected.id ? 'profile-option is-selected' : 'profile-option'}
            type="button"
            key={profile.id}
            disabled={pendingId !== null}
            onClick={() => void selectProfile(profile.id)}
          >
            <span className="profile-initials" aria-hidden="true">
              {profile.initials}
            </span>
            <span>
              <strong>{profile.displayName}</strong>
              <small>
                {profile.platformAdmin ? 'Platform administrator' : 'Tenant administrator'}
              </small>
            </span>
            {profile.id === selected.id ? <i aria-label="Selected">✓</i> : null}
          </button>
        ))}
      </div>
    </details>
  );
}
