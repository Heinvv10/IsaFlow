import {assertControlTx} from './context';
import {BeneficiaryError,type BeneficiaryDetails} from './beneficiaryValidation';
import type {ControlTx} from './contracts';
/** One active canonical store. Legacy employees is a different identity model, never a fallback. */
export async function lockEmployeeBank(ctx:ControlTx,employeeId:string):Promise<BeneficiaryDetails|null>{
 assertControlTx(ctx);
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-payroll:${ctx.principal.companyId}`},0))`;
 const parents=await ctx.sql`SELECT id FROM payroll_employees WHERE company_id=${ctx.principal.companyId}::uuid
  AND id=${employeeId}::uuid AND status='active' FOR UPDATE`;
 if(parents.length!==1)throw new BeneficiaryError('NOT_FOUND');
 const rows=await ctx.sql`SELECT b.bank_name AS "bankName",b.account_number AS "accountNumber",b.branch_code AS "branchCode",b.account_type AS "accountType",
   b.effective_from>(clock_timestamp() AT TIME ZONE 'Africa/Johannesburg')::date AS future_effective
  FROM payroll_bank_details b JOIN payroll_employees e ON e.id=b.employee_id
  WHERE e.company_id=${ctx.principal.companyId}::uuid AND e.id=${employeeId}::uuid AND b.is_active=true ORDER BY b.id LIMIT 2 FOR UPDATE OF b` as (BeneficiaryDetails&{future_effective:boolean})[];
 if(rows.length>1)throw new BeneficiaryError('AMBIGUOUS_BANKING');
 const row=rows[0];if(!row)return null;
 if(row.future_effective)throw new BeneficiaryError('FUTURE_EFFECTIVE_BANKING_UNSUPPORTED');
 return{bankName:row.bankName,accountNumber:row.accountNumber,branchCode:row.branchCode,accountType:row.accountType};
}
/** Called only after the shared proposal verifier has independently authorized activation. */
export async function activateEmployeeBank(ctx:ControlTx,employeeId:string,details:BeneficiaryDetails):Promise<void>{
 assertControlTx(ctx);
 await ctx.sql`UPDATE payroll_bank_details b SET is_active=false FROM payroll_employees e
  WHERE e.company_id=${ctx.principal.companyId}::uuid AND e.id=${employeeId}::uuid AND b.employee_id=e.id AND b.is_active=true`;
 const rows=await ctx.sql`INSERT INTO payroll_bank_details(employee_id,bank_name,account_number,account_type,branch_code,effective_from)
  SELECT id,${details.bankName},${details.accountNumber},${details.accountType},${details.branchCode},(clock_timestamp() AT TIME ZONE 'Africa/Johannesburg')::date
  FROM payroll_employees WHERE company_id=${ctx.principal.companyId}::uuid AND id=${employeeId}::uuid RETURNING id`;
 if(rows.length!==1)throw new BeneficiaryError('NOT_FOUND');
}
