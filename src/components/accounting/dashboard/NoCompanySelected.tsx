/**
 * NoCompanySelected: what the dashboard shows when company loading has
 * FINISHED and there is still no active company (the 2026-10-16 incident: the
 * session's company had been soft-deleted, so every company-scoped call
 * answered 403). Says what happened and gives a way out, never a spinner.
 */

export interface NoCompanySelectedProps {
  companies: Array<{ companyId: string; companyName?: string | null }>;
  onSwitch: (companyId: string) => void;
  onSetUp: () => void;
}

export function NoCompanySelected({ companies, onSwitch, onSetUp }: NoCompanySelectedProps) {
  return (
    <div className="p-6">
      <div className="max-w-xl rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] p-6">
        <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">No company selected</h1>
        {companies.length > 0 ? (
          <>
            <p className="mt-2 text-sm text-[var(--ff-text-secondary)]">
              We couldn&apos;t open the company this session was pointed at. It may have been
              removed. Choose one of your companies to carry on.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {companies.map((c) => (
                <button
                  key={c.companyId}
                  type="button"
                  onClick={() => onSwitch(c.companyId)}
                  className="rounded-lg border border-[var(--ff-border-primary)] px-3 py-2 text-sm text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-primary)]"
                >
                  {c.companyName || c.companyId}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-[var(--ff-text-secondary)]">
              You don&apos;t have access to any company yet. Set one up to get started, or ask
              whoever administers your account to invite you.
            </p>
            <button
              type="button"
              onClick={onSetUp}
              className="mt-4 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              Set up a company
            </button>
          </>
        )}
      </div>
    </div>
  );
}
