/**
 * split_allocate_bank_transaction: every contact line (supplier_id / customer_id) must name a contact of THIS company.
 * Split out of writeBankSplit.ts to keep it under the 300-line cap.
 */
import {
  CustomerNotInCompanyError, SupplierNotInCompanyError, assertCustomerInCompany, assertSupplierInCompany,
} from '@/modules/accounting/services/core/contactDirectoryService';

/**
 * False when a contact line names a contact outside the company. Missing and foreign answer alike (no existence
 * oracle); anything else is a fault, not a refusal, and is rethrown.
 */
export async function splitContactsBelongToCompany(
  companyId: string,
  lines: readonly { contactId?: string | null; contactType?: string | null }[],
): Promise<boolean> {
  for (const l of lines) {
    if (!l.contactId) continue;
    try {
      if (l.contactType === 'supplier') await assertSupplierInCompany(companyId, l.contactId);
      else await assertCustomerInCompany(companyId, l.contactId);
    } catch (err) {
      if (err instanceof SupplierNotInCompanyError || err instanceof CustomerNotInCompanyError) return false;
      throw err;
    }
  }
  return true;
}
