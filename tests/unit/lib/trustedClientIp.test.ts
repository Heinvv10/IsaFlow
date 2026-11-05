/**
 * The visitor's address for an audit or fraud record, from what nginx guarantees on app.isaflow.co.za:
 * `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` APPENDS nginx's TCP peer to whatever the client sent, and
 * there is no real_ip module, so that peer is Cloudflare's edge, which in turn appended the address that connected to
 * IT (the visitor) to the client's header. So the header reads `<client-forged...>, <visitor>, <cloudflare edge>`: the
 * LEFTMOST entries are the client's to write, the last is nginx's. Exactly ONE hop is peeled: the last entry is nginx's
 * peer; if that peer is a Cloudflare edge the visitor is the entry immediately left of it (or Cloudflare's own
 * CF-Connecting-IP, trusted only then), whatever it is; if the peer is not Cloudflare, the peer is the visitor. Never
 * further left: a visitor that itself egresses from a Cloudflare address (a Worker, WARP) must not let a forged entry win.
 * Anything that is not a valid IP address is null, never stored as text.
 */
import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'http';
import { trustedClientIp } from '@/lib/trustedClientIp';

const req = (xff: string | string[] | undefined, remote: string | null = '127.0.0.1', cf?: string) =>
  ({ headers: { ...(xff === undefined ? {} : { 'x-forwarded-for': xff }), ...(cf === undefined ? {} : { 'cf-connecting-ip': cf }) }, socket: { remoteAddress: remote ?? undefined } }) as unknown as Pick<IncomingMessage, 'headers' | 'socket'>;

describe('behind Cloudflare and nginx', () => {
  it('the visitor Cloudflare saw, not whatever the client put first', () => {
    expect(trustedClientIp(req('203.0.113.9, 172.71.1.1'))).toBe('203.0.113.9');
  });

  it('a forged leftmost entry is ignored, however many are forged', () => {
    expect(trustedClientIp(req('6.6.6.6, 203.0.113.9, 172.71.1.1'))).toBe('203.0.113.9');
    expect(trustedClientIp(req('1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.9, 104.16.5.5'))).toBe('203.0.113.9');
  });

  it('a forged entry that looks like a Cloudflare address does not move the answer left of the real visitor', () => {
    expect(trustedClientIp(req('104.16.0.1, 203.0.113.9, 172.71.1.1'))).toBe('203.0.113.9');
  });

  it('a visitor that egresses from a Cloudflare address (a Worker, WARP) is recorded as that address; a forged entry left of it is never chosen', () => {
    expect(trustedClientIp(req('6.6.6.6, 104.16.9.9, 172.71.1.1'))).toBe('104.16.9.9');
    expect(trustedClientIp(req('6.6.6.6, 2606:4700:4700::1111, 172.71.1.1'))).toBe('2606:4700:4700::1111');
    expect(trustedClientIp(req('6.6.6.6, 203.0.113.9, 104.16.9.9, 172.71.1.1'))).toBe('104.16.9.9'); // one hop, not two
  });

  it('IPv6 visitors and IPv6 Cloudflare edges', () => {
    expect(trustedClientIp(req('2001:db8::5, 2606:4700::1'))).toBe('2001:db8::5');
    expect(trustedClientIp(req('2001:db8::5, 172.71.1.1'))).toBe('2001:db8::5');
  });

  it('a header repeated (an array) is read as one chain, in order', () => {
    expect(trustedClientIp(req(['6.6.6.6', '203.0.113.9, 172.71.1.1']))).toBe('203.0.113.9');
  });

  it('IPv4-mapped IPv6 entries are the IPv4 address', () => {
    expect(trustedClientIp(req('::ffff:203.0.113.9, ::ffff:172.71.1.1'))).toBe('203.0.113.9');
  });
});

describe('CF-Connecting-IP', () => {
  it('is preferred when, and only when, the nginx peer is a Cloudflare edge', () => {
    expect(trustedClientIp(req('6.6.6.6, 203.0.113.9, 172.71.1.1', '127.0.0.1', '203.0.113.9'))).toBe('203.0.113.9');
    // Cloudflare's header and the appended entry agree on a real request; the header wins if they ever differ
    expect(trustedClientIp(req('172.71.1.1', '127.0.0.1', '203.0.113.9'))).toBe('203.0.113.9');
  });

  it('a forged CF-Connecting-IP from a peer that is not Cloudflare is ignored', () => {
    expect(trustedClientIp(req('6.6.6.6, 198.51.100.7', '127.0.0.1', '9.9.9.9'))).toBe('198.51.100.7');
    expect(trustedClientIp(req(undefined, '198.51.100.7', '9.9.9.9'))).toBe('198.51.100.7');
  });

  it('a garbage CF-Connecting-IP falls back to the one-hop rule', () => {
    expect(trustedClientIp(req('6.6.6.6, 203.0.113.9, 172.71.1.1', '127.0.0.1', '<script>'))).toBe('203.0.113.9');
  });
});

describe('not behind Cloudflare (a request that reached nginx directly)', () => {
  it('the last entry is nginx\'s own peer and cannot be forged: a forged leftmost entry is still ignored', () => {
    expect(trustedClientIp(req('6.6.6.6, 198.51.100.7'))).toBe('198.51.100.7');
    expect(trustedClientIp(req('198.51.100.7'))).toBe('198.51.100.7');
  });
});

describe('what is not an address is null', () => {
  it.each([
    ['garbage as the chosen entry', 'not-an-ip, 172.71.1.1'],
    ['markup', '<script>alert(1)</script>, 172.71.1.1'],
    ['an overlong value', `${'9'.repeat(400)}, 172.71.1.1`],
    ['a port on the visitor', '203.0.113.9:443, 172.71.1.1'],
    ['a Cloudflare peer and nobody left of it', '172.71.1.1'],
    ['an empty header', ''],
    ['a bad last entry', '203.0.113.9, nonsense'],
  ])('%s', (_label, xff) => {
    expect(trustedClientIp(req(xff, null))).toBeNull();
  });

  it('a garbage entry LEFT of the visitor does not matter (only the chosen entry is judged)', () => {
    expect(trustedClientIp(req('<b>x</b>, 203.0.113.9, 172.71.1.1'))).toBe('203.0.113.9');
  });
});

describe('no forwarding header (a direct or internal request)', () => {
  it('the socket peer, when it is an address', () => {
    expect(trustedClientIp(req(undefined, '198.51.100.7'))).toBe('198.51.100.7');
    expect(trustedClientIp(req(undefined, '::ffff:198.51.100.7'))).toBe('198.51.100.7');
  });
  it('null when there is none', () => {
    expect(trustedClientIp(req(undefined, null))).toBeNull();
  });
});
