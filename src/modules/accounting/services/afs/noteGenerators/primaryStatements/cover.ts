// AFS document cover generator.

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { NoteContent, ReportingFramework } from '@/modules/accounting/services/afs/afsTypes';
import { getFiscalRange } from '@/modules/accounting/services/afs/afsFiscalPeriod';

type DbRow = Record<string, unknown>;

export async function generateCover(
  companyId: string,
  fiscalYear: number,
  _framework: ReportingFramework,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  log.info('generateCover', { companyId, fiscalYear }, 'AfsPrimary');
  const { end: fyEnd } = await getFiscalRange(companyId, fiscalYear);
  const rows = (await sql`
    SELECT name, registered_name, registration_number, vat_number
    FROM companies WHERE id = ${companyId}::uuid LIMIT 1
  `) as DbRow[];
  const c = rows[0] ?? {};

  return {
    dataSnapshot: { fiscalYear, company: c },
    content: {
      title: 'Annual Financial Statements',
      blocks: [
        { type: 'heading', level: 2, text: String(c.registered_name ?? c.name ?? '') },
        { type: 'paragraph', text: `Registration: ${String(c.registration_number ?? '—')}` },
        { type: 'paragraph', text: `VAT: ${String(c.vat_number ?? '—')}` },
        { type: 'paragraph', text: `For the year ended ${fyEnd}` },
      ],
    },
  };
}
