import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';
import { changedFiles } from '../src/git.js';
import {
  allRows,
  chosenScripts,
  groupRows,
  initialSelection,
  moveCursor,
  rowKey,
  toggle,
  toggleAll,
  visibleRows,
  type PickerProject,
  type Selection,
} from '../src/ui/picker-state.js';

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

const fixtureProjects: PickerProject[] = [
  {
    name: 'api',
    type: 'node',
    scripts: ['dev', 'build'],
    commands: { dev: 'tsx watch src/index.ts', build: 'tsc' },
  },
  {
    name: 'web',
    type: 'node',
    scripts: ['dev'],
    commands: { dev: 'vite' },
  },
];

describe('picker state', () => {
  it('lists every script of every project', () => {
    expect(allRows(fixtureProjects)).toEqual([
      { projectIndex: 0, script: 'dev' },
      { projectIndex: 0, script: 'build' },
      { projectIndex: 1, script: 'dev' },
    ]);
  });

  it('filters by project name and by script name', () => {
    const rows = allRows(fixtureProjects);
    expect(visibleRows(rows, fixtureProjects, 'web').map((row) => row.script)).toEqual(['dev']);
    expect(visibleRows(rows, fixtureProjects, 'build').map((row) => row.script)).toEqual(['build']);
    expect(visibleRows(rows, fixtureProjects, 'nope')).toEqual([]);
  });

  it('treats an empty filter as no filter', () => {
    const rows = allRows(fixtureProjects);
    expect(visibleRows(rows, fixtureProjects, '')).toHaveLength(3);
    expect(visibleRows(rows, fixtureProjects, '   ')).toHaveLength(3);
  });

  it('groups the rows by project, in order', () => {
    const groups = groupRows(allRows(fixtureProjects), fixtureProjects);
    expect(groups.map((group) => group.project.name)).toEqual(['api', 'web']);
    expect(groups[0]?.rows.map((row) => row.script)).toEqual(['dev', 'build']);
  });

  it('toggles a row on and off', () => {
    let selection: Selection = new Set<string>();
    selection = toggle(selection, 0, 'dev');
    expect(selection.has(rowKey(0, 'dev'))).toBe(true);
    selection = toggle(selection, 0, 'dev');
    expect(selection.size).toBe(0);
  });

  it('toggles every visible row at once, then clears them', () => {
    const rows = allRows(fixtureProjects);
    const selected = toggleAll(new Set<string>(), rows);
    expect(selected.size).toBe(3);
    const cleared = toggleAll(selected, rows);
    expect(cleared.size).toBe(0);
  });

  it('starts with the suggested scripts selected', () => {
    const projects: PickerProject[] = [
      { ...fixtureProjects[0]!, suggested: 'build' },
      fixtureProjects[1]!,
    ];
    const selection = initialSelection(projects);
    expect(selection.has(rowKey(0, 'build'))).toBe(true);
    expect(selection.has(rowKey(0, 'dev'))).toBe(false);
  });

  it('reports the chosen scripts per project', () => {
    const rows = allRows(fixtureProjects);
    const selection = new Set([rowKey(0, 'dev'), rowKey(1, 'dev')]);
    const chosen = chosenScripts(selection, rows, fixtureProjects);
    expect(chosen.get('api')).toEqual(['dev']);
    expect(chosen.get('web')).toEqual(['dev']);
  });

  it('keeps the cursor inside the visible rows', () => {
    expect(moveCursor(0, 'up', 3)).toBe(0);
    expect(moveCursor(2, 'down', 3)).toBe(2);
    expect(moveCursor(1, 'down', 3)).toBe(2);
    expect(moveCursor(1, 'first', 3)).toBe(0);
    expect(moveCursor(1, 'last', 3)).toBe(2);
    expect(moveCursor(1, 'last', 0)).toBe(0);
  });
});

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
  });

  afterEach(async () => {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  });

  it('lists the detected projects when there is no terminal to draw on', async () => {
    const capture = captureOutput();
    let code: number;
    try {
      code = await main([]);
    } finally {
      capture.restore();
    }

    expect(code).toBe(0);
    const output = capture.text();
    // The project is named after its directory, and the fixture's scripts
    // are listed underneath it.
    expect(output).toContain(path.basename(root));
    expect(output).toContain('dev');
    expect(output).toContain('other');
  });

  it('points at the script argument when it cannot show a picker', async () => {
    const capture = captureOutput();
    let code: number;
    try {
      code = await main([]);
    } finally {
      capture.restore();
    }

    expect(code).toBe(0);
    expect(capture.text()).toContain('hop <script>');
  });

  it('marks the projects with uncommitted changes', async () => {
    vi.mocked(changedFiles).mockReturnValueOnce([path.join(root, 'package.json')]);

    const capture = captureOutput();
    let code: number;
    try {
      code = await main([]);
    } finally {
      capture.restore();
    }

    expect(code).toBe(0);
    expect(capture.text()).toContain('changed');
  });

  it('releases stdin so hop can exit', async () => {
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
