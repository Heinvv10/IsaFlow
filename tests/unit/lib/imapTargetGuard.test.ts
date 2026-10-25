/**
 * S-07e part B: the scan cron presents a connection's stored mailbox password to
 * host:port, so a tenant must not be able to aim it at the server's own network.
 * The host must be, and resolve only to, a public address; the port 143 or 993.
 * The address classes are safeFetch's; DNS is a fake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: m.lookup }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { log } from '@/lib/logger';
import { ALLOWED_IMAP_PORTS, IMAP_HOST_REFUSED, IMAP_PORT_REFUSED, checkImapTarget } from '@/lib/imapTargetGuard';

const HOST_REFUSED = { ok: false, message: 'This mail server address is not allowed' };

const PUBLIC = '93.184.216.34';
const resolvesTo = (...addresses: string[]) =>
  m.lookup.mockResolvedValue(addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));

beforeEach(() => {
  m.lookup.mockReset();
  vi.mocked(log.warn).mockClear();
  resolvesTo(PUBLIC);
});

describe('checkImapTarget: host', () => {
  it.each([
    ['loopback', '127.0.0.1'],
    ['loopback (other /8 address)', '127.8.9.10'],
    ['loopback v6', '::1'],
    ['RFC1918 10/8', '10.0.0.5'],
    ['RFC1918 172.16/12', '172.16.4.4'],
    ['RFC1918 192.168/16', '192.168.1.20'],
    ['link-local', '169.254.10.10'],
    ['cloud metadata', '169.254.169.254'],
    ['CGNAT (this box\'s tailnet)', '100.96.203.105'],
    ['unique-local v6', 'fd12:3456::1'],
    ['link-local v6', 'fe80::1'],
    ['unspecified', '0.0.0.0'],
    ['unspecified v6', '::'],
    ['multicast', '224.0.0.1'],
    ['multicast v6', 'ff02::1'],
    ['loopback wrapped as IPv4-mapped v6', '::ffff:127.0.0.1'],
  ])('refuses the IP literal %s (%s) without resolving anything', async (_what, host) => {
    expect(await checkImapTarget(host, 993)).toEqual(HOST_REFUSED);
    expect(m.lookup).not.toHaveBeenCalled();
    // The detail is for the log, not the tenant.
    expect(vi.mocked(log.warn).mock.calls[0]![1]).toMatchObject({ host, detail: expect.stringContaining('blocked address') });
  });

  it.each([
    ['localhost', ['127.0.0.1']],
    ['a name pointing at the metadata service', ['169.254.169.254']],
    ['a name pointing at a LAN host', ['192.168.0.9']],
    ['a name pointing at a ULA v6', ['fd00::1']],
    ['a name that also resolves to a private address (rebinding)', [PUBLIC, '10.1.1.1']],
  ])('refuses %s, which resolves to a non-public address', async (_what, addresses) => {
    resolvesTo(...addresses);
    expect(await checkImapTarget('imap.evil.test', 993)).toEqual(HOST_REFUSED);
    expect(vi.mocked(log.warn).mock.calls[0]![1]).toMatchObject({ detail: expect.stringMatching(/^imap\.evil\.test resolves to blocked address /) });
  });

  it('a name that does not resolve is told so, not that its address is "not allowed"', async () => {
    m.lookup.mockRejectedValue(new Error('ENOTFOUND'));
    expect(await checkImapTarget('nope.invalid', 993)).toEqual({ ok: false, message: "Could not resolve the mail server's address" });
    expect(vi.mocked(log.warn).mock.calls[0]![1]).toMatchObject({ detail: 'DNS resolution failed for nope.invalid' });
  });

  it.each([[''], ['   '], ['imap.test/x'], ['a b'], ['imap.test\n'], ['me@imap.test'], ['[::1]'], [undefined], [null], [42], [{ toString: () => 'x' }]])('refuses a host that is not a plain host name: %j', async (host) => {
    expect((await checkImapTarget(host, 993)).ok).toBe(false);
  });

  it('never puts a resolved address, a host or a port in the message the tenant sees', async () => {
    resolvesTo('10.1.2.3');
    const r = await checkImapTarget('internal.corp.test', 993);
    expect(r).toEqual(HOST_REFUSED);
    expect(JSON.stringify(r)).not.toMatch(/10\.1\.2\.3|internal|corp|993/);
    expect(IMAP_HOST_REFUSED).toBe('This mail server address is not allowed');
  });

  it('allows a public IP literal: it is the address to connect to, with no servername', async () => {
    expect(await checkImapTarget(PUBLIC, 993)).toEqual({ ok: true, address: PUBLIC });
    expect(m.lookup).not.toHaveBeenCalled();
    expect(await checkImapTarget('2606:2800:220:1:248:1893:25c8:1946', 993)).toEqual({ ok: true, address: '2606:2800:220:1:248:1893:25c8:1946' });
  });

  it('allows a name that resolves only to public addresses, and connects to its IPv4 one first (this host may have no IPv6 route)', async () => {
    resolvesTo('2606:2800:220:1:248:1893:25c8:1946', PUBLIC);
    expect(await checkImapTarget('imap.gmail.com', 993)).toEqual({ ok: true, address: PUBLIC, servername: 'imap.gmail.com' });
    expect(m.lookup).toHaveBeenCalledTimes(1);
  });

  it('connects to an IPv6 address when the name has no IPv4 one', async () => {
    resolvesTo('2606:2800:220:1:248:1893:25c8:1946');
    expect(await checkImapTarget('imap.gmail.com', 993)).toEqual({
      ok: true, address: '2606:2800:220:1:248:1893:25c8:1946', servername: 'imap.gmail.com',
    });
  });

  it('asks the resolver once per check: the answer it vets is the answer it returns', async () => {
    m.lookup.mockResolvedValueOnce([{ address: PUBLIC, family: 4 }]);
    m.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]); // what a rebinding record answers next
    expect(await checkImapTarget('imap.rebind.test', 993)).toEqual({ ok: true, address: PUBLIC, servername: 'imap.rebind.test' });
    expect(m.lookup).toHaveBeenCalledTimes(1);
  });
});

describe('checkImapTarget: port', () => {
  it('the port message is generic', () => expect(IMAP_PORT_REFUSED).toBe('Only ports 143 and 993 are supported'));

  it('allows only the IMAP ports, 143 and 993', async () => {
    expect([...ALLOWED_IMAP_PORTS]).toEqual([143, 993]);
    expect((await checkImapTarget('imap.gmail.com', 143)).ok).toBe(true);
    expect((await checkImapTarget('imap.gmail.com', 993)).ok).toBe(true);
  });

  it.each([[22], [25], [80], [443], [587], [1143], [5432], [6379], [0], [65535], [993.5], [-993], ['993'], [null], [undefined], [NaN]])(
    'refuses port %j, before any lookup', async (port) => {
      expect(await checkImapTarget('imap.gmail.com', port)).toEqual({ ok: false, message: 'Only ports 143 and 993 are supported' });
      expect(m.lookup).not.toHaveBeenCalled();
    });
});
