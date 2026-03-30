/**
 * Contract-to-Recurring API
 * POST /api/accounting/contract-to-recurring
 * Upload a PDF contract — extract terms, return suggested recurring invoice setup.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { Writable } from 'stream';
import formidable from 'formidable';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  parseContractExtractionResponse,
  mapContractToRecurringInput,
  validateContractExtraction,
  calculateEscalationSchedule,
} from '@/modules/accounting/services/contractExtractionService';

export const config = {
  api: { bodyParser: false },
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/** In-memory file buffer attached to formidable file objects */
const fileBuffers = new WeakMap<formidable.File, Buffer>();

function parseForm(req: NextApiRequest): Promise<{ fields: formidable.Fields; files: formidable.Files }> {
  return new Promise((resolve, reject) => {
    const form = formidable({
      maxFileSize: MAX_FILE_SIZE,
      keepExtensions: true,
      filter: (part) => {
        const mime = part.mimetype || '';
        return mime === 'application/pdf' || !mime;
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

async function extractContractFromPdf(buffer: Buffer): Promise<string> {
  // pdf-parse uses CommonJS export= — must use require()
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>;
  const data = await pdfParse(buffer);
  return data.text;
}

const CONTRACT_PROMPT = `Extract the following fields from this contract text and return a JSON object:
- partyA: first party / company name
- partyB: second party / supplier name
- contractDate: signing date (YYYY-MM-DD or null)
- startDate: service start date (YYYY-MM-DD or null)
- endDate: service end date (YYYY-MM-DD or null)
- paymentAmount: numeric monthly/recurring amount (number or null)
- paymentFrequency: "weekly" | "monthly" | "quarterly" | "annually" | null
- paymentDay: day of month for payment (number or null)
- escalationPercent: annual escalation % (number or null)
- escalationDate: when escalation starts (YYYY-MM-DD or null)
- renewalType: "auto" | "manual" | null
- renewalDate: renewal / expiry date (YYYY-MM-DD or null)
- noticePeriod: e.g. "30 days" (string or null)
- description: brief description of services
- confidence: your confidence 0-1
Return ONLY valid JSON, no markdown.`;

async function callLlmForContractExtraction(text: string): Promise<string> {
  const baseUrl = process.env.VLLM_BASE_URL;
  if (!baseUrl) throw new Error('VLLM_BASE_URL not configured');

  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.VLLM_API_KEY || 'EMPTY'}`,
    },
    body: JSON.stringify({
      model: process.env.VLLM_MODEL || 'Qwen/Qwen3-VL-8B',
      messages: [
        { role: 'system', content: CONTRACT_PROMPT },
        { role: 'user', content: text.substring(0, 8000) },
      ],
      max_tokens: 1024,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    throw new Error(`VLM request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content || '';
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    const { fields, files } = await parseForm(req);

    const fileField = files.file;
    const file = Array.isArray(fileField) ? fileField[0] : fileField;

    if (!file) {
      return apiResponse.badRequest(res, 'No file uploaded. Please provide a PDF contract.');
    }

    const mimeType = file.mimetype || '';
    if (mimeType !== 'application/pdf') {
      return apiResponse.badRequest(res, `Unsupported file type: ${mimeType}. Only application/pdf is accepted.`);
    }

    if (file.size > MAX_FILE_SIZE) {
      return apiResponse.badRequest(res, `File too large. Maximum size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
    }

    const buffer = fileBuffers.get(file);
    if (!buffer || buffer.length === 0) {
      return apiResponse.badRequest(res, 'Failed to read uploaded file');
    }

    // Validate PDF magic bytes (%PDF)
    const hex = buffer.subarray(0, 4).toString('hex').toUpperCase();
    if (!hex.startsWith('25504446')) {
      return apiResponse.badRequest(res, 'File does not appear to be a valid PDF');
    }

    // Extract supplier_id from form fields if provided
    const supplierIdField = fields.supplierId;
    const supplierId = (Array.isArray(supplierIdField) ? supplierIdField[0] : supplierIdField) || 'unknown';

    log.info('Starting contract extraction', {
      fileName: file.originalFilename,
      fileSize: file.size,
      supplierId,
      companyId,
    }, 'contract-to-recurring');

    // Step 1: Parse PDF text
    let contractText: string;
    try {
      contractText = await extractContractFromPdf(buffer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('PDF text extraction failed', { error: msg }, 'contract-to-recurring');
      return apiResponse.badRequest(res, `Failed to extract text from PDF: ${msg}`);
    }

    if (!contractText || contractText.trim().length < 50) {
      return apiResponse.badRequest(res, 'PDF appears to contain no extractable text. Please use a text-based PDF.');
    }

    // Step 2: LLM extraction
    let llmResponse: string;
    try {
      llmResponse = await callLlmForContractExtraction(contractText);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('LLM contract extraction failed', { error: msg }, 'contract-to-recurring');
      return apiResponse.internalError(res, err, `Contract analysis failed: ${msg}`);
    }

    // Step 3: Parse and validate
    const contract = parseContractExtractionResponse(llmResponse);
    if (!contract) {
      log.warn('Failed to parse contract extraction response', { llmResponse }, 'contract-to-recurring');
      return apiResponse.internalError(res, new Error('Parse failed'), 'Could not parse contract extraction result');
    }

    const validation = validateContractExtraction(contract);

    // Step 4: Map to recurring invoice suggestion
    const recurringInput = mapContractToRecurringInput(contract, supplierId);

    // Step 5: Escalation schedule (3 years if escalation data available)
    let escalationSchedule = null;
    if (
      contract.escalationPercent !== null &&
      contract.paymentAmount !== null &&
      contract.startDate
    ) {
      try {
        escalationSchedule = calculateEscalationSchedule(
          contract.paymentAmount,
          contract.escalationPercent,
          contract.startDate,
          3,
        );
      } catch (err) {
        log.warn('Escalation schedule calculation failed', { error: String(err) }, 'contract-to-recurring');
      }
    }

    log.info('Contract extraction completed', {
      confidence: contract.confidence,
      validationValid: validation.valid,
      partyB: contract.partyB,
      paymentAmount: contract.paymentAmount,
      paymentFrequency: contract.paymentFrequency,
      companyId,
    }, 'contract-to-recurring');

    return apiResponse.success(res, {
      contract,
      validation,
      recurringInvoiceSuggestion: recurringInput,
      escalationSchedule,
      meta: {
        fileName: file.originalFilename,
        fileSize: file.size,
        textLength: contractText.length,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Contract-to-recurring failed', { error: msg, companyId }, 'contract-to-recurring');

    if (msg.includes('maxFileSize')) {
      return apiResponse.badRequest(res, `File too large. Maximum size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
    }

    return apiResponse.internalError(res, err, `Contract processing failed: ${msg}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
