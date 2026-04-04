/**
 * VAT201 Summary view — SARS form box layout.
 */

import { formatDate } from '@/utils/formatters';
import { FormRow } from './VAT201FormSections';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

interface VAT201Data {
  periodStart: string;
  periodEnd: string;
  field1_standardRatedSupplies: number;
  field2_zeroRatedSupplies: number;
  field3_exemptSupplies: number;
  field4_totalImports: number;
  field5_outputVAT: number;
  field6_capitalGoods: number;
  field7_otherGoods: number;
  field8_services: number;
  field9_imports: number;
  field10_totalInputVAT: number;
  field11_vatPayableOrRefundable: number;
}

interface Props {
  data: VAT201Data;
}

export function VAT201SummaryForm({ data }: Props) {
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
      <div className="px-4 py-3 border-b border-[var(--ff-border-light)]">
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
          VAT201 — {formatDate(data.periodStart)} to {formatDate(data.periodEnd)}
        </h2>
      </div>
      <div className="divide-y divide-[var(--ff-border-light)]">
        <div className="px-4 py-2 bg-teal-500/5">
          <p className="text-xs font-semibold text-teal-500 uppercase tracking-wider">Output VAT (Sales)</p>
        </div>
        <FormRow field="1" label="Standard-rated supplies (15%)" amount={data.field1_standardRatedSupplies} />
        <FormRow field="2" label="Zero-rated supplies" amount={data.field2_zeroRatedSupplies} />
        <FormRow field="3" label="Exempt supplies" amount={data.field3_exemptSupplies} />
        <FormRow field="4" label="Total imports" amount={data.field4_totalImports} />
        <FormRow field="5" label="Output VAT (Field 1 x 15%)" amount={data.field5_outputVAT} highlight />
        <div className="px-4 py-2 bg-blue-500/5">
          <p className="text-xs font-semibold text-blue-500 uppercase tracking-wider">Input VAT (Purchases)</p>
        </div>
        <FormRow field="6" label="Capital goods" amount={data.field6_capitalGoods} />
        <FormRow field="7" label="Other goods" amount={data.field7_otherGoods} />
        <FormRow field="8" label="Services" amount={data.field8_services} />
        <FormRow field="9" label="Imports" amount={data.field9_imports} />
        <FormRow field="10" label="Total input VAT" amount={data.field10_totalInputVAT} highlight />
        <div className="px-4 py-2 bg-[var(--ff-bg-primary)]">
          <p className="text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">Result</p>
        </div>
        <div className="px-4 py-3 flex items-center justify-between bg-[var(--ff-bg-primary)]/50">
          <div className="flex items-center gap-3">
            <span className="text-sm font-mono text-[var(--ff-text-tertiary)] w-8">11</span>
            <span className="text-sm font-semibold text-[var(--ff-text-primary)]">
              {data.field11_vatPayableOrRefundable >= 0 ? 'VAT Payable to SARS' : 'VAT Refundable from SARS'}
            </span>
          </div>
          <span className={`text-lg font-bold ${data.field11_vatPayableOrRefundable >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>
            {fmt(Math.abs(data.field11_vatPayableOrRefundable))}
          </span>
        </div>
      </div>
    </div>
  );
}
