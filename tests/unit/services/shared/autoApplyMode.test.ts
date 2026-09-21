/**
 * The per-call application mode, and the order it resolves to.
 *
 * The defect these cover: a supplier or customer bank line that named no
 * document created the payment and applied NOTHING, because the contact's
 * `auto_allocate_strategy` defaults to 'off' and nobody ever sets it. The mode
 * is per call, defaults to FIFO, and the contact's strategy survives only as a
 * way to flip the direction.
 */
import { describe, it, expect } from 'vitest';
import {
  AUTO_APPLY_MODES,
  DEFAULT_AUTO_APPLY,
  parseAutoApplyMode,
  resolveApplicationOrder,
  type AutoApplyMode,
} from '@/modules/accounting/services/shared/autoAllocateStrategy';

describe('parseAutoApplyMode', () => {
  it('accepts exactly the two modes', () => {
    expect(AUTO_APPLY_MODES).toEqual(['fifo', 'none']);
    expect(parseAutoApplyMode('fifo')).toBe('fifo');
    expect(parseAutoApplyMode('none')).toBe('none');
  });

  it('refuses anything else rather than coercing it to a default', () => {
    // A typo that silently became 'fifo' would apply cash nobody asked it to.
    for (const bad of ['FIFO', 'oldest', 'off', '', ' fifo', null, undefined, 3, {}]) {
      expect(parseAutoApplyMode(bad)).toBeNull();
    }
  });

  it('defaults to fifo', () => {
    expect(DEFAULT_AUTO_APPLY).toBe('fifo');
  });
});

describe('resolveApplicationOrder', () => {
  it("applies oldest-first on 'fifo' even when the contact says 'off'", () => {
    // The whole point: 'off' is the column default and it left every payment
    // unapplied in production.
    expect(resolveApplicationOrder('fifo', 'off')).toBe('oldest');
    expect(resolveApplicationOrder('fifo', 'oldest')).toBe('oldest');
  });

  it("lets the contact's 'newest' strategy flip the order", () => {
    expect(resolveApplicationOrder('fifo', 'newest')).toBe('newest');
  });

  it("applies nothing on 'none', whatever the contact says", () => {
    expect(resolveApplicationOrder('none', 'off')).toBeNull();
    expect(resolveApplicationOrder('none', 'oldest')).toBeNull();
    expect(resolveApplicationOrder('none', 'newest')).toBeNull();
  });

  it('is exhaustive over the mode union', () => {
    const modes: AutoApplyMode[] = [...AUTO_APPLY_MODES];
    for (const m of modes) {
      expect([null, 'oldest', 'newest']).toContain(resolveApplicationOrder(m, 'off'));
    }
  });
});
