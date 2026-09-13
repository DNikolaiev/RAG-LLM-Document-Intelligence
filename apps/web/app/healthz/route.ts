/**
 * Liveness for the container healthcheck, outside the proxy's sign-in gate.
 *
 * A probe is not a user. Under verified identity every other route redirects an unauthenticated
 * request towards the identity provider's public address, which does not exist inside the
 * container, so a probe of `/` failed with the console perfectly healthy.
 */
export function GET(): Response {
  return Response.json({ status: 'ok' });
}
