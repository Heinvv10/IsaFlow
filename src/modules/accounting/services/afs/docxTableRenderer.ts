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

function makeCell(text: string, isHeader: boolean, isNumeric: boolean): TableCell {
  return new TableCell({
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text,
            bold: isHeader,
            size: isHeader ? 20 : 18,
          }),
        ],
        alignment: isNumeric ? AlignmentType.RIGHT : AlignmentType.LEFT,
      }),
    ],
    borders: {
      top: isHeader ? { style: BorderStyle.SINGLE, size: 6, color: '2C3E50' } : NONE_BORDER,
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

/** Returns true if the given string looks like a financial figure (number, currency, %) */
function isNumericColumn(headers: string[], colIdx: number, rows: string[][]): boolean {
  // Heuristic: check if the column header or ≥ 50% of data cells look numeric
  const header = headers[colIdx] ?? '';
  if (/R|ZAR|\$|%|amount|balance|debit|credit|total|value/i.test(header)) return true;
  const sample = rows.slice(0, 5).map((r) => r[colIdx] ?? '');
  const numeric = sample.filter((v) => /^-?[\d\s,.()+]+$/.test(v.trim()));
  return sample.length > 0 && numeric.length / sample.length >= 0.5;
}

export function renderNoteTable(block: NoteContentTable): Table {
  const { headers, rows } = block;
  const colCount = headers.length;
  const numericCols = headers.map((_, i) => isNumericColumn(headers, i, rows));

  // Equal-width columns as a percentage
  const colWidthPct = colCount > 0 ? Math.floor(5000 / colCount) : 5000;

  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h, i) => makeCell(h, true, numericCols[i] ?? false)),
  });

  const dataRows = rows.map(
    (row) =>
      new TableRow({
        children: row.map((cell, i) =>
          makeCell(cell ?? '', false, numericCols[i] ?? false)
        ),
      })
  );

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
