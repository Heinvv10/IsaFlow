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

export const FREQUENCIES = ['monthly', 'fortnightly', 'weekly'] as const;
export const RUN_KINDS = ['regular', 'bonus', 'termination'] as const;
/** The stored line figures of a prior period that the year-to-date reader consumes (spec §4 O3 F1); all required. */
export const PRIOR_FIGURES = [
  'paye', 'uifEmployee', 'uifLeviable', 'periodicTaxable', 'annualPayments', 'retirementDeduction', 'medicalCredit',
  'businessKm', 'etiRemuneration', 'etiHours',
] as const;

/**
 * Every key a case may put in `input.unmodelled` (TDD round 1): a typo or an unowned input is refused here, and
 * payrollOracleInputs.test.ts holds each one to a "passed" or "owned by <PR>" entry.
 */
export const UNMODELLED_KEYS = [
  'businessKm', 'businessUseAtLeast80Pct', 'dayRate', 'daysWorked', 'dbMemberCategoryFactor', 'employmentBasis', 'erMedicalContribution',
  'erRetirementPctOfRfi', 'fixedAmountDirective', 'fixedRateDirectivePercent', 'garnisheeOrders', 'hoursPerDay', 'maintenancePlanIncluded',
  'monthlyHours', 'ordinarilyWorksSunday', 'ordinaryHoursPerWeek', 'ordinaryHoursWage', 'overtimeHours', 'overtimeMultiplier', 'periodFraction',
  'reimbursiveRatePerKm', 'rfiBase', 'travelBusinessUseAtLeast80Pct', 'vehicleBenefitPctOfValue', 'vehicleDeterminedValue', 'writtenDeclarationHeld',
] as const;

/** Substrings of a normalised key (lowercase, no `_` or `-`) that mark personal data. */
export const PII_KEY_PARTS = ['name', 'surname', 'id', 'tax', 'bank', 'account', 'mobile', 'phone', 'email', 'dob', 'birth', 'passport'];

/** The schema's own keys, per object, which may contain a PII_KEY_PARTS substring by design. */
const SCHEMA: Record<string, readonly string[]> = {
  case: ['id', 'source', 'sourceRef', 'notes', 'input', 'expected', 'tolerance'],
  input: ['period', 'taxYear', 'employee', 'employerAnnualRemuneration', 'components', 'unmodelled', 'priorPeriods'],
  period: ['year', 'month', 'frequency', 'periodStart', 'periodEnd', 'runKind'],
  /** An earlier period of the tax year (wave-6 F1): its inputs and the line figures a run stored for it. */
  priorPeriod: ['periodStart', 'frequency', 'runKind', 'components', ...PRIOR_FIGURES],
  employee: ['dateOfBirth', 'startDate', 'taxStatus', 'uifExcluded', 'medicalAidMainMember', 'medicalAidDependantsCount', 's18aReceiptHeld'],
  component: ['code', 'name', 'type', 'amount', 'taxable', 'uif', 'sdl'],
  toleranceEntry: ['cents', 'reason', 'engineActual'],
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
  if (at === 'input.components' || at === 'input.priorPeriods.components') return SCHEMA.component!;
  if (at === 'input.priorPeriods') return SCHEMA.priorPeriod!;
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
  validatePeriod(input.period as Obj, input.taxYear as number, file);
  need(isNum(input.employerAnnualRemuneration), file, 'input.employerAnnualRemuneration must be a number');
  need(input.unmodelled === undefined || isObj(input.unmodelled), file, 'input.unmodelled must be an object');
  if (input.unmodelled !== undefined) onlyKeys(input.unmodelled as Obj, UNMODELLED_KEYS, file, 'input.unmodelled');

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
  validateComponents(input.components as unknown[], 'input.components', file);

  if (input.priorPeriods !== undefined) validatePriorPeriods(input.priorPeriods, input.period as Obj, input.taxYear as number, file);

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
      need(isNum((t as Obj).engineActual), file, `tolerance on ${k}: engineActual (the engine's current figure) is required`);
    }
  }
}

