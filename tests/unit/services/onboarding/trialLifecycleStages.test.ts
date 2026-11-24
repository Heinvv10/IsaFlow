/**
 * Trial lifecycle stage selection (pure): day boundaries, end-anchored stages, the ended window,
 * extended trials, and catch-up sending only the latest due stage.
 */
import { describe, expect, it } from 'vitest';
import { dueStage, stageToSend } from '@/modules/onboarding/services/trialLifecycle/stages';

const DAY = 24 * 60 * 60 * 1000;
const START = new Date('2026-11-01T09:00:00Z');
const END = new Date(START.getTime() + 30 * DAY);
const at = (ms: number) => new Date(START.getTime() + ms);
const due = (now: Date, trialEndsAt = END) => dueStage({ createdAt: START, trialEndsAt, now });

describe('dueStage', () => {
  it('nothing before whole day 3; setup_nudge from day 3 to day 9', () => {
    expect(due(at(3 * DAY - 1))).toBeNull();
    expect(due(at(3 * DAY))).toBe('setup_nudge');
    expect(due(at(10 * DAY - 1))).toBe('setup_nudge');
  });
  it('check_in from whole day 10 until ending_soon starts', () => {
    expect(due(at(10 * DAY))).toBe('check_in');
    expect(due(at(25 * DAY - 60_000))).toBe('check_in');
  });
  it('ending_soon when the end is 5 days or less away', () => {
    expect(due(at(25 * DAY))).toBe('ending_soon');
    expect(due(at(30 * DAY - 1))).toBe('ending_soon');
  });
  it('ended from the end for 7 days, then nothing', () => {
    expect(due(at(30 * DAY))).toBe('ended');
    expect(due(at(37 * DAY))).toBe('ended');
    expect(due(at(37 * DAY + 1))).toBeNull();
  });
  it('a long-lapsed trial is never due a start-anchored stage', () => {
    expect(due(at(90 * DAY))).toBeNull();
  });
  it('an extended trial uses the new end date', () => {
    const extended = new Date(START.getTime() + 60 * DAY);
    expect(due(at(30 * DAY), extended)).toBe('check_in');
    expect(due(at(55 * DAY), extended)).toBe('ending_soon');
    expect(due(at(61 * DAY), extended)).toBe('ended');
  });
});

describe('stageToSend (catch-up: latest due stage only)', () => {
  it('day 12 with nothing sent sends check_in, never setup_nudge', () => {
    expect(stageToSend(due(at(12 * DAY)), [])).toBe('check_in');
  });
  it('a stage already done is not sent again', () => {
    expect(stageToSend('check_in', ['check_in'])).toBeNull();
  });
  it('a higher stage done blocks lower ones', () => {
    expect(stageToSend('check_in', ['ending_soon'])).toBeNull();
    expect(stageToSend('setup_nudge', ['ended'])).toBeNull();
  });
  it('a lower stage done does not block a higher one', () => {
    expect(stageToSend('ended', ['setup_nudge', 'check_in'])).toBe('ended');
  });
  it('nothing due sends nothing', () => {
    expect(stageToSend(null, [])).toBeNull();
  });
});
