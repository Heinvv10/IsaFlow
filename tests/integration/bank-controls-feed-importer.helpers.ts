/**
 * Shared by the bank-controls-feed-importer suites: a company whose extension connection a pairing token can push
 * through the REAL extension-ingest route, and the push itself.
 */
import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { expect } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { createUser, plantRule } from './r035-approval.helpers';
import { journalRule } from './r035-pr6.helpers';
import { bankCompany, enforce, type BankCompany } from './bank-controls-a.helpers';
import { ingestReq, mockRes } from './s06b-extension-token-standing.helpers';

type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
export type FeedCompany = BankCompany & { conn: string };

export class FeedHarness {
  readonly tokens: Record<string, string> = {};
  readonly companies: string[] = [];
  a = '';
  b = '';
  private saved: string | undefined;
  private ingest!: Route;
  private sign!: typeof import('@/lib/auth/extensionJwt').signExtensionToken;
  private n = 0;

  constructor(private readonly pool: Pool) {}

  async start(): Promise<void> {
    this.saved = process.env.EXTENSION_SIGNING_KEY;
    process.env.EXTENSION_SIGNING_KEY = randomUUID() + randomUUID();
    this.a = await createUser(this.pool, this.tokens);
    this.b = await createUser(this.pool, this.tokens);
    ({ signExtensionToken: this.sign } = await import('@/lib/auth/extensionJwt'));
    this.ingest = (await import('../../pages/api/accounting/bank-feeds/[id]/extension-ingest')).default as unknown as Route;
  }

  async stop(cleanupBankControlsA: (pool: Pool, companies: string[], users: string[]) => Promise<void>): Promise<void> {
    if (this.saved === undefined) delete process.env.EXTENSION_SIGNING_KEY;
    else process.env.EXTENSION_SIGNING_KEY = this.saved;
    await this.pool.query('DELETE FROM bank_transfer_link_log WHERE company_id = ANY($1)', [this.companies]);
    await this.pool.query('DELETE FROM bank_feed_sync_logs WHERE company_id = ANY($1)', [this.companies]);
    await this.pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::text[])', [this.companies.map((c) => `extension-ingest:${c}`)]);
    await cleanupBankControlsA(this.pool, this.companies, [this.a, this.b]);
    const { getPoolForTests } = await import('@/lib/neon');
    await getPoolForTests().end();
  }

  /** a and b both admins unless `members` says otherwise; `types` enforced, an owner rule over R1 000 on manual journals. */
  async fixture(types: string[], members: [string, string][] = [[this.a, 'admin'], [this.b, 'admin']]): Promise<FeedCompany> {
    const f = await bankCompany(this.pool, members, this.companies);
    await journalRule(plantRule, this.pool, f.c);
    await enforce(this.pool, f.c, this.a, types);
    return { ...f, conn: await this.connection(f, f.bank) };
  }

  async connection(f: BankCompany, bankAccountId: string): Promise<string> {
    return (await this.pool.query(
      `INSERT INTO bank_feed_connections(company_id, bank_account_id, provider, status, is_active, config, created_by)
       VALUES($1,$2,'extension','active',true,'{"bankId":"absa"}',$3) RETURNING id`, [f.c, bankAccountId, this.a])).rows[0].id as string;
  }

  /** `pusher` pushes one row (dated 2026-09-02) through the real extension-ingest route on `conn`; returns the line id. */
  async push(f: FeedCompany, pusher: string, amount: number, conn: string = f.conn): Promise<string> {
    this.n += 1;
    const description = `FEEDGATE FORGED ${this.n}`;
    const token = await this.sign({ userId: pusher, companyId: f.c, connectionId: conn, bankId: 'absa', scope: 'bank-feed-ingest' });
    const req = ingestReq(token, conn, description);
    (req.body as { transactions: { amount: number }[] }).transactions[0]!.amount = amount;
    const res = mockRes();
    await this.ingest(req, res);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    return (await this.pool.query('SELECT id FROM bank_transactions WHERE company_id = $1 AND description = $2',
      [f.c, description])).rows[0].id as string;
  }
}

export const EXT_REFUSAL = (arm: string) =>
  `You brought this line in through the bank extension, so while ${arm} approval is on you cannot allocate it yourself. `
  + 'Ask another member to allocate this line.';
