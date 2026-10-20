import { describe, expect, it, vi } from 'vitest';
import { createRunController } from '../src/ui/controller.js';
import { formatMs } from '../src/ui/RunBoard.js';
import { toneForType } from '../src/ui/palette.js';
import type { RunResult } from '../src/executor.js';

const result = (overrides: Partial<RunResult> = {}): RunResult => ({
  name: 'api',
  script: 'dev',
  command: 'tsx',
  code: 0,
  signal: null,
  ok: true,
  durationMs: 120,
  ...overrides,
});

describe('run controller', () => {
  it('starts empty', () => {
    const controller = createRunController();
    expect(controller.getState()).toEqual({ rows: [], finished: false, logs: [] });
  });

  it('adds a row when a project starts', () => {
    const controller = createRunController();
    controller.startRow('api', 'dev', 'tsx');
    const rows = controller.getState().rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'api', script: 'dev', command: 'tsx', phase: 'running' });
  });

  it('patches a row in place', () => {
    const controller = createRunController();
    controller.startRow('api', 'dev', 'tsx');
    controller.updateRow('api', 'dev', { phase: 'waiting', waitingFor: 'db :5432' });
    expect(controller.getState().rows[0]).toMatchObject({ phase: 'waiting', waitingFor: 'db :5432' });
  });

  it('leaves other rows alone when one is patched', () => {
    const controller = createRunController();
    controller.startRow('api', 'dev', 'tsx');
    controller.startRow('web', 'dev', 'vite');
    controller.updateRow('api', 'dev', { phase: 'done' });
    const rows = controller.getState().rows;
    expect(rows.find((row) => row.name === 'api')?.phase).toBe('done');
    expect(rows.find((row) => row.name === 'web')?.phase).toBe('running');
  });

  it('settles a row with its result', () => {
    const controller = createRunController();
    controller.startRow('api', 'dev', 'tsx');
    controller.finishRow(result());
    expect(controller.getState().rows[0]).toMatchObject({ phase: 'done', durationMs: 120 });
  });

  it('records why a row failed', () => {
    const controller = createRunController();
    controller.startRow('api', 'dev', 'tsx');
    controller.finishRow(result({ ok: false, code: 2 }));
    expect(controller.getState().rows[0]).toMatchObject({ phase: 'failed', reason: 'exit 2' });
  });

  it('records a signal as the reason', () => {
    const controller = createRunController();
    controller.startRow('api', 'dev', 'tsx');
    controller.finishRow(result({ ok: false, code: null, signal: 'SIGTERM' }));
    expect(controller.getState().rows[0]).toMatchObject({ phase: 'failed', reason: 'signal SIGTERM' });
  });

  it('keeps the log lines in order', () => {
    const controller = createRunController();
    controller.addLog('one');
    controller.addLog('two');
    expect(controller.getState().logs).toEqual(['one', 'two']);
  });

  it('marks the run as finished', () => {
    const controller = createRunController();
    controller.finish(1234);
    expect(controller.getState()).toMatchObject({ finished: true, totalMs: 1234 });
  });

  it('keeps the state reference stable between changes', () => {
    const controller = createRunController();
    const before = controller.getState();
    expect(controller.getState()).toBe(before);
    controller.addLog('one');
    expect(controller.getState()).not.toBe(before);
  });

  it('notifies the subscribers', () => {
    const controller = createRunController();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    controller.addLog('one');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    controller.addLog('two');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('formatMs', () => {
  it('shows milliseconds below a second', () => {
    expect(formatMs(0)).toBe('0ms');
    expect(formatMs(340)).toBe('340ms');
    expect(formatMs(999)).toBe('999ms');
  });

  it('shows seconds with one decimal', () => {
    expect(formatMs(1000)).toBe('1.0s');
    expect(formatMs(2400)).toBe('2.4s');
  });

  it('shows minutes and seconds beyond a minute', () => {
    expect(formatMs(64_000)).toBe('1m 04s');
  });
});

describe('toneForType', () => {
  it('gives every known type its own tone', () => {
    const tones = ['node', 'docker', 'python', 'go'].map((type) => toneForType(type));
    expect(new Set(tones).size).toBe(4);
  });

  it('falls back for an unknown type', () => {
    expect(toneForType('rust')).toBe('gray');
  });
});
