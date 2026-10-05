/**
 * The bank lines linked to an asset (mig 853): linked to the asset itself, or to one of its fuel / service records.
 * Read-only — powers the "Linked bank transactions" list on the asset page. `null` for an asset that is missing or
 * another company's.
 */
import { sql, type DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { bankTxLinkOf, type BankTxLink } from '../bank/bankTxLink';
import { assetInCompany } from './fleetRecordsService';

export interface AssetBankLine {
  id: string;
  bankAccountId: string;
  bankAccountName: string | null;
  transactionDate: string;
  amount: number;
  description: string | null;
  status: string;
  kind: BankTxLink['kind'];
  link: BankTxLink;
}

export async function listAssetBankLinks(companyId: string, assetId: string): Promise<AssetBankLine[] | null> {
  if (!(await assetInCompany(companyId, assetId))) return null;
  // Three index-backed probes (the partial link indexes; the fleet tables' (company_id, asset_id, date)), not one OR
  // over the company's whole statement.
  const rows = (await sql`
    WITH hits AS (
      SELECT id FROM bank_transactions WHERE linked_asset_id = ${assetId}::UUID AND company_id = ${companyId}::UUID
      UNION ALL
      SELECT bt.id FROM fleet_fuel_transactions f
      JOIN bank_transactions bt ON bt.linked_fleet_fuel_id = f.id AND bt.company_id = f.company_id
      WHERE f.company_id = ${companyId}::UUID AND f.asset_id = ${assetId}::UUID
      UNION ALL
      SELECT bt.id FROM fleet_service_history s
      JOIN bank_transactions bt ON bt.linked_fleet_service_id = s.id AND bt.company_id = s.company_id
      WHERE s.company_id = ${companyId}::UUID AND s.asset_id = ${assetId}::UUID
    )
    SELECT bt.id, bt.bank_account_id, ga.account_name AS bank_account_name, bt.transaction_date, bt.amount,
      bt.description, bt.status, bt.linked_asset_id, bt.linked_fleet_fuel_id, bt.linked_fleet_service_id,
      a.id AS link_asset_id, a.name AS link_asset_name,
      f.fill_date AS link_fill_date, f.amount AS link_fuel_amount, s.description AS link_service_description
    FROM bank_transactions bt
    JOIN assets a ON a.id = ${assetId}::UUID AND a.company_id = bt.company_id
    LEFT JOIN fleet_fuel_transactions f ON f.id = bt.linked_fleet_fuel_id AND f.company_id = bt.company_id
    LEFT JOIN fleet_service_history s ON s.id = bt.linked_fleet_service_id AND s.company_id = bt.company_id
    LEFT JOIN gl_accounts ga ON ga.id = bt.bank_account_id AND ga.company_id = bt.company_id
    WHERE bt.company_id = ${companyId}::UUID AND bt.id IN (SELECT id FROM hits)
    ORDER BY bt.transaction_date DESC, bt.id`) as DbRow[];
  return rows.map((r) => {
    const link = bankTxLinkOf(r)!;
    return {
      id: String(r.id), bankAccountId: String(r.bank_account_id), bankAccountName: r.bank_account_name ? String(r.bank_account_name) : null,
      transactionDate: fmtDate(r.transaction_date), amount: Number(r.amount),
      description: r.description ? String(r.description) : null, status: String(r.status), kind: link.kind, link,
    };
  });
}
