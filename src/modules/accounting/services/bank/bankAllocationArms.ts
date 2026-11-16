/**
 * allocateTransaction's journal lines, one arm per allocation type: transfer, supplier (payment /
 * refund), customer (receipt / refund) and account (everything else, including a supplier/customer
 * call that names no contact). Moved verbatim out of bankAllocationService.ts (its line cap); every
 * refusal here still runs before allocateTransaction's first write.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import { resolveVatAccountId } from './bankVatAccountResolver';
import { isBankSubtype } from '../gl/accountSubtypes';
import type { JournalLineInput } from '../../types/gl.types';
import { planSupplierRefund } from '../ap/supplierRefundDocument';
import { planCustomerRefund } from '../ar/customerRefundDocument';
import { BankAllocationRefusal } from './bankAllocationRefusal';
import { isBankEvidenced } from '../ap/bankLinePaymentGate';
import { assertNoDuplicateTransfer } from './transferDuplicateGuard';
import type { AllocationType } from './bankAllocationTypes';
import type { AllocationPlan } from './bankAllocationPlan';

type Row = DbRow;

export interface AllocationArmInput {
  companyId: string; tx: Row; allocType: AllocationType; contraAccountId: string | null; entityId?: string;
  description?: string; bankAccountId: string; totalAmount: number; txDate: string; isSpent: boolean;
  plan: AllocationPlan;
}

export interface AllocationArm {
  lines: JournalLineInput[];
  source: import('../../types/gl.types').GLEntrySource;
  entryDesc: string;
  allocEntityName: string | null;
  counterpartyAccountId: string | null;
}

export async function buildAllocationArm(input: AllocationArmInput): Promise<AllocationArm> {
  const {
    companyId, tx, allocType, contraAccountId, entityId, description, bankAccountId, totalAmount, txDate, isSpent,
  } = input;
  const { contraRows, hasVat, vatRate, netAmount, vatAmount, vatAccountKey, mapVatType } = input.plan;

  let lines: JournalLineInput[];
  let source: import('../../types/gl.types').GLEntrySource;
  let entryDesc = '';
  let allocEntityName: string | null = null;
  let counterpartyAccountId: string | null = null;

  if (allocType === 'transfer') {
    if (!contraAccountId) throw new BankAllocationRefusal('contraAccountId is required for transfer allocation (counterparty bank account)');
    if (contraAccountId === bankAccountId) throw new BankAllocationRefusal('Transfer source and destination bank accounts must differ');

    const cpRows = (await sql`
      SELECT account_code, account_name, account_subtype FROM gl_accounts
      WHERE id = ${contraAccountId}::UUID AND company_id = ${companyId}::UUID
    `) as Row[];
    if (cpRows.length === 0) throw new BankAllocationRefusal('Counterparty bank account not found');
    const cp = cpRows[0]!;
    if (!isBankSubtype(cp.account_subtype == null ? null : String(cp.account_subtype))) {
      throw new BankAllocationRefusal('Transfer counterparty must be a bank account (subtype = bank)');
    }

    // The same movement already in the ledger (the other bank's line, or a Banking > Transfers journal): refused.
    await assertNoDuplicateTransfer(companyId, bankAccountId, contraAccountId, Number(tx.amount), txDate,
      isBankEvidenced(tx));

    counterpartyAccountId = contraAccountId;
    allocEntityName = `${String(cp.account_code)} ${String(cp.account_name)}`;
    entryDesc = description || `Transfer: ${isSpent ? 'to' : 'from'} ${allocEntityName}`;
    source = 'auto_bank_transfer';

    // isSpent (outflow on this bank) → DR counterparty, CR this bank.
    // deposit (inflow on this bank) → DR this bank, CR counterparty.
    if (isSpent) {
      lines = [
        { glAccountId: contraAccountId, debit: totalAmount, credit: 0, description: entryDesc },
        { glAccountId: bankAccountId, debit: 0, credit: totalAmount, description: entryDesc },
      ];
    } else {
      lines = [
        { glAccountId: bankAccountId, debit: totalAmount, credit: 0, description: entryDesc },
        { glAccountId: contraAccountId, debit: 0, credit: totalAmount, description: entryDesc },
      ];
    }
  } else if (allocType === 'supplier' && entityId) {
    const apAccountId = await getSystemAccountId('payable', companyId);
    const supRows = (await sql`SELECT name FROM suppliers WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
    const supName = supRows.length > 0 ? String(supRows[0]!.name) : `Supplier #${entityId}`;
    allocEntityName = supName;
    entryDesc = description || (isSpent ? `Payment to ${supName}` : `Refund from ${supName}`);
    source = 'auto_supplier_payment';
    // THE REFUND CEILING, DECIDED HERE AND NOT LOWER DOWN.
    //
    // A money-IN line against a supplier mints a refund document below, and a
    // refund cannot exceed the credit the supplier is holding — see
    // ap/supplierRefundDocument. This runs BEFORE `createJournalEntry`, which
    // is the first write on this path, because `withAuth` COMMITs on a 4xx and
    // rolls back only on a 5xx: a business refusal raised after the journal has
    // posted can only be answered by committing an orphan journal or by telling
    // the user an internal error occurred. Refused here there is nothing
    // written to unwind, and `BankAllocationRefusal` is the class the routes
    // already answer 400.
    if (!isSpent) await planSupplierRefund(companyId, entityId, totalAmount, txDate);
    // isSpent (money out) → a payment: DR AP, CR Bank.
    // deposit (money in)  → a refund:  DR Bank, CR AP.
    //
    // This branch ignored `isSpent` and always posted the payment direction, so
    // a refund credited the bank that the statement says was debited and the
    // account finished wrong by TWICE the line. Nothing failed: the call
    // returned success and the row read as allocated. R261,651.64 on Velocity
    // Fibre, found only by diffing the GL against the bank on signed amount.
    if (isSpent) {
      lines = [
        { glAccountId: apAccountId, debit: netAmount, credit: 0, description: entryDesc, vatType: mapVatType },
        { glAccountId: bankAccountId, debit: 0, credit: totalAmount, description: entryDesc },
      ];
      if (hasVat) {
        const vatAcctId = await resolveVatAccountId(vatAccountKey, companyId);
        lines.splice(1, 0, { glAccountId: vatAcctId, debit: vatAmount, credit: 0, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
      }
    } else {
      lines = [
        { glAccountId: bankAccountId, debit: totalAmount, credit: 0, description: entryDesc },
        { glAccountId: apAccountId, debit: 0, credit: netAmount, description: entryDesc, vatType: mapVatType },
      ];
      if (hasVat) {
        const vatAcctId = await resolveVatAccountId(vatAccountKey, companyId);
        lines.push({ glAccountId: vatAcctId, debit: 0, credit: vatAmount, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
      }
    }
  } else if (allocType === 'customer' && entityId) {

    const arAccountId = await getSystemAccountId('receivable', companyId);
    const custRows = (await sql`SELECT name FROM customers WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
    const custName = custRows.length > 0 ? String(custRows[0]!.name) : `Customer #${entityId}`;
    allocEntityName = custName;
    entryDesc = description || (isSpent ? `Refund to ${custName}` : `Receipt from ${custName}`);
    source = 'auto_payment';
    // The mirror of the supplier arm's ceiling, and decided in the same place
    // and for the same reason: before `createJournalEntry`, which is the first
    // write on this path. See the note there.
    if (isSpent) await planCustomerRefund(companyId, entityId, totalAmount, txDate);
    // The mirror of the supplier arm, and it carried the mirror bug with no
    // occurrence yet: money OUT against a customer is a refund — DR AR, CR Bank
    // — and posting the receipt direction moved the bank the wrong way by twice
    // in exactly the same silence.
    if (isSpent) {
      lines = [
        { glAccountId: arAccountId, debit: netAmount, credit: 0, description: entryDesc, vatType: mapVatType },
        { glAccountId: bankAccountId, debit: 0, credit: totalAmount, description: entryDesc },
      ];
      if (hasVat) {
        const vatAcctId = await resolveVatAccountId(vatAccountKey, companyId);
        lines.splice(1, 0, { glAccountId: vatAcctId, debit: vatAmount, credit: 0, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
      }
    } else {
      lines = [
        { glAccountId: bankAccountId, debit: totalAmount, credit: 0, description: entryDesc },
        { glAccountId: arAccountId, debit: 0, credit: netAmount, description: entryDesc, vatType: mapVatType },
      ];
      if (hasVat) {
        const vatAcctId = await resolveVatAccountId(vatAccountKey, companyId);
        lines.push({ glAccountId: vatAcctId, debit: 0, credit: vatAmount, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
      }
    }
  } else {
    if (!contraAccountId) throw new Error('contraAccountId is required for account allocation');
    allocEntityName = contraRows.length > 0
      ? `${String(contraRows[0]!.account_code)} ${String(contraRows[0]!.account_name)}` : null;
    entryDesc = description || String(tx.description || 'Bank allocation');
    source = 'auto_bank_recon';
    if (!isSpent) {
      lines = [
        { glAccountId: bankAccountId, debit: totalAmount, credit: 0, description: entryDesc },
        { glAccountId: contraAccountId, debit: 0, credit: netAmount, description: entryDesc, vatType: mapVatType },
      ];
      if (hasVat) {
        const vatAcctId = await resolveVatAccountId(vatAccountKey, companyId);
        lines.push({ glAccountId: vatAcctId, debit: 0, credit: vatAmount, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
      }
    } else {
      lines = [{ glAccountId: contraAccountId, debit: netAmount, credit: 0, description: entryDesc, vatType: mapVatType }];
      if (hasVat) {
        const vatAcctId = await resolveVatAccountId(vatAccountKey, companyId);
        lines.push({ glAccountId: vatAcctId, debit: vatAmount, credit: 0, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
      }
      lines.push({ glAccountId: bankAccountId, debit: 0, credit: totalAmount, description: entryDesc });
    }
  }

  return { lines, source, entryDesc, allocEntityName, counterpartyAccountId };
}
