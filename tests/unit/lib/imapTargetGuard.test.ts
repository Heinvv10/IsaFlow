/**
 * S-07e part B: the scan cron presents a connection's stored mailbox password to
 * host:port, so a tenant must not be able to aim it at the server's own network.
 * The host must be, and resolve only to, a public address; the port 143 or 993.
 * The address classes are safeFetch's; DNS is a fake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: m.lookup }));

import { ALLOWED_IMAP_PORTS, checkImapTarget } from '@/lib/imapTargetGuard';

const PUBLIC = '93.184.216.34';
const resolvesTo = (...addresses: string[]) =>
  m.lookup.mockResolvedValue(addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));

beforeEach(() => {
  m.lookup.mockReset();
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
    const refused = await checkImapTarget(host, 993);
    expect(refused).toMatch(/^IMAP host is not allowed: blocked address /);
    expect(m.lookup).not.toHaveBeenCalled();
  });

  it.each([
    ['localhost', ['127.0.0.1']],
    ['a name pointing at the metadata service', ['169.254.169.254']],
    ['a name pointing at a LAN host', ['192.168.0.9']],
    ['a name pointing at a ULA v6', ['fd00::1']],
    ['a name that also resolves to a private address (rebinding)', [PUBLIC, '10.1.1.1']],
  ])('refuses %s, which resolves to a non-public address', async (_what, addresses) => {
    resolvesTo(...addresses);
    const refused = await checkImapTarget('imap.evil.test', 993);
    expect(refused).toMatch(/^IMAP host is not allowed: imap\.evil\.test resolves to blocked address /);
  });

  it('refuses a name that does not resolve', async () => {
    m.lookup.mockRejectedValue(new Error('ENOTFOUND'));
    expect(await checkImapTarget('nope.invalid', 993)).toBe('IMAP host is not allowed: DNS resolution failed for nope.invalid');
  });

  it.each([[''], ['   '], ['imap.test/x'], ['a b'], ['imap.test\n'], ['me@imap.test'], ['[::1]'], [undefined], [null], [42], [{ toString: () => 'x' }]])('refuses a host that is not a plain host name: %j', async (host) => {
    expect(await checkImapTarget(host, 993)).not.toBeNull();
  });

  it('allows a public IP literal and a name that resolves only to public addresses', async () => {
    expect(await checkImapTarget(PUBLIC, 993)).toBeNull();
    resolvesTo(PUBLIC, '2606:2800:220:1:248:1893:25c8:1946');
    expect(await checkImapTarget('imap.gmail.com', 993)).toBeNull();
  });
});

describe('checkImapTarget: port', () => {
  it('allows only the IMAP ports, 143 and 993', async () => {
    expect([...ALLOWED_IMAP_PORTS]).toEqual([143, 993]);
    expect(await checkImapTarget('imap.gmail.com', 143)).toBeNull();
    expect(await checkImapTarget('imap.gmail.com', 993)).toBeNull();
  });

  it.each([[22], [25], [80], [443], [587], [1143], [5432], [6379], [0], [65535], [993.5], [-993], ['993'], [null], [undefined], [NaN]])(
    'refuses port %j, before any lookup', async (port) => {
      expect(await checkImapTarget('imap.gmail.com', port)).toBe('IMAP port must be 143 or 993');
      expect(m.lookup).not.toHaveBeenCalled();
    });
});
