import { describe, expect, it } from 'vitest';
import {
  deriveLineCc1, indexLadder, ladderFromBody, type LadderCentre,
} from '@/components/accounting/suppliers/billLineCc1';

/** A row as `GET /api/accounting/cost-centres?detail=dimensions` returns it: the FNO is the server's `fnoCode`. */
const row = (id: string, ccType: string, fnoCode: string | null, isActive = true): LadderCentre =>
  ({ id, code: id.toUpperCase(), name: `Name ${id}`, ccType, fnoCode, isActive });

const ladder = indexLadder([
  row('f1', 'cc1', 'F1'), row('f2', 'cc1', 'F2'), row('fdead', 'cc1', 'FDEAD', false),
  row('p1', 'cc2', 'F1'), row('p2', 'cc2', 'F2'), row('pdead', 'cc2', 'FDEAD'),
  row('orphan', 'cc2', null),
  // ccType arrives as 'cc1' only because the API maps a null cc_type to 'cc1': its fnoCode is what says where it rolls up.
  row('nulltyped', 'cc1', 'F1'),
]);
const none = { cc1Id: '', cc2Id: '' };
const F1 = { label: 'F1 Name f1', note: '' };

describe('deriveLineCc1 follows the server order', () => {
  it('takes the server-derived FNO of the line CC2', () => {
    expect(deriveLineCc1({ cc2Id: 'p1' }, ladder, none)).toEqual(F1);
  });
  it('a line naming no CC takes the supplier default CC2, and shows that CC2 FNO', () => {
    expect(deriveLineCc1({}, ladder, { cc1Id: '', cc2Id: 'p1' })).toEqual(F1);
  });
  it('a line naming no CC and a supplier with only a default CC1 shows that CC1', () => {
    expect(deriveLineCc1({}, ladder, { cc1Id: 'f1', cc2Id: '' })).toEqual(F1);
  });
  it('the supplier default is not applied to a line that names a CC2 of its own', () => {
    expect(deriveLineCc1({ cc2Id: 'orphan' }, ladder, { cc1Id: 'f1', cc2Id: 'p2' })).toBeNull();
  });
  it('the supplier default is not applied to a line that names only a CC1', () => {
    expect(deriveLineCc1({ cc1Id: 'f2' }, ladder, { cc1Id: 'f1', cc2Id: 'p1' })).toEqual({ label: 'F2 Name f2', note: '' });
  });
  it('a CC2 with no FNO ancestor keeps the explicit line CC1', () => {
    expect(deriveLineCc1({ cc1Id: 'f1', cc2Id: 'orphan' }, ladder, none)).toEqual(F1);
  });
  it('a CC2 with no FNO ancestor and no line CC1 shows nothing', () => {
    expect(deriveLineCc1({ cc2Id: 'orphan' }, ladder, none)).toBeNull();
  });
  it('a line carrying both: the CC2 FNO wins when they agree', () => {
    expect(deriveLineCc1({ cc1Id: 'f1', cc2Id: 'p1' }, ladder, none)).toEqual(F1);
  });
  it('a line carrying both that disagree is refused by the server: shown as a conflict, not as fine', () => {
    expect(deriveLineCc1({ cc1Id: 'f2', cc2Id: 'p1' }, ladder, none))
      .toEqual({ label: 'F2 Name f2', note: "conflicts with the project's FNO F1 Name f1, cannot be saved" });
  });
  it('marks an inactive FNO (the server refuses it) instead of showing it as fine', () => {
    expect(deriveLineCc1({ cc2Id: 'pdead' }, ladder, none)).toEqual({ label: 'FDEAD Name fdead', note: 'inactive, cannot be saved' });
  });
  it('marks an inactive line CC1', () => {
    expect(deriveLineCc1({ cc1Id: 'fdead' }, ladder, none)).toEqual({ label: 'FDEAD Name fdead', note: 'inactive, cannot be saved' });
  });
  it('an inactive supplier default CC1 is not applied by the server, so nothing shows', () => {
    expect(deriveLineCc1({}, ladder, { cc1Id: 'fdead', cc2Id: '' })).toBeNull();
  });
  it('uses fnoCode, never the row type: a row typed cc1 only by the null mapping still rolls up via fnoCode', () => {
    expect(deriveLineCc1({ cc2Id: 'nulltyped' }, ladder, none)).toEqual(F1);
  });
  it('shows nothing when nothing names a CC1, or the ids are unknown', () => {
    expect(deriveLineCc1({}, ladder, none)).toBeNull();
    expect(deriveLineCc1({ cc2Id: 'nope' }, ladder, none)).toBeNull();
    expect(deriveLineCc1({ cc1Id: 'nope' }, ladder, none)).toBeNull();
  });
});

describe('ladderFromBody', () => {
  it('reads the master rows, keeping the server fnoCode', () => {
    const body = { items: [{ id: 'a', code: 'A', name: 'An', ccType: 'cc2', isActive: true, fnoCode: 'F', parentId: 'x' }, 7, null] };
    expect(ladderFromBody(body)).toEqual([{ id: 'a', code: 'A', name: 'An', ccType: 'cc2', isActive: true, fnoCode: 'F' }]);
  });
  it('is empty for a body with no items', () => {
    expect(ladderFromBody(null)).toEqual([]);
    expect(ladderFromBody({})).toEqual([]);
  });
});
