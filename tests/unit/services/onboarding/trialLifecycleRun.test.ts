/**
 * runTrialLifecycleEmails: kill switch and dry run send and write nothing; a claim conflict sends
 * nothing; provably-not-sent releases the claim, an ambiguous failure keeps it; day 3 with setup done
 * records a skip and sends nothing; no owner writes nothing; one company failing does not stop the
 * rest; the batch limit counts only companies with a stage due; done stages are respected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sql: vi.fn(async () => []),
  loadTrialCandidates: vi.fn(),
  loadOwners: vi.fn(),
  claimStage: vi.fn(),
  finaliseStage: vi.fn(),
  openSetupSteps: vi.fn(),
  sendEmail: vi.fn(),
  logEmailAttempt: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/alsTransaction', () => ({ withAlsTransaction: (_a: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail: m.sendEmail, logEmailAttempt: m.logEmailAttempt }));
vi.mock('@/modules/onboarding/services/trialLifecycle/candidates', () => ({ loadTrialCandidates: m.loadTrialCandidates, loadOwners: m.loadOwners }));
vi.mock('@/modules/onboarding/services/trialLifecycle/markers', () => ({ claimStage: m.claimStage, finaliseStage: m.finaliseStage }));
vi.mock('@/modules/onboarding/services/trialLifecycle/compose', async (orig) => ({
  ...(await orig<typeof import('@/modules/onboarding/services/trialLifecycle/compose')>()),
  openSetupSteps: m.openSetupSteps,
}));
vi.mock('@/modules/accounting/services/core/setupProgressService', () => ({ probeSetupFacts: vi.fn(), buildSetupProgress: vi.fn() }));

import { runTrialLifecycleEmails } from '@/modules/onboarding/services/trialLifecycle/runTrialLifecycleEmails';
import type { TrialStage } from '@/modules/onboarding/services/trialLifecycle/stages';

const DAY = 86_400_000;
const NOW = new Date('2026-11-24T06:30:00Z');
/** A trial company `day` whole days old with a 30-day trial. */
function company(id: string, day: number, doneStages: TrialStage[] = []) {
  const createdAt = new Date(NOW.getTime() - day * DAY);
  return { companyId: id, companyName: `Company ${id}`, createdAt, trialEndsAt: new Date(createdAt.getTime() + 30 * DAY), doneStages };
}
const owner = { email: 'owner@example.test', name: 'Sam' };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TRIAL_LIFECYCLE_EMAILS_ENABLED = '1';
  m.loadOwners.mockResolvedValue([owner]);
  m.claimStage.mockResolvedValue(true);
  m.openSetupSteps.mockResolvedValue([{ label: 'Add a customer', href: '/accounting/customers/new' }]);
  m.sendEmail.mockResolvedValue({ success: true, messageId: 'x' });
});
afterEach(() => { delete process.env.TRIAL_LIFECYCLE_EMAILS_ENABLED; });

