/**
 * Journal Entry Posting Service
 * Post and reverse journal entries with fiscal period and balance validation.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateJournalEntry } from '../utils/doubleEntry';
import type { JournalEntry, JournalLineInput } from '../types/gl.types';
import {
  getJournalEntryById,
  createJournalEntry,
  resolveUserUuid,
  mapEntryRow,
} from './journalEntryCrudService';

type Row = Record<string, unknown>;

export async function postJournalEntry(companyId: string, id: string, userId: string): Promise<JournalEntry> {
  try {
    const entry = await getJournalEntryById(companyId, id);
    if (!entry) throw new Error(`Journal entry ${id} not found`);
    if (entry.status !== 'draft') throw new Error(`Cannot post entry with status: ${entry.status}`);

    if (entry.fiscalPeriodId) {
      const period = (await sql`
        SELECT status FROM fiscal_periods WHERE id = ${entry.fiscalPeriodId}
      `) as Row[];
      if (period.length > 0 && String(period[0]!.status) !== 'open') {
        throw new Error(`Cannot post to ${String(period[0]!.status)} fiscal period`);
      }
    }

    if (entry.lines) {
      const validation = validateJournalEntry(entry.lines.map(l => ({
        glAccountId: l.glAccountId,
        debit: l.debit,
        credit: l.credit,
      })));
      if (!validation.valid) throw new Error(`Entry not balanced: ${validation.errors.join('; ')}`);
    }

    const safePostUserId = await resolveUserUuid(userId);
    const rows = (await sql`
      UPDATE gl_journal_entries
      SET status = 'posted', posted_by = ${safePostUserId}::UUID, posted_at = NOW()
      WHERE id = ${id} AND company_id = ${companyId}
      RETURNING *
    `) as Row[];

    log.info('Posted journal entry', { id, entryNumber: String(rows[0]!.entry_number) }, 'accounting');
    return mapEntryRow(rows[0]!);
  } catch (err) {
    log.error('Failed to post journal entry', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function reverseJournalEntry(companyId: string, id: string, userId: string): Promise<JournalEntry> {
  try {
    const entry = await getJournalEntryById(companyId, id);
    if (!entry) throw new Error(`Journal entry ${id} not found`);
    if (entry.status !== 'posted') throw new Error('Can only reverse posted entries');
    if (!entry.lines || entry.lines.length === 0) throw new Error('Entry has no lines');

    const reversalLines: JournalLineInput[] = entry.lines.map(l => ({
      glAccountId: l.glAccountId,
      debit: l.credit,
      credit: l.debit,
      description: `Reversal: ${l.description || ''}`,
      projectId: l.projectId,
      costCenterId: l.costCenterId,
    }));

    const reversalEntry = await createJournalEntry(companyId, {
      entryDate: new Date().toISOString().split('T')[0]!,
      description: `Reversal of ${entry.entryNumber}`,
      source: entry.source,
      fiscalPeriodId: entry.fiscalPeriodId,
      lines: reversalLines,
    }, userId);

    await postJournalEntry(companyId, reversalEntry.id, userId);

    await sql`
      UPDATE gl_journal_entries
      SET status = 'reversed', reversed_by = ${userId}::UUID, reversed_at = NOW()
      WHERE id = ${id} AND company_id = ${companyId}
    `;

    await sql`
      UPDATE gl_journal_entries
      SET reversal_of_id = ${id}::UUID
      WHERE id = ${reversalEntry.id} AND company_id = ${companyId}
    `;

    log.info('Reversed journal entry', { originalId: id, reversalId: reversalEntry.id }, 'accounting');
    return reversalEntry;
  } catch (err) {
    log.error('Failed to reverse journal entry', { id, error: err }, 'accounting');
    throw err;
  }
}
