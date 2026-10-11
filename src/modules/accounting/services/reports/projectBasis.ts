/**
 * The two Project Profitability bases (Hein, 2026-10-10): `jobs` — the job a
 * line carries (`jl.project_id`, a `projects` row), the default everywhere —
 * and `cc2`, the CC2 cost-centre dimension. See projectProfitabilityService.ts.
 */
export const PROJECT_BASES = ['jobs', 'cc2'] as const;
export type ProjectBasis = (typeof PROJECT_BASES)[number];

export function isProjectBasis(v: unknown): v is ProjectBasis {
  return typeof v === 'string' && (PROJECT_BASES as readonly string[]).includes(v);
}
