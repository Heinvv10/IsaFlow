/**
 * The income statement body — every band, in the order a reader reconciles
 * them: Turnover, Cost of Sales, Gross Profit, Other Income, Operating
 * Expenses, Operating Profit, Other Expenses, Net Profit.
 *
 * Its own file so the ORDER and the presence of each band are testable without
 * dragging the page's layout and font imports into a unit test. Four of the
 * five surfaces that render these bands had no test at all: a whole section
 * could be deleted with the full suite green, which is how the statutory AFS
 * statement came to be missing two bands and stopped footing.
 */
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { IncomeStatementReport, IncomeStatementLineItem } from '@/modules/accounting/types/gl.types';
import { AccountDrillDown } from '@/components/accounting/AccountDrillDown';
import { DataQualityNotice } from '@/components/accounting/DataQualityNotice';
import { formatCurrency } from '@/utils/formatters';

/**
 * The statement body — every band, in the order a reader reconciles them:
 * Turnover, Cost of Sales, Gross Profit, Other Income, Operating Expenses,
 * Operating Profit, Other Expenses, Net Profit.
 *
 * Extracted from the page so the ORDER and the presence of each band are
 * testable. Four of the five surfaces that render these bands had no test at
 * all: a whole section could be deleted with the full suite green, which is how
 * the statutory AFS statement came to be missing two bands and stopped footing.
 */
