/**
 * What counts as a loopback redirect, in one place.
 *
 * Two callers need the same answer for different reasons, and they must not
 * drift: registration decides whether to ACCEPT a plain-http redirect at all
 * (RFC 8252 allows it only for loopback), and the consent screen decides
 * whether to DESCRIBE the destination as a program on the reader's own machine
 * rather than naming a host. If one gained an address the other lacked, the
 * screen would either name a host registration had refused, or describe a
 * reachable address as local.
 */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
]);

/** `url.hostname`, which is the host without any port. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}
