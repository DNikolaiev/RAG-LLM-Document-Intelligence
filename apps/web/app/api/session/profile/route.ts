import { NextResponse, type NextRequest } from 'next/server';
import { TEST_PROFILES, resolveTestProfile } from '@caselens/contracts';
import { PROFILE_COOKIE, testProfilesEnabled } from '@/lib/session-profile';

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!testProfilesEnabled()) return disabledResponse();
  const selected = resolveTestProfile(request.cookies.get(PROFILE_COOKIE)?.value);
  return NextResponse.json({ selected, profiles: TEST_PROFILES });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!testProfilesEnabled()) return disabledResponse();
  const input = (await request.json().catch(() => null)) as { profileId?: unknown } | null;
  const profile = TEST_PROFILES.find((candidate) => candidate.id === input?.profileId);
  if (!profile) {
    return NextResponse.json(
      { code: 'UNKNOWN_TEST_PROFILE', detail: 'Choose a profile from the test catalog.' },
      { status: 400 },
    );
  }
  const response = NextResponse.json({ selected: profile });
  response.cookies.set(PROFILE_COOKIE, profile.id, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/',
    maxAge: 60 * 60 * 8,
  });
  return response;
}

function disabledResponse(): NextResponse {
  return NextResponse.json(
    { code: 'TEST_PROFILES_DISABLED', detail: 'The test identity switcher is disabled.' },
    { status: 404 },
  );
}
