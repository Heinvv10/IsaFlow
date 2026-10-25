/**
 * BureauSharingConsent — the "share merchant patterns" switch with its consent wording
 * (SHARING_CONSENT_COPY, a DRAFT pending legal review, labelled as such on screen) and the recent changes.
 * Only the owner gets a working switch; everyone else sees the state and why they cannot change it.
 * While the server gate is off (`available` false: MERCHANT_SHARING_ENABLED, pending legal review of the
 * consent copy) it reads "Coming soon - pending legal review" and cannot be switched on; an owner whose
 * bureau is somehow already on can still switch it off.
 */
import {
  SHARING_CONSENT_COPY as COPY, SHARING_CONSENT_STATUS_LABEL,
} from '@/modules/bureau/services/sharingConsentCopy';
import { formatDisplayDateTime } from '@/utils/dateFormat';

interface SettingChange { id: string; changedAt: string; actorName: string | null; oldValue: boolean | null; newValue: boolean }

const onOff = (v: boolean | null) => (v === null ? 'unset' : v ? 'on' : 'off');

export const SHARING_COMING_SOON_LABEL = 'Coming soon - pending legal review';
/** Stored on, but the gate pools nothing (poolEligibility.ts), so it must not read plain "On". */
export const SHARING_PAUSED_LABEL = 'On (paused pending legal review)';

export function BureauSharingConsent({ enabled, canEdit, available, saving, history, onChange }: {
  enabled: boolean;
  canEdit: boolean;
  /** The server gate (GET /api/bureau/settings sharingAvailable). */
  available: boolean;
  saving: boolean;
  history: SettingChange[];
  onChange: (next: boolean) => void;
}) {
  // Gate off: only switching OFF stays possible (and only for the owner).
  const switchable = canEdit && !saving && (available || enabled);
  return (
    <section aria-label="Merchant-pattern sharing" className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-[var(--ff-text-primary)]">{COPY.title}</h2>
          <p className="text-xs text-[var(--ff-text-secondary)] mt-1">{COPY.intro}</p>
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-[var(--ff-text-primary)] shrink-0">
          <input
            type="checkbox"
            role="switch"
            aria-checked={enabled}
            checked={enabled}
            disabled={!switchable}
            onChange={(e) => onChange(e.target.checked)}
            className="h-4 w-4 accent-teal-500"
          />
          {available ? (enabled ? 'On' : 'Off') : (enabled ? SHARING_PAUSED_LABEL : SHARING_COMING_SOON_LABEL)}
        </label>
      </div>
      {!available && !enabled && (
        <p className="text-xs text-[var(--ff-text-tertiary)]">
          Sharing can&apos;t be switched on yet: the consent wording below is waiting for legal review.
        </p>
      )}
      {!available && enabled && (
        <p className="text-xs text-[var(--ff-text-tertiary)]">
          Sharing is paused while the consent wording below is waiting for legal review: nothing is shared.
          {canEdit ? ' You can still switch it off.' : ''}
        </p>
      )}
      {available && !canEdit && (
        <p className="text-xs text-[var(--ff-text-tertiary)]">Only the bureau owner can change this setting.</p>
      )}

      <p className="inline-block rounded bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 text-xs text-amber-500">
        {SHARING_CONSENT_STATUS_LABEL}
      </p>

      <div className="grid gap-4 md:grid-cols-3 text-xs text-[var(--ff-text-secondary)]">
        {([
          [COPY.sharedHeading, COPY.shared],
          [COPY.neverSharedHeading, COPY.neverShared],
          [COPY.controlsHeading, COPY.controls],
        ] as const).map(([heading, items]) => (
          <div key={heading}>
            <h3 className="font-medium text-[var(--ff-text-primary)] mb-1">{heading}</h3>
            <ul className="list-disc pl-4 space-y-1">
              {items.map((t) => <li key={t}>{t}</li>)}
            </ul>
          </div>
        ))}
      </div>

      {history.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-[var(--ff-text-primary)] mb-1">Recent changes</h3>
          <ul className="text-xs text-[var(--ff-text-tertiary)] space-y-0.5">
            {history.map((h) => (
              <li key={h.id}>
                {formatDisplayDateTime(h.changedAt)}: switched {onOff(h.oldValue)} to {onOff(h.newValue)} by {h.actorName ?? 'a user no longer on ISAFlow'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
