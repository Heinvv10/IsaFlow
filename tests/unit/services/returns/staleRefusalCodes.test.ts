/** The stale-return refusal codes are one list: the server throws them, the lifecycle dialog reloads on exactly them. */
import { expect, it } from 'vitest';
import { STALE_RETURN_REFUSAL, STALE_RETURN_REFUSAL_CODES } from '@/modules/accounting/services/returns/returnVersionTypes';

it('lists each stale code once, by its own name', () => {
  expect([...STALE_RETURN_REFUSAL_CODES].sort()).toEqual(['ALREADY_AMENDED', 'ALREADY_FILED', 'LIVE_VERSION_EXISTS', 'VERSION_SUPERSEDED']);
  for (const [k, v] of Object.entries(STALE_RETURN_REFUSAL)) expect(v).toBe(k);
});
