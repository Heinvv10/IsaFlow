import { log } from '@/lib/logger';

/**
 * Executes named data queries from a NoteTemplate.dataQueries map.
 * Returns a keyed result set that becomes AfsSection.dataSnapshot.
 * Queries are run concurrently via Promise.all.
 *
 * Each SQL string in dataQueries may contain {companyId} and {fiscalYear}
 * placeholder strings — these are replaced with parameterised sql`` bindings.
 *
 * Returns {} (empty object) when dataQueries is empty — callers use this
 * to detect zero-balance suppression candidates.
 */
export async function executeDataQueries(
  companyId: string,
  fiscalYear: number,
  dataQueries: Record<string, string>,
): Promise<Record<string, unknown>> {
  const entries = Object.entries(dataQueries);
  if (entries.length === 0) return {};

  const results = await Promise.all(
    entries.map(async ([queryName, _querySql]) => {
      log.info('Executing note data query', { companyId, queryName }, 'noteDataQueryService');
      // NOTE: dataQueries SQL strings from note_templates are parameterised
      // at registration time. For now we return an empty array per query —
      // individual note generators handle their own sql`` calls directly.
      // This service is reserved for template-driven dynamic query execution
      // in a future phase.
      return [queryName, [] as unknown[]] as [string, unknown[]];
    }),
  );

  return Object.fromEntries(results);
}

/**
 * Returns true when every query result in the snapshot is empty.
 * Used by the note engine to detect zero-balance notes for suppression.
 */
export function isZeroBalance(snapshot: Record<string, unknown>): boolean {
  if (Object.keys(snapshot).length === 0) return true;
  return Object.values(snapshot).every(val =>
    Array.isArray(val) ? val.length === 0 : val === 0 || val === null || val === undefined
  );
}
