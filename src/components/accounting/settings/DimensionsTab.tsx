import { Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { Toggle, SECTION_CLS } from './settingsTypes';

interface Props {
  enableCC: boolean;
  enableBU: boolean;
  dimLoaded: boolean;
  onCCChange: (v: boolean) => void;
  onBUChange: (v: boolean) => void;
}

async function saveDimensionSetting(key: string, value: boolean) {
  await apiFetch('/api/accounting/accounting-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value: String(value) }),
  });
}

export function DimensionsTab({ enableCC, enableBU, dimLoaded, onCCChange, onBUChange }: Props) {
  const handleCC = (v: boolean) => {
    onCCChange(v);
    void saveDimensionSetting('enable_cost_centres', v);
  };

  const handleBU = (v: boolean) => {
    onBUChange(v);
    void saveDimensionSetting('enable_business_units', v);
  };

  return (
    <div className={SECTION_CLS}>
      <h3 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-1">Reporting Dimensions</h3>
      <p className="text-sm text-[var(--ff-text-secondary)] mb-6">
        Enable cost centre and business unit tracking to tag transactions and filter reports by these dimensions.
      </p>

      {!dimLoaded ? (
        <div className="flex items-center gap-2 text-[var(--ff-text-tertiary)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading...</div>
      ) : (
        <div className="space-y-6">
          {/* Cost Centres */}
          <div className="flex items-start justify-between gap-4 p-4 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)]">
            <div>
              <h4 className="text-sm font-semibold text-[var(--ff-text-primary)]">Cost Centre Tracking (CC1 &amp; CC2)</h4>
              <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
                CC1 is typically used for client or division-level tracking. CC2 for project or sub-division.
                Shows CC1 and CC2 columns on bank transactions, journal entries, and enables filtering on reports.
              </p>
              {enableCC && (
                <a href="/accounting/cost-centres" className="text-xs text-blue-400 hover:text-blue-300 mt-2 inline-block">
                  Manage Cost Centres →
                </a>
              )}
            </div>
            <Toggle checked={enableCC} onChange={handleCC} label="" />
          </div>

          {/* Business Units */}
          <div className="flex items-start justify-between gap-4 p-4 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)]">
            <div>
              <h4 className="text-sm font-semibold text-[var(--ff-text-primary)]">Business Unit Tracking</h4>
              <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
                Tag transactions by department or business unit. Shows a BU column on bank transactions and journal entries,
                and enables BU filtering on financial reports.
              </p>
              {enableBU && (
                <a href="/accounting/business-units" className="text-xs text-blue-400 hover:text-blue-300 mt-2 inline-block">
                  Manage Business Units →
                </a>
              )}
            </div>
            <Toggle checked={enableBU} onChange={handleBU} label="" />
          </div>
        </div>
      )}
    </div>
  );
}
