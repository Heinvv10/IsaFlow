import { sql } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import type { JournalLineInput } from '../../types/gl.types';

/** Validate new CC1/CC2 references without excluding inactive historical coding. */
export async function assertJournalCostCentres(companyId: string, lines: JournalLineInput[]): Promise<void> {
  const supplied = lines.flatMap(line => [line.cc1Id, line.cc2Id])
    .filter(id => id !== undefined && id !== null && id !== '');
  if (supplied.length === 0) return;
  const message = 'Cost centre must belong to this company';
  if (supplied.some(id => typeof id !== 'string' || !UUID_RE.test(id))) throw new Error(message);
  const ids = [...new Set(supplied.map(id => id!.toLowerCase()))];
  const owned = await sql`
    SELECT id FROM cost_centres
    WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])
  `;
  if (owned.length !== ids.length) throw new Error(message);
}
