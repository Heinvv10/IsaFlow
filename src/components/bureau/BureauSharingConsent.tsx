/**
 * BureauSharingConsent — the "share merchant patterns" switch with its consent wording
 * (SHARING_CONSENT_COPY, a DRAFT pending legal review, labelled as such on screen) and the recent changes.
 * Only the owner gets a working switch; everyone else sees the state and why they cannot change it.
 */
import {
  SHARING_CONSENT_COPY as COPY, SHARING_CONSENT_STATUS_LABEL,
} from '@/modules/bureau/services/sharingConsentCopy';

interface SettingChange { id: string; changedAt: string; actorName: string | null; oldValue: boolean | null; newValue: boolean }

const onOff = (v: boolean | null) => (v === null ? 'unset' : v ? 'on' : 'off');

export function BureauSharingConsent({ enabled, canEdit, saving, history, onChange }: {
  enabled: boolean;
  canEdit: boolean;
  saving: boolean;
  history: SettingChange[];
  onChange: (next: boolean) => void;
}) {
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
            disabled={!canEdit || saving}
            onChange={(e) => onChange(e.target.checked)}
            className="h-4 w-4 accent-teal-500"
          />
          {enabled ? 'On' : 'Off'}
        </label>
      </div>
      {!canEdit && (
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
                {new Date(h.changedAt).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })}: switched {onOff(h.oldValue)} to {onOff(h.newValue)} by {h.actorName ?? 'a user no longer on ISAFlow'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
