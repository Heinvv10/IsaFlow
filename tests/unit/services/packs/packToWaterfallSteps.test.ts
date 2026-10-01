/**
 * The bridge's steps are CHECKED, not cast: a step that is not what a chart can
 * draw is refused by index, naming what is wrong with it.
 */
import { describe, expect, it } from 'vitest';
import { MissingPackFieldError, packToWaterfallSteps } from '@/modules/accounting/services/packs/packSectionData';

const ok = { label: 'Revenue', start: 0, end: 10, value: 10, isSubtotal: false, color: 'green' };

describe('packToWaterfallSteps', () => {
  it('returns well-formed steps, including an optional numeric labelValue and none at all', () => {
    expect(packToWaterfallSteps({ steps: [ok, { ...ok, labelValue: -3 }] })).toHaveLength(2);
    expect(packToWaterfallSteps({ steps: [] })).toEqual([]);
  });

  it.each([
    ['a missing steps field', {}, 'steps'],
    ['a steps field that is not an array', { steps: 'x' }, 'steps'],
    ['a null step', { steps: [ok, null] }, 'steps[1]'],
    ['a step with a numeric label', { steps: [{ ...ok, label: 4 }] }, 'steps[0]'],
    ['an infinite value', { steps: [{ ...ok, value: Infinity }] }, 'steps[0]'],
    ['a string start', { steps: [{ ...ok, start: '0' }] }, 'steps[0]'],
    ['a missing isSubtotal', { steps: [{ ...ok, isSubtotal: undefined }] }, 'steps[0]'],
    ['an unknown colour', { steps: [ok, ok, { ...ok, color: 'pink' }] }, 'steps[2]'],
    ['a non-numeric labelValue', { steps: [{ ...ok, labelValue: 'x' }] }, 'steps[0]'],
  ])('refuses %s, naming %s', (_what, data, field) => {
    let caught: unknown;
    try { packToWaterfallSteps(data as Record<string, unknown>); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(MissingPackFieldError);
    expect((caught as MissingPackFieldError).field).toBe(field);
  });
});
