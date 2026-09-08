import { sql, withTransaction } from '@/lib/neon';
import { requireCtx } from '@/lib/als';
import { fmtDate } from '@/lib/fmtDate';
import { validateJournalEntry } from '../../utils/doubleEntry';
import type { JournalLineInput } from '../../types/gl.types';
import { createJournalEntry, postJournalEntry } from './journalEntryService';

export class OpeningBalanceValidationError extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function amount(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value !== 'string' && typeof value !== 'number') throw new OpeningBalanceValidationError('Amounts must be numbers');
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || Math.round(number * 100) / 100 !== number
      || !Number.isSafeInteger(Math.round(number * 100))) {
    throw new OpeningBalanceValidationError('Amounts must be finite, non-negative and have at most two decimal places');
  }
  return number;
}
function parseBalances(input: unknown): JournalLineInput[] {
  if (!Array.isArray(input) || input.length === 0) throw new OpeningBalanceValidationError('Opening balances are required');
  const lines = input.map((value: unknown): JournalLineInput => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OpeningBalanceValidationError('Invalid opening balance');
    const row = value as Record<string, unknown>;
    if (typeof row.accountId !== 'string' || !uuid.test(row.accountId)) throw new OpeningBalanceValidationError('A valid account ID is required');
    return { glAccountId: row.accountId.toLowerCase(), debit: amount(row.debit), credit: amount(row.credit), description: 'Opening Balance' };
  });
  const debitCents = lines.reduce((sum, line) => sum + Math.round(line.debit * 100), 0);
  const creditCents = lines.reduce((sum, line) => sum + Math.round(line.credit * 100), 0);
  if (!Number.isSafeInteger(debitCents) || !Number.isSafeInteger(creditCents) || debitCents !== creditCents) {
    throw new OpeningBalanceValidationError('Debits must equal credits exactly');
  }
  const validation = validateJournalEntry(lines);
  if (!validation.valid) throw new OpeningBalanceValidationError(validation.errors.join('; '));
  return lines;
}

export async function postOpeningBalances(companyId: string, userId: string, input: unknown) {
  const ctx = requireCtx();
  if (ctx.companyId !== companyId || ctx.userId !== userId) throw new Error('Opening balances require the authenticated company transaction');
  const lines = parseBalances(input);
  return withTransaction(async () => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${companyId}::text, 619))`;
    const ids = [...new Set(lines.map(line => line.glAccountId))];
    const accounts = await sql`
      SELECT id FROM gl_accounts WHERE company_id = ${companyId}::uuid
        AND id = ANY(${ids}::uuid[]) AND is_active = true AND level = 3
      ORDER BY id FOR SHARE
    `;
    if (accounts.length !== ids.length) {
      throw new OpeningBalanceValidationError('Every balance must use an active posting account in this company');
    }
    const periods = await sql<{ id: string; start_date: string | Date }>`
      SELECT id, start_date FROM fiscal_periods WHERE company_id = ${companyId}::uuid AND status = 'open'
      ORDER BY start_date, id LIMIT 1 FOR SHARE
    `;
    const period = periods[0];
    if (!period) throw new OpeningBalanceValidationError('Create or open a fiscal period before entering opening balances');
    const draft = await createJournalEntry(companyId, {
      entryDate: fmtDate(period.start_date), fiscalPeriodId: period.id,
      source: 'manual', description: 'Opening Balances', reference: 'opening_balance', lines,
    }, userId);
    return postJournalEntry(companyId, draft.id, userId);
  });
}
