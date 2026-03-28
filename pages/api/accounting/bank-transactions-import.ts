/**
 * Bank Statement Import API
 * POST /api/accounting/bank-transactions-import
 *   Import CSV or PDF bank statement
 *
 * Body (CSV):
 *   { csvContent, bankAccountId, statementDate, bankFormat?, fileType?: 'csv' }
 *
 * Body (PDF):
 *   { pdfBase64, bankAccountId, statementDate, bankFormat?, fileType: 'pdf' }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { importBankStatement, importParsedTransactions } from '@/modules/accounting/services/bankReconciliationService';
import { parseBankPdf } from '@/modules/accounting/utils/bankPdfParser';
import type { BankFormat } from '@/modules/accounting/types/bank.types';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    const {
      csvContent,
      pdfBase64,
      fileType,
      bankAccountId,
      statementDate,
      bankFormat,
    } = req.body as {
      csvContent?: string;
      pdfBase64?: string;
      fileType?: 'csv' | 'pdf';
      bankAccountId: string;
      statementDate: string;
      bankFormat?: string;
    };

    if (!bankAccountId || !statementDate) {
      return apiResponse.badRequest(res, 'bankAccountId and statementDate are required');
    }

    const resolvedFileType: 'csv' | 'pdf' = fileType || (pdfBase64 ? 'pdf' : 'csv');

    if (resolvedFileType === 'pdf') {
      if (!pdfBase64) {
        return apiResponse.badRequest(res, 'pdfBase64 is required for PDF imports');
      }

      // Strip data-URL prefix if present: "data:application/pdf;base64,<data>"
      const base64Data = pdfBase64.includes(',') ? pdfBase64.split(',')[1]! : pdfBase64;
      const pdfBuffer = Buffer.from(base64Data, 'base64');

      log.info('Starting PDF bank statement import', {
        bankAccountId, statementDate, bankFormat, bufferSize: pdfBuffer.length,
      }, 'accounting-api');

      const parseResult = await parseBankPdf(pdfBuffer, bankFormat);

      if (parseResult.errors.length > 0 && parseResult.transactions.length === 0) {
        return apiResponse.badRequest(res, parseResult.errors[0]!.error);
      }

      const result = await importParsedTransactions(
        companyId,
        parseResult,
        String(bankAccountId),
        String(statementDate),
      );

      return apiResponse.created(res, result);
    }

    // Default: CSV import
    if (!csvContent) {
      return apiResponse.badRequest(res, 'csvContent is required for CSV imports');
    }

    const result = await importBankStatement(
      companyId,
      csvContent,
      String(bankAccountId),
      String(statementDate),
      (bankFormat || undefined) as BankFormat | undefined,
    );

    return apiResponse.created(res, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to import bank statement';
    log.error('Failed to import bank statement', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
