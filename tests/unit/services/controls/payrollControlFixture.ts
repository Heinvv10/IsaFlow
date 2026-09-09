import type {PayrollControlPopulation} from '@/modules/accounting/services/controls/payrollControlTypes';
export function payrollPopulation():PayrollControlPopulation{
 const accounts=['5200','2140','2150','2160','1110','2175'].map(code=>({id:code,account_code:code,is_active:true}));
 return{currency:'ZAR',populationCount:1,lineCount:1,employeeCount:1,over:false,accounts,allocations:[],mappings:[],beneficiaryGroups:[],componentChanges:[],declarations:[],
 employees:[{id:'employee',status:'active',start_date:'2020-01-01',end_date:null,cost_centre_id:null}],
 runs:[{id:'run',date:'2026-09-30',version:null,header:{employee_count:1,period_year:2026,period_month:9,status:'approved',total_gross:'100.00',total_taxable:'100.00',total_paye:'8.00',total_uif:'2.00',total_sdl:'1.00',total_eti:'0.00',total_net:'91.00'},
 lines:[{id:'line',employee_id:'employee',gross_pay:'100.00',taxable_income:'100.00',paye:'8.00',uif_employee:'1.00',uif_employer:'1.00',sdl:'1.00',eti:'0.00',net_pay:'91.00',component_breakdown:[]}],
 journal:{id:'journal',status:'posted',source:'auto_payroll',sourceRecordId:'run',reversed:false,lines:[{glAccountId:'5200',debit:'102.00',credit:'0.00'},{glAccountId:'2140',debit:'0.00',credit:'8.00'},{glAccountId:'2150',debit:'0.00',credit:'2.00'},{glAccountId:'2160',debit:'0.00',credit:'1.00'},{glAccountId:'1110',debit:'0.00',credit:'91.00'}]}}]};
}
