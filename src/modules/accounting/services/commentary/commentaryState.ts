/**
 * The only place a commentary status changes.
 *
 * The rule this encodes: text that a named person approved is not replaced by
 * a machine without a second, explicit human act. `generate` on an approved row
 * FAILS; `regenerate` succeeds and returns clearsApproval, which the caller
 * turns into approved_text = NULL. So an approved sentence is either still on
 * the share link or was deliberately withdrawn — it is never quietly swapped
 * for a newer one the approver has not read.
 */
export type CommentaryStatus = 'draft' | 'approved' | 'rejected';
export type CommentaryAction = 'generate' | 'regenerate' | 'approve' | 'reject';

export type Transition =
  | { ok: true; next: CommentaryStatus; clearsApproval: boolean }
  | { ok: false; reason: string };

export function nextStatus(current: CommentaryStatus | null, action: CommentaryAction): Transition {
  switch (action) {
    case 'generate':
      if (current === 'approved') {
        return { ok: false, reason: 'This commentary is approved. Use regenerate to withdraw the approval first.' };
      }
      return { ok: true, next: 'draft', clearsApproval: false };

    case 'regenerate':
      if (current !== 'approved') {
        return { ok: false, reason: 'Nothing to withdraw: this commentary is not approved.' };
      }
      return { ok: true, next: 'draft', clearsApproval: true };

    case 'approve':
      if (current !== 'draft') {
        return { ok: false, reason: `Only a draft can be approved (this one is ${current ?? 'missing'}).` };
      }
      return { ok: true, next: 'approved', clearsApproval: false };

    case 'reject':
      if (current !== 'draft') {
        return { ok: false, reason: `Only a draft can be rejected (this one is ${current ?? 'missing'}).` };
      }
      return { ok: true, next: 'rejected', clearsApproval: false };
  }
}
