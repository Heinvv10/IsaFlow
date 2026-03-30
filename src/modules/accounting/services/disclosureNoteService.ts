/**
 * Disclosure Note Service — WS-7.2
 * Orchestrates auto-generated + manual IFRS disclosure notes.
 * Auto-generation helpers live in disclosureNoteGenerators.ts.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

// ── Main: Generate All Auto Notes ────────────────────────────────────────────

export async function generateDisclosureNotes(
  companyId: string,
  fiscalYear: number,
): Promise<DisclosureNote[]> {
  log.info('Generating disclosure notes', { companyId, fiscalYear }, 'disclosureNoteService');

  const [n1, n2, n3, n4, n5, n6, n7] = await Promise.all([
    noteAccountingPolicies(companyId, fiscalYear),
    notePPE(companyId, fiscalYear),
    noteReceivables(companyId, fiscalYear),
    notePayables(companyId, fiscalYear),
    noteRevenue(companyId, fiscalYear),
    noteCash(companyId, fiscalYear),
    noteTaxation(companyId, fiscalYear),
  ]);

  return [n1, n2, n3, n4, n5, n6, n7];
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
  ` as Row[];

  return rows.map((r: Row) => ({
    noteNumber: r.note_number,
    title: r.title,
    content: r.content,
    source: 'manual' as const,
    id: r.id,
  }));
}

export async function deleteManualNote(companyId: string, noteId: string): Promise<void> {
  log.info('Deleting manual disclosure note', { companyId, noteId }, 'disclosureNoteService');

  await sql`
    DELETE FROM disclosure_notes_manual
    WHERE id = ${noteId} AND company_id = ${companyId}
  `;
}
