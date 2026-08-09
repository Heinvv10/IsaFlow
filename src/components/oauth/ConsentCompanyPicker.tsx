/**
 * Consent company picker — the "which company does this apply to" block on the
 * OAuth authorize screen. Extracted from pages/oauth/authorize.tsx to keep that
 * file under the 300-line cap, same as ConsentScopeList.
 *
 * A grant is pinned to ONE company for the life of the token (bearerPipeline
 * pushes it into the RLS GUC per request and never re-reads a cookie), so this
 * block exists to make the target tenant visible rather than implied by
 * whatever company happened to be active in the browser. A single-company user
 * gets a plain statement — a dropdown with one option is noise, not a choice.
 */
import type { ConsentCompany } from '@/lib/auth/consentCompany';

interface Props {
  companies: ConsentCompany[];
  value: string;
  onChange: (companyId: string) => void;
  disabled: boolean;
  /** App name, used to say plainly what this app will and won't see. */
  appName: string;
}

export function ConsentCompanyPicker({ companies, value, onChange, disabled, appName }: Props) {
  const multiple = companies.length > 1;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-3">
      <label
        htmlFor="consent-company"
        className="block text-xs uppercase tracking-wide text-slate-500 mb-1.5"
      >
        Company this access applies to
      </label>

      {multiple ? (
        <>
          <select
            id="consent-company"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100 disabled:opacity-50"
          >
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-500 mt-1.5">
            {appName} will only ever see this company. To grant another, authorise it separately.
          </p>
        </>
      ) : (
        <p id="consent-company" className="text-sm text-slate-100">
          {companies[0]?.name}
        </p>
      )}
    </div>
  );
}
