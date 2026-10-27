/**
 * The VAT, CC1, CC2 and BU cells of a bank transaction row. A new row gets selects; an allocated
 * row shows what the posted journal carries.
 */

import {
  NON_SUPPLY_ADVICE, NON_SUPPLY_LABEL, shouldWarnOnNonSupply,
} from '@/modules/accounting/services/gl/nonSupplyAccounts';
import { formatMoney } from '@/lib/money/formatMoney';
import { DimensionValue } from '../bank-transactions/BankTxDimensionValue';
import { VAT_OPTIONS, type AllocType, type BankTx, type BankTxTableProps, type RowSelection, type VatCode } from './bankTxTypes';
import { getOptionsForType } from './bankTxOptions';

function fmtCurrency(n: number): string {
  return formatMoney(n);
}

interface Props {
  tx: BankTx;
  sel: RowSelection | undefined;
  rowType: AllocType;
  isNew: boolean;
  table: BankTxTableProps;
}

export function BankTxDimensionCells({ tx, sel, rowType, isNew, table }: Props) {
  const { cc1Options, cc2Options, buOptions, showCC, showBU, onRowVatChange, onRowDimensionChange } = table;
  // s17(2)(a) denies input tax on entertainment — but its proviso
  // lets a vendor who continuously supplies entertainment claim it,
  // and only the user knows whether that is them. So this WARNS and
  // leaves the choice alone. The unattended rule sweep is the only
  // path that overrides.
  const vatDenied = rowType === 'account' && !!sel?.entityId
    && getOptionsForType('account', table).find(o => o.id === sel.entityId)?.vatInputDenied === true;
  const vatWarn = vatDenied && (sel?.vatCode || 'none') === 'standard';
  // Second guard, different statute: no supply arises on this
  // account at all. Classified on NAME, in the browser, from the
  // same pure module the report and the posting guard use — so a
  // pattern change cannot make the screen and the ledger disagree.
  const nonSupply = rowType === 'account' && !!sel?.entityId
    ? shouldWarnOnNonSupply(
        getOptionsForType('account', table).find(o => o.id === sel.entityId)?.name,
        sel?.vatCode,
      )
    : null;

  return (
    <>
      <td className="py-2 px-2">
        {sel?.type === 'supplier' || sel?.type === 'customer' || sel?.type === 'transfer' ? (
          <span className="text-xs text-[var(--ff-text-tertiary)] italic">N/A</span>
        ) : isNew ? (
          <>
            <select
              value={sel?.vatCode || 'none'}
              onChange={e => onRowVatChange(tx.id, e.target.value as VatCode)}
              className={`text-xs px-1 py-0.5 rounded bg-[var(--ff-bg-primary)] w-full ${
                vatWarn
                  ? 'border border-amber-500 text-amber-500'
                  : `border border-[var(--ff-border-light)] ${
                    (sel?.vatCode || 'none') === 'standard'
                      ? 'text-cyan-400' : 'text-[var(--ff-text-primary)]'}`
              }`}
            >
              {VAT_OPTIONS.map(v => (
                <option key={v.value} value={v.value}>{v.label}</option>
              ))}
            </select>
            {vatWarn && (
              <span
                className="mt-0.5 block text-xs leading-tight text-amber-500"
                title="VAT Act s17(2)(a). Claim it only if this business continuously supplies entertainment for a charge."
              >
                ⚠ Entertainment — input tax normally denied
              </span>
            )}
            {!vatWarn && nonSupply && (
              <span
                className="mt-0.5 block text-xs leading-tight text-amber-500"
                title={NON_SUPPLY_ADVICE[nonSupply]}
              >
                ⚠ {NON_SUPPLY_LABEL[nonSupply]} — no supply, so no VAT
              </span>
            )}
          </>
        ) : (
          // Allocated row: report what the JOURNAL did, never the
          // row's suggestion — that is cleared on allocation and
          // fell through to "No VAT" over a 15% claim.
          <span
            className={`text-xs ${tx.postedVatCode === 'standard'
              ? 'text-cyan-400' : 'text-[var(--ff-text-tertiary)]'}`}
            title={tx.postedVatAmount
              ? `VAT posted: ${fmtCurrency(tx.postedVatAmount)}` : undefined}
          >
            {VAT_OPTIONS.find(v => v.value === (tx.postedVatCode || 'none'))?.label || 'No VAT'}
          </span>
        )}
      </td>
      {/* CC1 */}
      {showCC && (
      <td className="py-2 px-2">
        {isNew ? (
          <select value={sel?.cc1Id || ''} onChange={e => onRowDimensionChange(tx.id, e.target.value, sel?.cc2Id || '', sel?.buId || '')}
            className="text-xs px-1 py-0.5 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] w-full text-[var(--ff-text-primary)]">
            <option value="">—</option>
            {cc1Options.map(o => <option key={o.id} value={o.id}>{o.code ? `${o.code} ${o.name}` : o.name}</option>)}
          </select>
        ) : (
          <DimensionValue code={tx.cc1Code} name={tx.cc1Name} source={tx.dimensionSource} />
        )}
      </td>
      )}
      {/* CC2 */}
      {showCC && (
      <td className="py-2 px-2">
        {isNew ? (
          <select value={sel?.cc2Id || ''} onChange={e => onRowDimensionChange(tx.id, sel?.cc1Id || '', e.target.value, sel?.buId || '')}
            className="text-xs px-1 py-0.5 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] w-full text-[var(--ff-text-primary)]">
            <option value="">—</option>
            {cc2Options.map(o => <option key={o.id} value={o.id}>{o.code ? `${o.code} ${o.name}` : o.name}</option>)}
          </select>
        ) : (
          <DimensionValue code={tx.cc2Code} name={tx.cc2Name} source={tx.dimensionSource} />
        )}
      </td>
      )}
      {/* BU */}
      {showBU && (
      <td className="py-2 px-2">
        {isNew ? (
          <select value={sel?.buId || ''} onChange={e => onRowDimensionChange(tx.id, sel?.cc1Id || '', sel?.cc2Id || '', e.target.value)}
            className="text-xs px-1 py-0.5 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] w-full text-[var(--ff-text-primary)]">
            <option value="">—</option>
            {buOptions.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        ) : (
          <DimensionValue code={tx.buCode} name={tx.buName} source={tx.dimensionSource} />
        )}
      </td>
      )}
    </>
  );
}
