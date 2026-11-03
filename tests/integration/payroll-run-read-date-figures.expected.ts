/**
 * Every line and header total of payroll-run-read-date-figures.int.test.ts as master (f60bd7e56, before the read-date
 * fix) wrote them, captured on a throwaway cluster with TZ=Africa/Johannesburg and again with TZ=UTC: the two were
 * identical. Generated once from that run; do not edit by hand. Ids are replaced by their fixture labels.
 */
type Period = 'feb' | 'mar';
export const EXPECTED_LINES: Record<Period, Record<string, Record<string, unknown>>> = {
  "feb": {
    "endsMid": {
      "additional_medical_credit": "0.00",
      "annual_taxable": "0.00",
      "component_breakdown": "[{\"amount\": 180, \"isTaxable\": false, \"componentId\": \"<union>\", \"componentName\": \"Union dues\", \"sarsSourceCode\": \"4018\", \"isUifApplicable\": false}, {\"amount\": 21000, \"isTaxable\": true, \"componentId\": \"<salary>\", \"componentName\": \"Basic salary\", \"sarsSourceCode\": \"3601\", \"isUifApplicable\": true}]",
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
      "component_breakdown": "[{\"amount\": 15000, \"isTaxable\": true, \"componentId\": \"<salary>\", \"componentName\": \"Basic salary\", \"sarsSourceCode\": \"3601\", \"isUifApplicable\": true}, {\"amount\": 10000, \"isTaxable\": true, \"componentId\": \"<bonus>\", \"componentName\": \"Bonus\", \"sarsSourceCode\": \"3605\", \"isUifApplicable\": true}]",
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
      "component_breakdown": "[{\"amount\": 1950, \"isTaxable\": true, \"componentId\": \"<medical>\", \"componentName\": \"Medical aid\", \"sarsSourceCode\": \"4005\", \"isUifApplicable\": false}, {\"amount\": 2280, \"isTaxable\": true, \"componentId\": \"<pension>\", \"componentName\": \"Pension fund\", \"sarsSourceCode\": \"4001\", \"isUifApplicable\": false, \"retirementContribution\": true}, {\"amount\": 28500, \"isTaxable\": true, \"componentId\": \"<salary>\", \"componentName\": \"Basic salary\", \"sarsSourceCode\": \"3601\", \"isUifApplicable\": true}, {\"amount\": 3000, \"isTaxable\": true, \"componentId\": \"<travel>\", \"componentName\": \"Travel allowance\", \"sarsSourceCode\": \"3701\", \"isUifApplicable\": true}]",
      "eti": "0.00",
      "gross_pay": "31500.00",
      "medical_credit": "974.00",
      "medical_scheme_fees": "1950.00",
      "net_pay": "23993.60",
      "paye": "3099.28",
      "periodic_taxable": "29550.00",
      "sdl": "315.00",
      "taxable_income": "29550.00",
      "uif_employee": "177.12",
      "uif_employer": "177.12",
      "validation_results": "[{\"code\": \"MISSING_TAX_NUMBER\", \"field\": \"taxNumber\", \"message\": \"Read RD-STEADY has no SARS tax number. PAYE cannot be calculated.\", \"deepLink\": \"/payroll/employees/<steady>#tax-number\", \"severity\": \"error\"}]"
    },
    "young": {
      "additional_medical_credit": "0.00",
      "annual_taxable": "0.00",
      "component_breakdown": "[{\"amount\": 6500, \"isTaxable\": true, \"componentId\": \"<salary>\", \"componentName\": \"Basic salary\", \"sarsSourceCode\": \"3601\", \"isUifApplicable\": true}]",
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
      "component_breakdown": "[{\"amount\": 21000, \"isTaxable\": true, \"componentId\": \"<salary>\", \"componentName\": \"Basic salary\", \"sarsSourceCode\": \"3601\", \"isUifApplicable\": true}]",
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
      "component_breakdown": "[{\"amount\": 16500, \"isTaxable\": true, \"componentId\": \"<salary>\", \"componentName\": \"Basic salary\", \"sarsSourceCode\": \"3601\", \"isUifApplicable\": true}, {\"amount\": 1200, \"isTaxable\": true, \"componentId\": \"<overtime>\", \"componentName\": \"Overtime\", \"sarsSourceCode\": \"3602\", \"isUifApplicable\": true}]",
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
      "component_breakdown": "[{\"amount\": 18000, \"isTaxable\": true, \"componentId\": \"<salary>\", \"componentName\": \"Basic salary\", \"sarsSourceCode\": \"3601\", \"isUifApplicable\": true}]",
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
      "component_breakdown": "[{\"amount\": 1950, \"isTaxable\": true, \"componentId\": \"<medical>\", \"componentName\": \"Medical aid\", \"sarsSourceCode\": \"4005\", \"isUifApplicable\": false}, {\"amount\": 2280, \"isTaxable\": true, \"componentId\": \"<pension>\", \"componentName\": \"Pension fund\", \"sarsSourceCode\": \"4001\", \"isUifApplicable\": false, \"retirementContribution\": true}, {\"amount\": 28500, \"isTaxable\": true, \"componentId\": \"<salary>\", \"componentName\": \"Basic salary\", \"sarsSourceCode\": \"3601\", \"isUifApplicable\": true}, {\"amount\": 3000, \"isTaxable\": true, \"componentId\": \"<travel>\", \"componentName\": \"Travel allowance\", \"sarsSourceCode\": \"3701\", \"isUifApplicable\": true}]",
      "eti": "0.00",
      "gross_pay": "31500.00",
      "medical_credit": "1006.00",
      "medical_scheme_fees": "1950.00",
      "net_pay": "24127.68",
      "paye": "2965.20",
      "periodic_taxable": "29550.00",
      "sdl": "315.00",
      "taxable_income": "29550.00",
      "uif_employee": "177.12",
      "uif_employer": "177.12",
      "validation_results": "[{\"code\": \"MISSING_TAX_NUMBER\", \"field\": \"taxNumber\", \"message\": \"Read RD-STEADY has no SARS tax number. PAYE cannot be calculated.\", \"deepLink\": \"/payroll/employees/<steady>#tax-number\", \"severity\": \"error\"}]"
    },
    "young": {
      "additional_medical_credit": "0.00",
      "annual_taxable": "0.00",
      "component_breakdown": "[{\"amount\": 6500, \"isTaxable\": true, \"componentId\": \"<salary>\", \"componentName\": \"Basic salary\", \"sarsSourceCode\": \"3601\", \"isUifApplicable\": true}]",
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
    "total_net": "71115.53",
    "total_paye": "7878.11",
    "total_sdl": "840.00",
    "total_taxable": "84000.00",
    "total_uif": "1192.72"
  },
  "mar": {
    "employee_count": 5,
    "total_eti": "750.00",
    "total_gross": "94700.00",
    "total_net": "82062.44",
    "total_paye": "7634.20",
    "total_sdl": "947.00",
    "total_taxable": "94700.00",
    "total_uif": "1546.72"
  }
};
