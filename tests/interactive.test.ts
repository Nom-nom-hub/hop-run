import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancel, groupMultiselect } from '@clack/prompts';
import { main } from '../src/index.js';
import { changedFiles } from '../src/git.js';

const { CANCEL_SYMBOL } = vi.hoisted(() => ({ CANCEL_SYMBOL: Symbol('clack:cancel') }));

vi.mock('@clack/prompts', () => ({
  groupMultiselect: vi.fn(async () => [0]),
  intro: vi.fn(),
  cancel: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), clear: vi.fn() })),
  isCancel: (value: unknown): value is symbol => value === CANCEL_SYMBOL,
}));

vi.mock('../src/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/git.js')>();
  return { ...actual, changedFiles: vi.fn(actual.changedFiles) };
});

const ANSI = /\u001b\[[0-9;]*m/g;

/** Captures hop's own messages and the prefixed child output. */
function captureOutput(): { text(): string; restore(): void } {
  const chunks: string[] = [];
  const push = (...args: unknown[]): void => {
    chunks.push(`${args.map((arg) => String(arg)).join(' ')}\n`);
  };
  const logSpy = vi.spyOn(console, 'log').mockImplementation(push);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(push);
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write);
  return {
    text: () => chunks.join('').replace(ANSI, ''),
    restore: () => {
      writeSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

describe('interactive picker', () => {
  let cwd: string;
  let root: string;

  beforeEach(async () => {
    cwd = process.cwd();
    root = await mkdtemp(path.join(tmpdir(), 'hop-menu-'));
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'menu-fixture',
        version: '1.0.0',
        private: true,
        scripts: {
          dev: 'node -e "console.log(\'MENU_RAN\')"',
          other: 'node -e "console.log(\'OTHER\')"',
        },
      }),
      'utf8',
    );
    process.chdir(root);
    vi.clearAllMocks();
    vi.mocked(groupMultiselect).mockImplementation(async () => [0]);
  });

  afterEach(async () => {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  });

  it('runs the picked script and reports success', async () => {
    const capture = captureOutput();
    let code: number;
    try {
      code = await main([]);
    } finally {
      capture.restore();
    }

    expect(code).toBe(0);
    expect(capture.text()).toContain('MENU_RAN');
    expect(capture.text()).not.toContain('OTHER');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('treats ctrl+c at the menu as a cancel and starts nothing', async () => {
    vi.mocked(groupMultiselect).mockResolvedValueOnce(CANCEL_SYMBOL as never);

    const capture = captureOutput();
    let code: number;
    try {
      code = await main([]);
    } finally {
      capture.restore();
    }

    expect(code).toBe(130);
    expect(cancel).toHaveBeenCalledWith(expect.stringContaining('canceled'));
    expect(capture.text()).not.toContain('MENU_RAN');
  });

  it('exits cleanly when nothing was selected', async () => {
    vi.mocked(groupMultiselect).mockResolvedValueOnce([] as number[]);

    const capture = captureOutput();
    let code: number;
    try {
      code = await main([]);
    } finally {
      capture.restore();
    }

    expect(code).toBe(0);
    expect(cancel).toHaveBeenCalledWith(expect.stringContaining('nothing selected'));
    expect(capture.text()).not.toContain('MENU_RAN');
  });

  it('pre-selects the primary script of projects with uncommitted changes', async () => {
    vi.mocked(changedFiles).mockReturnValueOnce([path.join(root, 'package.json')]);

    const capture = captureOutput();
    let code: number;
    try {
      code = await main([]);
    } finally {
      capture.restore();
    }

    expect(code).toBe(0);
    const call = vi.mocked(groupMultiselect).mock.calls[0]?.[0] as
      | { initialValues?: number[]; options: Record<string, unknown> }
      | undefined;
    expect(call?.initialValues).toEqual([0]); // "dev" is the first script of the dirty target
    expect(Object.keys(call?.options ?? {}).some((label) => label.includes('changed'))).toBe(true);
  });

  it('leaves the menu untouched when nothing is dirty', async () => {
    const capture = captureOutput();
    try {
      await main([]);
    } finally {
      capture.restore();
    }

    const call = vi.mocked(groupMultiselect).mock.calls[0]?.[0] as
      | { initialValues?: number[]; options: Record<string, unknown> }
      | undefined;
    expect(call?.initialValues).toEqual([]);
    expect(Object.keys(call?.options ?? {}).some((label) => label.includes('changed'))).toBe(false);
  });

  it('releases stdin after the menu so hop can exit', async () => {
    const pause = vi.spyOn(process.stdin, 'pause');
    const unref = typeof process.stdin.unref === 'function' ? vi.spyOn(process.stdin, 'unref') : undefined;

    const capture = captureOutput();
    let code: number;
    let pauseCalls = 0;
    let unrefCalls = 0;
    try {
      code = await main([]);
    } finally {
      capture.restore();
      // Read call counts before restoring the spies (restore clears history).
      pauseCalls = pause.mock.calls.length;
      unrefCalls = unref?.mock.calls.length ?? 0;
      pause.mockRestore();
      unref?.mockRestore();
    }

    expect(code).toBe(0);
    expect(pauseCalls).toBeGreaterThan(0);
    if (unref) {
      expect(unrefCalls).toBeGreaterThan(0);
    }
  });
});
