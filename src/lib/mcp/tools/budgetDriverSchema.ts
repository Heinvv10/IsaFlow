/**
 * The JSON schema of set_budget_drivers' `changes` (budget tools PR 3): one flat object per change whose `op`
 * says which fields it takes (budgetDriverArgs refuses a field another op takes). Accounts, members and cost
 * centres by id or code; driver amounts decimal strings; months YYYY-MM.
 */
import { BAND_ORDER } from '@/modules/accounting/services/budgets/grid/subtotals';
import { DRIVER_OPS, MAX_DRIVER_CHANGES } from './budgetDriverArgs';

import { ID_OR_CODE, REF_TYPE } from './budgetToolArgs';

const MONTH = { type: 'string', description: 'YYYY-MM' };
const ROW = { account: ID_OR_CODE, cc1: ID_OR_CODE, cc2: ID_OR_CODE, bu: ID_OR_CODE };

export const DRIVER_CHANGES_SCHEMA = {
  type: 'array', minItems: 1, maxItems: MAX_DRIVER_CHANGES,
  items: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: [...DRIVER_OPS] },
      ...ROW,
      kind: { type: 'string', enum: ['fixed', 'per_head', 'pct_of_line', 'pct_of_section', 'growth'], description: 'set_driver.' },
      from_month: MONTH, to_month: MONTH,
      rounding_unit: { type: 'integer', enum: [1, 100, 1000], description: 'set_driver (default 1).' },
      amount: { type: 'string', description: 'fixed: rand per month; per_head: rand per head per month. Decimal string.' },
      pct: { type: 'number', description: 'pct_of_line / pct_of_section: percent of the reference; growth: percent per month (4 decimals).' },
      ref: { type: 'object', properties: ROW, required: ['account'], additionalProperties: false, description: 'pct_of_line: the row it reads.' },
      section: { type: 'string', enum: [...BAND_ORDER], description: 'pct_of_section.' },
      scope: { type: 'string', enum: ['same_grain', 'company'], description: 'pct_of_section.' },
      base_month: { ...MONTH, description: 'growth: the month compounding starts from (before from_month).' },
      headcount_cost_centre: { type: [...REF_TYPE, 'null'], description: 'per_head: the headcount\'s cost centre (CC1 or CC2, id or code); absent or null: the company.' },
      month: { type: ['string', 'null'], description: 'reset_override: one month; absent or null: every override of the row.' },
      hire_id: { type: 'string', format: 'uuid', description: 'update_hire / delete_hire.' },
      label: { type: 'string', description: 'add_hire / update_hire: a role (never a person\'s name), 1-120 characters.' },
      cost_centre: { type: [...REF_TYPE, 'null'], description: 'add_hire / update_hire: CC1 or CC2, id or code; absent or null: the company.' },
      start_month: MONTH, end_month: { type: ['string', 'null'], description: 'YYYY-MM; absent or null: open-ended.' },
      fte: { type: 'number', description: 'add_hire / update_hire: more than 0, 2 decimals (default 1).' },
    },
    required: ['op'],
    additionalProperties: false,
  },
} as const;
