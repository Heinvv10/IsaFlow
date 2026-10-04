/**
 * D10: interleaving scenarios (d10-interleave) over `chainDoc` documents. One document, its chain reversed k times,
 * statement lines on the chosen positions, plus one FRESH 'imported' line of the same amount for MATCH; every flow that
 * takes the document, its journal or its lines out of the ledger; and the invariant the D10 brief states: the
 * document live iff its chain stands, the bill / invoice paid iff live, batch members follow the batch, and no
 * statement line matched once the document is out.
 */
import { sql } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { cancelCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { reverseBatch } from '@/modules/accounting/services/ap/batchPaymentReversal';
import { voidPaymentDocument } from '@/modules/accounting/services/core/paymentVoidService';
import { matchTransaction } from '@/modules/accounting/services/bank/bankTxStatusMutations';
import { reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { seedBankTx } from './helpers/l1FifoFixture';
import type { Ctx } from './d8-r4-helpers';
import { AMOUNT, bankLegOf, chainDoc, docState, type Side } from './d10-helpers';
import type { Scenario } from './d10-interleave';

type Row = Record<string, unknown>;
const LIVE: Record<Side, string[]> = { ap: ['processed', 'reconciled'], ar: ['confirmed', 'reconciled'], batch: ['processed'] };

export async function family(c: Ctx, side: Side, k: number, positions: number[]): Promise<Scenario> {
  const id = c.fx.companyId, u = c.fx.userId;
  const d = await chainDoc(c, side, k, positions);
  const head = d.chain[k]!;
  const free = await seedBankTx(c.fx, { date: '2026-05-20', amount: side === 'ar' ? AMOUNT : -AMOUNT, description: `D10F ${++c.seq}` });
  const mcp = async (kind: 'supplier' | 'customer') => {
    const r = await voidPaymentDocument(id, kind, d.payId, u);
    if ('refusal' in r) throw new Error(`MCP refusal ${JSON.stringify(r)}`);
    return r;
  };
  const flows: Scenario['flows'] = {
    GLREV: () => reverseJournalEntry(id, head, u),
    // A fresh line matched to the journal carrying the document now (the head while the chain stands).
    MATCH: async () => matchTransaction(id, free, await bankLegOf(c, k % 2 === 0 ? head : d.chain[0]!)),
  };
  const first = d.lines.values().next().value as string | undefined;
  if (first) flows.BANKREV = () => reverseReconciledTransaction(id, first, u);
  if (side === 'ap') Object.assign(flows, { HTTPV: () => voidSupplierPayment(id, d.payId, u), MCPV: () => mcp('supplier') });
  if (side === 'ar') Object.assign(flows, { RCPT: () => cancelCustomerPayment(id, d.payId, u), MCPV: () => mcp('customer') });
  if (side === 'batch') {
    Object.assign(flows, {
      BATCH: () => reverseBatch(id, d.docId, u),
      HTTPV_M: () => voidSupplierPayment(id, d.payId, u),
      MCPV_M: () => mcp('supplier'),
    });
  }
  return {
    flows,
    invariant: async () => {
      const s = await docState(c, d);
      const [fl] = (await sql`SELECT status FROM bank_transactions WHERE id = ${free}::UUID`) as Row[];
      const live = LIVE[side].includes(s.doc);
      const errs: string[] = [];
      if (s.chain === 'broken') errs.push('chain broken');
      if (live !== (s.chain === 'standing')) errs.push(`doc ${s.doc} but chain ${s.chain}`);
      if (s.paid !== (live ? AMOUNT : 0)) errs.push(`doc ${s.doc} but paid ${s.paid}`);
      if (s.member !== null && (s.member === 'processed') !== live) errs.push(`batch ${s.doc} but member ${s.member}`);
      for (const l of s.lines) {
        if (live !== (l.status !== 'imported')) errs.push(`doc ${s.doc} but line ${String(l.id).slice(0, 8)} ${String(l.status)}`);
      }
      if (!live && fl?.status !== 'imported') errs.push(`doc ${s.doc} but the fresh line is ${String(fl?.status)}`);
      return errs.length ? errs.join('; ') : null;
    },
  };
}
