/** SARS source code shapes and labels shared by the admin SARS Codes page, drawer and import wizard. */

export interface ReleaseRow {
  effective_year: number;
  brs_version: string;
  released_at: string;
  is_current: boolean;
  notes: string | null;
  code_count: number;
}

export interface CodeRow {
  code: string;
  effective_year: number;
  category: string;
  description: string;
  status: string;
  foreign_code: string | null;
  code_pair: string | null;
  applicability_note: string | null;
  source_document: string | null;
  source_url: string | null;
  official_excerpt: string | null;
  brs_version: string | null;
  imported_at: string;
  used_by_companies: number;
}

export interface ImportDiff {
  added: string[];
  removed: string[];
  changed: { code: string; field: string; oldValue: string | null; newValue: string | null }[];
}

export interface ImportResult {
  effectiveYear: number;
  brsVersion: string;
  upserted: number;
  diff: ImportDiff;
  setCurrent: boolean;
  rowCount?: number;
  dryRun?: boolean;
}

export const CATEGORY_LABELS: Record<string, string> = {
  income: 'Income',
  allowance: 'Allowance',
  fringe: 'Fringe Benefit',
  employer: 'Employer Contrib.',
  deduction: 'Deduction',
  lump_sum: 'Lump Sum',
};

export const STATUS_BADGE: Record<string, { bg: string; fg: string; label: string }> = {
  active:      { bg: 'bg-emerald-500/10', fg: 'text-emerald-400', label: 'Active' },
  conditional: { bg: 'bg-amber-500/10',   fg: 'text-amber-400',   label: 'Conditional' },
  deprecated:  { bg: 'bg-red-500/10',     fg: 'text-red-400',     label: 'Deprecated' },
};
