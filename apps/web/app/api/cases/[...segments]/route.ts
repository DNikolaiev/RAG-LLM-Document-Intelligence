import type { NextRequest } from 'next/server';
import { resolveTestProfile } from '@caselens/contracts';
import { PROFILE_COOKIE, testProfilesEnabled } from '@/lib/session-profile';

interface RouteContext {
  params: Promise<{ segments: string[] }>;
}

async function forward(request: NextRequest, context: RouteContext): Promise<Response> {
  const { segments } = await context.params;
  const baseUrl = process.env.PUBLIC_API_URL ?? 'http://localhost:4100';
  const target = new URL(`/v1/cases/${segments.map(encodeURIComponent).join('/')}`, baseUrl);
  target.search = request.nextUrl.search;
  const body =
    request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  const profile = resolveTestProfile(request.cookies.get(PROFILE_COOKIE)?.value);
  const identityHeaders = testProfilesEnabled() ? { 'x-test-profile-id': profile.id } : {};
  try {
    const response = await fetch(target, {
      method: request.method,
      headers: {
        accept: request.headers.get('accept') ?? 'application/json',
        'content-type': request.headers.get('content-type') ?? 'application/json',
        ...identityHeaders,
        'idempotency-key': request.headers.get('idempotency-key') ?? crypto.randomUUID(),
      },
      ...(body === undefined ? {} : { body }),
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    return new Response(response.body, {
      status: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
    });
  } catch {
    return Response.json(
      { code: 'API_UNAVAILABLE', detail: 'The CaseLens API is unavailable.' },
      { status: 503 },
    );
  }
}

export const GET = forward;
export const PATCH = forward;
export const POST = forward;
