/**
 * S-07e part B, review round 2 (DNS rebinding): the IMAP guard vets a host's
 * addresses, and the scan must then connect to the address it vetted. If it
 * handed ImapFlow the name, the socket would resolve it a second time and a DNS
 * record that answers public once and 127.0.0.1 the next time would walk past
 * the guard. ImapFlow is the real class here; the sockets are fakes, so what is
 * asserted is what reaches `tls.connect` / `net.connect`: the vetted IP as the
 * host, the original name as the TLS servername (SNI and the certificate check).
 */
import { PassThrough } from 'node:stream';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ lookup: vi.fn(), decrypt: vi.fn(() => 'password'), markError: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: m.lookup }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/encryption', () => ({ decrypt: m.decrypt }));
vi.mock('@/lib/documentStorage', () => ({ sha256: vi.fn(), storeCapturedBytes: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/captureRouterService', () => ({ routeEvent: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/imapMirrorInbox', () => ({ ensureMirrorInbox: vi.fn(), isTransientIngestError: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/mirrorScanError', () => ({ markMirrorScanError: m.markError }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: vi.fn() }));

import { scanConnection, type MirrorConnection } from '@/modules/accounting/services/capture/imapMirrorService';
import { scanSentConnection, type SentMirrorConnection } from '@/modules/accounting/services/ar/sentMirrorService';

const PUBLIC = '93.184.216.34';
const COMPANY = '11111111-1111-4111-8111-111111111111';

/** What the sockets were asked to connect to. */
const dialled: Array<{ via: 'tls' | 'net'; host?: string; servername?: string | false; port?: number }> = [];

/** A socket that fails the connect at once: nothing leaves the process. */
function failingSocket(): net.Socket {
  const s = new PassThrough();
  setImmediate(() => s.emit('error', new Error('stub: connect refused')));
  return s as unknown as net.Socket;
}

const imapConn = (over: Partial<MirrorConnection> = {}): MirrorConnection => ({
  id: 'c1', companyId: COMPANY, provider: 'imap', accountEmail: 'ap@co.test', folder: 'INBOX', scanCursor: {},
  allowedSenders: [], deniedSenders: [], imapHost: 'imap.rebind.test', imapPort: 993, imapUseTls: true,
  imapUsername: 'u', imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null, ...over,
});
const sentConn = (over: Partial<SentMirrorConnection> = {}): SentMirrorConnection => ({
  id: 's1', companyId: COMPANY, provider: 'imap', accountEmail: 'ap@co.test', sentFolder: 'Sent', scanCursor: {},
  imapHost: 'imap.rebind.test', imapPort: 993, imapUseTls: true, imapUsername: 'u', imapPasswordEnc: 'enc',
  oauthRefreshTokenEnc: null, ...over,
});

const SERVICES = [
  ['capture mirror', (over: object) => scanConnection(imapConn(over))],
  ['sent mirror', (over: object) => scanSentConnection(sentConn(over))],
] as const;

beforeEach(() => {
  dialled.length = 0;
  m.lookup.mockReset();
  m.decrypt.mockClear();
  m.markError.mockClear();
  m.lookup.mockResolvedValue([{ address: PUBLIC, family: 4 }]);
  vi.spyOn(tls, 'connect').mockImplementation(((o: tls.ConnectionOptions) => {
    dialled.push({ via: 'tls', host: o.host, servername: o.servername as string | false | undefined, port: o.port });
    return failingSocket();
  }) as never);
  vi.spyOn(net, 'connect').mockImplementation(((o: net.NetConnectOpts & { host?: string }) => {
    dialled.push({ via: 'net', host: o.host, port: (o as { port?: number }).port });
    return failingSocket();
  }) as never);
});
afterEach(() => vi.restoreAllMocks());

describe.each(SERVICES)('%s: the scan connects to the address the guard vetted', (_name, scan) => {
  it('hands the socket the vetted IP as the host and the name as the TLS servername', async () => {
    await scan({});
    expect(m.lookup).toHaveBeenCalledTimes(1);
    expect(dialled).toEqual([{ via: 'tls', host: PUBLIC, servername: 'imap.rebind.test', port: 993 }]);
  });

  it('a name whose DNS answers public once and 127.0.0.1 afterwards still connects to the public address', async () => {
    m.lookup.mockResolvedValueOnce([{ address: PUBLIC, family: 4 }]);
    m.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await scan({});
    expect(m.lookup).toHaveBeenCalledTimes(1); // the guard's answer is the only one asked for
    expect(dialled).toHaveLength(1);
    expect(dialled[0]!.host).toBe(PUBLIC);
    expect(dialled.some((d) => d.host === 'imap.rebind.test' || d.host === '127.0.0.1')).toBe(false);
  });

  it('with several public addresses it connects to the IPv4 one', async () => {
    m.lookup.mockResolvedValue([{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }, { address: PUBLIC, family: 4 }]);
    await scan({});
    expect(dialled[0]!.host).toBe(PUBLIC);
    expect(dialled[0]!.servername).toBe('imap.rebind.test');
  });

  it('an IP-literal host connects to itself, with no lookup and no servername (ImapFlow: false)', async () => {
    await scan({ imapHost: PUBLIC });
    expect(m.lookup).not.toHaveBeenCalled();
    expect(dialled).toEqual([{ via: 'tls', host: PUBLIC, servername: false, port: 993 }]);
  });

  it('a plain (STARTTLS) connection on 143 also dials the vetted IP', async () => {
    await scan({ imapPort: 143, imapUseTls: false });
    expect(dialled).toHaveLength(1);
    expect(dialled[0]).toMatchObject({ via: 'net', host: PUBLIC, port: 143 });
  });

  it('a host that resolves into private space is refused before the password is decrypted or anything dials', async () => {
    m.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await scan({});
    expect(dialled).toHaveLength(0);
    expect(m.decrypt).not.toHaveBeenCalled();
    // Generic text to the tenant (last_error): no resolved address.
    expect(m.markError).toHaveBeenCalledTimes(1);
    expect(m.markError.mock.calls[0]![2]).toBe('This mail server address is not allowed or could not be resolved');
  });
});