export function IncomeStatementSections({
  report, periodStart, periodEnd, expandedAccount, onToggleAccount, showComparative, onEvidence,
}: {
  report: IncomeStatementReport;
  periodStart: string;
  periodEnd: string;
  expandedAccount: string | null;
  onToggleAccount: (code: string) => void;
  showComparative: boolean;
  onEvidence: (accountId: string, accountName: string) => void;
}) {
  const setEvidenceTarget = ({ accountId, accountName }: { accountId: string; accountName: string }) =>
    onEvidence(accountId, accountName);
  const toggleAccount = onToggleAccount;
  return (
                <div className="divide-y divide-[var(--ff-border-light)]">
                  {/* Revenue */}
                  <Section label="Turnover" items={report.revenue} total={report.totalRevenue} color="teal"
                    periodStart={periodStart} periodEnd={periodEnd} expandedAccount={expandedAccount}
                    onToggleAccount={toggleAccount} showComparative={showComparative}
                    onEvidence={(id, name) => setEvidenceTarget({ accountId: id, accountName: name })} />

                  {/* Cost of Sales */}
                  {report.costOfSales.length > 0 && (
                    <Section label="Cost of Sales" items={report.costOfSales} total={report.totalCostOfSales} color="orange"
                      periodStart={periodStart} periodEnd={periodEnd} expandedAccount={expandedAccount}
                      onToggleAccount={toggleAccount} showComparative={showComparative}
                      onEvidence={(id, name) => setEvidenceTarget({ accountId: id, accountName: name })} />
                  )}

                  {/* Gross Profit */}
                  <div className="px-6 py-3 flex justify-between bg-teal-500/5">
                    <span className="font-semibold text-[var(--ff-text-primary)]">Gross Profit</span>
                    <span className={`font-bold font-mono ${report.grossProfit >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                      {formatCurrency(report.grossProfit)}
                      {showComparative && report.priorGrossProfit !== undefined && (
                        <span className="text-xs text-[var(--ff-text-tertiary)] ml-2">
                          (prior: {formatCurrency(report.priorGrossProfit)})
                        </span>
                      )}
                    </span>
                  </div>

                  {/* Other Income — below gross profit because it is not trading
                      revenue, and ABOVE the Operating Profit that contains it so
                      the column reconciles as a reader works down it. Printing it
                      after the total made GP - OpEx fall short of the stated
                      Operating Profit by exactly this amount. */}
                  {report.otherIncome.length > 0 && (
                    <Section label="Other Income" items={report.otherIncome} total={report.totalOtherIncome} color="teal"
                      periodStart={periodStart} periodEnd={periodEnd} expandedAccount={expandedAccount}
                      onToggleAccount={toggleAccount} showComparative={showComparative}
                      onEvidence={(id, name) => setEvidenceTarget({ accountId: id, accountName: name })} />
                  )}

                  {/* Operating Expenses */}
                  <Section label="Operating Expenses" items={report.operatingExpenses} total={report.totalOperatingExpenses} color="red"
                    periodStart={periodStart} periodEnd={periodEnd} expandedAccount={expandedAccount}
                    onToggleAccount={toggleAccount} showComparative={showComparative}
                    onEvidence={(id, name) => setEvidenceTarget({ accountId: id, accountName: name })} />

                  {/* Operating Profit — gross profit PLUS other income, less
                      operating expenses. Other income is above this line; only
                      finance cost and tax sit below it. */}
                  <div className="px-6 py-3 flex justify-between bg-blue-500/5">
                    <span className="font-semibold text-[var(--ff-text-primary)]">Operating Profit</span>
                    <span className={`font-bold font-mono ${report.operatingProfit >= 0 ? 'text-blue-400' : 'text-red-400'}`}>
                      {formatCurrency(report.operatingProfit)}
                      {showComparative && report.priorOperatingProfit !== undefined && (
                        <span className="text-xs text-[var(--ff-text-tertiary)] ml-2">
                          (prior: {formatCurrency(report.priorOperatingProfit)})
                        </span>
                      )}
                    </span>
                  </div>

                  {/* Other Expenses — finance cost, tax and other expense. */}
                  {report.otherExpenses.length > 0 && (
                    <Section label="Other Expenses" items={report.otherExpenses} total={report.totalOtherExpenses} color="orange"
                      periodStart={periodStart} periodEnd={periodEnd} expandedAccount={expandedAccount}
                      onToggleAccount={toggleAccount} showComparative={showComparative}
                      onEvidence={(id, name) => setEvidenceTarget({ accountId: id, accountName: name })} />
                  )}

                  {/* Net Profit */}
                  <div className="px-6 py-4 flex justify-between bg-[var(--ff-bg-primary)]">
                    <span className="text-lg font-bold text-[var(--ff-text-primary)]">Net Profit / (Loss)</span>
                    <span className={`text-xl font-bold font-mono ${report.netProfit >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                      {formatCurrency(report.netProfit)}
                      {showComparative && report.priorNetProfit !== undefined && (
                        <span className="text-xs text-[var(--ff-text-tertiary)] ml-2">
                          (prior: {formatCurrency(report.priorNetProfit)})
                        </span>
                      )}
                    </span>
                  </div>

                  {/* The shared data-quality notice, rendered ABOVE the margin
                      stats on purpose: the gross margin immediately below is the
                      figure these defaults make wrong, and Velocity read 96.6%
                      off that line while R82.7m of direct cost sat in operating
                      expenses. Same component, wording and currency format as the
                      nine other report surfaces — a user comparing two screens
                      must not see the same defect described two ways. */}
                  {report.subtypeDisclosure && (
                    <div className="px-6 py-3 border-t border-[var(--ff-border-light)]">
                      {/* The service already built these sentences, and the CSV and
                          XLSX exports emit the same array. Passing them through —
                          rather than re-deriving a partial input here — is what
                          stops the screen showing fewer caveats than the file
                          downloaded from it, and stops a count being taken from
                          the CAPPED named list. */}
                      <DataQualityNotice notices={report.subtypeDisclosure.notices} />
                      <p className="mt-2 font-mono text-xs text-[var(--ff-text-tertiary)]">
                        {report.subtypeDisclosure.accounts
                          .map(a => `${a.accountCode} ${a.accountName} ${formatCurrency(a.amount)}`)
                          .join(' \u00b7 ')}
                        {report.subtypeDisclosure.unnamedAccounts > 0
                          ? ` \u00b7 and ${report.subtypeDisclosure.unnamedAccounts} more`
                          : ''}
                      </p>
                      {report.priorSubtypeDisclosure && (
                        <p className="mt-1 text-xs text-amber-400/80">
                          The comparative period has its own unclassified accounts, so every
                          variance above is a difference between two differently-banded numbers.
                        </p>
                      )}
                    </div>
                  )}

                  {/* Margin Stats */}
                  {report.totalRevenue > 0 && (
                    <div className="px-6 py-2 flex gap-6 text-sm border-t border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                      <span className="text-[var(--ff-text-tertiary)]">
                        Gross Margin:{' '}
                        <span className="font-mono font-medium text-[var(--ff-text-primary)]">
                          {((report.grossProfit / report.totalRevenue) * 100).toFixed(1)}%
                        </span>
                      </span>
                      <span className="text-[var(--ff-text-tertiary)]">
                        Net Margin:{' '}
                        <span className="font-mono font-medium text-[var(--ff-text-primary)]">
                          {((report.netProfit / report.totalRevenue) * 100).toFixed(1)}%
                        </span>
                      </span>
                    </div>
                  )}
                </div>
  );
}


function Section({ label, items, total, color, periodStart, periodEnd, expandedAccount, onToggleAccount, showComparative, onEvidence }: {
  label: string;
  items: IncomeStatementLineItem[];
  total: number;
  color: string;
  periodStart: string;
  periodEnd: string;
  expandedAccount: string | null;
  onToggleAccount: (code: string) => void;
  showComparative: boolean;
  onEvidence: (accountId: string, accountName: string) => void;
}) {
  return (
    <div>
      <div className={`px-6 py-2 bg-${color}-500/5 flex items-center`}>
        <span className={`text-sm font-semibold text-${color}-400`}>{label}</span>
        {showComparative ? (
          <span className="flex items-center gap-4 text-xs text-[var(--ff-text-tertiary)] ml-auto">
            <span className="w-28 text-right">Prior</span>
            <span className="w-28 text-right">Current</span>
            <span className="w-20 text-right">Variance</span>
          </span>
        ) : (
          <span className="text-xs text-[var(--ff-text-tertiary)] ml-auto">Click account to expand</span>
        )}
      </div>
      {items.map(item => {
        const isExpanded = expandedAccount === item.accountCode;
        return (
          <div key={item.accountCode}>
            <div className="w-full px-6 py-2 flex justify-between items-center text-sm hover:bg-[var(--ff-bg-tertiary)]">
              <button
                type="button"
                onClick={() => onToggleAccount(item.accountCode)}
                className="flex items-center gap-1 text-[var(--ff-text-secondary)] flex-1 text-left"
              >
                {isExpanded
                  ? <ChevronDown className="h-3 w-3 shrink-0 text-[var(--ff-text-tertiary)]" />
                  : <ChevronRight className="h-3 w-3 shrink-0 text-[var(--ff-text-tertiary)]" />}
                <span className="font-mono text-xs mr-1">{item.accountCode}</span>
                {item.accountName}
              </button>
              <span className="flex items-center gap-3">
                {showComparative && item.priorAmount !== undefined ? (
                  <>
                    <span className="font-mono text-[var(--ff-text-tertiary)] w-28 text-right text-xs">{formatCurrency(item.priorAmount)}</span>
                    <button onClick={() => onEvidence(item.accountCode, item.accountName)} className="font-mono text-[var(--ff-text-primary)] w-28 text-right hover:text-indigo-400 cursor-pointer">{formatCurrency(item.amount)}</button>
                    <span className={`font-mono w-20 text-right text-xs ${(item.variance ?? 0) >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                      {(item.variance ?? 0) >= 0 ? '+' : ''}{formatCurrency(item.variance ?? 0)}
                    </span>
                  </>
                ) : (
                  <button onClick={() => onEvidence(item.accountCode, item.accountName)} className="font-mono text-[var(--ff-text-primary)] hover:text-indigo-400 cursor-pointer">{formatCurrency(item.amount)}</button>
                )}
              </span>
            </div>
            {isExpanded && (
              <div className="px-6 pb-3">
                <AccountDrillDown accountCode={item.accountCode} periodStart={periodStart} periodEnd={periodEnd} />
              </div>
            )}
          </div>
        );
      })}
      {items.length === 0 && (
        <div className="px-6 py-2 text-sm text-[var(--ff-text-tertiary)]">No entries</div>
      )}
      <div className="px-6 py-2 flex justify-between border-t border-[var(--ff-border-light)]">
        <span className="text-sm font-medium text-[var(--ff-text-primary)]">Total {label}</span>
        <span className="font-mono font-medium text-[var(--ff-text-primary)]">{formatCurrency(total)}</span>
      </div>
    </div>
  );
}
