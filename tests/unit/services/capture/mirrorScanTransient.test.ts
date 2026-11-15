/**
 * A mirror scan that failed for a passing reason must not disable its connection
 * (production, 2026-11-15: one failed DNS lookup under load flipped a new mailbox to
 * 'error', and nothing sets it back, so it was never scanned again). isTransientScanFailure
 * says which failures pass: the resolver gave no answer, or the network failed to connect or
 * dropped the socket. Everything else (a rejected login, a host refused by policy, anything
 * unclassified) stays permanent, as before. recordScanFailure counts a transient failure
 * (consecutive_scan_failures, migration 995; status flips only at the row's cap) and marks a
 * permanent one 'error' at once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ route: [] as Array<{ text: string; values: unknown[] }> }));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth/routeAdminPool', () => ({
  routeAdminQuery: vi.fn(async (_label: string, text: string, values: unknown[]) => {
    h.route.push({ text: text.replace(/\s+/g, ' ').trim(), values });
    return [];
  }),
}));

import { IMAP_HOST_REFUSED, IMAP_PORT_REFUSED, ImapTargetError } from '@/lib/imapTargetGuard';
import { MAIL_SERVER_UNREACHABLE, isTransientScanFailure, recordScanFailure } from '@/modules/accounting/services/capture/mirrorScanError';

const conn = { id: '22222222-2222-4222-8222-222222222222', companyId: '11111111-1111-4111-8111-111111111111' };
const coded = (code: string, message = `failed: ${code}`) => Object.assign(new Error(message), { code });
const FLIPS = "status = CASE WHEN status = 'active' THEN 'error' ELSE status END";
const COUNTS = new RegExp("SET last_scan_at = NOW\\(\\), last_error = \\$1, consecutive_scan_failures = consecutive_scan_failures \\+ 1, "
  + "status = CASE WHEN status = 'active' AND consecutive_scan_failures \\+ 1 >= GREATEST\\(3, CEIL\\(1440\\.0 / GREATEST\\(scan_interval_minutes, 5\\)\\)\\) "
  + "THEN 'error' ELSE status END WHERE id = \\$2::uuid AND company_id = \\$3::uuid$");

beforeEach(() => { h.route.length = 0; });

describe('isTransientScanFailure', () => {
  it('a target whose DNS gave no answer is transient', () => {
    expect(isTransientScanFailure(new ImapTargetError(IMAP_HOST_REFUSED, true))).toBe(true);
  });

  it.each([
    'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN',
    'ETIMEOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT',
    'NoConnection', 'EConnectionClosed', 'ClosedAfterConnectTLS', 'ClosedAfterConnectText',
  ])('a network failure coded %s is transient', (code) => {
    expect(isTransientScanFailure(coded(code))).toBe(true);
  });

  it.each([
    ['a target refused by policy (resolves to private space)', new ImapTargetError(IMAP_HOST_REFUSED, false)],
    ['a port that is not allowed', new ImapTargetError(IMAP_PORT_REFUSED, false)],
    ['a rejected login', Object.assign(new Error('Command failed'), { authenticationFailed: true })],
    ['a rejected login whose socket also closed', Object.assign(coded('NoConnection'), { authenticationFailed: true })],
    ['a rejected login that is also a transient target error (the login check comes first)', Object.assign(new ImapTargetError(IMAP_HOST_REFUSED, true), { authenticationFailed: true })],
    ['an error with no code', new Error('connect ECONNREFUSED 1.2.3.4:993')],
    ['an unclassified code', coded('ERR_SSL_WRONG_VERSION_NUMBER')],
    ['a code that is not a string', Object.assign(new Error('x'), { code: 61 })],
    ['a string', 'ECONNREFUSED'],
    ['null', null],
    ['undefined', undefined],
  ])('%s is permanent', (_what, err) => {
    expect(isTransientScanFailure(err)).toBe(false);
  });
});

describe.each([['imap', 'imap_mirror_connections'], ['sent', 'sent_mirror_connections']] as const)('%s mirror: recordScanFailure', (kind, table) => {
  it('a DNS-dependent target failure is counted with the target message; status flips only at the cap (a day of scans, at least 3)', async () => {
    await recordScanFailure(kind, conn, new ImapTargetError(IMAP_HOST_REFUSED, true));
    expect(h.route).toHaveLength(1);
    expect(h.route[0]!.text).toMatch(new RegExp(`^UPDATE ${table} `));
    expect(h.route[0]!.text).toMatch(COUNTS);
    expect(h.route[0]!.values).toEqual([IMAP_HOST_REFUSED, conn.id, conn.companyId]);
  });

  it('a network failure is counted with a generic message (never the address it tried)', async () => {
    await recordScanFailure(kind, conn, coded('ECONNREFUSED', 'connect ECONNREFUSED 93.184.216.34:993'));
    expect(h.route[0]!.text).toMatch(COUNTS);
    expect(h.route[0]!.values).toEqual([MAIL_SERVER_UNREACHABLE, conn.id, conn.companyId]);
    expect(MAIL_SERVER_UNREACHABLE).toBe('Mail server could not be reached; will retry');
  });

  it.each([
    ['a rejected login', Object.assign(new Error('Command failed'), { authenticationFailed: true }), 'Command failed'],
    ['a policy refusal', new ImapTargetError(IMAP_HOST_REFUSED, false), IMAP_HOST_REFUSED],
    ['an unclassified error', new Error('boom'), 'boom'],
    ['a thrown string', 'boom', 'boom'],
  ])('%s marks the connection errored with its message', async (_what, err, message) => {
    await recordScanFailure(kind, conn, err);
    expect(h.route).toHaveLength(1);
    expect(h.route[0]!.text).toContain(`UPDATE ${table}`);
    expect(h.route[0]!.text).toContain(FLIPS);
    expect(h.route[0]!.text).not.toContain('consecutive_scan_failures');
    expect(h.route[0]!.values).toEqual([message, conn.id, conn.companyId]);
  });
});
