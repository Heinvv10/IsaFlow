/**
 * Contract Extraction Service — Extract terms from contracts → recurring entries.
 * Pure business logic — no database dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedContract {
  partyA: string | null;
  partyB: string | null;
  contractDate: string | null;
  startDate: string | null;
  endDate: string | null;
  paymentAmount: number | null;
  paymentFrequency: 'weekly' | 'monthly' | 'quarterly' | 'annually' | null;
  paymentDay: number | null;
  escalationPercent: number | null;
  escalationDate: string | null;
  renewalType: 'auto' | 'manual' | null;
  renewalDate: string | null;
  noticePeriod: string | null;
  description: string | null;
  confidence: number;
}

export interface RecurringInvoiceInput {
  templateName: string;
  supplierId: string;
  frequency: string;
  amount: number;
  nextRunDate: string;
  endDate: string | null;
  description: string;
}

export interface ContractValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface EscalationEntry {
  year: number;
  amount: number;
  effectiveDate: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseContractExtractionResponse(response: string): ExtractedContract | null {
  let jsonStr = response.trim();

  if (jsonStr.includes('<think>')) {
    jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  }
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  const match = jsonStr.match(/\{[\s\S]*\}/);
  if (match) jsonStr = match[0];

  try {
    const p = JSON.parse(jsonStr) as Record<string, unknown>;

    const validFreqs = ['weekly', 'monthly', 'quarterly', 'annually'];
    const freq = typeof p.paymentFrequency === 'string' && validFreqs.includes(p.paymentFrequency)
      ? p.paymentFrequency as ExtractedContract['paymentFrequency']
      : null;

    return {
      partyA: typeof p.partyA === 'string' ? p.partyA : null,
      partyB: typeof p.partyB === 'string' ? p.partyB : null,
      contractDate: asDate(p.contractDate),
      startDate: asDate(p.startDate),
      endDate: asDate(p.endDate),
      paymentAmount: typeof p.paymentAmount === 'number' ? p.paymentAmount : null,
      paymentFrequency: freq,
      paymentDay: typeof p.paymentDay === 'number' ? p.paymentDay : null,
      escalationPercent: typeof p.escalationPercent === 'number' ? p.escalationPercent : null,
      escalationDate: asDate(p.escalationDate),
      renewalType: p.renewalType === 'auto' || p.renewalType === 'manual' ? p.renewalType : null,
      renewalDate: asDate(p.renewalDate),
      noticePeriod: typeof p.noticePeriod === 'string' ? p.noticePeriod : null,
      description: typeof p.description === 'string' ? p.description : null,
      confidence: typeof p.confidence === 'number' ? p.confidence : 0.5,
    };
  } catch {
    return null;
  }
}

export function mapContractToRecurringInput(
  contract: ExtractedContract,
  supplierId: string,
): RecurringInvoiceInput {
  return {
    templateName: `${contract.partyB || 'Supplier'} — ${contract.description || 'Contract'}`,
    supplierId,
    frequency: contract.paymentFrequency || 'monthly',
    amount: contract.paymentAmount || 0,
    nextRunDate: contract.startDate || new Date().toISOString().split('T')[0]!,
    endDate: contract.endDate || null,
    description: contract.description || `Contract with ${contract.partyB || 'supplier'}`,
  };
}

export function validateContractExtraction(contract: ExtractedContract): ContractValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (contract.paymentAmount === null || contract.paymentAmount === undefined) {
    errors.push('paymentAmount is required');
  }
  if (!contract.paymentFrequency) {
    errors.push('paymentFrequency is required');
  }
  if (!contract.startDate) {
    warnings.push('startDate not extracted');
  }
  if (!contract.endDate) {
    warnings.push('endDate not extracted — contract may be open-ended');
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function calculateEscalationSchedule(
  baseAmount: number,
  escalationPercent: number,
  startDate: string,
  years: number,
): EscalationEntry[] {
  const entries: EscalationEntry[] = [];
  let amount = baseAmount;
  const startYear = parseInt(startDate.substring(0, 4), 10);
  const monthDay = startDate.substring(4); // -MM-DD

  for (let i = 0; i < years; i++) {
    entries.push({
      year: i + 1,
      amount: Math.round(amount * 100) / 100,
      effectiveDate: `${startYear + i}${monthDay}`,
    });
    amount = amount * (1 + escalationPercent / 100);
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asDate(val: unknown): string | null {
  if (!val || typeof val !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  return null;
}
