/**
 * K-053 round 5 (LOW-1) — `purgeExpiredDeletes` takes the recorded reversal
 * row with the document it describes.
 *
 * `soft_delete_journal_reversals` (migration 653) is keyed on
 * (company_id, entity_type, entity_id) and has NO foreign key to the invoice —
 * it cannot have one, because the key covers two different tables. So a hard
 * purge of the invoice used to strand the row: the undo would then find a
 * reversal recorded for a document that no longer exists.
 *
 * The purge itself is not wired up (no caller), and the module header now says
 * why one must not be added lightly: destroying the invoice row destroys the
 * only thing the dated presence predicate can evaluate. This test covers the
 * cascade so that whoever does wire it up inherits a correct one.
 *
 * The purge is per-tenant, and it skips an invoice that still carries a posted
 * journal (`gl_journal_entry_id IS NOT NULL`) — both pinned below alongside the
 * cascade. It still runs inside a transaction that is ROLLED BACK, because this
 * fixture database is shared with other suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { purgeExpiredDeletes } from '@/modules/accounting/services/core/softDeleteService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K053PURGE-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let customer: string;
let supplier: string;
let arInvoice: string;
let apInvoice: string;
let liveInvoice: string;
/** Deleted long enough ago to be in the window, but still carrying a journal. */
let journalInvoice: string;
/** Another tenant's row carrying the SAME entity_id. Must survive. */
let otherEntry: string;

