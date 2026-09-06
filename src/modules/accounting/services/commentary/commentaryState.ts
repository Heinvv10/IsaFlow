/**
 * The only place a commentary status changes.
 *
 * The rule this encodes: text that a named person approved is not replaced by
 * a machine without a second, explicit human act. `generate` on an approved row
 * FAILS; `regenerate` succeeds and returns `withdrawsApproval`.
 *
 * WITHDRAWS, not clears. Migration 612 changed what the caller does with it:
 * the approval columns are LEFT ALONE and `withdrawn_by` / `withdrawn_at` are
 * stamped instead, so the record of who put their name to that sentence
 * survives the act of taking it back. The row moves to 'draft', which is what
 * keeps it off the share link — `sharedPackService` filters on
 * `status = 'approved'` — while the database can still answer "who signed off,
 * and who withdrew it?".
 */
export type CommentaryStatus = 'draft' | 'approved' | 'rejected';
export type CommentaryAction = 'generate' | 'regenerate' | 'approve' | 'reject';

export type Transition =
  | { ok: true; next: CommentaryStatus; withdrawsApproval: boolean }
  | { ok: false; reason: string };

export function nextStatus(current: CommentaryStatus | null, action: CommentaryAction): Transition {
  switch (action) {
    case 'generate':
      if (current === 'approved') {
        return { ok: false, reason: 'This commentary is approved. Use regenerate to withdraw the approval first.' };
      }
      return { ok: true, next: 'draft', withdrawsApproval: false };

    case 'regenerate':
      if (current !== 'approved') {
        return { ok: false, reason: 'Nothing to withdraw: this commentary is not approved.' };
      }
      return { ok: true, next: 'draft', withdrawsApproval: true };

    case 'approve':
      if (current !== 'draft') {
        return { ok: false, reason: `Only a draft can be approved (this one is ${current ?? 'missing'}).` };
      }
      return { ok: true, next: 'approved', withdrawsApproval: false };

    case 'reject':
      if (current !== 'draft') {
        return { ok: false, reason: `Only a draft can be rejected (this one is ${current ?? 'missing'}).` };
      }
      return { ok: true, next: 'rejected', withdrawsApproval: false };
  }
}
