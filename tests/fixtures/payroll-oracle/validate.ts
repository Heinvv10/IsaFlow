/**
 * Fixture guard for the payroll oracle: shape, source, tolerance cap and personal-data masking
 * (corpus-ground-truth rules). Every problem is thrown with the file name, so a bad fixture is
 * named instead of failing somewhere inside the engine.
 */

export const ORACLE_FIELDS = ['paye', 'uifEmployee', 'uifEmployer', 'sdl', 'eti', 'net'] as const;
export type OracleField = typeof ORACLE_FIELDS[number];

/** Documented rounding only: at most this many cents per field. */
export const MAX_TOLERANCE_CENTS = 5;

const SOURCE_PATTERN = /^(sage|simplepay|both|velocity-register-v2|UNVERIFIED|sars-guide:.+)$/;

/** Substrings of a normalised key (lowercase, no `_` or `-`) that mark personal data. */
export const PII_KEY_PARTS = ['name', 'surname', 'id', 'tax', 'bank', 'account', 'mobile', 'phone', 'email', 'dob', 'birth', 'passport'];

/** The schema's own keys, per object, which may contain a PII_KEY_PARTS substring by design. */
const SCHEMA: Record<string, readonly string[]> = {
  case: ['id', 'source', 'sourceRef', 'notes', 'input', 'expected', 'tolerance'],
  input: ['period', 'taxYear', 'employee', 'employerAnnualRemuneration', 'components', 'unmodelled'],
  period: ['year', 'month'],
  employee: ['dateOfBirth', 'startDate', 'taxStatus', 'uifExcluded', 'medicalAidMainMember', 'medicalAidDependantsCount', 's18aReceiptHeld'],
  component: ['code', 'name', 'type', 'amount', 'taxable', 'uif', 'sdl'],
  toleranceEntry: ['cents', 'reason'],
};

const normaliseKey = (k: string) => k.toLowerCase().replace(/[_-]/g, '');

/** SA ID numbers are 13 digits; spaces or dashes between digits are ignored. */
const THIRTEEN_DIGITS = /\d{13}/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function piiInString(value: string): string | null {
  if (THIRTEEN_DIGITS.test(value.replace(/(\d)[\s-](?=\d)/g, '$1'))) return 'a 13-digit number (ID-number shape)';
  if (EMAIL.test(value)) return 'an email address';
  return null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The schema keys allowed at a path (array indices dropped); anything else is checked for personal data. */
function schemaAt(path: readonly string[]): readonly string[] {
  const at = path.join('.');
  if (at === '') return SCHEMA.case!;
  if (at === 'input') return SCHEMA.input!;
  if (at === 'input.period') return SCHEMA.period!;
  if (at === 'input.employee') return SCHEMA.employee!;
  if (at === 'input.components') return SCHEMA.component!;
  if (at === 'expected' || at === 'tolerance') return ORACLE_FIELDS;
  if (path.length === 2 && path[0] === 'tolerance') return SCHEMA.toleranceEntry!;
  return [];
}

/** Throws on the first personal-data key or string value. Schema keys are exempt only in their own place. */
export function assertNoPersonalData(raw: unknown, file: string): void {
  const walk = (v: unknown, path: string[]): void => {
    if (typeof v === 'string') {
      const hit = piiInString(v);
      if (hit) throw new Error(`${file}: ${path.join('.') || '(root)'} holds ${hit}; oracle fixtures must be anonymised`);
    } else if (Array.isArray(v)) {
      v.forEach(x => walk(x, path));
    } else if (isObj(v)) {
      const allowed = schemaAt(path);
      for (const [k, x] of Object.entries(v)) {
        if (!allowed.includes(k)) {
          const part = PII_KEY_PARTS.find(p => normaliseKey(k).includes(p));
          if (part) throw new Error(`${file}: key "${[...path, k].join('.')}" looks like personal data ("${part}"); oracle fixtures must be anonymised`);
        }
        walk(x, [...path, k]);
      }
    }
  };
  walk(raw, []);
}

function need(cond: boolean, file: string, what: string): void {
  if (!cond) throw new Error(`${file}: ${what}`);
}
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown) => Number.isInteger(v);
const onlyKeys = (o: Obj, keys: readonly string[], file: string, where: string) => {
  const extra = Object.keys(o).filter(k => !keys.includes(k));
  need(extra.length === 0, file, `${where} has unknown key(s) ${extra.join(', ')} (allowed: ${keys.join(', ')})`);
};

