/**
 * S-07e part B, review round 2: the spellings an attacker tries to get a private
 * address past checkImapTarget. Every refusal here is the generic message, with
 * the reason in the log. Name forms a resolver reads as an address (2130706433,
 * 0x7f000001, 127.1, ...) are not IP literals to the guard, so they go to the
 * resolver and are refused on its answer; DNS is a fake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: m.lookup }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { checkImapTarget } from '@/lib/imapTargetGuard';
import { ipReason } from '@/lib/safeFetch';

const PUBLIC = '93.184.216.34';
const REFUSED = { ok: false, message: 'This mail server address is not allowed or could not be resolved' };
const resolvesTo = (...addresses: string[]) =>
  m.lookup.mockResolvedValue(addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));

beforeEach(() => {
  m.lookup.mockReset();
  resolvesTo(PUBLIC);
});

describe('IP literals, every IPv6 spelling of a private address: refused with no lookup', () => {
  it.each([
    ['IPv4-mapped, hex', '::ffff:7f00:1'],
    ['IPv4-mapped, expanded and zero-padded', '0:0:0:0:0:ffff:7f00:0001'],
    ['IPv4-compatible, dotted', '::127.0.0.1'],
    ['IPv4-mapped, upper case, dotted', '::FFFF:127.0.0.1'],
    ['IPv4-mapped, private /8', '::ffff:10.0.0.1'],
    ['IPv4-mapped, metadata', '::ffff:a9fe:a9fe'],
    ['link-local, upper case', 'FE80::1'],
    ['NAT64 well-known prefix wrapping metadata', '64:ff9b::a9fe:a9fe'],
    ['IPv4-translated (SIIT) ::ffff:0:x wrapping loopback', '::ffff:0:7f00:1'],
    ['IPv4-translated (SIIT), dotted tail', '::ffff:0:127.0.0.1'],
    ['site-local (fec0::/10, deprecated)', 'fec0::1'],
    ['site-local, top of the range', 'feff::1'],
    ['local-use NAT64 (64:ff9b:1::/48) wrapping 10.0.0.1', '64:ff9b:1::a00:1'],
    ['6to4 wrapping loopback', '2002:7f00:1::'],
    ['Teredo', '2001:0:7f00::1'],
    ['6to4 relay anycast (192.88.99.0/24)', '192.88.99.1'],
    ['6to4 relay anycast, IPv4-mapped', '::ffff:192.88.99.1'],
    ['documentation (2001:db8::/32)', '2001:db8::1'],
    ['documentation, upper case, zero-padded', '2001:0DB8:0:0:0:0:0:1'],
    ['discard-only (100::/64)', '100::1'],
    ['loopback, expanded', '0:0:0:0:0:0:0:1'],
    ['loopback, redundant zero', '::0:1'],
  ])('%s: %s', async (_what, host) => {
    expect(await checkImapTarget(host, 993)).toEqual(REFUSED);
    expect(m.lookup).not.toHaveBeenCalled();
  });

  it.each([
    ['IPv4-translated (SIIT)', '::ffff:0:5db8:d822'],
    ['local-use NAT64', '64:ff9b:1::5db8:d822'],
  ])('%s is refused even around a public IPv4 (the translator is the unknown)', async (_what, host) => {
    expect(await checkImapTarget(host, 993)).toEqual(REFUSED);
    expect(ipReason(host)).not.toBeNull();
  });
});

describe('names a resolver reads as an address are not literals: refused on the resolver answer', () => {
  it.each([
    ['decimal integer', '2130706433'],
    ['hex integer', '0x7f000001'],
    ['octal dotted', '0177.0.0.1'],
    ['short dotted', '127.1'],
    ['trailing dot', '127.0.0.1.'],
    ['mixed hex dotted', '0x7f.1'],
    ['zero', '0'],
    ['upper-case localhost', 'LOCALHOST'],
    ['rooted localhost', 'localhost.'],
  ])('%s (%s)', async (_what, host) => {
    resolvesTo('127.0.0.1');
    expect(await checkImapTarget(host, 993)).toEqual(REFUSED);
    expect(m.lookup).toHaveBeenCalledTimes(1);
  });
});

describe('the reserved ranges that stay public-looking are refused as DNS answers too', () => {
  it.each([['6to4 relay anycast', '192.88.99.1'], ['documentation', '2001:db8::5'], ['discard-only', '100::5']])('%s', async (_what, address) => {
    resolvesTo(address);
    expect(await checkImapTarget('reserved.example', 993)).toEqual(REFUSED);
  });

  it('their neighbours are still public', async () => {
    for (const address of ['192.88.98.1', '192.88.100.1', '2001:db9::1', '2001:db7::1', '100:0:0:1::1']) {
      expect(ipReason(address), address).toBeNull();
    }
  });
});

describe('a name DNS cannot answer for is not a policy refusal', () => {
  const UNRESOLVED = { ok: false, message: 'This mail server address is not allowed or could not be resolved' };

  it('a resolver failure (ENOTFOUND, EAI_AGAIN)', async () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN']) {
      m.lookup.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      expect(await checkImapTarget('typo.example', 993)).toEqual(UNRESOLVED);
    }
  });

  it('an answer with no records', async () => {
    m.lookup.mockResolvedValue([]);
    expect(await checkImapTarget('empty.example', 993)).toEqual(UNRESOLVED);
  });

  it('an answer that is private stays the generic refusal, whatever else is wrong with the name', async () => {
    resolvesTo('10.0.0.1');
    expect(await checkImapTarget('private.example', 993)).toEqual(REFUSED);
  });
});

describe('a name with one private address among its answers is refused whole', () => {
  it('public and private A records', async () => {
    resolvesTo(PUBLIC, '10.0.0.1');
    expect(await checkImapTarget('mixed.example', 993)).toEqual(REFUSED);
  });

  it('a public A record and an IPv4-mapped loopback AAAA', async () => {
    resolvesTo(PUBLIC, '::ffff:127.0.0.1');
    expect(await checkImapTarget('mixed6.example', 993)).toEqual(REFUSED);
  });

  it('a public A record and a SIIT AAAA', async () => {
    resolvesTo(PUBLIC, '::ffff:0:7f00:1');
    expect(await checkImapTarget('siit.example', 993)).toEqual(REFUSED);
  });
});

describe('hosts that are not a plain name or literal: refused with no lookup', () => {
  it.each([
    ['leading space', ' 127.0.0.1'],
    ['trailing newline', '127.0.0.1\n'],
    ['inner space', 'a b'],
    ['trailing tab', 'host\t'],
    ['bracketed v6', '[::1]'],
    ['zone id', 'fe80::1%eth0'],
    ['Cyrillic homoglyph', 'exаmple.com'],
    ['path', 'h/../x'],
    ['userinfo', 'user@host'],
  ])('%s: %j', async (_what, host) => {
    expect(await checkImapTarget(host, 993)).toEqual(REFUSED);
    expect(m.lookup).not.toHaveBeenCalled();
  });

  it('punycode is a plain name: it goes to the resolver and is allowed when public', async () => {
    expect(await checkImapTarget('xn--nxasmq6b.example', 993)).toEqual({ ok: true, address: PUBLIC, servername: 'xn--nxasmq6b.example' });
  });
});

describe('ports that are not exactly the number 143 or 993', () => {
  it.each([
    ['numeric string', '993'], ['fraction', 993.5], ['NaN', NaN], ['negative', -993], ['zero', 0], ['past 16 bits', 65536],
    ['an unlisted IMAP-ish port', 1143], ['null', null], ['array', [993]], ['object with valueOf', { valueOf: () => 993 }],
  ])('%s: %j', async (_what, port) => {
    expect(await checkImapTarget('imap.example.com', port)).toEqual({ ok: false, message: 'Only ports 143 and 993 are supported' });
    expect(m.lookup).not.toHaveBeenCalled();
  });

  it('993.0 is the number 993; 143 is allowed', async () => {
    expect((await checkImapTarget('imap.example.com', 993.0)).ok).toBe(true);
    expect((await checkImapTarget('imap.example.com', 143)).ok).toBe(true);
  });
});
