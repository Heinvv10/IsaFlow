/** EMP201 field section: ETI and the PAYE payable after it. The ETI carry-forward row (wave 5 ET) belongs here. */
import { fmt, type EMP201Data } from './emp201Types';
import { SummaryRow } from './Emp201SummaryRow';

export function Emp201EtiSection({ data }: { data: EMP201Data }) {
  return (
    <>
      <SummaryRow label="Less: ETI (Employment Tax Incentive)" value={fmt(-data.totalETI)} />
      <SummaryRow label="PAYE payable" value={fmt(data.payePayable)} bold />
    </>
  );
}
