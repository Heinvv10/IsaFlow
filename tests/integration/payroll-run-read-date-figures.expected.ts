/**
 * Every line and header total of payroll-run-read-date-figures.int.test.ts as master (f60bd7e56, before the read-date
 * fix) wrote them, captured on a throwaway cluster with TZ=Africa/Johannesburg and again with TZ=UTC: the two were
 * identical. Ids are replaced by their fixture labels. Two things differ from that capture, both for #1116 (pension is
 * no longer deducted from taxable income): the pension line's component_breakdown entry carries
 * `retirementContribution: true`, and taxable_income / periodic_taxable of the lines with a pension are no longer reduced
 * by it (27270.00 -> 29550.00). Two more for PR #1142 (SDL is levied after the s11F retirement deduction PAYE 4c
 * records, SDL Act s3(4)): every component_breakdown item carries `isSdlApplicable` (an earning flagged
 * is_sdl_applicable), and the pension employee's sdl is 1% of (28500 + 3000 - 2280) = 292.20, not 315.00, so
 * total_sdl is 817.20 (feb) and 924.20 (mar), 22.80 lower. Two more for PR #1215 (para 2(4): only s11F and s18A
 * deductions reduce PAYE): the steady employee's taxable medical aid (4005, R1 950) no longer reduces taxable_income /
 * periodic_taxable (29550.00 -> 31500.00), so their paye is 507.00 higher (net_pay and total_paye / total_net follow),
 * and their validation_results carry a DEDUCTION_NOT_PAYE_DEDUCTIBLE warning. Nothing else was edited.
 */
