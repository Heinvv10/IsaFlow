// src/modules/accounting/services/afs/docxTableRenderer.ts
import {
  Table,
  TableRow,
  TableCell,
  Paragraph,
  TextRun,
  BorderStyle,
  AlignmentType,
  WidthType,
  ShadingType,
} from 'docx';
import type { NoteContentTable } from './afsTypes';

const NONE_BORDER = {
  style: BorderStyle.NONE,
  size: 0,
  color: 'auto',
} as const;

const NO_VERTICAL_BORDERS = {
  insideVertical: NONE_BORDER,
  left: NONE_BORDER,
  right: NONE_BORDER,
} as const;

interface CellStyle { header: boolean; numeric: boolean; bold: boolean; shade: boolean }

function makeCell(text: string, style: CellStyle): TableCell {
  return new TableCell({
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text,
            bold: style.header || style.bold,
            size: style.header ? 20 : 18,
          }),
        ],
        alignment: style.numeric ? AlignmentType.RIGHT : AlignmentType.LEFT,
      }),
    ],
    ...(style.shade ? { shading: { type: ShadingType.CLEAR, fill: 'E2E8F0', color: 'auto' } } : {}),
    borders: {
      top: style.header ? { style: BorderStyle.SINGLE, size: 6, color: '2C3E50' } : NONE_BORDER,
      bottom: NONE_BORDER,
      left: NONE_BORDER,
      right: NONE_BORDER,
    },
    margins: {
      top: 80,
      bottom: 80,
      left: 100,
      right: 100,
    },
  });
}

/** A printed figure: "R 250 000.00", "−R 5.00", "+50.0%", "1 234", "(12)". Spaces (incl. no-break) are digit grouping. */
const FIGURE = /^[−+-]?\(?R?[\d,.]+\)?%?$/;
/** A placeholder for "no figure" ("—", "-"): neither numeric nor text, so it does not decide a column. */
const DASH = /^[—–-]$/;

/**
 * A column is a figure column when most of its filled cells are figures: decided by the cells, never by
 * the header's wording (the old header regex right-aligned any header with an "R" in it and left a
 * "This month" column of figures left-aligned).
 */
function isNumericColumn(colIdx: number, rows: string[][]): boolean {
  const cells = rows
    .map((r) => (r[colIdx] ?? '').replace(/[\s\u00A0]/g, ''))
    .filter((v) => v !== '' && !DASH.test(v));
  if (cells.length === 0) return false;
  return cells.filter((v) => FIGURE.test(v)).length / cells.length >= 0.5;
}

const BOLD_KINDS = ['heading', 'subtotal', 'total'];

export function renderNoteTable(block: NoteContentTable): Table {
  const { headers, rows } = block;
  const colCount = headers.length;
  const numericCols = headers.map((_, i) => isNumericColumn(i, rows));

  // Equal-width columns as a percentage
  const colWidthPct = colCount > 0 ? Math.floor(5000 / colCount) : 5000;

  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h, i) => makeCell(h, { header: true, numeric: numericCols[i] ?? false, bold: true, shade: false })),
  });

  const dataRows = rows.map((row, r) => {
    // The statement's row kinds (heading, subtotal, bottom line) print bold, the bottom line shaded, as in the PDF.
    const kind: unknown = block.rowKinds?.[r];
    return new TableRow({
      children: row.map((cell, i) =>
        makeCell(cell ?? '', { header: false, numeric: numericCols[i] ?? false, bold: typeof kind === 'string' && BOLD_KINDS.includes(kind), shade: kind === 'total' }),
      ),
    });
  });

  return new Table({
    rows: [headerRow, ...dataRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: Array(colCount).fill(colWidthPct) as number[],
    borders: {
      ...NO_VERTICAL_BORDERS,
      top: NONE_BORDER,
      bottom: NONE_BORDER,
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'CCCCCC' },
    },
  });
}
