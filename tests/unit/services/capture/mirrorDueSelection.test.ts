/**
 * S-07e part B, review round 3: while `last_scan_at` was app-writable (the first 946),
 * an app login could stamp a connection row into the future. The cron's "due" selection
 * used to wait for that time to pass, which silenced the connection for good while it
 * stayed 'active'. A future stamp counts as due (kept, though since review round 5 only
 * migration_admin writes the column).
 * The selection's behaviour on rows is proven on a real database by
 * tests/integration/s07e-b-routes-paths-{imap,sent}.int.test.ts; this pins the
 * statement the services send, for runs without that fixture.
 *
 * Round 4: a future stamp sorts LAST among the due rows (it used to sort first, so a few
 * forged rows pinned the LIMIT), and SKIP LOCKED keeps a held row from occupying a slot.
 * Round 5: the selection runs on migration_admin (routeAdminQuery: an app role has no UPDATE,
 * which a row lock needs) and locks FOR NO KEY UPDATE, which the key-share lock of an app
 * role's scan-log INSERT does not block. Nothing goes through the app pool.
 * Round 8: at most ONE connection per company per tick (ROW_NUMBER per company), and a stored
 * interval below 5 minutes counts as 5 (mirrorDueSql.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ statements: [] as string[] }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => { h.statements.push(`app: ${strings.join('?').replace(/\s+/g, ' ').trim()}`); return []; }),
  withTransaction: vi.fn(),
}));
vi.mock('@/lib/auth/routeAdminPool', () => ({
  routeAdminQuery: vi.fn(async (_label: string, text: string, values: unknown[]) => {
    h.statements.push(`route: ${text.replace(/\s+/g, ' ').trim()}`);
    expect(values).toEqual([]);
    return [];
  }),
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
  it('active rows never scanned, past their interval (at least 5 minutes), or stamped into the future (last of the due rows), one per company; a row another transaction holds is skipped, not counted against the limit', async () => {
    await list();
    expect(h.statements).toHaveLength(1);
    const q = h.statements[0]!;
    expect(q.startsWith('route: SELECT c.* FROM')).toBe(true);
    expect(q).toContain(`FROM ${table} c JOIN`);
    expect(q).toContain("WHERE status = 'active'");
    expect(q).toMatch(/\(last_scan_at IS NULL OR last_scan_at > NOW\(\) OR last_scan_at < NOW\(\) - \(GREATEST\(scan_interval_minutes, 5\) \|\| ' minutes'\)::INTERVAL\)/);
    // One candidate per company: the company's most overdue due row (a future stamp last), then oldest first across companies.
    expect(q).toContain("ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY CASE WHEN last_scan_at > NOW() THEN 'infinity'::timestamptz ELSE last_scan_at END ASC NULLS FIRST, id) AS rn");
    expect(q).toContain('ON d.id = c.id AND d.rn = 1');
    expect(q).toContain('ORDER BY d.dueness ASC NULLS FIRST');
    expect(q).toMatch(/LIMIT 20 FOR NO KEY UPDATE OF c SKIP LOCKED$/);
  });
});
