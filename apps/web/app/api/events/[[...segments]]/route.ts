import type { NextRequest } from 'next/server';
import { upstreamIdentity } from '@/lib/auth/upstream';

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
  const identityHeaders = await upstreamIdentity((name) => request.cookies.get(name)?.value);

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
