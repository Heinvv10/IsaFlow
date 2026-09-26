/**
 * Against a real ledger: the two 2026-09-26 gaps.
 *
 * 1. vatGateOverrideService.assertVatGateClear — blocking exceptions refuse
 *    unless an owner/admin supplies a reason, which is recorded
 *    (vat_gate_overrides, migration 704) with a snapshot of the counts.
 * 2. vatDeclaredElsewhereService.mark/unmarkVatDeclaredElsewhere — moves a
 *    document between the BLOCKING unposted list and the non-blocking
 *    "declared elsewhere" list, WITHOUT touching a VAT201 field.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import {
  assertVatGateClear, VatGateBlockedError, VatGateOverrideForbiddenError,
} from '@/modules/accounting/services/reports/vatGateOverrideService';
import {
  markVatDeclaredElsewhere, unmarkVatDeclaredElsewhere, VatDeclaredElsewhereRefusal,
} from '@/modules/accounting/services/reports/vatDeclaredElsewhereService';
import { getLedgerVAT201 } from '@/modules/accounting/services/reports/vat201LedgerFields';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, seedInvoice, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: Fixture;
let invoice = '';
const PERIOD = { start: '2026-05-01', end: '2026-06-30' };
const report = () => inTx(fx, () => getVatExceptions(fx.companyId, PERIOD.start, PERIOD.end));

describeIfDb('VAT gate override + declared-elsewhere, against a real ledger', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds an invoice and writes vat_gate_overrides / vat_declared_elsewhere_*.');
    fx = await seedFixture('VGDE', DATABASE_URL!);
    // A real users row: markVatDeclaredElsewhere's audit log has an FK to it.
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${fx.userId}, ${`vgde-${fx.userId}@isaflow.test`}, 'admin', true)`;
    invoice = await seedInvoice(fx, { number: 'INV-VGDE', date: '2026-05-05', total: 1150, status: 'sent' });
    await sql`UPDATE customer_invoices SET subtotal = 1000, tax_rate = 15, tax_amount = 150, total_amount = 1150
      WHERE id = ${invoice}::UUID AND company_id = ${fx.companyId}::UUID`;
  }, 180000);

  afterAll(async () => {
    if (fx) {
      await sql`DELETE FROM audit_log WHERE company_id = ${fx.companyId}::UUID`;
      await sql`DELETE FROM vat_gate_overrides WHERE company_id = ${fx.companyId}::UUID`;
      await sql`DELETE FROM users WHERE id = ${fx.userId}`;
      await dropFixture(fx);
    }
  }, 120000);

  it('blocking exceptions are present (the unposted invoice) before any gate/mark call', async () => {
    const r = await report();
    expect(r.unpostedInvoiceVatCount).toBe(1);
    expect(r.totalExceptions).toBeGreaterThan(0);
  });

  describe('assertVatGateClear', () => {
    it('refuses with no override, and writes nothing', async () => {
      const before = ((await sql`SELECT COUNT(*)::INT AS n FROM vat_gate_overrides WHERE company_id = ${fx.companyId}::UUID`) as Row[])[0]!.n;
      await expect(inTx(fx, () => assertVatGateClear(
        fx.companyId, PERIOD.start, PERIOD.end, 'vat_period_lock', null, { userId: fx.userId, role: 'viewer' }, undefined,
      ))).rejects.toBeInstanceOf(VatGateBlockedError);
      const after = ((await sql`SELECT COUNT(*)::INT AS n FROM vat_gate_overrides WHERE company_id = ${fx.companyId}::UUID`) as Row[])[0]!.n;
      expect(after).toBe(before);
    });

    it('refuses a non-owner/admin override with a reason, and writes nothing', async () => {
      const before = ((await sql`SELECT COUNT(*)::INT AS n FROM vat_gate_overrides WHERE company_id = ${fx.companyId}::UUID`) as Row[])[0]!.n;
      await expect(inTx(fx, () => assertVatGateClear(
        fx.companyId, PERIOD.start, PERIOD.end, 'vat_period_lock', null, { userId: fx.userId, role: 'manager' }, 'I checked it',
      ))).rejects.toBeInstanceOf(VatGateOverrideForbiddenError);
      const after = ((await sql`SELECT COUNT(*)::INT AS n FROM vat_gate_overrides WHERE company_id = ${fx.companyId}::UUID`) as Row[])[0]!.n;
      expect(after).toBe(before);
    });

    it('an owner override records the row with the exception snapshot', async () => {
      const result = await inTx(fx, () => assertVatGateClear(
        fx.companyId, PERIOD.start, PERIOD.end, 'vat_period_lock', null,
        { userId: fx.userId, role: 'owner' }, 'Filed manually outside IsaFlow this quarter',
      ));
      expect(result.overridden).toBe(true);
      const rows = (await sql`SELECT * FROM vat_gate_overrides WHERE company_id = ${fx.companyId}::UUID
        AND period_start = ${PERIOD.start}::DATE AND period_end = ${PERIOD.end}::DATE`) as Row[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe(fx.userId);
      expect(rows[0]!.reason).toBe('Filed manually outside IsaFlow this quarter');
      expect((rows[0]!.exception_snapshot as { totalExceptions: number }).totalExceptions).toBe(result.counts.totalExceptions);
    });
  });

  describe('markVatDeclaredElsewhere / unmarkVatDeclaredElsewhere', () => {
    it('refuses a non-owner/admin actor, writing nothing', async () => {
      await expect(inTx(fx, () => markVatDeclaredElsewhere(
        fx.companyId, 'customer', invoice, { userId: fx.userId, role: 'manager' }, 'reason',
      ))).rejects.toThrow();
      const row = ((await sql`SELECT vat_declared_elsewhere_at FROM customer_invoices WHERE id = ${invoice}::UUID`) as Row[])[0]!;
      expect(row.vat_declared_elsewhere_at).toBeNull();
    });

    it('refuses another company\'s invoice id (no cross-tenant existence oracle)', async () => {
      const other = await seedFixture('VGDE2', DATABASE_URL!);
      try {
        await expect(inTx(fx, () => markVatDeclaredElsewhere(
          other.companyId, 'customer', invoice, { userId: fx.userId, role: 'owner' }, 'reason',
        ))).rejects.toBeInstanceOf(VatDeclaredElsewhereRefusal);
      } finally {
        await dropFixture(other);
      }
    });

    it('mark clears the block, VAT201 fields are unchanged, and unmark restores it', async () => {
      const before = await inTx(fx, () => getLedgerVAT201(fx.companyId, PERIOD.start, PERIOD.end));
      const blockedBefore = await report();
      expect(blockedBefore.unpostedInvoiceVat.map((u) => u.invoiceId)).toContain(invoice);

      await inTx(fx, () => markVatDeclaredElsewhere(fx.companyId, 'customer', invoice, { userId: fx.userId, role: 'owner' }, 'Historical import'));

      const afterMark = await report();
      expect(afterMark.unpostedInvoiceVat.map((u) => u.invoiceId)).not.toContain(invoice);
      expect(afterMark.declaredElsewhereVat.map((d) => d.invoiceId)).toContain(invoice);
      expect(afterMark.declaredElsewhereVat.find((d) => d.invoiceId === invoice)?.markedReason).toBe('Historical import');

      const afterMarkLedger = await inTx(fx, () => getLedgerVAT201(fx.companyId, PERIOD.start, PERIOD.end));
      expect(afterMarkLedger.field5_outputVAT).toBe(before.field5_outputVAT);
      expect(afterMarkLedger.field10_totalInputVAT).toBe(before.field10_totalInputVAT);

      await inTx(fx, () => unmarkVatDeclaredElsewhere(fx.companyId, 'customer', invoice, { userId: fx.userId, role: 'admin' }, 'Reopen'));

      const afterUnmark = await report();
      expect(afterUnmark.unpostedInvoiceVat.map((u) => u.invoiceId)).toContain(invoice);
      expect(afterUnmark.declaredElsewhereVat.map((d) => d.invoiceId)).not.toContain(invoice);
    });
  });
});
