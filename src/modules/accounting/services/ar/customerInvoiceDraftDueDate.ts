/**
 * The due date a customer invoice DRAFT edit writes (payment-terms programme, Part A). Pure of the edit's other work:
 * `editDraftCustomerInvoice` reads the stored row under its row lock and hands the three facts here.
 *
 * `source` is set only when the edit re-dated the draft (shared/draftDueDate.ts); null leaves the UPDATE's own rule
 * (a due date the edit moves is hand-set, migration 962).
 */
import { dueDateForContact } from '../core/paymentTermsResolver';
import { redatedDueDate } from '../shared/draftDueDate';
import { dueDateSourceOf, type DueDateSource } from '../shared/dueDateSource';

/** The locked row, as the edit selects it: `invoice_date` and `due_date` as YYYY-MM-DD text, `customer_id` COALESCE(client_id, customer_id). */
type StoredRow = Record<string, unknown>;

export async function draftEditDueDate(
  companyId: string,
  row: StoredRow,
  edit: { invoiceDate?: string; clientId?: string; dueDate?: string },
): Promise<{ dueDate: string | null; source: DueDateSource | null }> {
  const storedInvoiceDate = String(row.invoice_date);
  const storedCustomer = String(row.customer_id);
  const invoiceDate = edit.invoiceDate ?? storedInvoiceDate;
  const customerId = edit.clientId ?? storedCustomer;
  const moved = invoiceDate !== storedInvoiceDate || customerId.toLowerCase() !== storedCustomer.toLowerCase();
  const redated = await redatedDueDate({
    storedSource: row.due_date_source,
    moved,
    storedDueDate: row.due_date == null ? null : String(row.due_date),
    givenDueDate: edit.dueDate,
    termsDate: async () => {
      const dueDate = await dueDateForContact(companyId, 'customer', customerId, invoiceDate);
      return { dueDate, source: dueDateSourceOf(null, dueDate, 'manual') };
    },
  });
  return redated ?? { dueDate: edit.dueDate ?? null, source: null };
}
