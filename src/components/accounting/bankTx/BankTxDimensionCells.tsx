/**
 * The VAT, CC1, CC2 and BU cells of a bank transaction row. A new row gets selects; an allocated
 * row shows what the posted journal carries.
 */

import {
  NON_SUPPLY_ADVICE, NON_SUPPLY_LABEL, shouldWarnOnNonSupply,
} from '@/modules/accounting/services/gl/nonSupplyAccounts';
import { useMemo } from 'react';
import { formatMoney } from '@/lib/money/formatMoney';
import { Select, type SelectOption as KitOption } from '@/components/ui/Select';
import { DimensionValue } from '../bank-transactions/BankTxDimensionValue';
import { VAT_OPTIONS, type AllocType, type BankTx, type BankTxTableProps, type RowSelection, type SelectOption, type VatCode } from './bankTxTypes';
import { getOptionsForType } from './bankTxOptions';

/** The "no dimension" row, stored as ''. */
const NONE = '__none__';
const VAT_KIT_OPTIONS: KitOption[] = VAT_OPTIONS.map(v => ({ value: v.value, label: v.label }));

function dimensionOptions(opts: SelectOption[], withCode: boolean): KitOption[] {
  return [{ value: NONE, label: '—' }, ...opts.map(o => ({ value: o.id, label: withCode && o.code ? `${o.code} ${o.name}` : o.name }))];
}
const fromKit = (v: string | null): string => (v === null || v === NONE ? '' : v);
const toKit = (v: string | undefined): string => v || NONE;

/**
 * A stored id the active-only options lack (deactivated after the row was tagged) is still posted on accept, so the
 * trigger shows it: by the code and name the row carries for that same id, else as an inactive dimension.
 */
function storedOption(
  id: string | undefined, opts: KitOption[], fallback: string, rowId?: string, code?: string, name?: string,
): KitOption | null {
  if (!id || opts.some(o => o.value === id)) return null;
  const label = id === rowId && name ? (code ? `${code} ${name}` : name) : fallback;
  return { value: id, label };
}

/** The trigger's amber (a warning) or cyan (input tax claimed) state, painted from its cell. */
function vatClass(warn: boolean, standard: boolean): string {
  if (warn) return '[&_[role=combobox]]:!border-amber-500 [&_[role=combobox]]:!text-amber-700 dark:[&_[role=combobox]]:!text-amber-500';
  return standard ? '[&_[role=combobox]]:!text-cyan-700 dark:[&_[role=combobox]]:!text-cyan-400' : '';
}

function fmtCurrency(n: number): string {
  return formatMoney(n);
}

interface Props {
  tx: BankTx;
  sel: RowSelection | undefined;
  rowType: AllocType;
  isNew: boolean;
  /** rowLabel(tx), for the accessible names. */
  label: string;
  table: BankTxTableProps;
}

export function BankTxDimensionCells({ tx, sel, rowType, isNew, label, table }: Props) {
  const { cc1Options, cc2Options, buOptions, showCC, showBU, onRowVatChange, onRowDimensionChange } = table;
  const cc1Kit = useMemo(() => dimensionOptions(cc1Options, true), [cc1Options]);
  const cc2Kit = useMemo(() => dimensionOptions(cc2Options, true), [cc2Options]);
  const buKit = useMemo(() => dimensionOptions(buOptions, false), [buOptions]);
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
  const warnId = `bank-tx-vat-warn-${tx.id}`;

  return (
    <>
      <td className="py-2 px-2">
        {sel?.type === 'supplier' || sel?.type === 'customer' || sel?.type === 'transfer' ? (
          <span className="text-xs text-[var(--ff-text-tertiary)] italic">N/A</span>
        ) : isNew ? (
          <>
            <div data-vat-warn={vatWarn ? 'true' : 'false'} className={vatClass(vatWarn, (sel?.vatCode || 'none') === 'standard')}>
              <Select
                label={`VAT, ${label}`} labelClassName="sr-only" size="sm"
                options={VAT_KIT_OPTIONS} value={sel?.vatCode || 'none'}
                onChange={v => { if (v) onRowVatChange(tx.id, v as VatCode); }}
                describedBy={vatWarn || nonSupply ? warnId : undefined}
              />
            </div>
            {vatWarn && (
              <span
                id={warnId}
                className="mt-0.5 block text-xs leading-tight text-amber-700 dark:text-amber-500"
                title="VAT Act s17(2)(a). Claim it only if this business continuously supplies entertainment for a charge."
              >
                ⚠ Entertainment — input tax normally denied
              </span>
            )}
            {!vatWarn && nonSupply && (
              <span
                id={warnId}
                className="mt-0.5 block text-xs leading-tight text-amber-700 dark:text-amber-500"
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
          <Select
            label={`Cost centre 1, ${label}`} labelClassName="sr-only" size="sm" searchable
            options={cc1Kit} value={toKit(sel?.cc1Id)}
            valueOption={storedOption(sel?.cc1Id, cc1Kit, 'Inactive cost centre', tx.cc1Id, tx.cc1Code, tx.cc1Name)}
            onChange={v => onRowDimensionChange(tx.id, fromKit(v), sel?.cc2Id || '', sel?.buId || '')}
          />
        ) : (
          <DimensionValue code={tx.cc1Code} name={tx.cc1Name} source={tx.dimensionSource} />
        )}
      </td>
      )}
      {/* CC2 */}
      {showCC && (
      <td className="py-2 px-2">
        {isNew ? (
          <Select
            label={`Cost centre 2, ${label}`} labelClassName="sr-only" size="sm" searchable
            options={cc2Kit} value={toKit(sel?.cc2Id)}
            valueOption={storedOption(sel?.cc2Id, cc2Kit, 'Inactive cost centre', tx.cc2Id, tx.cc2Code, tx.cc2Name)}
            onChange={v => onRowDimensionChange(tx.id, sel?.cc1Id || '', fromKit(v), sel?.buId || '')}
          />
        ) : (
          <DimensionValue code={tx.cc2Code} name={tx.cc2Name} source={tx.dimensionSource} />
        )}
      </td>
      )}
      {/* BU */}
      {showBU && (
      <td className="py-2 px-2">
        {isNew ? (
          <Select
            label={`Business unit, ${label}`} labelClassName="sr-only" size="sm" searchable
            options={buKit} value={toKit(sel?.buId)}
            valueOption={storedOption(sel?.buId, buKit, 'Inactive business unit', tx.buId, undefined, tx.buName)}
            onChange={v => onRowDimensionChange(tx.id, sel?.cc1Id || '', sel?.cc2Id || '', fromKit(v))}
          />
        ) : (
          <DimensionValue code={tx.buCode} name={tx.buName} source={tx.dimensionSource} />
        )}
      </td>
      )}
    </>
  );
}
