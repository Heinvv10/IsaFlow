import { describe, expect, it } from 'vitest';
import { contactIssues, emailError, phoneError } from '@/components/onboarding/contactValidation';

describe('onboarding contact validation (M18)', () => {
  it('accepts empty optional values', () => {
    expect(contactIssues({ email: '', phone: '' })).toEqual([]);
    expect(contactIssues({ email: '  ', phone: ' ' })).toEqual([]);
  });
  it('accepts valid values', () => {
    expect(emailError('info@acme.co.za')).toBe('');
    expect(phoneError('+27 82 123 4567')).toBe('');
    expect(phoneError('(011) 555-0100')).toBe('');
  });
  it('rejects invalid email', () => {
    for (const v of ['acme', 'a@b', 'a b@c.com', '@c.com', 'a@@c.com']) expect(emailError(v)).not.toBe('');
  });
  it('rejects invalid phone', () => {
    for (const v of ['abc', '12', '082-ABC-1234', '1234567890123456']) expect(phoneError(v)).not.toBe('');
  });
  it('reports one issue per bad field', () => {
    expect(contactIssues({ email: 'x', phone: 'y' })).toHaveLength(2);
  });
});
