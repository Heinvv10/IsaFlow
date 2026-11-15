/**
 * OP-1: scripts/isaflow-health-alerts.{service,timer} run the admin health alerts every 5 minutes,
 * shaped like the isaflow-mirror-scan pair (the other 5-minute cron timer). The service's secret
 * handling (stdin, never argv) is run for real by cronUnitsSecret.test.ts, which picks up every
 * isaflow-*.service that calls 127.0.0.1:3101.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const DIR = join(process.cwd(), 'scripts');

/** section -> key -> values (a key may repeat), continuation lines joined, comments dropped. */
function parseUnit(file: string): Record<string, Record<string, string[]>> {
  const text = readFileSync(join(DIR, file), 'utf8').replace(/\\\n/g, ' ');
  const out: Record<string, Record<string, string[]>> = {};
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const head = /^\[(\w+)\]$/.exec(line);
    if (head) { section = head[1]!; out[section] = {}; continue; }
    const kv = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (!kv || !section) throw new Error(`${file}: unparseable line: ${line}`);
    (out[section]![kv[1]!] ??= []).push(kv[2]!);
  }
  return out;
}

/** A systemd time span in seconds (the forms these units use: 5min, 60, 30s, 1h). */
function seconds(span: string): number {
  const m = /^(\d+)\s*(s|sec|min|m|h)?$/.exec(span.trim());
  if (!m) throw new Error(`unsupported time span: ${span}`);
  const n = Number(m[1]);
  return m[2] === 'min' || m[2] === 'm' ? n * 60 : m[2] === 'h' ? n * 3600 : n;
}

describe('isaflow-health-alerts timer', () => {
  const timer = parseUnit('isaflow-health-alerts.timer');

  it('fires every 5 minutes, from 5 minutes after boot, with jitter and no catch-up', () => {
    expect(timer.Timer!.OnUnitActiveSec!.map(seconds)).toEqual([300]);
    expect(timer.Timer!.OnBootSec!.map(seconds)).toEqual([300]);
    expect(seconds(timer.Timer!.RandomizedDelaySec![0]!)).toBeGreaterThan(0);
    expect(seconds(timer.Timer!.RandomizedDelaySec![0]!)).toBeLessThan(300);
    expect(timer.Timer!.Persistent).toEqual(['false']);
    expect(timer.Timer!.OnCalendar).toBeUndefined();
    expect(timer.Install!.WantedBy).toEqual(['timers.target']);
  });
});

describe('isaflow-health-alerts service', () => {
  const unit = parseUnit('isaflow-health-alerts.service');
  const exec = unit.Service!.ExecStart!.join(' ');

  it('is a oneshot run as velo with the app env file', () => {
    expect(unit.Service!.Type).toEqual(['oneshot']);
    expect(unit.Service!.User).toEqual(['velo']);
    expect(unit.Service!.Group).toEqual(['velo']);
    expect(unit.Service!.EnvironmentFile).toEqual(['/home/velo/isaflow/.env.local']);
    expect(unit.Service!.SyslogIdentifier).toEqual(['isaflow-health-alerts']);
  });

  it('POSTs the health-alerts cron route with a bounded, failing curl', () => {
    expect(exec).toMatch(/exec \/usr\/bin\/curl --silent --show-error --fail /);
    expect(exec).toMatch(/-X POST /);
    const maxTime = Number(/--max-time (\d+)/.exec(exec)?.[1]);
    expect(maxTime).toBeGreaterThan(0);
    expect(maxTime).toBeLessThan(300); // a pass ends well inside the 5-minute interval
    expect(exec).toMatch(/http:\/\/127\.0\.0\.1:3101\/api\/cron\/health-alerts'$/);
    expect(existsSync(join(process.cwd(), 'pages/api/cron/health-alerts.ts'))).toBe(true);
  });
});
