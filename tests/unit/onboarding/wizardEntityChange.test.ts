/**
 * Changing the business type in the wizard (withEntityType) never carries over data the new
 * type does not use: a CIPC certificate does not ride along into a sole proprietor's request
 * (the server would refuse it), people are capped and take the new role, and a registration
 * number is cleared when the new type has none.
 */
import { describe, expect, it } from 'vitest';
import { INITIAL_WIZARD, withEntityType, type WizardData } from '@/components/onboarding/wizardTypes';

const docOf = (type: string) => ({ type, name: `${type}.pdf`, data: 'data:application/pdf;base64,JVBERg==', mimeType: 'application/pdf', size: 4 });
const filled: WizardData = {
  ...INITIAL_WIZARD, entityType: 'pty_ltd', registrationNumber: '2020/123456/07',
  directors: [{ name: 'Person A', idNumber: '', role: 'Director' }, { name: 'Person B', idNumber: '', role: 'Director' }],
  documents: [docOf('cipc_certificate'), docOf('tax_clearance')],
};

describe('withEntityType', () => {
  it('pty_ltd -> sole proprietor: CIPC certificate and registration number dropped, one owner kept', () => {
    const d = withEntityType(filled, 'sole_proprietor');
    expect(d.entityType).toBe('sole_proprietor');
    expect(d.documents.map(x => x.type)).toEqual(['tax_clearance']);
    expect(d.registrationNumber).toBe('');
    expect(d.directors).toEqual([{ name: 'Person A', idNumber: '', role: 'Owner' }]);
  });
  it('pty_ltd -> trust: everyone becomes a trustee, the registration number field is kept', () => {
    const d = withEntityType(filled, 'trust');
    expect(d.directors.map(p => p.role)).toEqual(['Trustee', 'Trustee']);
    expect(d.registrationNumber).toBe('2020/123456/07');
    expect(d.documents.map(x => x.type)).toEqual(['tax_clearance']);
  });
  it('pty_ltd -> npc keeps the CIPC certificate (same proof)', () => {
    expect(withEntityType(filled, 'npc').documents.map(x => x.type)).toEqual(['cipc_certificate', 'tax_clearance']);
  });
});
