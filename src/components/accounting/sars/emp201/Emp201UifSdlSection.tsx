/** EMP201 field section: UIF and SDL. */
import { fmt, type EMP201Data } from './emp201Types';
import { SummaryRow } from './Emp201SummaryRow';

export function Emp201UifSdlSection({ data }: { data: EMP201Data }) {
  return (
    <>
      <SummaryRow label="UIF — Employee contribution" value={fmt(data.totalUIF_employee)} />
      <SummaryRow label="UIF — Employer contribution" value={fmt(data.totalUIF_employer)} />
      <SummaryRow label="Total UIF" value={fmt(data.totalUIF)} bold />
      <SummaryRow label="SDL (Skills Development Levy)" value={fmt(data.totalSDL)} />
    </>
  );
}
