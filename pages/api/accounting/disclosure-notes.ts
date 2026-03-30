/**
 * Disclosure Notes API — WS-7.2
 * GET  /api/accounting/disclosure-notes?year=2026        — generate all auto notes
 * GET  /api/accounting/disclosure-notes?year=2026&manual=true — fetch manual notes only
 * GET  /api/accounting/disclosure-notes?year=2026&export=true — full export text
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  generateDisclosureNotes,
  getManualNotes,
  type DisclosureNote,
} from '@/modules/accounting/services/disclosureNoteService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;
  const yearStr = req.query.year as string;
  const year = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();

  if (isNaN(year) || year < 2000 || year > 2100) {
    return apiResponse.badRequest(res, 'Invalid fiscal year');
  }

  log.info('Fetching disclosure notes', { companyId, year }, 'disclosure-notes-api');

  const exportMode = req.query.export === 'true';

  try {
    const [autoNotes, manualNotes] = await Promise.all([
      generateDisclosureNotes(companyId, year),
      getManualNotes(companyId, year),
    ]);

    // Merge: auto notes first, then manual notes appended
    const allNotes: DisclosureNote[] = [...autoNotes, ...manualNotes];
    allNotes.sort((a, b) => a.noteNumber - b.noteNumber);

    if (exportMode) {
      const lines: string[] = [
        `IFRS DISCLOSURE NOTES`,
        `Fiscal Year: ${year}`,
        `Generated: ${new Date().toISOString()}`,
        ``,
      ];

      for (const note of allNotes) {
        lines.push(`${'='.repeat(60)}`);
        lines.push(`NOTE ${note.noteNumber}: ${note.title.toUpperCase()}`);
        lines.push(`${'='.repeat(60)}`);
        lines.push(note.content);
        lines.push('');

        if (note.tables) {
          for (const table of note.tables) {
            lines.push(table.headers.join('\t'));
            for (const row of table.rows) {
              lines.push(row.join('\t'));
            }
            lines.push('');
          }
        }
      }

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="disclosure-notes-${year}.txt"`);
      return res.status(200).send(lines.join('\n'));
    }

    return apiResponse.success(res, { year, notes: allNotes, total: allNotes.length });
  } catch (err) {
    log.error('Failed to generate disclosure notes', { error: err, companyId, year }, 'disclosure-notes-api');
    return apiResponse.badRequest(res, 'Failed to generate disclosure notes');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
