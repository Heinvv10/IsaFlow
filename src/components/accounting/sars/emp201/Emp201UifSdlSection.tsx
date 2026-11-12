/** EMP201 field section: UIF and SDL. */
import { fmt, type DrillOpener, type EMP201Data } from './emp201Types';
import { SummaryRow } from './Emp201SummaryRow';

export function Emp201UifSdlSection({ data, onDrill }: { data: EMP201Data; onDrill?: DrillOpener }) {
  return (
    <>
      <SummaryRow label="UIF — Employee contribution" value={fmt(data.totalUIF_employee)} />
      <SummaryRow label="UIF — Employer contribution" value={fmt(data.totalUIF_employer)} />
      <SummaryRow label="Total UIF" value={fmt(data.totalUIF)} bold onDrill={onDrill?.('uif', data.totalUIF)} />
      <SummaryRow label="SDL (Skills Development Levy)" value={fmt(data.totalSDL)} onDrill={onDrill?.('sdl', data.totalSDL)} />
    </>
  );
}
