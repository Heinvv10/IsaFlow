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
/**
 * The role the approver holds when the company's pay-run rule allows it: `manager` (rank 4), the role migration 951 seeds
 * the rule with ('All pay runs', approver_role 'manager') and the least that can decide a pay-run request. provisionDb.ts reads
 * the company's actual rule and gives `admin` only if the rule demands more than `manager` (see chooseApproverRole).
 */
export const APPROVER_ROLE = 'manager';
/** What `user_metadata.purpose` carries on a GoTrue login this provisioner created: a login without it is somebody else's and is never adopted. */
export const LOGIN_PURPOSE = 'deploy verification (scripts/deploy/provision-verify-company.ts)';
/**
 * The locks a deploy holds (scripts/deploy.sh: /tmp/isaflow-deploy.lock for the whole deploy; scripts/deploy/bluegreen.sh
 * bg_lock: /tmp/isaflow-colours.lock for anything that changes or restarts a colour, rollback and restart-colours included).
 * The provisioner takes both for a whole real run, so no verification can log in while a password and the env file disagree.
 */
export const DEPLOY_LOCK_FILES = ['/tmp/isaflow-deploy.lock', '/tmp/isaflow-colours.lock'] as const;
