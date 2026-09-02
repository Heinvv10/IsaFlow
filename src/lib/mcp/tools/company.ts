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

/**
 * `list_companies` — which company is this connection actually pointed at?
 *
 * The honest answer is "exactly one, and you cannot change it": a personal
 * access token carries a single `company_id` column, and an OAuth grant binds
 * the token to one company at consent. So this returns ONE row, always. It is
 * not a picker and deliberately does not pretend to be — offering a list an
 * agent cannot choose from would invite exactly the wrong mental model.
 *
 * It exists because the alternative was worse. The active company is invisible
 * to the agent, it changed mid-session during the Velocity Fibre migration,
 * and the agent concluded — confidently and wrongly — that the connector was
 * pointed somewhere else. One call that names the company and its id ends that
 * class of mistake, and gives the caller the value to pass back as the
 * `company_id` assertion on writes.
 */
export const listCompaniesTool: McpTool = {
  name: 'list_companies',
  description:
    'The company this connection is bound to. Always returns exactly ONE company — a token is bound to a single company at grant time and no tool can switch it. ' +
    'Call this first to confirm which entity you are about to write to, and pass the returned id as company_id on write tools to have them refuse if you were wrong.',
  scope: null, // any authenticated token — identity, not data
  write: false,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const company = await getCompany(ctx.companyId); // companyId from ctx ONLY
    if (!company) return toolError(NOT_FOUND);
    return ok({
      companies: [{
        company_id: ctx.companyId,
        name: company.name,
        vat_number: company.vatNumber ?? null,
        base_currency: company.defaultCurrency ?? 'ZAR',
        is_active_company: true,
      }],
      total: 1,
      note: 'This token is bound to this company only; it cannot be switched from a tool argument.',
    });
  },
};
