/**
 * The draft edit's per-line VAT (customerInvoiceDraftEdit, which is at the file cap): the same contract as create
 * (invoiceLineVatTypes) and the same pricing (invoiceLineVatPricing), read under the caller's row lock, before the first
 * write.
 *
 * - Lines sent: a line without a type keeps the type of the IDENTICAL stored line (description, quantity, unit price;
 *   each stored line used once, in order: items/itemEditLines' rule); a stored legacy (NULL) line reads as standard when
 *   its rate is above zero, else zero_rated (storedLineVatType). Otherwise the default chain, with the customer the
 *   invoice has after the edit, so a customer change keeps every kept line's type. A legacy draft saved here becomes
 *   typed: its lines and their VAT are approval content (migration 1009), so the approval digest moves, the editor
 *   becomes an author and an approval request raised on the old content no longer matches.
 * - No lines sent, the date moved, the invoice typed: its stored lines are re-taxed at the new date (a standard line
 *   across 1 April 2018 moves from 14% to 15%): an exclusive line keeps its net, an inclusive one its gross.
 *   A company no longer registered for VAT cannot re-tax a rated line: refused (INVOICE_VAT_NOT_REGISTERED).
 * - `amountsAre` with no lines is refused: how the stored unit prices read cannot change without them.
 * - Otherwise nothing is re-priced. What is priced is held to the poster's own check (assertPricedPostable).
 * The mode (`amountsAre`) is the edit's, else the stored one, else exclusive; an inclusive line's unit price is its
 * VAT-inclusive price as entered (invoiceLineVatPricing).
 */
import { VatRateDateError } from '@/lib/vat/standardRate';
import type { VatType } from '../../types/gl.types';
import { identicalLineKey } from '../items/itemEditLines';
import { vatDocumentTotals, vatLineAmounts, type AmountsAre } from '../shared/vatLineAmounts';
import { lineVatShape, storedVatType } from './invoiceVatLegs';
import { RATED_VAT_TYPES } from '../shared/vatTypes';
import { assertPricedPostable, invoiceVatParties, resolveInvoiceVat } from './invoiceLineVatDefaults';
import { priceInvoiceVat, type VatPricedHeader, type VatPricedLine } from './invoiceLineVatPricing';
import { InvoiceLineVatRefusal, InvoiceVatNotRegisteredRefusal, storedLineVatType } from './invoiceLineVatTypes';

type Row = Record<string, unknown>;
type Tx = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown>;

interface EditVatLine {
  description: string; quantity: number; unitPrice: number; discount?: number;
  vatType?: unknown; taxRate?: unknown; itemId?: unknown; glAccountId?: unknown;
}

export interface RetaxedLine { id: string; amount: number; taxAmount: number; taxRate: number }

export type DraftVat =
  | { kind: 'refused'; message: string; code: string }
  | { kind: 'priced'; header: VatPricedHeader; lines: VatPricedLine[] }
  | { kind: 'retaxed'; header: VatPricedHeader; lines: RetaxedLine[] }
  | { kind: 'unchanged' };

const day = (v: unknown): string => (v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v ?? '').slice(0, 10));

/** The stored lines, in entry order (956), through the invoice so they are the company's. */
const storedLines = async (tx: Tx, companyId: string, invoiceId: string): Promise<Row[]> => (await tx`
  SELECT cii.id, cii.description, cii.quantity, cii.unit_price, cii.amount, cii.tax_amount, cii.tax_rate, cii.vat_type
    FROM customer_invoice_items cii JOIN customer_invoices ci ON ci.id = cii.invoice_id
   WHERE cii.invoice_id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
   ORDER BY cii.line_position NULLS LAST, cii.created_at, cii.id
`) as Row[];

/** Per sent line, the type of the identical stored line (each used once, in order), or null. */
function keptTypes(sent: readonly EditVatLine[], stored: readonly Row[]): (ReturnType<typeof storedLineVatType>)[] {
  const pool = stored.map((r) => ({ key: identicalLineKey(String(r.description), r.quantity, r.unit_price), row: r, used: false }));
  return sent.map((l) => {
    const hit = pool.find((p) => !p.used && p.key === identicalLineKey(l.description, l.quantity, l.unitPrice));
    if (!hit) return null;
    hit.used = true;
    return storedLineVatType(hit.row.vat_type, hit.row.tax_rate);
  });
}

function refused(err: unknown): DraftVat {
  if (err instanceof InvoiceLineVatRefusal || err instanceof InvoiceVatNotRegisteredRefusal) {
    return { kind: 'refused', message: err.message, code: err.code };
  }
  if (err instanceof VatRateDateError) {
    return { kind: 'refused', message: `The invoice date has no VAT rate: ${err.message}`, code: 'INVOICE_LINE_VAT_REFUSED' };
  }
  throw err;
}

