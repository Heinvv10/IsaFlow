/**
 * "Budget by CC1… / Budget at company level…" (spec §11): confirms clearing an account's amounts
 * at its current grain, optionally carrying the per-month totals onto the new grain (the picked
 * member, or company level), and applies it as ONE batch / undo entry. PY-share distribution
 * across members is not in P2 (spec leaves it to the agent).
 */
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { formatStatementFigure } from '@/lib/format/money';
import type { CellWriteByKey, GrainChange } from './rowActionWrites';

export interface GrainChangeTarget {
  /** "1000 Sales" */
  accountLabel: string;
  /** "CC1 Alpha" / "company level" */
  toLabel: string;
  /** "per cost centre" / "at company level" */
  enterHint: string;
  build(carry: boolean): GrainChange;
}

interface GrainChangeDialogProps {
  target: GrainChangeTarget;
  onApply(writes: CellWriteByKey[], announcement: string): void;
  onClose(): void;
}

export function GrainChangeDialog({ target, onApply, onClose }: GrainChangeDialogProps) {
  const [carry, setCarry] = useState(true);
  const change = target.build(carry);
  const rand = `R ${formatStatementFigure(change.clearedCents / 100, { cents: true })}`;
  const months = `${change.clearedMonths} month${change.clearedMonths === 1 ? '' : 's'}`;
  return (
    <Modal open onClose={onClose} title={`Budget ${target.accountLabel} ${target.toLabel === 'company level' ? 'at company level' : `by ${target.toLabel}`}`} size="md">
      <Modal.Body className="space-y-3 text-sm text-[var(--ff-text-secondary)]">
        <p>
          This clears {rand} across {months} at the current grain. You then enter amounts {target.enterHint}.
        </p>
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={carry} onChange={e => setCarry(e.target.checked)} className="mt-0.5" />
          <span>Put the current amounts on {target.toLabel} instead of clearing them</span>
        </label>
        <p className="text-xs text-[var(--ff-text-tertiary)]">One change: undo reverses all of it. Nothing is saved until you save.</p>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="button" onClick={() => onApply(change.writes, `${target.accountLabel} now budgeted ${target.enterHint}`)}>
          Change grain
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
