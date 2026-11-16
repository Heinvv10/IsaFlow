/** The strict query parser of GET /api/payroll/pre-validation (wave 6 PV): every key accounted for, the rest refused. */
import type { NextApiRequest } from 'next';
import type { PreValidationScope } from './preValidationService';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEYS = new Set(['taxYear', 'employeeId', 'runId']);

/** The scope, or the reason it is refused. */
export function parsePreValidationQuery(query: NextApiRequest['query']): PreValidationScope | string {
  const scope: PreValidationScope = {};
  for (const [key, value] of Object.entries(query)) {
    if (!KEYS.has(key)) return 'Unknown query parameter: only taxYear, employeeId and runId are accepted';
    if (typeof value !== 'string') return `${key} must be given once`;
    if (key === 'taxYear') {
      if (!/^\d{4}$/.test(value) || Number(value) < 2000 || Number(value) > 2100) return 'taxYear must be a year between 2000 and 2100';
      scope.taxYear = Number(value);
    } else {
      if (!UUID.test(value)) return `${key} must be a UUID`;
      scope[key as 'employeeId' | 'runId'] = value;
    }
  }
  if (scope.employeeId && scope.runId) return 'Give employeeId or runId, not both';
  if (scope.runId && scope.taxYear !== undefined) return 'A run decides its own tax year: give runId without taxYear';
  return scope;
}
