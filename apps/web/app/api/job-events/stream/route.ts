import type { NextRequest } from 'next/server';
import { resolveTestProfile } from '@caselens/contracts';
import { PROFILE_COOKIE, testProfilesEnabled } from '@/lib/session-profile';

export const dynamic = 'force-dynamic';

export function GET(request: NextRequest): Response {
  const profile = resolveTestProfile(request.cookies.get(PROFILE_COOKIE)?.value);
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
            headers: testProfilesEnabled() ? { 'x-test-profile-id': profile.id } : {},
            cache: 'no-store',
            signal: AbortSignal.timeout(4_000),
          });
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
