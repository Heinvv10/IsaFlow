// src/modules/accounting/services/afs/noteGenerators/note3PropertyPlantEquipment.ts
// AFS Note 3 — Property, Plant and Equipment (split from notes1to5.ts for the 300-line limit; re-exported there)

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import type { NoteContent } from '@/modules/accounting/services/afs/afsTypes';
import { fmt, toNum } from './noteHelpers';
import { getReportingPeriod } from '@/modules/accounting/services/afs/afsReportingPeriod';

type NoteResult = { dataSnapshot: Record<string, unknown>; content: NoteContent };

export async function generateNote3PropertyPlantEquipment(
  companyId: string,
  fiscalYear: number,
): Promise<NoteResult> {
  log.info('Generating AFS note 3', { companyId }, 'noteGenerators');

  const { current: { start, end, phrase } } = await getReportingPeriod(companyId, fiscalYear);

  const rows = (await sql`
    SELECT a.category,
      SUM(a.purchase_price) AS total_cost,
      SUM(a.accumulated_depreciation) AS total_accum_dep,
      SUM(a.current_book_value) AS total_carrying_value,
      SUM(CASE WHEN a.purchase_date BETWEEN ${start} AND ${end} THEN a.purchase_price ELSE 0 END) AS additions,
      SUM(CASE WHEN a.disposal_date BETWEEN ${start} AND ${end} THEN a.purchase_price ELSE 0 END) AS disposals
    FROM assets a
    WHERE a.company_id = ${companyId}
      AND (a.disposal_date IS NULL OR a.disposal_date >= ${start}::DATE)
    GROUP BY a.category
    ORDER BY a.category
  `) as DbRow[];

  if (rows.length === 0) {
    return {
      dataSnapshot: { ppe: [], suppressReason: 'zero_balance' },
      content: {
        title: 'Property, Plant and Equipment',
        blocks: [
          {
            type: 'paragraph',
            text: 'No property, plant and equipment has been recorded for this period. [Accountant: complete this note if applicable]',
          },
        ],
      },
    };
  }

  const dataRows: string[][] = rows.map((r) => [
    String(r.category ?? ''),
    fmt(toNum(r.total_cost)),
    fmt(toNum(r.total_accum_dep)),
    fmt(toNum(r.total_carrying_value)),
    fmt(toNum(r.additions)),
    fmt(toNum(r.disposals)),
  ]);

  const totals = rows.reduce<{ cost: number; dep: number; cv: number; add: number; dis: number }>(
    (acc, r) => {
      acc.cost += toNum(r.total_cost);
      acc.dep += toNum(r.total_accum_dep);
      acc.cv += toNum(r.total_carrying_value);
      acc.add += toNum(r.additions);
      acc.dis += toNum(r.disposals);
      return acc;
    },
    { cost: 0, dep: 0, cv: 0, add: 0, dis: 0 },
  );

  dataRows.push(['Total', fmt(totals.cost), fmt(totals.dep), fmt(totals.cv), fmt(totals.add), fmt(totals.dis)]);

  const content: NoteContent = {
    title: 'Property, Plant and Equipment',
    blocks: [
      {
        type: 'paragraph',
        text: `The following table summarises the carrying amounts and movements in property, plant and equipment for the ${phrase}:`,
      },
      {
        type: 'table',
        headers: ['Category', 'Cost', 'Accum Depr', 'Carrying Value', 'Additions', 'Disposals'],
        rows: dataRows,
      },
    ],
  };

  return { dataSnapshot: { ppe: rows }, content };
}
