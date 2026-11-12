/** The EMP201 form card: one file per field section (wave 5 L2 split; L3u adds drill links in the sections). */
import { formatDate } from '@/utils/formatters';
import type { EMP201Data } from './emp201Types';
import { Emp201EmployeeSection } from './Emp201EmployeeSection';
import { Emp201PayeSection } from './Emp201PayeSection';
import { Emp201EtiSection } from './Emp201EtiSection';
import { Emp201UifSdlSection } from './Emp201UifSdlSection';
import { Emp201TotalSection } from './Emp201TotalSection';

export function Emp201ReturnForm({ data }: { data: EMP201Data }) {
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
      <div className="px-4 py-3 border-b border-[var(--ff-border-light)]">
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
          EMP201 — {formatDate(data.periodStart)} to {formatDate(data.periodEnd)}
        </h2>
      </div>

      <div className="divide-y divide-[var(--ff-border-light)]">
        <Emp201EmployeeSection data={data} />
        <Emp201PayeSection data={data} />
        <Emp201EtiSection data={data} />
        <Emp201UifSdlSection data={data} />
        <Emp201TotalSection data={data} />
      </div>
    </div>
  );
}
