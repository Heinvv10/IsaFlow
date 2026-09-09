import { CONTROL_OPERATIONS, type OperationBinding } from './contracts';

const NONMONETARY = new Set<string>([
  'fiscal_period.close', 'fiscal_period.lock', 'fiscal_period.reopen', 'year.close', 'year.periods_close',
  'company_lockdown.change', 'vat_period.lock', 'beneficiary.propose', 'beneficiary.verify',
  'beneficiary.activate', 'payroll_run.reopen',
]);

function text(value: unknown): void {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('Empty operation binding field');
}
function version(value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid binding version');
}
function record(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid binding object');
}
function moneyPair(amount: unknown, currency: unknown): void {
  if (amount === null && currency === null) return;
  if (typeof amount !== 'string' || !/^-?\d{1,30}(?:\.\d{1,12})?$/.test(amount)
    || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new Error('Invalid currency/amount pair');
}
function entity(value: unknown): asserts value is Record<string, unknown> {
  record(value); text(value.entityType); text(value.entityId);
}

/** Called after lossless canonical-shape validation, before reading material fields. */
export function validateOperationBinding(binding: OperationBinding): void {
  entity(binding); text(binding.companyId); version(binding.entityVersion);
  if (!CONTROL_OPERATIONS.includes(binding.operation)) throw new Error('Unsupported operation');
  const date = binding.accountingDate;
  if (date !== null && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) throw new Error('Invalid accounting date');
  moneyPair(binding.amount, binding.currency);
  if (binding.amount === null && !NONMONETARY.has(binding.operation)) throw new Error('Missing operation amount');
  if (!Array.isArray(binding.beneficiaries) || !Array.isArray(binding.sourceVersions) || !Array.isArray(binding.policies)) {
    throw new Error('Invalid binding collections');
  }
  for (const source of [...binding.sourceVersions, ...binding.beneficiaries]) {
    entity(source); version(source.version); text(source.fingerprint);
  }
  for (const beneficiary of binding.beneficiaries) {
    if (!['supplier', 'employee'].includes(beneficiary.entityType)) throw new Error('Invalid beneficiary type');
    text(beneficiary.beneficiaryId); moneyPair(beneficiary.amount, beneficiary.currency);
  }
  for (const policy of binding.policies) {
    record(policy); text(policy.policyId); version(policy.policyVersion); text(policy.approverRole);
    if (typeof policy.mandatory !== 'boolean') throw new Error('Invalid policy requirement');
  }
}
