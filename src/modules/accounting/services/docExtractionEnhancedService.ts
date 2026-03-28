/**
 * Enhanced Document Extraction Service
 * Fills gaps: supplier matching, auto-invoice, field confidence, Claude vision fallback.
 * Pure business logic — no database dependencies.
 */

export interface ExtractedDocFields {
  vendorName: string;
  documentDate: string;
  referenceNumber: string;
  subtotal: number;
  vatAmount: number;
  totalAmount: number;
  vatRate?: number;
  lineItems: Array<{ description: string; quantity: number; unitPrice: number; total: number }>;
}

export interface SupplierMatch {
  supplierId: string;
  supplierName: string;
  confidence: number;
}

export interface AutoInvoiceData {
  supplierId: string;
  invoiceNumber: string;
  invoiceDate: string;
  totalAmount: number;
  taxAmount: number;
  taxRate: number;
  items: Array<{ description: string; quantity: number; unitPrice: number; total: number }>;
}

export interface FieldConfidence {
  vendorName: number;
  documentDate: number;
  referenceNumber: number;
  totalAmount: number;
  vatAmount: number;
  overall: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// SUPPLIER FUZZY MATCHING
// ═══════════════════════════════════════════════════════════════════════════

const STRIP_SUFFIXES = /\s*\(?(pty|ltd|limited|inc|cc|soc|holdings|group|pty\s*ltd|proprietary)\)?\s*/gi;

function normalize(name: string): string {
  return name.toLowerCase().replace(STRIP_SUFFIXES, '').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;

  // Check if one contains the other
  if (a.includes(b) || b.includes(a)) {
    const shorter = a.length < b.length ? a : b;
    const longer = a.length >= b.length ? a : b;
    return shorter.length / longer.length;
  }

  // Word overlap
  const wordsA = new Set(a.split(' '));
  const wordsB = new Set(b.split(' '));
  const intersection = [...wordsA].filter(w => wordsB.has(w));
  const union = new Set([...wordsA, ...wordsB]);
  return union.size > 0 ? intersection.length / union.size : 0;
}

export function fuzzyMatchSupplier(
  extractedName: string,
  suppliers: Array<{ id: string; name: string }>,
): SupplierMatch | null {
  if (!extractedName || extractedName.trim() === '') return null;

  const normalizedInput = normalize(extractedName);
  if (!normalizedInput) return null;

  let bestMatch: SupplierMatch | null = null;
  let bestScore = 0;

  for (const s of suppliers) {
    const normalizedSupplier = normalize(s.name);
    const score = similarity(normalizedInput, normalizedSupplier);

    if (score > bestScore && score >= 0.5) {
      bestScore = score;
      bestMatch = {
        supplierId: s.id,
        supplierName: s.name,
        confidence: Math.round(score * 100) / 100,
      };
    }
  }

  return bestMatch;
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTO-INVOICE FROM EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════

export function buildAutoInvoiceFromExtraction(
  extraction: ExtractedDocFields,
  supplierId: string,
): AutoInvoiceData {
  return {
    supplierId,
    invoiceNumber: extraction.referenceNumber || '',
    invoiceDate: extraction.documentDate || new Date().toISOString().split('T')[0]!,
    totalAmount: extraction.totalAmount || 0,
    taxAmount: extraction.vatAmount || 0,
    taxRate: extraction.vatRate || 15,
    items: (extraction.lineItems || []).map(li => ({
      description: li.description,
      quantity: li.quantity,
      unitPrice: li.unitPrice,
      total: li.total,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PER-FIELD CONFIDENCE
// ═══════════════════════════════════════════════════════════════════════════

export function calculateFieldConfidence(fields: ExtractedDocFields): FieldConfidence {
  const vendorName = fields.vendorName && fields.vendorName.trim().length > 2 ? 0.9 : 0.1;

  const documentDate = fields.documentDate && /^\d{4}-\d{2}-\d{2}$/.test(fields.documentDate)
    ? 0.95 : fields.documentDate ? 0.5 : 0.1;

  const referenceNumber = fields.referenceNumber && fields.referenceNumber.trim().length > 0 ? 0.85 : 0.1;

  const totalAmount = fields.totalAmount > 0 ? 0.9 : 0.1;

  // VAT validation: subtotal + VAT should equal total
  let vatAmount = 0.1;
  if (fields.vatAmount > 0 && fields.subtotal > 0 && fields.totalAmount > 0) {
    const calculatedTotal = fields.subtotal + fields.vatAmount;
    const diff = Math.abs(calculatedTotal - fields.totalAmount);
    const tolerance = fields.totalAmount * 0.01; // 1% tolerance
    vatAmount = diff <= tolerance ? 0.95 : diff <= fields.totalAmount * 0.05 ? 0.6 : 0.3;
  } else if (fields.vatAmount > 0) {
    vatAmount = 0.5;
  }

  const scores = [vendorName, documentDate, referenceNumber, totalAmount, vatAmount];
  const overall = Math.round((scores.reduce((s, v) => s + v, 0) / scores.length) * 100) / 100;

  return { vendorName, documentDate, referenceNumber, totalAmount, vatAmount, overall };
}

// ═══════════════════════════════════════════════════════════════════════════
// CLAUDE VISION FALLBACK
// ═══════════════════════════════════════════════════════════════════════════

export function buildClaudeVisionPrompt(documentType: string): string {
  if (documentType === 'bank_statement') {
    return `Extract data from this bank statement image. Return JSON with:
{"bankName": "", "accountNumber": "", "statementPeriod": {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"}, "openingBalance": 0, "closingBalance": 0, "transactions": [{"date": "YYYY-MM-DD", "description": "", "amount": 0, "balance": 0}]}
Use negative amounts for debits, positive for credits. Return only valid JSON.`;
  }

  return `Extract data from this ${documentType} image. You are a South African bookkeeper.
Return JSON with these fields:
{"vendorName": "", "documentDate": "YYYY-MM-DD", "referenceNumber": "", "subtotal": 0, "vatAmount": 0, "totalAmount": 0, "vatRate": 15, "lineItems": [{"description": "", "quantity": 1, "unitPrice": 0, "total": 0}]}
Rules:
- Amounts in ZAR (South African Rand)
- VAT is typically 15% in South Africa
- Extract all visible line items
- Use YYYY-MM-DD date format
- Return only valid JSON, no explanation`;
}

export function parseClaudeVisionResponse(response: string): ExtractedDocFields | null {
  if (!response || response.trim() === '') return null;

  try {
    let jsonStr = response;
    const jsonMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1]!;
    } else {
      const objMatch = response.match(/\{[\s\S]*\}/);
      if (objMatch) jsonStr = objMatch[0];
    }

    const parsed = JSON.parse(jsonStr);
    return {
      vendorName: String(parsed.vendorName || ''),
      documentDate: String(parsed.documentDate || ''),
      referenceNumber: String(parsed.referenceNumber || ''),
      subtotal: Number(parsed.subtotal || 0),
      vatAmount: Number(parsed.vatAmount || 0),
      totalAmount: Number(parsed.totalAmount || 0),
      vatRate: Number(parsed.vatRate || 15),
      lineItems: Array.isArray(parsed.lineItems) ? parsed.lineItems.map((li: any) => ({
        description: String(li.description || ''),
        quantity: Number(li.quantity || 0),
        unitPrice: Number(li.unitPrice || 0),
        total: Number(li.total || 0),
      })) : [],
    };
  } catch {
    return null;
  }
}
