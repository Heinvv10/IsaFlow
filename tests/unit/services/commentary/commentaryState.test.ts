import { describe, it, expect } from 'vitest';
import {
  nextStatus,
  type CommentaryStatus,
  type CommentaryAction,
} from '@/modules/accounting/services/commentary/commentaryState';

type ExpectedOk = { ok: true; next: CommentaryStatus; withdrawsApproval: boolean };

// Every cell of the 4 states x 4 actions table. `false` means the transition
// must be refused (Transition.ok === false); anything else pins the exact
// { next, withdrawsApproval } the transition must produce.
const table: Array<[CommentaryStatus | null, CommentaryAction, ExpectedOk | false]> = [
  // generate: create/re-create a draft, unless a human has already approved it
  [null, 'generate', { ok: true, next: 'draft', withdrawsApproval: false }],
  ['draft', 'generate', { ok: true, next: 'draft', withdrawsApproval: false }],
  ['approved', 'generate', false],
  ['rejected', 'generate', { ok: true, next: 'draft', withdrawsApproval: false }],

  // regenerate: the only path that withdraws an approval, so it requires one
  [null, 'regenerate', false],
  ['draft', 'regenerate', false],
  ['approved', 'regenerate', { ok: true, next: 'draft', withdrawsApproval: true }],
  ['rejected', 'regenerate', false],

  // approve: only a draft can be approved, and only once
  [null, 'approve', false],
  ['draft', 'approve', { ok: true, next: 'approved', withdrawsApproval: false }],
  ['approved', 'approve', false],
  ['rejected', 'approve', false],

  // reject: only a draft can be rejected
  [null, 'reject', false],
  ['draft', 'reject', { ok: true, next: 'rejected', withdrawsApproval: false }],
  ['approved', 'reject', false],
  ['rejected', 'reject', false],
];

describe('nextStatus', () => {
  it.each(table)('%s x %s', (current, action, expected) => {
    const result = nextStatus(current, action);
    if (expected === false) {
      expect(result.ok).toBe(false);
    } else {
      expect(result).toEqual(expected);
    }
  });

  it('refuses to silently overwrite approved text with a new draft, and says why', () => {
    const t = nextStatus('approved', 'generate');
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.reason).toContain('approved');
  });
});
