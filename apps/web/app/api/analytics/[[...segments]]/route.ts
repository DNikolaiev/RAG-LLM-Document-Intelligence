import type { NextRequest } from 'next/server';
import { resolveTestProfile } from '@caselens/contracts';
import { PROFILE_COOKIE, testProfilesEnabled } from '@/lib/session-profile';

interface RouteContext {
  params: Promise<{ segments?: string[] }>;
}

/**
 * Forwards analytics queries to the analytics service, the same way `/api/cases` forwards to the
 * application API.
 *
 * Deliberately a second upstream rather than a passthrough on `apps/api`. Routing this through the
 * case API would mean teaching it the analytics URL and its response shapes, which is exactly the
 * coupling the separate service exists to avoid - and the browser would then be one outage away
 * from losing analytics whenever the case API was down, for no reason.
 */
async function forward(request: NextRequest, context: RouteContext): Promise<Response> {
  const { segments } = await context.params;
  const baseUrl = process.env.ANALYTICS_API_URL ?? 'http://localhost:4200';
  const target = new URL(
    `/v1/analytics/${(segments ?? []).map(encodeURIComponent).join('/')}`,
    baseUrl,
  );
  target.search = request.nextUrl.search;
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
    // The read model being unreachable must not look like an empty read model: a dashboard that
    // silently renders zeroes during an outage is worse than one that says it cannot answer.
    return Response.json({ detail: 'Analytics service unavailable' }, { status: 503 });
  }
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  return forward(request, context);
}
