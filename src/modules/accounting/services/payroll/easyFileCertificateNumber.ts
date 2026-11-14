/**
 * The e@syFile certificate number (moved out of easyFileExportService.ts, unchanged: 300-line cap).
 */
import { UsageError } from './easyFileFields';

/**
 * SARS requires the certificate number to be 30 characters:
 *   10 digits PAYE ref + 4 digits transaction year CCYY + 2 digits reconciliation period MM + 14 alphanumeric unique suffix (left-padded with zeros).
 */
export function buildCertificateNumber(
  payeRef: string,
  transactionYear: number,
  reconciliationMonthMM: 2 | 8,
  uniqueSuffix: string | number,
): string {
  if (!/^\d{10}$/.test(payeRef)) {
    throw new UsageError('PAYE ref must be 10 digits to build a certificate number');
  }
  const yr = String(transactionYear).padStart(4, '0');
  const mm = String(reconciliationMonthMM).padStart(2, '0');
  const suffix = String(uniqueSuffix).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (suffix.length > 14) {
    throw new UsageError('Unique suffix for certificate number cannot exceed 14 characters');
  }
  return `${payeRef}${yr}${mm}${suffix.padStart(14, '0')}`;
}
