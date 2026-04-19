-- 384_drop_legacy_payroll.sql
-- PRD-02 Phase 2: remove pre-Phase-1 payroll schema.
-- Phase 1 tables live in payroll_employees / payroll_components /
-- payroll_run_headers / payroll_run_lines and are unaffected.

DROP TABLE IF EXISTS payslips          CASCADE;
DROP TABLE IF EXISTS pay_structures    CASCADE;
DROP TABLE IF EXISTS payroll_runs      CASCADE;
DROP TABLE IF EXISTS employees         CASCADE;
DROP TABLE IF EXISTS payroll_audit_log CASCADE;
