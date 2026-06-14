/**
 * SSRF guard tests — WS-1 (pentest H2/M5).
 *
 * safeFetch / assertPublicUrl must refuse any URL that resolves to a private,
 * loopback, link-local, CGNAT (the prod Tailscale mesh), or otherwise reserved
 * address — on BOTH IP literals and DNS hostnames (rebinding) — and must enforce
 * https + an optional host allowlist.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const lookup = vi.fn();
vi.mock('node:dns/promises', () => ({ lookup: (...a: unknown[]) => lookup(...a) }));

import { ipReason, assertPublicUrl, SsrfError } from '@/lib/safeFetch';

beforeEach(() => {
  lookup.mockReset();
});

describe('ipReason — IPv4 reserved ranges', () => {
  it('allows public addresses', () => {
    expect(ipReason('8.8.8.8')).toBeNull();
    expect(ipReason('1.1.1.1')).toBeNull();
    expect(ipReason('93.184.216.34')).toBeNull();
  });

  it('blocks RFC-1918 private ranges', () => {
    expect(ipReason('10.0.0.1')).not.toBeNull();
    expect(ipReason('192.168.1.1')).not.toBeNull();
    expect(ipReason('172.16.0.1')).not.toBeNull();
    expect(ipReason('172.31.255.255')).not.toBeNull();
  });

  it('treats only 172.16–172.31 as private (not all 172.x)', () => {
    expect(ipReason('172.15.0.1')).toBeNull();
    expect(ipReason('172.32.0.1')).toBeNull();
  });

  it('blocks loopback, link-local and the cloud metadata IP', () => {
    expect(ipReason('127.0.0.1')).not.toBeNull();
    expect(ipReason('127.1.2.3')).not.toBeNull();
    expect(ipReason('169.254.0.1')).not.toBeNull();
    expect(ipReason('169.254.169.254')).not.toBeNull();
  });

  it('blocks CGNAT 100.64.0.0/10 — the prod Tailscale mesh', () => {
    expect(ipReason('100.64.0.1')).not.toBeNull();
    expect(ipReason('100.127.255.255')).not.toBeNull();
    expect(ipReason('100.96.203.105')).not.toBeNull(); // the actual velo-server mesh IP
  });

  it('allows addresses just outside CGNAT', () => {
    expect(ipReason('100.63.255.255')).toBeNull();
    expect(ipReason('100.128.0.0')).toBeNull();
  });

  it('blocks 0.0.0.0/8, multicast, reserved and broadcast', () => {
    expect(ipReason('0.0.0.0')).not.toBeNull();
    expect(ipReason('224.0.0.1')).not.toBeNull();
    expect(ipReason('240.0.0.1')).not.toBeNull();
    expect(ipReason('255.255.255.255')).not.toBeNull();
  });
});

describe('ipReason — IPv6 reserved ranges', () => {
  it('allows public IPv6', () => {
    expect(ipReason('2606:4700:4700::1111')).toBeNull();
    expect(ipReason('2001:4860:4860::8888')).toBeNull();
  });

  it('blocks loopback/unspecified', () => {
    expect(ipReason('::1')).not.toBeNull();
    expect(ipReason('::')).not.toBeNull();
  });

  it('blocks ULA fc00::/7 and link-local fe80::/10', () => {
    expect(ipReason('fc00::1')).not.toBeNull();
    expect(ipReason('fd12:3456::1')).not.toBeNull();
    expect(ipReason('fe80::1')).not.toBeNull();
  });

  it('blocks IPv4-mapped IPv6 that wraps a private/loopback v4 — dotted AND hex form', () => {
    // Dotted form (raw)
    expect(ipReason('::ffff:127.0.0.1')).not.toBeNull();
    expect(ipReason('::ffff:10.0.0.1')).not.toBeNull();
    expect(ipReason('::ffff:100.96.203.105')).not.toBeNull();
    // Hex form — what new URL() canonicalizes the above to (the bypass the review caught)
    expect(ipReason('::ffff:7f00:1')).not.toBeNull();        // 127.0.0.1
    expect(ipReason('::ffff:a9fe:a9fe')).not.toBeNull();     // 169.254.169.254
    expect(ipReason('::ffff:6460:cb69')).not.toBeNull();     // 100.96.203.105
    // But a mapped PUBLIC v4 is still allowed
    expect(ipReason('::ffff:808:808')).toBeNull();           // 8.8.8.8
    // NAT64-wrapped private
    expect(ipReason('64:ff9b::7f00:1')).not.toBeNull();      // 127.0.0.1 via NAT64
  });

  it('returns a reason for non-IP input', () => {
    expect(ipReason('not-an-ip')).not.toBeNull();
    expect(ipReason('999.1.1.1')).not.toBeNull();
  });
});

describe('assertPublicUrl', () => {
  it('passes a public https host', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(assertPublicUrl('https://example.com/hook')).resolves.toBeUndefined();
  });

  it('rejects non-https by default', async () => {
    await expect(assertPublicUrl('http://example.com')).rejects.toBeInstanceOf(SsrfError);
  });

  it('allows http only when allowHttp is set', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(assertPublicUrl('http://example.com', { allowHttp: true })).resolves.toBeUndefined();
  });

  it('rejects an IP-literal loopback without any DNS call', async () => {
    await expect(assertPublicUrl('https://127.0.0.1/x')).rejects.toBeInstanceOf(SsrfError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects the metadata IP and bracketed IPv6 loopback', async () => {
    await expect(assertPublicUrl('https://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('https://[::1]/')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects IPv4-mapped IPv6 literals through URL normalization (the hex-form bypass)', async () => {
    // new URL() rewrites these to ::ffff:7f00:1 etc — must still be blocked end-to-end.
    await expect(assertPublicUrl('https://[::ffff:127.0.0.1]/')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('https://[::ffff:169.254.169.254]/latest/meta-data/')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('https://[::ffff:100.96.203.105]/')).rejects.toBeInstanceOf(SsrfError);
    expect(lookup).not.toHaveBeenCalled(); // IP literals never hit DNS
  });

  it('still allows a genuinely public IPv6 literal', async () => {
    await expect(assertPublicUrl('https://[2606:4700:4700::1111]/')).resolves.toBeUndefined();
  });

  it('rejects a hostname whose AAAA resolves to a mapped private v4 (rebinding via IPv6)', async () => {
    lookup.mockResolvedValue([{ address: '::ffff:7f00:1', family: 6 }]);
    await expect(assertPublicUrl('https://v6rebind.example')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects a hostname that resolves to a private IP (DNS rebinding)', async () => {
    lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(assertPublicUrl('https://rebind.evil.com')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects a hostname that resolves to the CGNAT mesh', async () => {
    lookup.mockResolvedValue([{ address: '100.96.203.105', family: 4 }]);
    await expect(assertPublicUrl('https://innocent.example')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects when ANY resolved address is private', async () => {
    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    await expect(assertPublicUrl('https://mixed.example')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects a host that does not resolve', async () => {
    lookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertPublicUrl('https://nope.invalid')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects malformed URLs and non-http(s) schemes', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('ftp://example.com')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfError);
  });

  describe('allowHosts mode (sage-pull)', () => {
    it('permits an allowlisted host', async () => {
      lookup.mockResolvedValue([{ address: '102.130.50.10', family: 4 }]);
      await expect(
        assertPublicUrl('https://accounting.sageone.co.za/x', { allowHosts: ['sageone.co.za'] }),
      ).resolves.toBeUndefined();
    });

    it('rejects a non-allowlisted host even if public', async () => {
      lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      await expect(
        assertPublicUrl('https://evil.com/x', { allowHosts: ['sageone.co.za'] }),
      ).rejects.toBeInstanceOf(SsrfError);
    });

    it('rejects a look-alike host (suffix must be a dot-boundary match)', async () => {
      lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      await expect(
        assertPublicUrl('https://notsageone.co.za/x', { allowHosts: ['sageone.co.za'] }),
      ).rejects.toBeInstanceOf(SsrfError);
    });
  });
});
