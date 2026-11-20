/**
 * A personal service provider's entity particulars (wave 6 PSP-H, migration 1015): what its H certificate carries. Judged
 * before any write, against SARS PAYE Employer Reconciliation BRS V25.3.0:
 * - 3030 (FT120) the trading name of the company / CC or trust, for nature of person H (p. 20);
 * - 3066 (FT30) its registration number, with 3065 = 1 for a company / CC (format CCYY/NNNNNN/NN, CCYY from 1800 to this
 *   year, the last two digits one of the listed suffixes) or 2 for a trust (no stated format) (pp. 23-24);
 * - 3100 its income tax reference: ten digits starting with 9 for E, G and H (pp. 26-27) that pass the modulus 10 test of
 *   Appendix B §8.1 (pp. 117-118, passesIncomeTaxModulus10).
 * No text value may hold a comma, a pipe (BRS §3(h) p. 8), a double quote (the field delimiter, §3(l)) or a control
 * character (CR / LF end a record): refused here and by the 1015 CHECK, so nothing can break or forge a file record. Only a PSP holds them (the 1015 CHECK); moving off PSP clears them.
 */
import type { PspEntityType } from './payrollTypes';
import { passesIncomeTaxModulus10 } from './easyFileFields';

export const PSP_PARTICULAR_KEYS = ['pspEntityName', 'pspRegistrationNumber', 'pspTaxReference'] as const;
export type PspParticularKey = typeof PSP_PARTICULAR_KEYS[number];
export type PspParticulars = Record<PspParticularKey, string | null>;

type Refuse = (message: string) => Error;
const PSP = 'personal_service_provider';
const COMPANY_SUFFIXES = ['06', '07', '08', '09', '10', '11', '20', '21', '22', '23', '24', '25', '26', '30', '31'];

function forbidden(v: string): string | null {
  return /[\x00-\x1f\x7f",|]/.test(v) ? 'must not contain a comma, a pipe, a double quote or a control character (SARS e@syFile)' : null;
}

/** Why a registration number cannot be filed for this entity (BRS V25.3.0 p. 24), or null. */
export function pspRegistrationProblem(entity: PspEntityType | null, v: string, currentYear: number): string | null {
  if (v.length > 30) return 'must be at most 30 characters (3066)';
  const bad = forbidden(v);
  if (bad) return bad;
  const m = /^(\d{4})\/\d{6}\/(\d{2})$/.exec(v);
  // L-a (review of #1689): a company-format number is not a trust's (it would file as 3065 = 2 with a company 3066).
  if (entity !== 'company') return m ? 'is a company registration number (CCYY/NNNNNN/NN), not a trust registration number' : null;
  if (!m) return 'must be a company registration number in the format CCYY/NNNNNN/NN';
  const year = Number(m[1]);
  if (year < 1800 || year > currentYear) return `must have a year from 1800 to ${currentYear}`;
  if (!COMPANY_SUFFIXES.includes(m[2]!)) return `must end in one of ${COMPANY_SUFFIXES.join(', ')}`;
  return null;
}

/**
 * Why stored particulars cannot be filed on an H certificate, or null: the ONE judgement the builder, the loader, the EMP501
 * month totals, readiness and the filing warnings share (review of #1689 L3), so none of them disagrees with another.
 */
export function pspParticularsProblem(
  p: { entityType: PspEntityType | null; registrationNumber: string | null; taxReference: string | null }, currentYear = new Date().getFullYear(),
): string | null {
  const t = p.taxReference;
  if (t != null && (!/^9\d{9}$/.test(t) || !passesIncomeTaxModulus10(t))) {
    return 'its income tax reference (code 3100) is not 10 digits starting with 9 that pass the SARS modulus 10 test';
  }
  const bad = p.registrationNumber == null ? null : pspRegistrationProblem(p.entityType, p.registrationNumber, currentYear);
  return bad ? `its registration number (code 3066) ${bad}` : null;
}

/** M1 (review of #1689): the entity moved and the stored registration number is not one for the new entity. A 422. */
export class PspRegistrationNotForEntity extends Error {
  readonly code = 'PSP_REGISTRATION_NOT_FOR_ENTITY';
  constructor(entity: PspEntityType, problem: string) {
    super(`The stored registration number is not a ${entity === 'company' ? 'company' : 'trust'} registration number (${problem}, BRS V25.3.0 `
      + 'p. 24): send the registration number for the new entity (pspRegistrationNumber) with the change.');
    this.name = 'PspRegistrationNotForEntity';
  }
}

/**
 * A PATCH body's particulars: the keys present, trimmed and judged (blank clears one). For a status after the patch that is
 * not PSP, any particular given is refused and all three are cleared.
 */
export function pspParticularsOfPatch(
  body: Record<string, unknown>, taxStatusAfter: string | null | undefined, entityAfter: PspEntityType | null | undefined,
  refuse: Refuse, currentYear = new Date().getFullYear(),
): Partial<PspParticulars> {
  const given = PSP_PARTICULAR_KEYS.filter((k) => body[k] !== undefined);
  if (taxStatusAfter !== PSP) {
    const set = given.filter((k) => body[k] !== null && body[k] !== '');
    if (set.length > 0) throw refuse(`${set.join(', ')} can only be set for a personal service provider`);
    return taxStatusAfter === undefined && given.length === 0 ? {} : { pspEntityName: null, pspRegistrationNumber: null, pspTaxReference: null };
  }
  const out: Partial<PspParticulars> = {};
  for (const k of given) {
    const raw = body[k];
    if (raw === null || raw === '') { out[k] = null; continue; }
    if (typeof raw !== 'string') throw refuse(`${k} must be text`);
    const v = raw.trim();
    if (v === '') { out[k] = null; continue; }
    if (k === 'pspEntityName') {
      if (v.length > 120) throw refuse('pspEntityName must be at most 120 characters (3030)');
      const bad = forbidden(v);
      if (bad) throw refuse(`pspEntityName ${bad}`);
    } else if (k === 'pspRegistrationNumber') {
      const bad = pspRegistrationProblem(entityAfter ?? null, v, currentYear);
      if (bad) throw refuse(`pspRegistrationNumber ${bad}`);
    } else if (!/^9\d{9}$/.test(v)) {
      throw refuse('pspTaxReference must be the entity\'s income tax reference: 10 digits starting with 9 (3100)');
    } else if (!passesIncomeTaxModulus10(v)) {
      throw refuse('pspTaxReference is not a valid income tax reference: its check digit fails the SARS modulus 10 test (3100)');
    }
    out[k] = v;
  }
  return out;
}

/** The three columns of a payroll_employees row. */
export function pspParticularsFromRow(r: Record<string, unknown>): PspParticulars {
  const s = (v: unknown) => (v == null || v === '' ? null : String(v));
  return { pspEntityName: s(r.psp_entity_name), pspRegistrationNumber: s(r.psp_registration_number), pspTaxReference: s(r.psp_tax_reference) };
}