describe('runTrialLifecycleEmails', () => {
  it('sends the due stage once, logs it, and finalises it as sent', async () => {
    m.loadTrialCandidates.mockResolvedValue([company('a', 12)]);
    const r = await runTrialLifecycleEmails({ now: NOW });
    expect(m.claimStage).toHaveBeenCalledWith('a', 'check_in');
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
    expect(m.sendEmail.mock.calls[0]![0]).toMatchObject({ to: owner.email, replyTo: 'accounts@isaflow.co.za' });
    expect(m.logEmailAttempt).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'a', emailType: 'trial_lifecycle', status: 'sent' }));
    expect(m.finaliseStage).toHaveBeenCalledWith('a', 'check_in', 'sent', 1);
    expect(r).toMatchObject({ dryRun: false, enabled: true, processed: 1, failed: 0, emailsSent: 1 });
  });

  it('kill switch off: behaves as a dry run whatever was asked', async () => {
    delete process.env.TRIAL_LIFECYCLE_EMAILS_ENABLED;
    m.loadTrialCandidates.mockResolvedValue([company('a', 12)]);
    const r = await runTrialLifecycleEmails({ now: NOW, dryRun: false });
    expect(r).toMatchObject({ dryRun: true, enabled: false });
    expect(r.perCompany[0]).toMatchObject({ action: 'would_send', stage: 'check_in', recipients: 1 });
    expect(m.claimStage).not.toHaveBeenCalled();
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it('dry run writes no marker and sends nothing, and reports no addresses', async () => {
    m.loadTrialCandidates.mockResolvedValue([company('a', 4), company('b', 26)]);
    m.openSetupSteps.mockResolvedValueOnce([]);
    const r = await runTrialLifecycleEmails({ now: NOW, dryRun: true });
    expect(r.perCompany.map((p) => [p.stage, p.action])).toEqual([['setup_nudge', 'would_skip_setup_complete'], ['ending_soon', 'would_send']]);
    expect(m.claimStage).not.toHaveBeenCalled();
    expect(m.finaliseStage).not.toHaveBeenCalled();
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(m.logEmailAttempt).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain(owner.email);
  });

  it('a claim conflict sends nothing', async () => {
    m.loadTrialCandidates.mockResolvedValue([company('a', 12)]);
    m.claimStage.mockResolvedValue(false);
    const r = await runTrialLifecycleEmails({ now: NOW });
    expect(r.perCompany[0]!.action).toBe('already_claimed');
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(m.finaliseStage).not.toHaveBeenCalled();
  });

  it('every send provably not sent: the claim is released for tomorrow', async () => {
    m.loadTrialCandidates.mockResolvedValue([company('a', 12)]);
    m.sendEmail.mockResolvedValue({ success: false, error: 'SMTP not configured', provablyNotSent: true });
    const r = await runTrialLifecycleEmails({ now: NOW });
    expect(m.finaliseStage).toHaveBeenCalledWith('a', 'check_in', 'released', 0);
    expect(r.perCompany[0]!.action).toBe('released');
    expect(m.logEmailAttempt).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('an ambiguous failure (or a throw) keeps the claim as unknown: at most once', async () => {
    m.loadTrialCandidates.mockResolvedValue([company('a', 12)]);
    m.sendEmail.mockRejectedValueOnce(new Error('socket closed'));
    await runTrialLifecycleEmails({ now: NOW });
    expect(m.finaliseStage).toHaveBeenCalledWith('a', 'check_in', 'unknown', 0);
  });

  it('day 3 with setup complete records the skip and sends nothing', async () => {
    m.loadTrialCandidates.mockResolvedValue([company('a', 4)]);
    m.openSetupSteps.mockResolvedValue([]);
    const r = await runTrialLifecycleEmails({ now: NOW });
    expect(m.claimStage).toHaveBeenCalledWith('a', 'setup_nudge', 'skipped_setup_complete');
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(r.perCompany[0]!.action).toBe('skipped_setup_complete');
  });

  it('day 3 lists the open steps in the email', async () => {
    m.loadTrialCandidates.mockResolvedValue([company('a', 4)]);
    await runTrialLifecycleEmails({ now: NOW });
    expect(m.sendEmail.mock.calls[0]![0].html).toContain('Add a customer');
  });

  it('a company with no owner email writes no marker', async () => {
    m.loadTrialCandidates.mockResolvedValue([company('a', 12)]);
    m.loadOwners.mockResolvedValue([]);
    const r = await runTrialLifecycleEmails({ now: NOW });
    expect(r.perCompany[0]!.action).toBe('no_recipient');
    expect(m.claimStage).not.toHaveBeenCalled();
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it('one company throwing is counted failed and the rest still run', async () => {
    m.loadTrialCandidates.mockResolvedValue([company('a', 12), company('b', 12)]);
    m.loadOwners.mockRejectedValueOnce(new Error('lock timeout'));
    const r = await runTrialLifecycleEmails({ now: NOW });
    expect(r.perCompany.map((p) => p.action)).toEqual(['failed', 'sent']);
    expect(r.failed).toBe(1);
    expect(JSON.stringify(r)).not.toContain('lock timeout');
  });

  it('the limit counts only companies with a stage due, and done stages are respected', async () => {
    m.loadTrialCandidates.mockResolvedValue([
      company('early', 1), company('done', 12, ['check_in']), company('higher-done', 12, ['ending_soon']),
      company('a', 12), company('b', 26), company('c', 31),
    ]);
    const r = await runTrialLifecycleEmails({ now: NOW, limit: 2 });
    expect(r.due).toBe(3);
    expect(r.perCompany.map((p) => [p.companyId, p.stage])).toEqual([['a', 'check_in'], ['b', 'ending_soon']]);
    expect(m.sendEmail).toHaveBeenCalledTimes(2);
  });
});
