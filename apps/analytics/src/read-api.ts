import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolveCaller, type CallerContext } from './caller.js';
import type { AnalyticsStore } from './store.js';

export interface ReadApiOptions {
  store: AnalyticsStore;
  port: number;
  /** Injectable so a test can drive identity without a real header, and Keycloak can replace it. */
  resolve?: (profileHeader: string | undefined) => CallerContext;
  onError?: (error: Error) => void;
}

/**
 * The read side of CQRS: queries answered from the projection, never from the case pipeline.
 *
 * Plain `node:http` rather than the framework `apps/api` uses. The point of this service is that a
 * second service can be built against nothing but the event contract, and a shared framework would
 * make it look like another arm of the same application while quietly growing shared middleware.
 *
 * Every handler takes a `CallerContext` rather than reading headers itself. That is what keeps the
 * eventual swap to verified Keycloak tokens a change to one function instead of a change to every
 * query.
 */
export function startReadApi(options: ReadApiOptions): Server {
  const resolve = options.resolve ?? resolveCaller;

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      options.onError?.(error as Error);
      send(response, 500, { detail: 'Analytics query failed' });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://analytics');

    // Liveness answers before identity is considered: a probe is not a caller.
    if (url.pathname === '/v1/health/live') return send(response, 200, { status: 'ok' });

    if (request.method !== 'GET') return send(response, 405, { detail: 'Method not allowed' });

    const header = request.headers['x-test-profile-id'];
    const caller = resolve(Array.isArray(header) ? header[0] : header);

    if (url.pathname === '/v1/analytics/throughput') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const range = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
      return send(response, 200, { days: await options.store.throughput(caller, range) });
    }

    if (url.pathname === '/v1/analytics/cycle-time') {
      return send(response, 200, await options.store.cycleTime(caller));
    }

    if (url.pathname === '/v1/analytics/rules') {
      return send(response, 200, { rules: await options.store.ruleEffectiveness(caller) });
    }

    if (url.pathname === '/v1/analytics/state') {
      // Only the consumer's half of consumer lag. The other half - the outbox high-water mark -
      // belongs to the publisher's database, which this service has no access to and should not
      // have. Comparing them is the caller's job, and that is the honest shape: lag is a statement
      // about two systems, so it cannot be measured from inside one of them.
      return send(response, 200, { lastProjectedSequence: await options.store.lastSequence() });
    }

    send(response, 404, { detail: 'Unknown analytics resource' });
  }

  server.listen(options.port);
  return server;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    // A projection is eventually consistent by construction; a cached copy of it would add a second
    // unbounded delay on top of the one that is already there and meant to be visible.
    'cache-control': 'no-store',
  });
  response.end(payload);
}
