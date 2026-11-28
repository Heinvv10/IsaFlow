/**
 * R38-3 (round 38): a snapshot (sageTold.ts) keeps a programming error's name and stack, as strings read inside a try; a name or stack
 * getter that throws, or one that is not a string, leaves the snapshot's own. Nothing of the value is read again later.
 */
import { describe, expect, it } from 'vitest';
import { snapshot } from '@/modules/accounting/services/sage-migration/sageTold';
import { hostileValues } from './hostileValues';

describe('R38-3: a snapshot keeps name and stack', () => {
  it('a TypeError: its name and its stack, frozen', () => {
    const real = new TypeError('cannot read x of undefined');
    const s = snapshot(real);
    expect(s).not.toBe(real);
    expect(s.name).toBe('TypeError');
    expect(s.stack).toBe(real.stack);
    expect(Object.isFrozen(s)).toBe(true);
  });
  it('a name or stack getter that throws, or a value that is not a string: the snapshot\'s own, never a throw', () => {
    const e = new Error('x');
    Object.defineProperty(e, 'stack', { value: 42 }); // first: V8 formats the stack (reading the name) when it is replaced
    Object.defineProperty(e, 'name', { get: () => { throw new Error('injected: name'); } });
    const s = snapshot(e);
    expect(s.name).toBe('Error');
    expect(typeof s.stack).toBe('string');
    expect(s.message).toBe('x');
  });
  for (const [what, make] of hostileValues) {
    it(`${what}: never a throw; name and stack strings`, () => {
      const s = snapshot(make());
      expect(typeof s.name).toBe('string');
      expect(typeof s.stack).toBe('string');
    });
  }
});
