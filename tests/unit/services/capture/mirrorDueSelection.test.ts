/**
 * S-07e part B, review round 3: an app login may write `last_scan_at` (it is a scan
 * stamp, migration 946), so it can stamp a connection row into the future. The
 * cron's "due" selection used to wait for that time to pass, which silenced the
 * connection for good while it stayed 'active'. A future stamp now counts as due.
 * The selection's behaviour on rows is proven on a real database by
 * tests/integration/s07e-b-routes-paths-{imap,sent}.int.test.ts; this pins the
 * statement the services send, for runs without that fixture.
 *
 * Round 4: a future stamp sorts LAST among the due rows (it used to sort first, so a few
 * forged rows pinned the LIMIT), and FOR UPDATE SKIP LOCKED keeps a row an app role holds
 * locked from occupying a LIMIT slot tick after tick.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ statements: [] as string[] }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => { h.statements.push(strings.join('?').replace(/\s+/g, ' ').trim()); return []; }),
  withTransaction: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('imapflow', () => ({ ImapFlow: class {} }));
vi.mock('@/lib/documentStorage', () => ({ sha256: vi.fn(), storeCapturedBytes: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/captureRouterService', () => ({ routeEvent: vi.fn() }));

import { listActiveConnections } from '@/modules/accounting/services/capture/imapMirrorService';
import { listActiveSentConnections } from '@/modules/accounting/services/ar/sentMirrorService';

beforeEach(() => { h.statements.length = 0; });

describe.each([
  ['capture mirror', listActiveConnections, 'imap_mirror_connections'],
  ['sent mirror', listActiveSentConnections, 'sent_mirror_connections'],
] as const)('%s: the connections the cron picks', (_name, list, table) => {
  it('active rows never scanned, past their interval, or stamped into the future (last of the due rows); a row another transaction holds is skipped, not counted against the limit', async () => {
    await list();
    expect(h.statements).toHaveLength(1);
    const q = h.statements[0]!;
    expect(q).toContain(`FROM ${table}`);
    expect(q).toContain("WHERE status = 'active'");
    expect(q).toMatch(/\(last_scan_at IS NULL OR last_scan_at > NOW\(\) OR last_scan_at < NOW\(\) - \(scan_interval_minutes \|\| ' minutes'\)::INTERVAL\)/);
    expect(q).toContain("ORDER BY CASE WHEN last_scan_at > NOW() THEN 'infinity'::timestamptz ELSE last_scan_at END ASC NULLS FIRST");
    expect(q).toMatch(/LIMIT 20 FOR UPDATE SKIP LOCKED$/);
  });
});
