/**
 * The ONE predicate behind every read of the credit-note list: the page rows, the count and the MCP summary
 * (`creditNoteSummaryService`) all splice `creditNoteListWhere`, so a total can never describe a different set
 * than the rows it stands in for. Before this, the page's SQL took `type` only and silently ignored `status`,
 * for the REST routes and `list_credit_notes` alike.
 */
import { sql } from '@/lib/neon';
import type { CreditNoteStatus } from '../../types/ar.types';

export interface CreditNoteListScope {
  type?: 'customer' | 'supplier';
  status?: CreditNoteStatus;
}

/** `credit_notes cn`, company-scoped, narrowed by the optional type and status. */
export function creditNoteListWhere(companyId: string, f: CreditNoteListScope) {
  const type = f.type ?? null;
  const status = f.status ?? null;
  return sql`cn.company_id = ${companyId}::UUID
    AND (${type}::TEXT IS NULL OR cn.type = ${type}::TEXT)
    AND (${status}::TEXT IS NULL OR cn.status = ${status}::TEXT)`;
}
