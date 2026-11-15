/**
 * WP2-1 round 4 (PR #1449 LOW): the guard's FOR SHARE is race protection for a WRITE. The read-only callers — the
 * MCP read tools bank_statement_coverage and get_opening_balances (through bankGlAccountBelongsToCompany) and the
 * bulk-preview route — took it too, so a chart edit of the account waited behind a running read, and the read failed
 * after 5 s behind an open edit where it never used to block. They read the account with the same canonical
 * predicate and no lock (`{ lock: false }`); every write path keeps FOR SHARE (bank-account-guard-feeds).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import bulkPreview from '../../pages/api/accounting/bank-transactions-bulk-preview';
import { bankStatementCoverageTool, getOpeningBalancesTool } from '../../src/lib/mcp/tools/bankCoverage';
import type { McpToolContext } from '../../src/lib/mcp/types';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { inRequest } from './r035-pr5.helpers';
import { cleanupGuardFixture, guardFixture, type GuardFixture } from './bank-account-guard.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let x: GuardFixture;

beforeAll(async () => { x = await guardFixture(pool); });
afterAll(() => cleanupGuardFixture(pool, x));

const ctx = (): McpToolContext => ({
  userId: x.user, companyId: x.f.c, companyRole: 'owner', scopes: ['read:bank-tx', 'read:reports'],
  tokenJti: 'bag-reads', oauthAppId: null,
});
type Reply = { isError?: boolean; content: { text: string }[] };

const reads: Array<[string, () => Promise<{ ok: boolean; detail: string }>]> = [
  ['MCP bank_statement_coverage', async () => {
    const r = await inRequest(pool, x.user, x.f.c, () => bankStatementCoverageTool.handler({ bank_account_id: x.f.bank }, ctx())) as Reply;
    return { ok: !r.isError, detail: r.content[0]!.text.slice(0, 200) };
  }],
  ['MCP get_opening_balances', async () => {
    const r = await inRequest(pool, x.user, x.f.c, () => getOpeningBalancesTool.handler({ bank_account_id: x.f.bank }, ctx())) as Reply;
    return { ok: !r.isError, detail: r.content[0]!.text.slice(0, 200) };
  }],
  ['bank-transactions-bulk-preview', async () => {
    const r = await callRoute(bulkPreview as never, x.tokens[x.user]!, x.f.c, 'POST', {
      bankAccountId: x.f.bank, fileType: 'csv', filename: 'reads.csv', bankFormat: 'unknown',
      csvContent: ['Date,Description,Amount', '2026-09-02,BAG READ,-120.00'].join('\n'),
    }, '/api/accounting/bank-transactions-bulk-preview');
    return { ok: r.state.statusCode === 200, detail: JSON.stringify(r.state.body).slice(0, 200) };
  }],
];

describe('a read-only caller does not lock the bank account', () => {
  for (const [what, read] of reads) {
    it(`${what} answers at once while a chart edit holds the account`, async () => {
      const writer = await pool.connect();
      await writer.query('BEGIN');
      await writer.query('UPDATE gl_accounts SET account_name = account_name WHERE id = $1', [x.f.bank]);
      try {
        const t0 = Date.now();
        const out = await read();
        expect(out.ok, out.detail).toBe(true);
        expect(Date.now() - t0, 'the read waited on the held account').toBeLessThan(2000);
      } finally {
        await writer.query('ROLLBACK');
        writer.release();
      }
    }, 15_000);
  }

  it('a chart edit of the account is not blocked behind a running MCP read', async () => {
    const other = await pool.connect();
    try {
      await other.query("SET lock_timeout = '300ms'");
      await inRequest(pool, x.user, x.f.c, async () => {
        const r = await bankStatementCoverageTool.handler({ bank_account_id: x.f.bank }, ctx()) as Reply;
        expect(r.isError, r.content[0]!.text).toBeFalsy();
        await other.query('BEGIN');
        await other.query('UPDATE gl_accounts SET account_name = account_name WHERE id = $1', [x.f.bank]);
        await other.query('ROLLBACK');
      });
    } finally {
      await other.query('ROLLBACK').catch(() => undefined);
      await other.query('RESET lock_timeout');
      other.release();
    }
  });
});
