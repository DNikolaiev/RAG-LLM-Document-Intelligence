import type { NextRequest } from 'next/server';
import { upstreamIdentity } from '@/lib/auth/upstream';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  // Read once, when the stream opens. The proxy refreshed the token on the way in, so it is fresh now
  // and will expire while the stream is still open - see the 401 handling below.
  const identityHeaders = await upstreamIdentity((name) => request.cookies.get(name)?.value);
  const baseUrl = process.env.PUBLIC_API_URL ?? 'http://localhost:4100';
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let priorPayload = '';
      const poll = async (): Promise<void> => {
        if (request.signal.aborted) {
          controller.close();
          return;
        }
        try {
          const response = await fetch(new URL('/v1/jobs?limit=30', baseUrl), {
            headers: identityHeaders,
            cache: 'no-store',
            signal: AbortSignal.timeout(4_000),
          });
          if (response.status === 401) {
            // The access token captured when the stream opened has expired, and a response that is
            // already streaming cannot set a refreshed cookie. Closing it makes the browser's
            // EventSource reconnect, and that new request passes through the proxy, which refreshes
            // the token before this route runs again.
            controller.close();
            return;
          }
          if (response.ok) {
            const payload = await response.text();
            if (payload !== priorPayload) {
              priorPayload = payload;
              controller.enqueue(encoder.encode(`event: jobs\ndata: ${payload}\n\n`));
            } else {
              controller.enqueue(encoder.encode(': keep-alive\n\n'));
            }
          }
        } catch {
          controller.enqueue(encoder.encode('event: unavailable\ndata: {}\n\n'));
        }
        timer = setTimeout(() => void poll(), 2_000);
      };
      request.signal.addEventListener('abort', () => {
        if (timer) clearTimeout(timer);
      });
      void poll();
    },
    cancel() {
      if (timer) clearTimeout(timer);
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}
