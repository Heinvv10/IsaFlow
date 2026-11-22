/** L12 (round 3): an error after a live run may have committed says so. */
import { describe, expect, it } from 'vitest';
import { stopMessage } from '@/modules/accounting/services/sage-migration/sageStopMessage';

describe('stopMessage', () => {
  it('a dry run that stops says only why', () => {
    expect(stopMessage(new Error('boom'), false)).toBe('sage migration stopped: boom');
  });
  it('a live run that stops says the run may have committed, and what to do', () => {
    const m = stopMessage(new Error('boom'), true);
    expect(m).toContain('sage migration stopped: boom');
    expect(m).toMatch(/the live run may already have committed.*check the books.*dry run/s);
  });
  it('a non-Error is stringified', () => {
    expect(stopMessage('plain', false)).toBe('sage migration stopped: plain');
  });
});
