/** entityChangeCensus.test.ts's known migrations (moved out unchanged to keep that file within 300 lines). */
/**
 * Migrations before 888 that match laterMigrationViolates: the schema-wide grants
 * to app_user (348) and platform_admin (352). They ran before entity_changes and
 * the capture existed, so they reach neither. A new one is a reason to look.
 */
export const KNOWN_GRANTS = ['348_rls_and_auth_helpers.sql', '352_platform_admin_role.sql',
  // 930 (S-07c): names entity_change_capture() only in its list of reviewed definers (with its body's
  // hash, so a change to the capture is refused on every deploy); it does not touch the history.
  '930_credential_membership_writes_off_app_pools.sql',
  // 952 (wave 3 K1): widens the entity_type CHECK and entity_changes_read for payroll_bank_detail and attaches the
  // capture, ENABLE ALWAYS, to payroll_bank_details. The capture itself is unchanged, so 930's registry is too.
  '952_payroll_bank_details_tenant_history.sql',
  // 961/962 (payment terms): new types in the CHECK (962: read policy, projection arm), narrow captures; 964 VALIDATEs that CHECK.
  '961_company_default_terms_history.sql', '962_due_date_source_and_history.sql', '964_entity_changes_type_check_validate.sql'];
/**
 * Matching only in their comments: 693 explains why ENABLE TRIGGER downgrades, 855 why it uses E'' under
 * standard_conforming_strings, 876 why TRUNCATE ... cascade.
 */
export const KNOWN_IN_COMMENTS = ['693_oauth_apps_trust_flags_not_app_writable.sql', '855_retire_data_archiving.sql',
  '876_supplier_bank_verification.sql'];