function validateComponents(list: unknown[], where: string, file: string): void {
  list.forEach((x, i) => {
    need(isObj(x), file, `${where}[${i}] must be an object`);
    const k = x as Obj;
    onlyKeys(k, SCHEMA.component!, file, `${where}[${i}]`);
    need(typeof k.code === 'string' && typeof k.name === 'string' && (k.type === 'earning' || k.type === 'deduction') && isNum(k.amount)
      && typeof k.taxable === 'boolean' && typeof k.uif === 'boolean' && typeof k.sdl === 'boolean', file,
    `${where}[${i}] needs code, name, type (earning|deduction), amount and boolean taxable/uif/sdl`);
  });
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
/**
 * The SA tax year's last day, and the earliest a period of it may start: a weekly or fortnightly period paid on or after
 * 1 March may begin up to 13 days before it (the 2027 year's first Sunday pay day, 1 March 2026, ends a week begun 23 February).
 */
function taxYearBounds(taxYear: number): { from: string; to: string } {
  const first = new Date(Date.UTC(taxYear - 1, 2, 1 - 13));
  return { from: first.toISOString().slice(0, 10), to: `${taxYear}-02-${taxYear % 4 === 0 ? 29 : 28}` };
}

/** frequency, periodStart/periodEnd (both or neither, inside the tax year, in order) and runKind: each optional, each strict. */
function validatePeriod(period: Obj, taxYear: number, file: string): void {
  onlyKeys(period, SCHEMA.period!, file, 'input.period');
  need(period.frequency === undefined || (FREQUENCIES as readonly unknown[]).includes(period.frequency), file,
    `input.period.frequency must be one of ${FREQUENCIES.join(' | ')}`);
  need(period.runKind === undefined || (RUN_KINDS as readonly unknown[]).includes(period.runKind), file,
    `input.period.runKind must be one of ${RUN_KINDS.join(' | ')}`);
  need((period.periodStart === undefined) === (period.periodEnd === undefined), file, 'input.period needs periodStart and periodEnd together');
  if (period.periodStart === undefined) return;
  need(isDate(period.periodStart) && isDate(period.periodEnd), file, 'input.period.periodStart and periodEnd must be real YYYY-MM-DD dates');
  const { from, to } = taxYearBounds(taxYear);
  const start = period.periodStart as string;
  const end = period.periodEnd as string;
  need(start <= end && start >= from && end <= to, file, `input.period ${start}..${end} must be in order and inside tax year ${taxYear} (${from}..${to})`);
  const month = `${String(period.year)}-${String(period.month).padStart(2, '0')}`;
  need(start.slice(0, 7) <= month && month <= end.slice(0, 7), file, `input.period ${start}..${end} must overlap its pay month ${month}`);
}

/** Each earlier period: strict keys, a real date inside the tax year and not after this period's start, and every figure. */
function validatePriorPeriods(raw: unknown, period: Obj, taxYear: number, file: string): void {
  need(Array.isArray(raw) && raw.length > 0, file, 'input.priorPeriods must be a non-empty array (leave it out for a first period)');
  const { from } = taxYearBounds(taxYear);
  const thisStart = (period.periodStart as string | undefined) ?? `${String(period.year)}-${String(period.month).padStart(2, '0')}-01`;
  let previous = '';
  (raw as unknown[]).forEach((x, i) => {
    const at = `input.priorPeriods[${i}]`;
    need(isObj(x), file, `${at} must be an object`);
    const p = x as Obj;
    onlyKeys(p, SCHEMA.priorPeriod!, file, at);
    need(isDate(p.periodStart) && (p.periodStart as string) >= from && (p.periodStart as string) <= thisStart, file,
      `${at}.periodStart must be a real date from ${from} to this period's start ${thisStart}`);
    need((p.periodStart as string) > previous, file, `${at}.periodStart must be after the previous prior's (${previous}): oldest first, no duplicates`);
    previous = p.periodStart as string;
    need((FREQUENCIES as readonly unknown[]).includes(p.frequency), file, `${at}.frequency must be one of ${FREQUENCIES.join(' | ')}`);
    need((RUN_KINDS as readonly unknown[]).includes(p.runKind), file, `${at}.runKind must be one of ${RUN_KINDS.join(' | ')}`);
    need(Array.isArray(p.components), file, `${at}.components must be an array`);
    validateComponents(p.components as unknown[], `${at}.components`, file);
    for (const f of PRIOR_FIGURES) need(isNum(p[f]), file, `${at}.${f} must be a number`);
  });
}
