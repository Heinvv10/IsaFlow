/** The GL import page's mapped spreadsheet rows, each stamped with the row the preview shows it on (header = row 1). */
import type { ImportRow } from '@/modules/accounting/services/gl/glImportService';

export function buildImportRows(rawRows: string[][], mapping: Record<number, string>): ImportRow[] {
  return rawRows.map((row, i) => {
    const get = (field: string) => {
      const entry = Object.entries(mapping).find(([, v]) => v === field);
      return entry ? (row[Number(entry[0])] ?? '') : '';
    };
    return {
      date: get('date'),
      accountCode: get('accountCode'),
      description: get('description'),
      reference: get('reference') || undefined,
      debit: parseFloat(get('debit').replace(/,/g, '')) || 0,
      credit: parseFloat(get('credit').replace(/,/g, '')) || 0,
      vatCode: get('vatCode') || undefined,
      costCentre: get('costCentre') || undefined,
      // The page sends only the rows that validated: without this a refusal's row number would count from the survivors.
      sheetRow: i + 2,
    };
  });
}
