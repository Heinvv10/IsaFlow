/**
 * The column census's decisions for the frozen journal and line rows (breaker r1 F2), shared by the integration
 * census (against the live schema) and the unit census (against the migrations, so GitHub's CI runs it too).
 */

/** Column → the canonical row key it is frozen under, where the names differ. */
export const RENAMED: Record<string, string> = { journal_entry_id: 'journal_id', gl_account_id: 'account_id' };

/** Columns deliberately NOT frozen, with the reason. */
export const NOT_MATERIAL: Record<'gl_journal_entries' | 'gl_journal_lines', Record<string, string>> = {
  gl_journal_entries: {
    company_id: 'the snapshot is one company\'s; the row cannot move tenants unseen (RLS, composite keys)',
    updated_at: 'bookkeeping: changes with any touch; every material column is frozen itself',
    cost_center_id: 'legacy CC1 column, read by nothing (cc1_id on the lines is the one CC1)',
    extraction_confidence: 'capture AI score; says nothing about what was posted',
  },
  gl_journal_lines: {
    company_id: 'as on the journal',
    created_at: 'the line is created with its journal; the journal\'s created_at / posted_at are frozen',
    updated_at: 'bookkeeping',
    cost_center_id: 'legacy CC1 column, read by nothing (cc1_id is frozen)',
  },
};
