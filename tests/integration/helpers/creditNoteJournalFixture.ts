/**
 * An approved credit note with the journal an approval (or an import) leaves:
 * `posted` on the control account — DR payable for a supplier note, CR
 * receivable for a customer note — balanced against the fixture's expense
 * account. `posted: null` seeds a note with NO journal; `reversed: true` stamps
 * the journal reversed. Built on `l1FifoFixture`, whose chart carries the
 * `payable` / `receivable` subtypes the posted-credit read resolves by.
 */
import { sql } from '@/lib/neon';
import type { Fixture } from './l1FifoFixture';

export interface SeedPostedNoteArgs {
  side: 'supplier' | 'customer';
  number: string;
  total: number;
  /** What the journal puts on the control account; null = the note has no journal. */
  posted: number | null;
  reversed?: boolean;
  status?: string;
  /** Defaults to the fixture's supplier / customer. */
  counterpartyId?: string;
}

async function accountId(fx: Fixture, subtype: string): Promise<string> {
  const rows = (await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = ${subtype}
    ORDER BY account_code LIMIT 1`) as { id: string }[];
  return rows[0]!.id;
}

export async function seedPostedNote(fx: Fixture, args: SeedPostedNoteArgs): Promise<string> {
  const number = `${args.number}-${fx.tag}`;
  let journalId: string | null = null;
  if (args.posted !== null) {
    journalId = ((await sql`
      INSERT INTO gl_journal_entries
        (company_id, entry_number, entry_date, description, status, source, created_by, fiscal_period_id,
         posted_at, reversed_at)
      VALUES (${fx.companyId}::UUID, ${`JE-${number}`}, '2026-03-01'::DATE, ${`Credit note ${number}`}, 'posted',
              'auto_credit_note', ${fx.userId}::UUID,
              (SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID LIMIT 1), NOW(),
              ${args.reversed ? new Date() : null})
      RETURNING id`) as { id: string }[])[0]!.id;
    const control = await accountId(fx, args.side === 'supplier' ? 'payable' : 'receivable');
    const contra = await accountId(fx, 'default_expense');
    const p = args.posted;
    // Supplier: DR payable / CR contra. Customer: DR contra / CR receivable.
    const [ctrlDr, ctrlCr] = args.side === 'supplier' ? [p, 0] : [0, p];
    await sql`
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
      VALUES (${fx.companyId}::UUID, ${journalId}::UUID, ${control}::UUID, ${ctrlDr}, ${ctrlCr}),
             (${fx.companyId}::UUID, ${journalId}::UUID, ${contra}::UUID, ${ctrlCr}, ${ctrlDr})`;
  }
  const party = args.counterpartyId ?? (args.side === 'supplier' ? fx.supplierId : fx.customerId);
  const rows = (await sql`
    INSERT INTO credit_notes
      (company_id, type, supplier_id, client_id, credit_note_number, credit_date,
       subtotal, total_amount, applied_amount, status, created_by, gl_journal_entry_id)
    VALUES (${fx.companyId}::UUID, ${args.side},
            ${args.side === 'supplier' ? party : null}::UUID,
            ${args.side === 'customer' ? party : null}::UUID,
            ${number}, '2026-03-01'::DATE, ${args.total}, ${args.total}, 0, ${args.status ?? 'approved'},
            ${fx.userId}::UUID, ${journalId}::UUID)
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}
