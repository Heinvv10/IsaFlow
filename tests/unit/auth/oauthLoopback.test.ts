/**
 * One definition of "loopback", shared by registration (which decides whether
 * to accept a plain-http redirect) and the consent screen (which decides
 * whether to describe the destination as local instead of naming a host).
 * They must not drift.
 */
import { describe, it, expect } from 'vitest';
import { isLoopbackHost, LOOPBACK_HOSTS } from '@/lib/auth/oauthLoopback';

describe('isLoopbackHost', () => {
  it('accepts every RFC 8252 loopback form', () => {
    for (const h of ['localhost', '127.0.0.1', '[::1]', '::1']) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
  });

  it('rejects hosts that merely look local', () => {
    for (const h of ['localhost.evil.example', 'notlocalhost', '127.0.0.2', 'evil.example', '']) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });

  // url.hostname never carries a port; a caller passing url.host would silently
  // stop matching, so pin that this takes the port-free form.
  it('takes a hostname, not a host with a port', () => {
    expect(isLoopbackHost('localhost:3000')).toBe(false);
  });

  it('exposes the set so both callers share one source of truth', () => {
    expect(LOOPBACK_HOSTS.size).toBe(4);
  });
});
