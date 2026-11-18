/**
 * Who and what the Deploy Verification company is. Constants only, so the provisioner, the golden global setup and the
 * golden helpers can all name them without importing each other's code.
 */

export interface LoginIdentity {
  email: string;
  firstName: string;
  lastName: string;
  /** The deploy env file's keys: what verify-deploy.sh reads (`emailKey`, `passwordKey`), and where a password waits until provisioning is whole (`pendingKey`). */
  emailKey: string;
  passwordKey: string;
  pendingKey: string;
}

/**
 * The verification login. On isaflow.co.za, whose mail goes to a server we run: a password reset for a production owner login
 * on the GoTrue shared by dev and production must never reach a mailbox someone else could register.
 */
export const VERIFY_LOGIN: LoginIdentity = {
  email: 'deploy-verify@isaflow.co.za',
  firstName: 'Deploy',
  lastName: 'Verification',
  emailKey: 'E2E_VERIFY_EMAIL',
  passwordKey: 'E2E_VERIFY_PASSWORD',
  pendingKey: 'E2E_VERIFY_PENDING_PASSWORD',
};

/** The second member, an admin of the same company: decides the pay run the verify login raises (R-035 two-person gate). */
export const APPROVER_LOGIN: LoginIdentity = {
  email: 'deploy-verify-approver@isaflow.co.za',
  firstName: 'Deploy Verification',
  lastName: 'Approver',
  emailKey: 'E2E_VERIFY_APPROVER_EMAIL',
  passwordKey: 'E2E_VERIFY_APPROVER_PASSWORD',
  pendingKey: 'E2E_VERIFY_APPROVER_PENDING_PASSWORD',
};

/** Hidden from platform metrics because is_demo = true; the verify login's default (first) company. */
export const VERIFY_COMPANY_NAME = 'Deploy Verification';
/** The migration-wizard spec's own company (tests/e2e/golden-paths/_migrationSandbox.ts finds it by this name). */
export const MIGRATION_SANDBOX_NAME = '0GP Golden Migration Sandbox';
/** The role the approver holds: above the pay-run rule's `manager`, below owner, so the company keeps one owner. */
export const APPROVER_ROLE = 'admin';