type Period = 'feb' | 'mar';
export const EXPECTED_LINES: Record<Period, Record<string, Record<string, unknown>>> = {
  "feb": {
    "endsMid": {
      "additional_medical_credit": "0.00",
      "annual_taxable": "0.00",
      "component_breakdown": "[{\"amount\": 180, \"isTaxable\": false, \"componentId\": \"<union>\", \"componentName\": \"Union dues\", \"sarsSourceCode\": \"4018\", \"isSdlApplicable\": false, \"isUifApplicable\": false}, {\"amount\": 21000, \"isTaxable\": true, \"componentId\": \"<salary>\", \"componentName\": \"Basic salary\", \"sarsSourceCode\": \"3601\", \"isSdlApplicable\": true, \"isUifApplicable\": true}]",
      "eti": "0.00",
      "gross_pay": "21000.00",
      "medical_credit": "364.00",
      "medical_scheme_fees": "0.00",
      "net_pay": "18563.80",
      "paye": "2079.08",
      "periodic_taxable": "21000.00",
      "sdl": "210.00",
      "taxable_income": "21000.00",
      "uif_employee": "177.12",
      "uif_employer": "177.12",
      "validation_results": "[{\"code\": \"MISSING_TAX_NUMBER\", \"field\": \"taxNumber\", \"message\": \"Read RD-ENDSMID has no SARS tax number. PAYE cannot be calculated.\", \"deepLink\": \"/payroll/employees/<endsMid>#tax-number\", \"severity\": \"error\"}]"
    },
    "increase": {
      "additional_medical_credit": "0.00",
      "annual_taxable": "10000.00",
      "component_breakdown": "[{\"amount\": 15000, \"isTaxable\": true, \"componentId\": \"<salary>\", \"componentName\": \"Basic salary\", \"sarsSourceCode\": \"3601\", \"isSdlApplicable\": true, \"isUifApplicable\": true}, {\"amount\": 10000, \"isTaxable\": true, \"componentId\": \"<bonus>\", \"componentName\": \"Bonus\", \"sarsSourceCode\": \"3605\", \"isSdlApplicable\": true, \"isUifApplicable\": true}]",
      "eti": "0.00",
      "gross_pay": "25000.00",
      "medical_credit": "364.00",
      "medical_scheme_fees": "0.00",
      "net_pay": "22123.13",
      "paye": "2699.75",
      "periodic_taxable": "15000.00",
      "sdl": "250.00",
      "taxable_income": "25000.00",
      "uif_employee": "177.12",
      "uif_employer": "177.12",
      "validation_results": "[{\"code\": \"MISSING_TAX_NUMBER\", \"field\": \"taxNumber\", \"message\": \"Read RD-INCREASE has no SARS tax number. PAYE cannot be calculated.\", \"deepLink\": \"/payroll/employees/<increase>#tax-number\", \"severity\": \"error\"}]"
    },
    "steady": {
      "additional_medical_credit": "0.00",
      "annual_taxable": "0.00",
      "component_breakdown": "[{\"amount\": 1950, \"isTaxable\": true, \"componentId\": \"<medical>\", \"componentName\": \"Medical aid\", \"sarsSourceCode\": \"4005\", \"isSdlApplicable\": false, \"isUifApplicable\": false}, {\"amount\": 2280, \"isTaxable\": true, \"componentId\": \"<pension>\", \"componentName\": \"Pension fund\", \"sarsSourceCode\": \"4001\", \"isSdlApplicable\": false, \"isUifApplicable\": false, \"retirementContribution\": true}, {\"amount\": 28500, \"isTaxable\": true, \"componentId\": \"<salary>\", \"componentName\": \"Basic salary\", \"sarsSourceCode\": \"3601\", \"isSdlApplicable\": true, \"isUifApplicable\": true}, {\"amount\": 3000, \"isTaxable\": true, \"componentId\": \"<travel>\", \"componentName\": \"Travel allowance\", \"sarsSourceCode\": \"3701\", \"isSdlApplicable\": true, \"isUifApplicable\": true}]",
      "eti": "0.00",
      "gross_pay": "31500.00",
      "medical_credit": "974.00",
      "medical_scheme_fees": "1950.00",
      "net_pay": "23486.60",
      "paye": "3606.28",
      "periodic_taxable": "31500.00",
      "sdl": "292.20",
      "taxable_income": "31500.00",
      "uif_employee": "177.12",
      "uif_employer": "177.12",
      "validation_results": "[{\"code\": \"MISSING_TAX_NUMBER\", \"field\": \"taxNumber\", \"message\": \"Read RD-STEADY has no SARS tax number. PAYE cannot be calculated.\", \"deepLink\": \"/payroll/employees/<steady>#tax-number\", \"severity\": \"error\"}, {\"code\": \"DEDUCTION_NOT_PAYE_DEDUCTIBLE\", \"message\": \"Medical aid (code 4005, R 1 950.00) is marked taxable, but SARS lets an employer deduct only retirement fund contributions (4001, 4003, 4006) and s18A donations (4030) before PAYE, so PAYE was calculated without it. Medical aid contributions are given the medical tax credit instead.\", \"severity\": \"warning\"}]"
    },
    "young": {
      "additional_medical_credit": "0.00",
      "annual_taxable": "0.00",
      "component_breakdown": "[{\"amount\": 6500, \"isTaxable\": true, \"componentId\": \"<salary>\", \"componentName\": \"Basic salary\", \"sarsSourceCode\": \"3601\", \"isSdlApplicable\": true, \"isUifApplicable\": true}]",
      "eti": "750.00",
      "gross_pay": "6500.00",
      "medical_credit": "0.00",
      "medical_scheme_fees": "0.00",
      "net_pay": "6435.00",
      "paye": "0.00",
      "periodic_taxable": "6500.00",
      "sdl": "65.00",
      "taxable_income": "6500.00",
      "uif_employee": "65.00",
      "uif_employer": "65.00",
      "validation_results": "[{\"code\": \"MISSING_TAX_NUMBER\", \"field\": \"taxNumber\", \"message\": \"Read RD-YOUNG has no SARS tax number. PAYE cannot be calculated.\", \"deepLink\": \"/payroll/employees/<young>#tax-number\", \"severity\": \"error\"}]"
    }
  },
  "mar": {
    "endsMid": {
      "additional_medical_credit": "0.00",
      "annual_taxable": "0.00",
      "component_breakdown": "[{\"amount\": 21000, \"isTaxable\": true, \"componentId\": \"<salary>\", \"componentName\": \"Basic salary\", \"sarsSourceCode\": \"3601\", \"isSdlApplicable\": true, \"isUifApplicable\": true}]",
      "eti": "0.00",
      "gross_pay": "21000.00",
      "medical_credit": "376.00",
      "medical_scheme_fees": "0.00",
      "net_pay": "18857.88",
      "paye": "1965.00",
      "periodic_taxable": "21000.00",
      "sdl": "210.00",
      "taxable_income": "21000.00",
      "uif_employee": "177.12",
      "uif_employer": "177.12",
      "validation_results": "[{\"code\": \"MISSING_TAX_NUMBER\", \"field\": \"taxNumber\", \"message\": \"Read RD-ENDSMID has no SARS tax number. PAYE cannot be calculated.\", \"deepLink\": \"/payroll/employees/<endsMid>#tax-number\", \"severity\": \"error\"}]"
    },
    "increase": {
      "additional_medical_credit": "0.00",
      "annual_taxable": "0.00",
      "component_breakdown": "[{\"amount\": 16500, \"isTaxable\": true, \"componentId\": \"<salary>\", \"componentName\": \"Basic salary\", \"sarsSourceCode\": \"3601\", \"isSdlApplicable\": true, \"isUifApplicable\": true}, {\"amount\": 1200, \"isTaxable\": true, \"componentId\": \"<overtime>\", \"componentName\": \"Overtime\", \"sarsSourceCode\": \"3602\", \"isSdlApplicable\": true, \"isUifApplicable\": true}]",
      "eti": "0.00",
      "gross_pay": "17700.00",
      "medical_credit": "376.00",
      "medical_scheme_fees": "0.00",
      "net_pay": "16198.00",
      "paye": "1325.00",
      "periodic_taxable": "17700.00",
      "sdl": "177.00",
      "taxable_income": "17700.00",
      "uif_employee": "177.00",
      "uif_employer": "177.00",
      "validation_results": "[{\"code\": \"MISSING_TAX_NUMBER\", \"field\": \"taxNumber\", \"message\": \"Read RD-INCREASE has no SARS tax number. PAYE cannot be calculated.\", \"deepLink\": \"/payroll/employees/<increase>#tax-number\", \"severity\": \"error\"}]"
    },
    "starter": {
      "additional_medical_credit": "0.00",
      "annual_taxable": "0.00",
      "component_breakdown": "[{\"amount\": 18000, \"isTaxable\": true, \"componentId\": \"<salary>\", \"componentName\": \"Basic salary\", \"sarsSourceCode\": \"3601\", \"isSdlApplicable\": true, \"isUifApplicable\": true}]",
      "eti": "0.00",
      "gross_pay": "18000.00",
      "medical_credit": "376.00",
      "medical_scheme_fees": "0.00",
      "net_pay": "16443.88",
      "paye": "1379.00",
      "periodic_taxable": "18000.00",
      "sdl": "180.00",
      "taxable_income": "18000.00",
      "uif_employee": "177.12",
      "uif_employer": "177.12",
      "validation_results": "[{\"code\": \"MISSING_TAX_NUMBER\", \"field\": \"taxNumber\", \"message\": \"Read RD-STARTER has no SARS tax number. PAYE cannot be calculated.\", \"deepLink\": \"/payroll/employees/<starter>#tax-number\", \"severity\": \"error\"}]"
    },
    "steady": {
      "additional_medical_credit": "0.00",
      "annual_taxable": "0.00",
      "component_breakdown": "[{\"amount\": 1950, \"isTaxable\": true, \"componentId\": \"<medical>\", \"componentName\": \"Medical aid\", \"sarsSourceCode\": \"4005\", \"isSdlApplicable\": false, \"isUifApplicable\": false}, {\"amount\": 2280, \"isTaxable\": true, \"componentId\": \"<pension>\", \"componentName\": \"Pension fund\", \"sarsSourceCode\": \"4001\", \"isSdlApplicable\": false, \"isUifApplicable\": false, \"retirementContribution\": true}, {\"amount\": 28500, \"isTaxable\": true, \"componentId\": \"<salary>\", \"componentName\": \"Basic salary\", \"sarsSourceCode\": \"3601\", \"isSdlApplicable\": true, \"isUifApplicable\": true}, {\"amount\": 3000, \"isTaxable\": true, \"componentId\": \"<travel>\", \"componentName\": \"Travel allowance\", \"sarsSourceCode\": \"3701\", \"isSdlApplicable\": true, \"isUifApplicable\": true}]",
      "eti": "0.00",
      "gross_pay": "31500.00",
      "medical_credit": "1006.00",
      "medical_scheme_fees": "1950.00",
      "net_pay": "23620.68",
      "paye": "3472.20",
      "periodic_taxable": "31500.00",
      "sdl": "292.20",
      "taxable_income": "31500.00",
      "uif_employee": "177.12",
      "uif_employer": "177.12",
      "validation_results": "[{\"code\": \"MISSING_TAX_NUMBER\", \"field\": \"taxNumber\", \"message\": \"Read RD-STEADY has no SARS tax number. PAYE cannot be calculated.\", \"deepLink\": \"/payroll/employees/<steady>#tax-number\", \"severity\": \"error\"}, {\"code\": \"DEDUCTION_NOT_PAYE_DEDUCTIBLE\", \"message\": \"Medical aid (code 4005, R 1 950.00) is marked taxable, but SARS lets an employer deduct only retirement fund contributions (4001, 4003, 4006) and s18A donations (4030) before PAYE, so PAYE was calculated without it. Medical aid contributions are given the medical tax credit instead.\", \"severity\": \"warning\"}]"
    },
    "young": {
      "additional_medical_credit": "0.00",
      "annual_taxable": "0.00",
      "component_breakdown": "[{\"amount\": 6500, \"isTaxable\": true, \"componentId\": \"<salary>\", \"componentName\": \"Basic salary\", \"sarsSourceCode\": \"3601\", \"isSdlApplicable\": true, \"isUifApplicable\": true}]",
      "eti": "750.00",
      "gross_pay": "6500.00",
      "medical_credit": "0.00",
      "medical_scheme_fees": "0.00",
      "net_pay": "6435.00",
      "paye": "0.00",
      "periodic_taxable": "6500.00",
      "sdl": "65.00",
      "taxable_income": "6500.00",
      "uif_employee": "65.00",
      "uif_employer": "65.00",
      "validation_results": "[{\"code\": \"MISSING_TAX_NUMBER\", \"field\": \"taxNumber\", \"message\": \"Read RD-YOUNG has no SARS tax number. PAYE cannot be calculated.\", \"deepLink\": \"/payroll/employees/<young>#tax-number\", \"severity\": \"error\"}]"
    }
  }
};

export const EXPECTED_HEADERS: Record<Period, Record<string, unknown>> = {
  "feb": {
    "employee_count": 4,
    "total_eti": "750.00",
    "total_gross": "84000.00",
    "total_net": "70608.53",
    "total_paye": "8385.11",
    "total_sdl": "817.20",
    "total_taxable": "84000.00",
    "total_uif": "1192.72"
  },
  "mar": {
    "employee_count": 5,
    "total_eti": "750.00",
    "total_gross": "94700.00",
    "total_net": "81555.44",
    "total_paye": "8141.20",
    "total_sdl": "924.20",
    "total_taxable": "94700.00",
    "total_uif": "1546.72"
  }
};
