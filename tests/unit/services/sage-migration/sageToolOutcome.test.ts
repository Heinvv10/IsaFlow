/** L6 (round 7): a successful tool answer that is not JSON is a failure, never an "ok" with nothing reported. */
import { describe, expect, it } from 'vitest';
import { toolOutcome } from '@/modules/accounting/services/sage-migration/sageToolSession';

describe('toolOutcome', () => {
  it('a JSON object answer is ok with its body', () => {
    expect(toolOutcome('{"created": 3}', false)).toEqual({ isError: false, text: '{"created": 3}', body: { created: 3 } });
  });
  it('a refusal keeps its text and has no body', () => {
    expect(toolOutcome('item code is required', true)).toEqual({ isError: true, text: 'item code is required', body: null });
  });
  it('a success whose text is not JSON fails loudly, naming what came back', () => {
    const r = toolOutcome('<html>502 Bad Gateway</html>', false);
    expect(r.isError).toBe(true);
    expect(r.body).toBeNull();
    expect(r.text).toMatch(/not JSON.*<html>502/s);
  });
  it('a success that is JSON but not an object (null, a list, a number) fails too', () => {
    for (const text of ['null', '[1,2]', '7', '"x"', '']) expect(toolOutcome(text, false).isError).toBe(true);
  });
});
