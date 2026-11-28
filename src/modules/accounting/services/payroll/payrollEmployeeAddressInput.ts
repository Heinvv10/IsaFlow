/**
 * An employee's residential and postal address (wave 7 EA1, W5 part 1; migration 1056): the shape, the checks and the
 * lines it prints as. Pure, no DB: the profile card, the route and the portal share it.
 *
 * Source: SARS BRS PAYE Employer Reconciliation V25.3.0 (Jun-26). Residential pp. 34-35 (3211-3217, 3285); postal
 * pp. 36-40 (3279, 3288, 3289-3294). Lengths are the BRS length column. Character sets (p. 4-5): AN is letters
 * (accented too), digits, dash, space and apostrophe; FT is Latin-1 (ISO-8859-1) text. Every quoted field also refuses
 * a comma, a pipe, a double quote and control characters (§3(h), §3(l) p. 8: easyFileFields' FORBIDDEN_IN_QUOTED), and
 * no field may start with a space (§3(m)): values are trimmed. A leading = + - @ is refused too: these values reach
 * files and exports, where it would start a spreadsheet formula.
 *
 * Postal: two of 3288's four structures are captured, 1 (same as the residential address) and 4 (unstructured, four
 * lines + postal code + country); a PO Box or a different street address is written as the lines. 3279 (care of) is
 * then N for both, which structure 4 requires (p. 36). Country codes are two upper-case letters; that the code is on
 * the BRS Appendix A list is not checked here (e@syFile checks it on import).
 */
import { z } from 'zod';

export interface ResidentialAddress {
  unitNumber: string | null;      // 3211 AN8, optional
  complex: string | null;         // 3212 FT26, optional
  streetNumber: string | null;    // 3213 AN8, optional
  street: string;                 // 3214 FT26, mandatory
  suburb: string | null;          // 3215 FT33: 3215 or 3216
  city: string | null;            // 3216 FT21: 3215 or 3216
  postalCode: string | null;      // 3217 AN10: mandatory for ZA, 4 digits, not 0000
  countryCode: string;            // 3285 A2, mandatory
}

export type PostalAddress =
  | { sameAsResidential: true }                                  // 3288 = 1
  | {
    sameAsResidential: false;                                    // 3288 = 4
    line1: string;                                               // 3289 FT35, mandatory
    line2: string | null; line3: string | null; line4: string | null; // 3290-3292 FT35, optional
    postalCode: string | null;                                   // 3293 AN10: mandatory for ZA, 4 digits, not 0000
    countryCode: string;                                         // 3294 A2, mandatory (nature of person A)
  };

export interface EmployeeAddress { residential: ResidentialAddress; postal: PostalAddress }

const QUOTED_FORBIDDEN = /[\x00-\x1f\x7f",|]/;
const LATIN1 = /^[\x20-\x7e\xa0-\xff]*$/;
const AN = /^[A-Za-z0-9À-ÖØ-öø-ÿ' -]*$/;
const FORMULA_LEAD = /^[=+\-@]/;

/** Trimmed, curly apostrophes as the BRS's plain one (they are not Latin-1), blank as null. */
const clean = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/[‘’]/g, "'") : v);

function text(label: string, code: number, max: number, kind: 'AN' | 'FT') {
  return z.preprocess(clean, z.string(`${label} must be text`)
    .max(max, `${label} is at most ${max} characters (code ${code})`)
    .refine((v) => !QUOTED_FORBIDDEN.test(v), `${label} may not hold a comma, a pipe, a double quote or a line break (code ${code})`)
    .refine((v) => QUOTED_FORBIDDEN.test(v) || (kind === 'AN' ? AN.test(v) : LATIN1.test(v)), // one message per character
      kind === 'AN' ? `${label} may hold letters, digits, spaces, - and ' only (code ${code})` : `${label} holds a character SARS cannot accept (code ${code})`)
    .refine((v) => !FORMULA_LEAD.test(v), `${label} may not start with = + - or @ (code ${code})`));
}
const optional = (label: string, code: number, max: number, kind: 'AN' | 'FT') =>
  text(label, code, max, kind).nullish().transform((v) => v || null);
