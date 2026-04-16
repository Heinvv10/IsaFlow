import type { NoteContent, NoteContentBlock } from '@/modules/accounting/services/afs/afsTypes';

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

interface RendererSection {
  heading?: string;
  queryKey: string;
  headers: string[];
  columns: string[];
  numberColumns?: number[];
  totalRow?: boolean;
}

interface RendererSchema {
  intro?: string;
  sections?: RendererSection[];
}

export function renderNoteContent(
  title: string,
  dataSnapshot: Record<string, unknown[]>,
  contentSchema: Record<string, unknown>,
): NoteContent {
  const schema = contentSchema as RendererSchema;
  const blocks: NoteContentBlock[] = [];

  // First block: intro paragraph
  if (schema.intro) {
    blocks.push({ type: 'paragraph', text: schema.intro });
  }

  // Section blocks
  for (const section of schema.sections ?? []) {
    const rows = dataSnapshot[section.queryKey] ?? [];

    // Optional heading
    if (section.heading) {
      blocks.push({ type: 'heading', text: section.heading, level: 3 });
    }

    // Skip empty tables
    if (rows.length === 0) continue;

    const numCols = section.numberColumns ?? [];

    const tableRows: string[][] = rows.map(row => {
      const r = row as Record<string, unknown>;
      return section.columns.map((col, idx) => {
        const val = r[col];
        if (numCols.includes(idx)) {
          return fmt(val != null ? Number(val) : null);
        }
        return val != null ? String(val) : '—';
      });
    });

    if (section.totalRow && numCols.length > 0) {
      const totalsRow = section.columns.map((_, idx) => {
        if (!numCols.includes(idx)) return idx === 0 ? 'Total' : '';
        const sum = rows.reduce((s: number, row) => {
          const r = row as Record<string, unknown>;
          const val = r[section.columns[idx]!];
          return s + (val != null ? Number(val) : 0);
        }, 0 as number);
        return fmt(sum);
      });
      tableRows.push(totalsRow);
    }

    blocks.push({ type: 'table', headers: section.headers, rows: tableRows });
  }

  // Ensure at least one block
  if (blocks.length === 0) {
    blocks.push({ type: 'paragraph', text: title });
  }

  return { title, blocks };
}
