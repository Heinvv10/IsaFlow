/**
 * Budgets P5-2 (security review S1): budget figures (remaining, the bill's amount against it) are report
 * data — `budget_variance` needs `read:reports`. An approve tool called by a token without that scope words
 * its budget refusals, warnings and dry-run verdicts by account, slice and month only, with no amounts.
 */
import type { McpToolContext } from '../types';

export const mayReadBudgetFigures = (ctx: Pick<McpToolContext, 'scopes'>): boolean => (ctx.scopes ?? []).includes('read:reports');
