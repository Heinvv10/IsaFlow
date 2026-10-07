/**
 * The VAT input / output account for a bank allocation, with the pre-migration-327
 * code fallback. Moved verbatim from bankAllocationService.ts (file-size cap).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getSystemAccountId } from '../gl/systemAccountResolver';

type Row = DbRow;

// ── VAT account fallback resolver ──────────────────────────────────────────
//
// Migration 327 normalises account_subtype to 'vat_input' / 'vat_output'.
// If a company's COA pre-dates that migration, we fall back to the standard
// SA account codes (1140 / 2120).  If still not found, we throw a clear error.

const VAT_FALLBACK_CODES: Record<'vat_input' | 'vat_output', string> = {
  vat_input: '1140',
  vat_output: '2120',
};

export async function resolveVatAccountId(
  key: 'vat_input' | 'vat_output',
  companyId: string,
): Promise<string> {
  try {
    return await getSystemAccountId(key, companyId);
  } catch {
    // Subtype lookup failed — try the well-known SA account code as fallback.
    const code = VAT_FALLBACK_CODES[key];
    const rows = (await sql`
      SELECT id FROM gl_accounts
      WHERE company_id = ${companyId}::UUID
        AND is_system_account = true
        AND account_code = ${code}
      LIMIT 1
    `) as Row[];
    if (rows.length > 0 && rows[0]!.id) {
      log.warn(
        `VAT account '${key}' found via account_code fallback (code=${code}); run migration 327 to normalise subtypes.`,
        { companyId },
        'accounting',
      );
      return String(rows[0]!.id);
    }
    throw new Error(
      `VAT Input system account not found for company ${companyId}. ` +
      `Create a system account with account_subtype='${key}' or account_code='${code}' (migration 327).`,
    );
  }
}
