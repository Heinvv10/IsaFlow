/**
 * The Assumptions form's model (budgets P6 spec §4, §13.18-21). Pure.
 *
 * - `PROV_FIELDS`: every scalar of the document, grouped as §4, with how the form edits it. An edit makes the
 *   value `{ value, source: 'manual' }`; "Use derived" puts the derive service's `Prov` back (its basis is the
 *   evidence the form shows).
 * - `buildSaveDoc`: what the PUT sends. A scenario whose chain resolves over a base (and that stores overrides,
 *   or nothing yet) saves OVERRIDES: its stored overrides plus every field or list the user changed against the
 *   resolved document as loaded, whole (a `Prov` and a list replace, never merge). Anything else saves the full
 *   document. An override cannot clear a base's payable account (undefined = keep, the server's rule), so a cleared
 *   account is not sent.
 */
import type { ThreeWayAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsSchema';
import type { AssumptionsView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';

export type ProvSection = 'workingCapital' | 'vat' | 'payroll' | 'incomeTax' | 'minimumCash';
export type FieldKind = 'days' | 'percent' | 'bool' | 'choice' | 'money';

export interface ProvField {
  path: string;
  section: ProvSection;
  key: string;
  label: string;
  kind: FieldKind;
  max?: number;
  choices?: ReadonlyArray<{ value: string | number; label: string }>;
}

const f = (section: ProvSection, key: string, label: string, kind: FieldKind, extra: Partial<ProvField> = {}): ProvField =>
  ({ path: section === 'minimumCash' ? 'minimumCash' : `${section}.${key}`, section, key, label, kind, ...extra });

export const PROV_FIELDS: readonly ProvField[] = [
  f('workingCapital', 'debtorDays', 'Debtor days', 'days', { max: 365 }),
  f('workingCapital', 'creditorDays', 'Creditor days', 'days', { max: 365 }),
  f('workingCapital', 'inventoryDays', 'Inventory days', 'days', { max: 730 }),
  f('vat', 'registered', 'VAT registered', 'bool'),
  f('vat', 'cadence', 'VAT period', 'choice', { choices: [{ value: 'monthly', label: 'Monthly' }, { value: 'bi-monthly', label: 'Every two months' }] }),
  f('vat', 'alignment', 'Two-month periods end in', 'choice', { choices: [{ value: 'odd', label: 'Odd months' }, { value: 'even', label: 'Even months' }] }),
  f('vat', 'basis', 'VAT basis', 'choice', { choices: [{ value: 'invoice', label: 'Invoice' }, { value: 'payment', label: 'Payment' }] }),
  f('vat', 'vatableSalesShare', 'Vatable share of sales (%)', 'percent'),
  f('vat', 'vatablePurchasesShare', 'Vatable share of purchases (%)', 'percent'),
  f('vat', 'refundLagMonths', 'VAT refund lag (months)', 'choice', { choices: [0, 1, 2].map((n) => ({ value: n, label: String(n) })) }),
  f('payroll', 'statutoryShare', 'PAYE, UIF and SDL share of payroll (%)', 'percent'),
  f('incomeTax', 'mode', 'Provisional tax', 'choice', { choices: [{ value: 'provisional', label: 'Budget it' }, { value: 'off', label: 'Off' }] }),
  f('incomeTax', 'topUpMonthOffset', 'Top-up paid months after the prior year end', 'choice', { choices: [6, 7].map((n) => ({ value: n, label: String(n) })) }),
  f('minimumCash', 'minimumCash', 'Minimum cash (runway line, R)', 'money'),
];

export const SECTION_TITLES: Record<ProvSection, string> = {
  workingCapital: 'Working capital', vat: 'VAT', payroll: 'Payroll', incomeTax: 'Income tax', minimumCash: 'Runway',
};

export interface ProvValue { value: unknown; source: 'derived' | 'manual'; derivedAsAt?: string; basis?: string }

type Doc = ThreeWayAssumptions;
type Loose = Record<string, unknown>;

export function getProv(doc: Doc, field: ProvField): ProvValue {
  if (field.section === 'minimumCash') return doc.minimumCash as ProvValue;
  return (doc[field.section] as unknown as Record<string, ProvValue>)[field.key] as ProvValue;
}

function putProv(doc: Doc, field: ProvField, prov: ProvValue): Doc {
  if (field.section === 'minimumCash') return { ...doc, minimumCash: prov as Doc['minimumCash'] };
  return { ...doc, [field.section]: { ...(doc[field.section] as unknown as Loose), [field.key]: prov } } as Doc;
}

/** The user typed a value: manual from now on. */
export const setManual = (doc: Doc, field: ProvField, value: unknown): Doc => putProv(doc, field, { value, source: 'manual' });

/** "Use derived": the derive service's value and basis back. */
export const withDerived = (doc: Doc, derived: Doc, field: ProvField): Doc => putProv(doc, field, getProv(derived, field));

/** The display value of a field (percent and money converted from the document's fraction and cents). */
export function displayValue(field: ProvField, value: unknown): string {
  if (field.kind === 'percent') return String(Math.round(Number(value) * 100 * 100) / 100);
  if (field.kind === 'money') return String(Number(value) / 100);
  return String(value);
}

/** The document value from what the input holds; null when it cannot be one (left for the server to name). */
export function parseInput(field: ProvField, raw: string): unknown {
  if (field.kind === 'bool') return raw === 'true';
  if (field.kind === 'choice') {
    const c = field.choices?.find((x) => String(x.value) === raw);
    return c ? c.value : null;
  }
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) return null;
  if (field.kind === 'percent') return Math.round((n / 100) * 10_000) / 10_000;
  if (field.kind === 'money') return Math.round(n * 100);
  return Math.round(n * 100) / 100;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const OBJECT_SECTIONS = ['workingCapital', 'vat', 'payroll', 'incomeTax', 'loans', 'equity'] as const;

/** True when this version saves as overrides of its base (spec §13.21). */
export function savesOverrides(view: AssumptionsView): boolean {
  if (view.version.kind !== 'scenario' || view.version.basedOnVersionId === null || view.chain.length < 2) return false;
  return view.stored === null || 'overrides' in view.stored.doc;
}

export function buildSaveDoc(view: AssumptionsView, edited: Doc): Record<string, unknown> {
  if (!savesOverrides(view)) return edited as unknown as Record<string, unknown>;
  const stored = view.stored && 'overrides' in view.stored.doc ? (view.stored.doc.overrides as Loose) : {};
  const overrides: Loose = JSON.parse(JSON.stringify(stored)) as Loose;
  const loaded = view.resolved as unknown as Loose;
  const now = edited as unknown as Loose;
  for (const s of OBJECT_SECTIONS) {
    const a = loaded[s] as Loose;
    const b = now[s] as Loose;
    for (const key of Object.keys(b)) {
      if (b[key] === undefined || same(a[key], b[key])) continue;
      overrides[s] = { ...((overrides[s] as Loose | undefined) ?? {}), [key]: b[key] };
    }
  }
  for (const s of ['capex', 'minimumCash'] as const) {
    if (!same(loaded[s], now[s])) overrides[s] = now[s];
  }
  return { schemaVersion: 1, overrides };
}

/** A new list entry id (≤ 64 chars, unique within the list). */
export function newId(prefix: string): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `${prefix}-${rnd}`.slice(0, 64);
}
