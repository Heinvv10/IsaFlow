/**
 * A personal service provider's entity particulars (wave 6 PSP-H, migration 1015): what its H certificate carries. Judged
 * before any write, against SARS PAYE Employer Reconciliation BRS V25.3.0:
 * - 3030 (FT120) the trading name of the company / CC or trust, for nature of person H (p. 20);
 * - 3066 (FT30) its registration number, with 3065 = 1 for a company / CC (format CCYY/NNNNNN/NN, CCYY from 1800 to this
 *   year, the last two digits one of the listed suffixes) or 2 for a trust (no stated format) (pp. 23-24);
 * - 3100 its income tax reference: ten digits starting with 9 for E, G and H (pp. 26-27). The BRS also requires a modulus 10
 *   test, whose algorithm it does not state: UNVERIFIED, not applied here.
 * No value may hold a comma or a pipe (BRS §3, easyFileFields). Only a PSP holds them (the 1015 CHECK); moving off PSP clears them.
 */
import type { PspEntityType } from './payrollTypes';

export const PSP_PARTICULAR_KEYS = ['pspEntityName', 'pspRegistrationNumber', 'pspTaxReference'] as const;
export type PspParticularKey = typeof PSP_PARTICULAR_KEYS[number];
export type PspParticulars = Record<PspParticularKey, string | null>;

type Refuse = (message: string) => Error;
const PSP = 'personal_service_provider';
const COMPANY_SUFFIXES = ['06', '07', '08', '09', '10', '11', '20', '21', '22', '23', '24', '25', '26', '30', '31'];

function forbidden(v: string): string | null {
  return v.includes(',') || v.includes('|') ? 'must not contain a comma or a pipe (SARS e@syFile)' : null;
}

/** Why a registration number cannot be filed for this entity (BRS V25.3.0 p. 24), or null. */
export function pspRegistrationProblem(entity: PspEntityType | null, v: string, currentYear: number): string | null {
  if (v.length > 30) return 'must be at most 30 characters (3066)';
  const bad = forbidden(v);
  if (bad) return bad;
  if (entity !== 'company') return null;
  const m = /^(\d{4})\/\d{6}\/(\d{2})$/.exec(v);
  if (!m) return 'must be a company registration number in the format CCYY/NNNNNN/NN';
  const year = Number(m[1]);
  if (year < 1800 || year > currentYear) return `must have a year from 1800 to ${currentYear}`;
  if (!COMPANY_SUFFIXES.includes(m[2]!)) return `must end in one of ${COMPANY_SUFFIXES.join(', ')}`;
  return null;
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