const required = (label: string, code: number, max: number) =>
  text(label, code, max, 'FT').refine((v) => v.length > 0, `${label} is required (code ${code})`);
const country = (code: number) => z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
  z.string('Country is required').regex(/^[A-Z]{2}$/, `Country must be a two-letter code, e.g. ZA (code ${code})`));

/** BRS pp. 34, 37, 39: a ZA postal code is four digits ("0040", never "40") and not "0000"; elsewhere optional. */
function postalCodeRule(code: number) {
  return (a: { postalCode: string | null; countryCode: string }, ctx: z.RefinementCtx) => {
    if (a.countryCode !== 'ZA') return;
    if (!a.postalCode) ctx.addIssue({ code: 'custom', path: ['postalCode'], message: `Postal code is required for a South African address (code ${code})` });
    else if (!/^[0-9]{4}$/.test(a.postalCode) || a.postalCode === '0000') {
      ctx.addIssue({ code: 'custom', path: ['postalCode'], message: `A South African postal code is four digits and not 0000 (code ${code})` });
    }
  };
}

const ResidentialSchema = z.object({
  unitNumber: optional('Unit number', 3211, 8, 'AN'),
  complex: optional('Complex', 3212, 26, 'FT'),
  streetNumber: optional('Street number', 3213, 8, 'AN'),
  street: required('Street or farm name', 3214, 26),
  suburb: optional('Suburb or district', 3215, 33, 'FT'),
  city: optional('City or town', 3216, 21, 'FT'),
  postalCode: optional('Postal code', 3217, 10, 'AN'),
  countryCode: country(3285),
}).superRefine((a, ctx) => {
  if (!a.suburb && !a.city) ctx.addIssue({ code: 'custom', path: ['city'], message: 'Give a suburb or district, or a city or town (codes 3215 / 3216)' });
  postalCodeRule(3217)(a, ctx);
});

const PostalSchema = z.discriminatedUnion('sameAsResidential', [
  z.object({ sameAsResidential: z.literal(true) }),
  z.object({
    sameAsResidential: z.literal(false),
    line1: required('Postal address line 1', 3289, 35),
    line2: optional('Postal address line 2', 3290, 35, 'FT'),
    line3: optional('Postal address line 3', 3291, 35, 'FT'),
    line4: optional('Postal address line 4', 3292, 35, 'FT'),
    postalCode: optional('Postal code', 3293, 10, 'AN'),
    countryCode: country(3294),
  }).superRefine(postalCodeRule(3293)),
], 'Say whether the postal address is the residential address');

const AddressSchema = z.object({ residential: ResidentialSchema, postal: PostalSchema });

export type AddressParse = { ok: true; address: EmployeeAddress } | { ok: false; fieldErrors: Record<string, string[]> };

/** The request body checked; field errors keyed by dotted path ("residential.postalCode"). Reads nothing. */
export function parseEmployeeAddress(raw: unknown): AddressParse {
  const parsed = AddressSchema.safeParse(raw);
  if (parsed.success) return { ok: true, address: parsed.data as EmployeeAddress };
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path.join('.') || 'address';
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return { ok: false, fieldErrors };
}

const joined = (...parts: Array<string | null>) => parts.filter(Boolean).join(' ');

/** The residential address as printed lines: "12 Main Road", "Unit 4, Oak Court", "Hatfield", "Pretoria 0028", "ZA". */
export function residentialLines(a: ResidentialAddress): string[] {
  return [
    joined(a.unitNumber ? `Unit ${a.unitNumber}` : null, a.complex),
    joined(a.streetNumber, a.street),
    a.suburb ?? '',
    joined(a.city, a.postalCode),
    a.countryCode,
  ].filter((l) => l !== '');
}

/** The postal address as printed lines; the residential lines when it is the same. */
export function postalLines(address: EmployeeAddress): string[] {
  const p = address.postal;
  if (p.sameAsResidential) return residentialLines(address.residential);
  return [p.line1, p.line2 ?? '', p.line3 ?? '', p.line4 ?? '', p.postalCode ?? '', p.countryCode].filter((l) => l !== '');
}
