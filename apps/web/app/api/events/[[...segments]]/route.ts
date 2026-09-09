import type { NextRequest } from 'next/server';
import { resolveTestProfile } from '@caselens/contracts';
import { PROFILE_COOKIE, testProfilesEnabled } from '@/lib/session-profile';

interface RouteContext {
  params: Promise<{ segments?: string[] }>;
}

/**
 * Forwards event-backbone state queries to the application API.
 *
 * A second upstream from `/api/analytics` on purpose: the two halves of consumer lag come from two
 * services that cannot see each other's databases, and pretending otherwise by routing both through
 * one of them would erase exactly the boundary the number measures across.
 */
async function forward(request: NextRequest, context: RouteContext): Promise<Response> {
  const { segments } = await context.params;
  const baseUrl = process.env.PUBLIC_API_URL ?? 'http://localhost:4100';
  const target = new URL(
    `/v1/events/${(segments ?? []).map(encodeURIComponent).join('/')}`,
    baseUrl,
  );
  const profile = resolveTestProfile(request.cookies.get(PROFILE_COOKIE)?.value);
  const identityHeaders = testProfilesEnabled() ? { 'x-test-profile-id': profile.id } : {};

  try {
    const response = await fetch(target, {
      method: 'GET',
      headers: { accept: 'application/json', ...identityHeaders },
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    return new Response(response.body, {
      status: response.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    return Response.json({ detail: 'Event state unavailable' }, { status: 503 });
  }
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  return forward(request, context);
}
