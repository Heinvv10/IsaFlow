/**
 * A refusal from an un-apply plan: raised from reads, before anything is
 * written, with a message safe to show the caller. The MCP tools return it as
 * a toolError; anything else they rethrow so the registry unwinds.
 */
export class UnapplyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnapplyRefusal';
  }
}

/**
 * A source (payment, credit note) whose journal is not posted-and-unreversed
 * has no cash or credit behind it in the GL. Un-applying it would mint
 * on-account credit that auto_apply_unapplied and the refund ceiling then
 * spend with nothing behind it. Refused by name, from a read.
 */
export async function assertSourceJournalLive(
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>,
  companyId: string,
  journalId: unknown,
  what: string,
): Promise<void> {
  if (!journalId) {
    throw new UnapplyRefusal(
      `${what} has no posted journal behind it, so there is no cash or credit in the ledger to take back. `
      + 'Reconcile it by hand.',
    );
  }
  const rows = (await sql`
    SELECT status, reversed_at FROM gl_journal_entries
    WHERE id = ${String(journalId)}::UUID AND company_id = ${companyId}::UUID`) as { status: string; reversed_at: unknown }[];
  const je = rows[0];
  if (!je || je.status !== 'posted') {
    throw new UnapplyRefusal(`${what}'s journal is not posted, so there is nothing in the ledger to take back.`);
  }
  if (je.reversed_at != null) {
    throw new UnapplyRefusal(
      `${what}'s journal has been reversed, so the ledger no longer carries it. Reconcile by hand `
      + 'rather than turning it back into credit.',
    );
  }
}
