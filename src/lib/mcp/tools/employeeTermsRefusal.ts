/**
 * create_employee / update_employee do not take the work terms of migration 967 (tax status, pay basis, hours,
 * rates, occupation). The tool schemas say additionalProperties:false but the registry does not enforce it, so an
 * unknown argument would be dropped silently and the agent would believe the term was set. Refused by name instead.
 */
import type { McpToolResult } from '../types';
import { toolError } from './toolHelpers';

const TERM_ARGS = ['tax_status', 'pay_basis', 'hours_per_week', 'hours_per_day', 'hourly_rate', 'daily_rate', 'occupation', 'eti_id_document'] as const;
/** Either spelling: the REST body's camelCase is refused as well as the tool's snake_case. */
const camel = (k: string) => k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
const SPELLINGS: readonly string[] = TERM_ARGS.flatMap((k) => [k, camel(k)]);

export function refuseEmployeeTermArgs(args: Record<string, unknown>): McpToolResult | null {
  // "director" is a tax status (the engine reads tax_status, not employment_type), and this tool cannot set one: a director made here
  // would be an employee on the tables with a contradicting label, which the pay run refuses to approve (DIRECTOR_STATUS_NOT_SET).
  const isDirector = (v: unknown) => typeof v === 'string' && v.trim().toLowerCase() === 'director';
  if (isDirector(args.employment_type) || isDirector(args.employmentType)) {
    return toolError('employment_type director cannot be set through this tool: create the employee as permanent, contract or casual, then set the tax status to Director on the employee profile.');
  }
  const given = Object.keys(args).filter((k) => SPELLINGS.includes(k) && args[k] !== undefined);
  if (given.length === 0) return null;
  return toolError(`${given.join(', ')} cannot be set through this tool yet: set the work terms on the employee profile.`);
}
