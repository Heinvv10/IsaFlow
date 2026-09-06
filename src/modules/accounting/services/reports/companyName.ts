/**
 * The company's display name for a report header.
 *
 * One function, because three copies of this query existed — the authenticated
 * pack route, the shared-pack builder and the commentary pack data — and a
 * shared link and the owner's own screen printing DIFFERENT names on the same
 * pack is the kind of defect nobody reports and everybody notices. Two of the
 * three already agreed; the third fell back to 'Company' in a different place.
 *
 * `'Company'` rather than a throw: a header is not worth failing a report over,
 * and a company row that does not exist cannot be reached by a caller whose
 * company_id came from `withAuth` or from a share link row.
 */
import { sql, type DbRow } from '@/lib/neon';

export async function getCompanyName(companyId: string): Promise<string> {
  const rows = (await sql`
    SELECT name FROM companies WHERE id = ${companyId}::uuid LIMIT 1
  `) as DbRow[];
  const name = rows[0]?.name;
  return name === null || name === undefined ? 'Company' : String(name);
}