/** The stored typed lines at `date` (see the header). */
function retax(stored: readonly Row[], date: string, amountsAre: AmountsAre): { header: VatPricedHeader; lines: RetaxedLine[] } {
  const lines = stored.map((r): RetaxedLine => {
    const type = storedVatType(r.vat_type) as VatType;
    const net = Number(r.amount);
    const v = amountsAre === 'inclusive'
      ? vatLineAmounts(Math.round((net + Number(r.tax_amount)) * 100) / 100, type, date, 'inclusive')
      : vatLineAmounts(net, type, date);
    return { id: String(r.id), amount: v.net, taxAmount: v.vat, taxRate: v.ratePct };
  });
  const t = vatDocumentTotals(lines.map((l) => ({ net: l.amount, vat: l.taxAmount })));
  return { lines, header: { subtotal: t.subtotal, tax: t.vat, total: t.total, taxRate: lines.reduce((m, l) => Math.max(m, l.taxRate), 0), amountsAre } };
}

export async function draftEditVat(tx: Tx, companyId: string, invoiceId: string, args: {
  items: readonly EditVatLine[] | undefined;
  /** The edit's invoiceDate, when it sends one. */
  invoiceDate: string | undefined;
  headerTaxRate: number | undefined;
  amountsAre: AmountsAre | undefined;
  /** The customer the invoice has after the edit. */
  customerId: string;
  /** The row as read under the lock: its invoice_date ('YYYY-MM-DD') and amounts_are. */
  stored: Row;
}): Promise<DraftVat> {
  const date = args.invoiceDate ?? day(args.stored.invoice_date);
  const amountsAre: AmountsAre = args.amountsAre ?? (args.stored.amounts_are === 'inclusive' ? 'inclusive' : 'exclusive');
  try {
    if (args.items) {
      const stored = await storedLines(tx, companyId, invoiceId);
      const vat = await resolveInvoiceVat(companyId, args.customerId, {
        invoiceDate: date, headerTaxRate: args.headerTaxRate, lines: args.items, kept: keptTypes(args.items, stored),
      });
      const priced = priceInvoiceVat(args.items, vat, date, amountsAre);
      assertPricedPostable(priced, date);
      return { kind: 'priced', ...priced };
    }
    if (args.amountsAre !== undefined) {
      throw new InvoiceLineVatRefusal('amountsAre needs items: how the unit prices read cannot change without the lines they price.');
    }
    if (!args.invoiceDate || args.invoiceDate === day(args.stored.invoice_date)) return { kind: 'unchanged' };
    const stored = await storedLines(tx, companyId, invoiceId);
    const shape = lineVatShape(stored.map((r) => ({ vatType: r.vat_type as string | null, taxAmount: r.tax_amount == null ? null : Number(r.tax_amount) })));
    if (shape !== 'typed' || stored.some((r) => storedVatType(r.vat_type) === null)) return { kind: 'unchanged' };
    if (stored.some((r) => (RATED_VAT_TYPES as readonly string[]).includes(String(r.vat_type)))
      && !(await invoiceVatParties(companyId, null)).registered) {
      throw new InvoiceVatNotRegisteredRefusal('This company is not registered for VAT, so its standard-rated lines cannot be re-taxed at a new date: '
        + 'send the lines (items) to save them without VAT.');
    }
    const retaxed = retax(stored, date, amountsAre);
    assertPricedPostable({ header: retaxed.header, lines: retaxed.lines.map((l, i) => ({ qty: 0, price: 0, ...l,
      vatType: storedVatType(stored[i]!.vat_type) as VatPricedLine['vatType'] })) }, date);
    return { kind: 'retaxed', ...retaxed };
  } catch (err) {
    return refused(err);
  }
}

/** Writes the re-taxed lines (the caller has written the header), through the company's own invoice. */
export async function applyRetaxedLines(tx: Tx, companyId: string, invoiceId: string, vat: DraftVat): Promise<void> {
  if (vat.kind !== 'retaxed') return;
  for (const l of vat.lines) {
    await tx`UPDATE customer_invoice_items SET amount = ${l.amount}, tax_amount = ${l.taxAmount}, tax_rate = ${l.taxRate}
             WHERE id = ${l.id}::UUID AND invoice_id = ${invoiceId}::UUID
               AND invoice_id IN (SELECT ci.id FROM customer_invoices ci WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID)`;
  }
}
