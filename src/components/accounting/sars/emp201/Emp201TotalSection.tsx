/** EMP201 field section: total payable to SARS. */
import { fmt, type EMP201Data } from './emp201Types';

export function Emp201TotalSection({ data }: { data: EMP201Data }) {
  return (
    <>
      <div className="px-4 py-2 bg-[var(--ff-bg-primary)]">
        <p className="text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">Total Payable</p>
      </div>
      <div className="px-4 py-3 flex items-center justify-between bg-[var(--ff-bg-primary)]/50">
        <span className="text-sm font-semibold text-[var(--ff-text-primary)]">
          Total payable to SARS
        </span>
        <span className="text-lg font-bold text-red-400">
          {fmt(data.totalDeductions)}
        </span>
      </div>
    </>
  );
}
