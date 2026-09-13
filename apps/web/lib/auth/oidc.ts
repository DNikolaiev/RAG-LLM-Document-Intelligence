import * as client from 'openid-client';
import { oidcSettings } from './config';

let configuration: Promise<client.Configuration> | null = null;

/**
 * The OIDC client, discovered once per process.
 *
 * Discovery is standard OpenID Connect rather than hard-coded Keycloak paths, so moving to another
 * provider is configuration: issuer, client id, secret.
 *
 * A failed discovery is not cached. The identity provider being down at the first sign-in attempt
 * should not leave the console unable to sign anyone in after it recovers.
 */
export function oidcConfiguration(): Promise<client.Configuration> {
  configuration ??= discover().catch((error: unknown) => {
    configuration = null;
    throw error;
  });
  return configuration;
}

async function discover(): Promise<client.Configuration> {
  const settings = oidcSettings();
  const { issuer, internalIssuer } = settings;

  /**
   * The split-horizon rewrite.
   *
   * The browser reaches the identity provider at its public address, and every token names that
   * address as its issuer. This server, inside the container network, reaches the same provider at
   * a private address. So server-to-server calls - discovery, the code exchange, refresh - are sent
   * to the private address, while the issuer being validated stays the public one.
   *
   * The alternative that looks simpler is discovering against the private address directly. It
   * fails: the discovery document names the public issuer, the client rejects it as a mismatch, and
   * the tempting "fix" of disabling issuer validation removes the check that stops a token from one
   * provider being accepted as another's.
   */
  const splitHorizon: client.CustomFetch = (url, options) => {
    const target = new URL(url);
    if (internalIssuer && target.origin === issuer.origin) {
      target.protocol = internalIssuer.protocol;
      target.host = internalIssuer.host;
    }
    return fetch(target, options as RequestInit);
  };

  return client.discovery(issuer, settings.clientId, settings.clientSecret, undefined, {
    [client.customFetch]: splitHorizon,
    // Plain HTTP is refused by default and allowed here only when the issuer itself is plain HTTP,
    // which is the local stack. Any real deployment's issuer is https, and then this is inert.
    execute: issuer.protocol === 'http:' ? [client.allowInsecureRequests] : [],
  });
}
