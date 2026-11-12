/** EMP201 field section: PAYE withheld. */
import { fmt, type DrillOpener, type EMP201Data } from './emp201Types';
import { SectionHeading, SummaryRow } from './Emp201SummaryRow';

export function Emp201PayeSection({ data, onDrill }: { data: EMP201Data; onDrill?: DrillOpener }) {
  return (
    <>
      <SectionHeading>Deductions</SectionHeading>
      <SummaryRow label="PAYE (Pay As You Earn)" value={fmt(data.totalPAYE)} onDrill={onDrill?.('paye', data.totalPAYE)} />
    </>
  );
}
