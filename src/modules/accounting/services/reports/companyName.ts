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
 *
 * An EMPTY name takes the same fallback. `companies.name` is not constrained
 * against `''` or a run of spaces, and one of the three call sites this
 * replaced used to fall back for that too — without this, a company saved with
 * a blank name prints a blank line where the company's name belongs, on a
 * document that gets sent to a bank.
 */
import { sql, type DbRow } from '@/lib/neon';

export async function getCompanyName(companyId: string): Promise<string> {
  const rows = (await sql`
    SELECT name FROM companies WHERE id = ${companyId}::uuid LIMIT 1
  `) as DbRow[];
  const name = rows[0]?.name;
  const trimmed = name === null || name === undefined ? '' : String(name).trim();
  return trimmed === '' ? 'Company' : trimmed;
}
