import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_PROFILES } from '@caselens/contracts';

import { ProfileSwitcher } from '@/components/profile-switcher';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

describe('profile switcher', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
    refresh.mockClear();
  });

  it('shows tenant and platform identities and switches through the server session endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ProfileSwitcher selected={TEST_PROFILES[0]} profiles={TEST_PROFILES} />);

    fireEvent.click(screen.getByLabelText(/switch profile/i));
    expect(screen.getByText('Platform administrator')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /mara stein/i }));

    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith('/api/session/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'profile_mara_stein' }),
    });
    expect(push).toHaveBeenCalledWith('/');
  });
});
