/**
 * The ONE code path that builds financial years and their periods.
 *
 * A year is generated on demand from the company's template (migration 942's
 * fiscal_year_ensure + fiscal_periods_generate, over 940's
 * fiscal_year_template): when onboarding completes, when a tenant is
 * provisioned, when a posting lands in a year that does not exist yet, and when
 * an admin creates a year by label. Companies are no longer pre-seeded
 * (migration 942). tests/unit/guards/fiscalPeriodWriterCensus.test.ts fails the
 * build when anything else INSERTs into fiscal_periods or fiscal_years.
 *
 * Concurrency is the database's: two first postings into the same new year
 * both call fiscal_year_ensure, one INSERT wins and the other reads its row
 * (ON CONFLICT DO NOTHING, the overlap EXCLUDE included); the periods are
 * filled the same way. Neither caller sees an error.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

/** A pg client inside the caller's own transaction (provisioning's admin client). */
export interface GeneratorClient {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

export interface GeneratedYear {
  fiscalYearId: string;
  /** Periods this call created (0 when the year was already complete). */
  periodsCreated: number;
}

/** The year holding `date`, created from the template with every month's period if missing. */
export async function generateFiscalYearForDate(
  companyId: string,
  date: string | Date,
  client?: GeneratorClient,
): Promise<GeneratedYear> {
  const day = fmtDate(date);
  let fiscalYearId: string;
  let periodsCreated: number;
  if (client) {
    const y = await client.query<{ id: string }>('SELECT public.fiscal_year_ensure($1::UUID, $2::DATE) AS id', [companyId, day]);
    fiscalYearId = String(y.rows[0]!.id);
    const n = await client.query<{ n: number }>('SELECT public.fiscal_periods_generate($1::UUID) AS n', [fiscalYearId]);
    periodsCreated = Number(n.rows[0]!.n);
  } else {
    // The request's own connection: its transaction and RLS.
    const y = (await sql`SELECT public.fiscal_year_ensure(${companyId}::UUID, ${day}::DATE) AS id`) as DbRow[];
    fiscalYearId = String(y[0]!.id);
    const n = (await sql`SELECT public.fiscal_periods_generate(${fiscalYearId}::UUID) AS n`) as DbRow[];
    periodsCreated = Number(n[0]!.n);
  }
  return { fiscalYearId, periodsCreated };
}
