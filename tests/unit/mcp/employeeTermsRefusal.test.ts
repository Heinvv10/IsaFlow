/** create_employee / update_employee name the work terms they do not take, instead of dropping them silently. */
import { describe, expect, it } from 'vitest';
import { refuseEmployeeTermArgs } from '@/lib/mcp/tools/employeeTermsRefusal';

describe('refuseEmployeeTermArgs', () => {
  it('passes arguments that carry no work term', () => {
    expect(refuseEmployeeTermArgs({ first_name: 'A', employment_type: 'permanent' })).toBeNull();
  });

  it('refuses employment_type director, in either spelling: the tax status is what makes a director', () => {
    for (const args of [{ employment_type: 'director' }, { employmentType: 'director' }]) {
      const out = refuseEmployeeTermArgs(args);
      expect(out?.isError).toBe(true);
      expect(JSON.stringify(out)).toContain('tax status to Director');
    }
  });

  it('refuses the camelCase spelling too', () => {
    const out = refuseEmployeeTermArgs({ taxStatus: 'director', hourlyRate: 10 });
    expect(JSON.stringify(out)).toContain('taxStatus, hourlyRate');
  });

  it('refuses each term by name', () => {
    const out = refuseEmployeeTermArgs({ tax_status: 'director', occupation: 'Welder', hourly_rate: 0 });
    expect(out?.isError).toBe(true);
    expect(JSON.stringify(out)).toContain('tax_status, occupation, hourly_rate');
  });
});