/** Shape and rule checks; returns nothing, throws a named error. */
export function validateCase(raw: unknown, file: string): void {
  assertNoPersonalData(raw, file);
  need(isObj(raw), file, 'not a JSON object');
  const c = raw as Obj;
  onlyKeys(c, SCHEMA.case!, file, 'the case');
  need(typeof c.id === 'string' && `${c.id}.json` === file, file, `id "${String(c.id)}" must match the file name`);
  need(typeof c.source === 'string' && SOURCE_PATTERN.test(c.source), file,
    `source "${String(c.source)}" is not one of sage | simplepay | both | sars-guide:<ref> | velocity-register-v2 | UNVERIFIED`);
  need(typeof c.sourceRef === 'string' && c.sourceRef.length > 0 && typeof c.notes === 'string' && c.notes.length > 0, file, 'sourceRef and notes are required');

  need(isObj(c.input), file, 'input must be an object');
  const input = c.input as Obj;
  onlyKeys(input, SCHEMA.input!, file, 'input');
  need(isObj(input.period) && isInt((input.period as Obj).year) && isInt((input.period as Obj).month)
    && ((input.period as Obj).month as number) >= 1 && ((input.period as Obj).month as number) <= 12, file, 'input.period needs integer year and month 1-12');
  need(isInt(input.taxYear), file, 'input.taxYear must be an integer');
  need(isNum(input.employerAnnualRemuneration), file, 'input.employerAnnualRemuneration must be a number');
  need(input.unmodelled === undefined || isObj(input.unmodelled), file, 'input.unmodelled must be an object');

  need(isObj(input.employee), file, 'input.employee must be an object');
  const e = input.employee as Obj;
  onlyKeys(e, SCHEMA.employee!, file, 'input.employee');
  // Masking: a date of birth keeps the year only (YYYY-01-01), never a real birthday.
  need(e.dateOfBirth === null || (typeof e.dateOfBirth === 'string' && /^\d{4}-01-01$/.test(e.dateOfBirth)), file,
    'input.employee.dateOfBirth must be null or YYYY-01-01 (year only: a real date of birth is personal data)');
  need(typeof e.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.startDate), file, 'input.employee.startDate must be YYYY-MM-DD');
  need(typeof e.taxStatus === 'string', file, 'input.employee.taxStatus must be a string');
  for (const b of ['uifExcluded', 'medicalAidMainMember', 's18aReceiptHeld']) need(typeof e[b] === 'boolean', file, `input.employee.${b} must be a boolean`);
  need(isInt(e.medicalAidDependantsCount), file, 'input.employee.medicalAidDependantsCount must be an integer');

  need(Array.isArray(input.components) && input.components.length > 0, file, 'input.components must be a non-empty array');
  (input.components as unknown[]).forEach((x, i) => {
    need(isObj(x), file, `input.components[${i}] must be an object`);
    const k = x as Obj;
    onlyKeys(k, SCHEMA.component!, file, `input.components[${i}]`);
    need(typeof k.code === 'string' && typeof k.name === 'string' && (k.type === 'earning' || k.type === 'deduction') && isNum(k.amount)
      && typeof k.taxable === 'boolean' && typeof k.uif === 'boolean' && typeof k.sdl === 'boolean', file,
    `input.components[${i}] needs code, name, type (earning|deduction), amount and boolean taxable/uif/sdl`);
  });

  need(isObj(c.expected) && Object.keys(c.expected).length > 0, file, 'no expected figure');
  for (const [k, v] of Object.entries(c.expected as Obj)) {
    need((ORACLE_FIELDS as readonly string[]).includes(k), file, `unknown expected field ${k}`);
    need(isNum(v), file, `expected.${k} must be a number`);
  }
  if (c.tolerance !== undefined) {
    need(isObj(c.tolerance), file, 'tolerance must be an object');
    for (const [k, t] of Object.entries(c.tolerance as Obj)) {
      need((ORACLE_FIELDS as readonly string[]).includes(k) && (c.expected as Obj)[k] !== undefined, file, `tolerance on ${k}: not an asserted field`);
      need(isObj(t) && isInt(t.cents) && (t.cents as number) >= 1 && (t.cents as number) <= MAX_TOLERANCE_CENTS, file,
        `tolerance on ${k}: cents must be an integer from 1 to ${MAX_TOLERANCE_CENTS}`);
      need(typeof (t as Obj).reason === 'string' && ((t as Obj).reason as string).trim().length > 0, file, `tolerance on ${k}: a reason is required`);
    }
  }
}
