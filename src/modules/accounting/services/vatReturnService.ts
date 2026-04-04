/**
 * VAT Return Report Service
 * Generates GL-based VAT201 return with box breakdown and drill-down from journal lines.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { VATReturnReport } from '../types/gl.types';

type Row = Record<string, unknown>;

interface VAT201BoxDef {
  box: string;
  label: string;
  accountType: 'liability' | 'asset';
  vatTypes: string[];
}

const OUTPUT_BOXES: VAT201BoxDef[] = [
  { box: '1',   label: 'Standard rated supplies',           accountType: 'liability', vatTypes: ['standard'] },
  { box: '1A',  label: 'Capital goods/services supplied',   accountType: 'liability', vatTypes: ['capital_goods'] },
  { box: '2',   label: 'Zero-rated supplies (domestic)',    accountType: 'liability', vatTypes: ['zero_rated'] },
  { box: '2A',  label: 'Zero-rated exports',                accountType: 'liability', vatTypes: ['export'] },
  { box: '3',   label: 'Exempt supplies',                   accountType: 'liability', vatTypes: ['exempt'] },
  { box: '12',  label: 'Imported services / other output',  accountType: 'liability', vatTypes: ['reverse_charge', 'imported'] },
];

const INPUT_BOXES: VAT201BoxDef[] = [
  { box: '14',      label: 'Capital goods/services purchased', accountType: 'asset', vatTypes: ['capital_goods'] },
  { box: '15',      label: 'Other goods/services purchased',   accountType: 'asset', vatTypes: ['standard'] },
  { box: '14A/15A', label: 'Goods imported',                   accountType: 'asset', vatTypes: ['imported'] },
  { box: '16',      label: 'Change in use',                    accountType: 'asset', vatTypes: ['reverse_charge'] },
  { box: '17',      label: 'Bad debts',                        accountType: 'asset', vatTypes: ['bad_debt'] },
  { box: '18',      label: 'Other adjustments',                accountType: 'asset', vatTypes: ['exempt', 'no_vat'] },
];

interface VATDrillDown {
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  description: string;
  sourceDocument?: string;
  amount: number;
}

interface PopulatedBox {
  box: string;
  label: string;
  amount: number;
  transactions: VATDrillDown[];
}

export async function getVATReturn(companyId: string,
  periodStart: string,
  periodEnd: string
): Promise<VATReturnReport> {
  try {
    const vatLines = (await sql`
      SELECT
        jl.id              AS line_id,
        jl.gl_account_id,
        jl.debit,
        jl.credit,
        jl.vat_type,
        jl.description     AS line_description,
        je.id              AS journal_entry_id,
        je.entry_number,
        je.entry_date,
        je.description     AS entry_description,
        je.source_document_id,
        ga.account_code,
        ga.account_name,
        ga.account_type,
        ga.account_subtype
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga        ON ga.id  = jl.gl_account_id
      WHERE je.status = 'posted'
        AND je.company_id = ${companyId}::UUID
        AND je.entry_date >= ${periodStart}
        AND je.entry_date <= ${periodEnd}
        AND (
          ga.account_subtype IN ('vat_input', 'vat_output', 'tax')
        )
      ORDER BY je.entry_date, je.entry_number
    `) as Row[];

    const toDrillDown = (l: Row, signFn: (debit: number, credit: number) => number): VATDrillDown => ({
      journalEntryId: String(l.journal_entry_id),
      entryNumber:    String(l.entry_number),
      entryDate:      String(l.entry_date),
      description:    l.entry_description
        ? String(l.entry_description)
        : l.line_description ? String(l.line_description) : '',
      sourceDocument: l.source_document_id ? String(l.source_document_id) : undefined,
      amount: signFn(Number(l.debit), Number(l.credit)),
    });

    const outputBoxes: PopulatedBox[] = OUTPUT_BOXES.map((boxDef) => {
      const matching = vatLines.filter((l: Row) => {
        const isOutput = String(l.account_type) === 'liability' || String(l.account_subtype) === 'vat_output';
        const matchesType = l.vat_type != null && boxDef.vatTypes.includes(String(l.vat_type));
        return isOutput && matchesType;
      });
      const transactions = matching.map((l: Row) => toDrillDown(l, (d, c) => c - d));
      const amount = transactions.reduce((s, t) => s + t.amount, 0);
      return { box: boxDef.box, label: boxDef.label, amount, transactions };
    });

    const unclassifiedOutput = vatLines.filter((l: Row) => {
      const isOutput = String(l.account_type) === 'liability' || String(l.account_subtype) === 'vat_output';
      return isOutput && l.vat_type == null;
    });
    if (unclassifiedOutput.length > 0) {
      const box1 = outputBoxes.find((b) => b.box === '1');
      if (box1) {
        const extra = unclassifiedOutput.map((l: Row) => toDrillDown(l, (d, c) => c - d));
        box1.amount += extra.reduce((s, t) => s + t.amount, 0);
        box1.transactions.push(...extra);
      }
    }

    const inputBoxes: PopulatedBox[] = INPUT_BOXES.map((boxDef) => {
      const matching = vatLines.filter((l: Row) => {
        const isInput = String(l.account_type) === 'asset' || String(l.account_subtype) === 'vat_input';
        const matchesType = l.vat_type != null && boxDef.vatTypes.includes(String(l.vat_type));
        return isInput && matchesType;
      });
      const transactions = matching.map((l: Row) => toDrillDown(l, (d, c) => d - c));
      const amount = transactions.reduce((s, t) => s + t.amount, 0);
      return { box: boxDef.box, label: boxDef.label, amount, transactions };
    });

    const unclassifiedInput = vatLines.filter((l: Row) => {
      const isInput = String(l.account_type) === 'asset' || String(l.account_subtype) === 'vat_input';
      return isInput && l.vat_type == null;
    });
    if (unclassifiedInput.length > 0) {
      const box15 = inputBoxes.find((b) => b.box === '15');
      if (box15) {
        const extra = unclassifiedInput.map((l: Row) => toDrillDown(l, (d, c) => d - c));
        box15.amount += extra.reduce((s, t) => s + t.amount, 0);
        box15.transactions.push(...extra);
      }
    }

    const totalOutputTax = outputBoxes.reduce((s, b) => s + b.amount, 0);
    const totalInputTax  = inputBoxes.reduce((s, b) => s + b.amount, 0);
    const netVAT         = totalOutputTax - totalInputTax;

    const outputDetails = outputBoxes
      .filter((b) => Math.abs(b.amount) > 0.001)
      .map((b) => ({ accountCode: b.box, accountName: b.label, amount: b.amount }));
    const inputDetails = inputBoxes
      .filter((b) => Math.abs(b.amount) > 0.001)
      .map((b) => ({ accountCode: b.box, accountName: b.label, amount: b.amount }));

    return {
      periodStart, periodEnd,
      outputBoxes, totalOutputTax,
      inputBoxes, totalInputTax, netVAT,
      outputVAT: totalOutputTax,
      inputVAT:  totalInputTax,
      outputDetails, inputDetails,
    };
  } catch (err) {
    log.error('Failed to generate VAT return', { error: err }, 'accounting');
    throw err;
  }
}