/** Runs `fn` on its own client and always ROLLBACKs, returning fn's result. */
async function inRolledBackTx<T>(fn: () => Promise<T>): Promise<T> {
  const client: PoolClient = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    return await als.run({ client, userId: USER, companyId: COMPANY, claims: {} }, fn);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function journalEntry(company: string): Promise<string> {
  const rows = (await sql`
    INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source, created_by)
    VALUES (${company}::UUID, ${'JE-' + TAG + '-' + randomUUID().slice(0, 8)}, CURRENT_DATE,
            ${'K053 purge ' + TAG}, 'posted', 'manual', ${USER}::UUID)
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

async function recordedFor(company: string, entityId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS n FROM soft_delete_journal_reversals
    WHERE company_id = ${company}::UUID AND entity_id = ${entityId}::UUID`) as { n: number }[];
  return rows[0]!.n;
}

describeIfDb('K-053 purging a soft-deleted document takes its recorded reversal', () => {
  beforeAll(async () => {
    assertDisposable();
    for (const [id, name] of [[COMPANY, 'K053PURGE ' + TAG], [OTHER_COMPANY, 'K053PURGE other ' + TAG]] as const) {
      await sql`INSERT INTO companies (id, name, registration_number)
                VALUES (${id}::UUID, ${name}, ${name})`;
    }
    customer = ((await sql`INSERT INTO customers (company_id, name)
                           VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name)
                           VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    // Two documents deleted 10 minutes ago (past the 5-minute window) and one
    // live document that the purge must not touch.
    const invoices = (await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
        due_date, status, total_amount, amount_paid, created_by, deleted_at)
      VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-DEL'}, CURRENT_DATE,
              CURRENT_DATE, 'approved', 100, 0, ${USER}::UUID, NOW() - INTERVAL '10 minutes'),
             (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-LIVE'}, CURRENT_DATE,
              CURRENT_DATE, 'approved', 100, 0, ${USER}::UUID, NULL)
      RETURNING id, invoice_number`) as { id: string; invoice_number: string }[];
    arInvoice = invoices.find((r) => r.invoice_number.endsWith('-DEL'))!.id;
    liveInvoice = invoices.find((r) => r.invoice_number.endsWith('-LIVE'))!.id;

    journalInvoice = ((await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
        due_date, status, total_amount, amount_paid, created_by, deleted_at, gl_journal_entry_id)
      VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-JE'}, CURRENT_DATE,
              CURRENT_DATE, 'approved', 100, 0, ${USER}::UUID, NOW() - INTERVAL '10 minutes',
              ${await journalEntry(COMPANY)}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;

    apInvoice = ((await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
        status, total_amount, amount_paid, created_by, deleted_at)
      VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP-DEL'}, CURRENT_DATE, CURRENT_DATE,
              'approved', 100, 0, ${USER}::UUID, NOW() - INTERVAL '10 minutes')
      RETURNING id`) as { id: string }[])[0]!.id;

    for (const [type, id] of [['customer_invoice', arInvoice], ['supplier_invoice', apInvoice],
                              ['customer_invoice', liveInvoice]] as const) {
      await sql`
        INSERT INTO soft_delete_journal_reversals
          (company_id, entity_type, entity_id, reversal_journal_entry_id, created_by)
        VALUES (${COMPANY}::UUID, ${type}, ${id}::UUID, ${await journalEntry(COMPANY)}::UUID, ${USER})`;
    }

    // Same entity_id, different tenant. The purge deletes by PAIR, so this row
    // must survive a purge that removed the first company's document.
    otherEntry = await journalEntry(OTHER_COMPANY);
    await sql`
      INSERT INTO soft_delete_journal_reversals
        (company_id, entity_type, entity_id, reversal_journal_entry_id, created_by)
      VALUES (${OTHER_COMPANY}::UUID, 'customer_invoice', ${arInvoice}::UUID, ${otherEntry}::UUID, ${USER})`;
  }, 120000);

  afterAll(async () => {
    for (const company of [COMPANY, OTHER_COMPANY]) {
      await sql`DELETE FROM soft_delete_journal_reversals WHERE company_id = ${company}::UUID`;
      await sql`UPDATE customer_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${company}::UUID`;
      await sql`DELETE FROM customer_invoices WHERE company_id = ${company}::UUID`;
      await sql`DELETE FROM supplier_invoices WHERE company_id = ${company}::UUID`;
      await sql`DELETE FROM gl_journal_entries WHERE company_id = ${company}::UUID`;
      await sql`DELETE FROM customers WHERE company_id = ${company}::UUID`;
      await sql`DELETE FROM suppliers WHERE company_id = ${company}::UUID`;
      await sql`DELETE FROM companies WHERE id = ${company}::UUID`;
    }
  }, 120000);

  it('the purge removes the reversal rows of the documents it purged, and only those', async () => {
    const seen = await inRolledBackTx(async () => {
      await purgeExpiredDeletes(COMPANY);
      return {
        purgedAr: await recordedFor(COMPANY, arInvoice),
        purgedAp: await recordedFor(COMPANY, apInvoice),
        live: await recordedFor(COMPANY, liveInvoice),
        otherTenant: await recordedFor(OTHER_COMPANY, arInvoice),
        arRow: ((await sql`SELECT COUNT(*)::int AS n FROM customer_invoices
                           WHERE id = ${arInvoice}::UUID`) as { n: number }[])[0]!.n,
        liveRow: ((await sql`SELECT COUNT(*)::int AS n FROM customer_invoices
                             WHERE id = ${liveInvoice}::UUID`) as { n: number }[])[0]!.n,
        journalRow: ((await sql`SELECT COUNT(*)::int AS n FROM customer_invoices
                                WHERE id = ${journalInvoice}::UUID`) as { n: number }[])[0]!.n,
      };
    });

    expect(seen.arRow).toBe(0);
    expect(seen.liveRow).toBe(1);
    expect(seen.purgedAr).toBe(0);
    expect(seen.purgedAp).toBe(0);
    // The live document was never purged, so its recorded reversal stays.
    expect(seen.live).toBe(1);
    // Same entity_id, other tenant: untouched.
    expect(seen.otherTenant).toBe(1);
    // In the window, but its journal is still posted — the purge leaves it,
    // because destroying the row destroys the only side of the control-account
    // tie the dated presence predicate can evaluate.
    expect(seen.journalRow).toBe(1);
  });

  it('the rollback held: nothing above actually left the database', async () => {
    expect(await recordedFor(COMPANY, arInvoice)).toBe(1);
    expect(await recordedFor(COMPANY, apInvoice)).toBe(1);
    expect(await recordedFor(OTHER_COMPANY, arInvoice)).toBe(1);
  });
});
