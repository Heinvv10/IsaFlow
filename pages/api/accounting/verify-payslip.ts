/**
 * Payslip Verification API
 * POST /api/accounting/verify-payslip — Upload payslip PDF, verify against payroll record
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { Writable } from 'stream';
import formidable from 'formidable';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  parsePayslipExtractionResponse,
  verifyPayslipAgainstPayroll,
  validatePayslipExtraction,
  matchEmployeeFromExtraction,
  type PayrollRecord,
} from '@/modules/accounting/services/payslipVerificationService';

export const config = {
  api: { bodyParser: false },
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const ALLOWED_MIME_TYPES: Record<string, boolean> = {
  'application/pdf': true,
  'image/jpeg': true,
  'image/jpg': true,
  'image/png': true,
};

const fileBuffers = new WeakMap<formidable.File, Buffer>();

function parseForm(req: NextApiRequest): Promise<{ fields: formidable.Fields; files: formidable.Files }> {
  return new Promise((resolve, reject) => {
    const form = formidable({
      maxFileSize: MAX_FILE_SIZE,
      keepExtensions: true,
      filter: (part) => {
        const mime = part.mimetype || '';
        return mime in ALLOWED_MIME_TYPES || !mime;
      },
      fileWriteStreamHandler: (file) => {
        const chunks: Buffer[] = [];
        const writable = new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            callback();
          },
          final(callback) {
            fileBuffers.set(file as unknown as formidable.File, Buffer.concat(chunks));
            callback();
          },
        });
        return writable;
      },
    });
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { fields, files } = await parseForm(req);

  const fileField = files.file;
  const file = Array.isArray(fileField) ? fileField[0] : fileField;

  if (!file) {
    return apiResponse.badRequest(res, 'No file uploaded. Please select a PDF or image.');
  }

  const mimeType = file.mimetype || '';
  if (!ALLOWED_MIME_TYPES[mimeType]) {
    return apiResponse.badRequest(res, `Unsupported file type: ${mimeType}. Supported: PDF, JPEG, PNG`);
  }

  const buffer = fileBuffers.get(file);
  if (!buffer || buffer.length === 0) {
    return apiResponse.badRequest(res, 'Failed to read uploaded file');
  }

  // Parse payroll record from form fields
  const payrollRaw = Array.isArray(fields.payroll) ? fields.payroll[0] : fields.payroll;
  const employeesRaw = Array.isArray(fields.employees) ? fields.employees[0] : fields.employees;
  const extractedRaw = Array.isArray(fields.extracted) ? fields.extracted[0] : fields.extracted;

  if (!payrollRaw && !extractedRaw) {
    return apiResponse.badRequest(res, 'Either payroll record or extracted payslip data is required');
  }

  let payroll: PayrollRecord | undefined;
  if (payrollRaw) {
    try {
      payroll = JSON.parse(payrollRaw) as PayrollRecord;
    } catch {
      return apiResponse.badRequest(res, 'Invalid payroll JSON');
    }
  }

  // Use pre-extracted data or attempt to parse from a VLM response string
  const extracted = extractedRaw ? parsePayslipExtractionResponse(extractedRaw) : null;

  if (!extracted) {
    log.warn('No extracted payslip data provided — returning raw buffer analysis not available without VLM', {}, 'verify-payslip');
    return apiResponse.badRequest(res, 'extracted field with payslip JSON is required');
  }

  const validation = validatePayslipExtraction(extracted);
  if (!validation.valid) {
    return apiResponse.badRequest(res, `Extracted payslip incomplete: ${validation.errors.join(', ')}`);
  }

  // Optional employee matching
  let employeeMatch = null;
  if (employeesRaw) {
    try {
      const employees = JSON.parse(employeesRaw) as Array<{ id: string; name: string; idNumber: string }>;
      employeeMatch = matchEmployeeFromExtraction(extracted, employees);
    } catch {
      log.warn('Could not parse employees field — skipping employee match', {}, 'verify-payslip');
    }
  }

  if (!payroll) {
    log.info('No payroll record supplied — returning extracted data only', {}, 'verify-payslip');
    return apiResponse.success(res, { extracted, employeeMatch });
  }

  const result = verifyPayslipAgainstPayroll(extracted, payroll);

  log.info('Payslip verification complete', {
    valid: result.valid,
    score: result.score,
    discrepancies: result.discrepancies.length,
  }, 'verify-payslip');

  return apiResponse.success(res, { result, extracted, employeeMatch });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
