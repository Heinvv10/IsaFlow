/** EMP201 drift in the ETI carry (wave 5 ET round 1): compared when recorded; a pre-ET version gets a calculation note. */
import { describe, expect, it } from 'vitest';
import { ETI_CARRY_CALC_NOTE, empEtiDrift } from '@/modules/accounting/services/returns/empEtiDrift';

const carry = (bf: number, used: number, cf = 0, refund = 0) => ({ broughtForward: bf, used, carriedForward: cf, refundClaimable: refund });

describe('empEtiDrift', () => {
  it('a version that recorded the carry is compared field by field', () => {
    const d = empEtiDrift({ etiCarry: carry(1_800, 2_300) }, { totalPAYE: 3_000, totalETI: 500, payePayable: 700, etiCarry: carry(1_500, 2_000) });
    expect(d.fields.map((f) => f.name)).toEqual(['etiCarry.broughtForward', 'etiCarry.used']);
    expect(d.payableExplained).toBe(false);
  });
  it('a pre-ET version whose payable moved only by the calculation gets the note, not a payable drift', () => {
    const d = empEtiDrift({ totalPAYE: 3_000, totalETI: 500, payePayable: 2_500 }, { totalPAYE: 3_000, totalETI: 500, payePayable: 700, etiCarry: carry(1_800, 2_300) });
    expect(d).toEqual({ fields: [], payableExplained: true, notes: [ETI_CARRY_CALC_NOTE] });
  });
  it('a pre-ET version whose runs changed is real drift: no note', () => {
    const d = empEtiDrift({ totalPAYE: 2_800, totalETI: 500, payePayable: 2_300 }, { totalPAYE: 3_000, totalETI: 500, payePayable: 700, etiCarry: carry(1_800, 2_300) });
    expect(d.payableExplained).toBe(false);
    expect(d.notes).toEqual([]);
  });
});
