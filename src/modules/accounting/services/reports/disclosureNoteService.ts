/**
 * Disclosure Note Service — WS-7.2
 * Orchestrates auto-generated + manual IFRS disclosure notes.
 * Auto-generation helpers live in disclosureNoteGenerators.ts.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import {
  noteAccountingPolicies,
  notePPE,
  noteReceivables,
  notePayables,
  noteRevenue,
  noteCash,
  noteTaxation,
} from './disclosureNoteGenerators';

export interface NoteTable {
  headers: string[];
  rows: string[][];
}

export interface DisclosureNote {
  noteNumber: number;
  title: string;
  content: string;
  tables?: NoteTable[];
  source: 'auto' | 'manual';
  id?: string;
}


// ── Main: Generate All Auto Notes ────────────────────────────────────────────

export async function generateDisclosureNotes(
  companyId: string,
  fiscalYear: number,
): Promise<DisclosureNote[]> {
  log.info('Generating disclosure notes', { companyId, fiscalYear }, 'disclosureNoteService');

  // Each generator runs inside its own savepoint so a query failure in one note
  // (e.g. schema drift on a single table) doesn't poison the surrounding tx and
  // cascade-fail every other note + the outer handler's follow-up queries.
  const generators: [string, () => Promise<DisclosureNote>][] = [
    ['accountingPolicies', () => noteAccountingPolicies(companyId, fiscalYear)],
    ['ppe', () => notePPE(companyId, fiscalYear)],
    ['receivables', () => noteReceivables(companyId, fiscalYear)],
    ['payables', () => notePayables(companyId, fiscalYear)],
    ['revenue', () => noteRevenue(companyId, fiscalYear)],
    ['cash', () => noteCash(companyId, fiscalYear)],
    ['taxation', () => noteTaxation(companyId, fiscalYear)],
  ];

  const notes: DisclosureNote[] = [];
  for (const [name, gen] of generators) {
    const note = await runInSavepoint(`dn_${name}`, gen).catch((err) => {
      log.warn(
        'Disclosure note generation skipped',
        { fiscalYear, note: name, error: err instanceof Error ? err.message : String(err) },
        'disclosureNoteService',
      );
      return null;
    });
    if (note) notes.push(note);
  }
  return notes;
}

/**
 * Run `fn` inside a Postgres SAVEPOINT bound to the ambient (ALS) tx client.
 * On failure, rolls back to the savepoint so the outer tx stays usable; on
 * success, releases the savepoint. Rethrows the original error.
 */
async function runInSavepoint<T>(name: string, fn: () => Promise<T>): Promise<T> {
  await sql.unsafe(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await sql.unsafe(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    try {
      await sql.unsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    } catch (rbErr) {
      log.warn('ROLLBACK TO SAVEPOINT failed', { name, error: rbErr instanceof Error ? rbErr.message : String(rbErr) }, 'disclosureNoteService');
    }
    throw err;
  }
}

// ── Manual Notes CRUD ─────────────────────────────────────────────────────────

export async function saveManualNote(
  companyId: string,
  fiscalYear: number,
  note: { title: string; content: string; noteNumber: number },
  createdBy: string,
): Promise<void> {
  log.info('Saving manual disclosure note', { companyId, fiscalYear, noteNumber: note.noteNumber }, 'disclosureNoteService');

  await sql`
    INSERT INTO disclosure_notes_manual (company_id, fiscal_year, note_number, title, content, created_by)
    VALUES (${companyId}, ${fiscalYear}, ${note.noteNumber}, ${note.title}, ${note.content}, ${createdBy})
    ON CONFLICT (company_id, fiscal_year, note_number)
    DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content, updated_at = NOW()
  `;
}

export async function getManualNotes(
  companyId: string,
  fiscalYear: number,
): Promise<DisclosureNote[]> {
  const rows = await sql`
    SELECT id, note_number, title, content
    FROM disclosure_notes_manual
    WHERE company_id = ${companyId} AND fiscal_year = ${fiscalYear}
    ORDER BY note_number ASC
  ` as DbRow[];

  return rows.map((r: DbRow) => ({
    noteNumber: r.note_number as number,
    title: r.title as string,
    content: r.content as string,
    source: 'manual' as const,
    id: r.id as string,
  }));
}

export async function deleteManualNote(companyId: string, noteId: string): Promise<void> {
  log.info('Deleting manual disclosure note', { companyId, noteId }, 'disclosureNoteService');

  await sql`
    DELETE FROM disclosure_notes_manual
    WHERE id = ${noteId} AND company_id = ${companyId}
  `;
}
