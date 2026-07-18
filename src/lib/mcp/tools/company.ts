/**
 * MCP read tool: company_profile. Calls the same companyService the
 * /api/accounting/companies?id= route uses; returns a TRIMMED profile
 * (data minimisation — not the full ~150-field company record).
 */
import type { McpTool } from '../types';
import { getCompany } from '@/modules/accounting/services/core/companyService';
import { NOT_FOUND, ok, toolError } from './toolHelpers';

export const companyProfileTool: McpTool = {
  name: 'company_profile',
  description:
    'Profile of the connected company: name, VAT number, fiscal year start month, base currency, VAT period. Amounts elsewhere are in this currency.',
  scope: null, // any authenticated token
  write: false,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const company = await getCompany(ctx.companyId); // companyId from ctx ONLY
    if (!company) return toolError(NOT_FOUND);
    return ok({
      name: company.name,
      vat_number: company.vatNumber ?? null,
      financial_year_start_month: company.financialYearStart ?? null,
      base_currency: company.defaultCurrency ?? 'ZAR',
      currency_symbol: company.currencySymbol ?? 'R',
      vat_period: company.vatPeriod ?? null,
    });
  },
};
