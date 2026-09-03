/**
 * noteTaxation (AFS disclosure note 7) must ignore the VAT submission journals.
 *
 * V-05, the census. This note aggregates the same two control accounts over the
 * fiscal year and prints "Output VAT collected from customers" / "Input VAT paid
 * to suppliers" into a set of annual financial statements — so contamination
 * here is a mis-statement in a signed document, not just a screen.
 *
 * Its exposure is narrower than the other readers and worth writing down: it
 * sums `debit` on vat_input and `credit` on vat_output only, and the clearing
 * entry posts on the OPPOSITE side of both (DR VAT Output, CR VAT Input) in
 * both the payable and the refundable case. So the forward clearing entry
 * misses it by direction — but `reverseJournalEntry` COPIES `source`, and a
 * reversed submission posts CR VAT Output / DR VAT Input, which lands squarely
 * in both FILTERs. A cancelled or re-filed return is exactly what produces one.
 *
 * This test WRITES, so it refuses to run against production. Every row goes
 * into a transaction that is always rolled back.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { als } from '@/lib/als';
import { isDbReachable } from '../../helpers/dbReachable';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';
import {
  ctxFor, inRolledBackTx, seedVatCompany, seedTradeVat,
  seedClearingEntry, seedClearingReversal, postEntry,
} from '../../helpers/vatControlFixture';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
// The fiscal calendar is resolved from company settings and has its own tests
// (tests/unit/services/afs/afsFiscalPeriod.test.ts). Mocking it here keeps
// these generator tests about the note CONTENT, and keeps the sql mock
// sequences below counting only the generator's own queries.
vi.mock('@/modules/accounting/services/afs/afsFiscalPeriod', () => ({
  getFiscalRange: vi.fn(async () => ({ start: '2026-01-01', end: '2026-12-31' })),
}));

import { noteTaxation } from '@/modules/accounting/services/reports/disclosureNoteGenerators';

const FISCAL_YEAR = 2026;

/** Pull one amount out of the note's rendered table (en-ZA thousands separators). */
function amount(
  note: Awaited<ReturnType<typeof noteTaxation>>, label: string,
): number {
  const row = note.tables?.[0]?.rows.find((r) => r[0]?.startsWith(label));
  expect(row, `row '${label}' missing`).toBeDefined();
  // en-ZA groups with a (non-breaking) space and uses a COMMA as the decimal
  // separator — stripping commas would multiply every figure by 100.
  return Number(row![1]!.replace(/[\s\u00A0\u202F]/g, '').replace(',', '.'));
}

describe('noteTaxation — V-05 excludes the VAT submission clearing journal', () => {
  let dbUp = false;
  beforeAll(async () => {
    dbUp = await isDbReachable();
    if (dbUp) assertNotProductionDb('This test inserts companies, GL accounts and journal entries.');
  });

  it('ignores a reversed clearing journal inside the fiscal year', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedVatCompany(client, 'note reversal');
      await seedTradeVat(client, f, '2026-01-15', '2026-01-20');
      await seedClearingEntry(client, f, '2026-02-28');
      // The reversal a cancelled or re-filed return produces. It carries the
      // same source and posts on the side this note actually sums.
      await seedClearingReversal(client, f, '2026-03-05');

      const note = await als.run(ctxFor(client, f.companyId), () =>
        noteTaxation(f.companyId, FISCAL_YEAR),
      );

      // Without the predicate the reversal doubles both figures (2000 / 600)
      // and the net stays 700 by luck — a statement that is wrong on every
      // line but the last.
      expect(amount(note, 'Output VAT')).toBeCloseTo(1000, 2);
      expect(amount(note, 'Input VAT')).toBeCloseTo(300, 2);
      expect(amount(note, 'Net VAT')).toBeCloseTo(700, 2);
    });
  });

  it('is unchanged by the forward clearing journal, which posts the other way', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedVatCompany(client, 'note forward');
      await seedTradeVat(client, f, '2026-01-15', '2026-01-20');
      await seedClearingEntry(client, f, '2026-02-28');

      const note = await als.run(ctxFor(client, f.companyId), () =>
        noteTaxation(f.companyId, FISCAL_YEAR),
      );

      // Documents the asymmetry the header explains: the forward settlement is
      // out of reach of these one-directional FILTERs. If this ever starts
      // failing, the clearing entry's shape has changed.
      expect(amount(note, 'Output VAT')).toBeCloseTo(1000, 2);
      expect(amount(note, 'Input VAT')).toBeCloseTo(300, 2);
    });
  });

  it('still counts auto_vat_adjustment, manual and NULL-source journals', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedVatCompany(client, 'note other sources');
      await seedTradeVat(client, f, '2026-01-15', '2026-01-20');
      await seedClearingReversal(client, f, '2026-03-05');

      // Same account, same direction, same NULL vat_type as the reversal above.
      // Only the source differs — so widening the predicate would swallow these.
      await postEntry(client, f.companyId, 'auto_vat_adjustment', '2026-04-10', [
        { accountId: f.vatOutputId, debit: 0, credit: 50, vatType: null },
        { accountId: f.contraId,    debit: 50, credit: 0 },
      ]);
      await postEntry(client, f.companyId, 'manual', '2026-04-11', [
        { accountId: f.vatInputId, debit: 20, credit: 0, vatType: null },
        { accountId: f.contraId,   debit: 0, credit: 20 },
      ]);
      // NULLABLE source: a plain `<>` would drop this row entirely.
      await postEntry(client, f.companyId, null, '2026-04-12', [
        { accountId: f.vatOutputId, debit: 0, credit: 5, vatType: null },
        { accountId: f.contraId,    debit: 5, credit: 0 },
      ]);

      const note = await als.run(ctxFor(client, f.companyId), () =>
        noteTaxation(f.companyId, FISCAL_YEAR),
      );

      expect(amount(note, 'Output VAT')).toBeCloseTo(1055, 2);  // 1000 + 50 + 5
      expect(amount(note, 'Input VAT')).toBeCloseTo(320, 2);    // 300 + 20
    });
  });

  it('does not reach outside the fiscal year', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedVatCompany(client, 'note year bound');
      await seedTradeVat(client, f, '2026-01-15', '2026-01-20');
      await postEntry(client, f.companyId, 'auto_invoice', '2027-01-15', [
        { accountId: f.vatOutputId, debit: 0, credit: 999, vatType: 'standard' },
        { accountId: f.contraId,    debit: 999, credit: 0 },
      ]);

      const note = await als.run(ctxFor(client, f.companyId), () =>
        noteTaxation(f.companyId, FISCAL_YEAR),
      );

      expect(amount(note, 'Output VAT')).toBeCloseTo(1000, 2);
    });
  });
});
