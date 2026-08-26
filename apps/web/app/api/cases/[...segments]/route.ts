import type { NextRequest } from 'next/server';

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
  try {
    const response = await fetch(target, {
      method: request.method,
      headers: {
        accept: request.headers.get('accept') ?? 'application/json',
        'content-type': request.headers.get('content-type') ?? 'application/json',
        'x-tenant-id': process.env.DEMO_TENANT_ID ?? 'tenant_demo',
        'x-user-id': 'user_demo_reviewer',
        'x-role': 'reviewer',
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
