import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isCliEntry, main } from '../src/index.js';

const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Captures everything hop writes: its own messages (console.log/error) and the
 * prefixed child output (written straight to process.stdout).
 */
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

describe('isCliEntry', () => {
  let root: string;
  let cliFile: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hop-cli-'));
    cliFile = path.join(root, 'cli.js');
    await writeFile(cliFile, '// entry point\n', 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns true when the entry path is the module itself', () => {
    expect(isCliEntry(cliFile, pathToFileURL(cliFile).href)).toBe(true);
  });

  it('returns false for missing entries, other files, or no argv[1]', async () => {
    const other = path.join(root, 'other.js');
    await writeFile(other, '', 'utf8');

    expect(isCliEntry(undefined, pathToFileURL(cliFile).href)).toBe(false);
    expect(isCliEntry(other, pathToFileURL(cliFile).href)).toBe(false);
    expect(isCliEntry(path.join(root, 'missing.js'), pathToFileURL(cliFile).href)).toBe(false);
  });

  it('matches through a symlink/junction like global npm installs do', async () => {
    // `npm link` / `npm i -g` execute the CLI through a link in the global
    // node_modules: argv[1] carries the link path, import.meta.url is real.
    const link = path.join(root, 'linked');
    await symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir');

    expect(isCliEntry(path.join(link, 'cli.js'), pathToFileURL(cliFile).href)).toBe(true);
  });
});

describe('main with --npm', () => {
  let cwd: string;
  let root: string;

  beforeEach(async () => {
    cwd = process.cwd();
    root = await mkdtemp(path.join(tmpdir(), 'hop-cli-npm-'));
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture-app',
        version: '1.0.0',
        private: true,
        scripts: {
          predev: 'node -e "console.log(\'PRE\')"',
          dev: 'node -e "console.log(\'DEV\')"',
          postdev: 'node -e "console.log(\'POST\')"',
        },
      }),
      'utf8',
    );
    process.chdir(root);
  });

  afterEach(async () => {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  });

  it('runs node scripts through the package manager so pre/post hooks execute', async () => {
    const capture = captureOutput();
    let code: number;
    try {
      code = await main(['dev', '--npm']);
    } finally {
      capture.restore();
    }

    const output = capture.text();
    expect(code).toBe(0);
    expect(output).toMatch(/(npm|pnpm|yarn|bun) run dev/);
    expect(output).toContain('PRE');
    expect(output).toContain('DEV');
    expect(output).toContain('POST');
  });

  it('runs the raw command without --npm, skipping hooks', async () => {
    const capture = captureOutput();
    let code: number;
    try {
      code = await main(['dev']);
    } finally {
      capture.restore();
    }

    const output = capture.text();
    expect(code).toBe(0);
    expect(output).toContain("node -e \"console.log('DEV')\"");
    expect(output).toContain('DEV');
    expect(output).not.toContain('PRE');
    expect(output).not.toContain('POST');
  });
});

describe('main --help', () => {
  it('aligns the usage rows in one column', async () => {
    const capture = captureOutput();
    let code: number;
    try {
      code = await main(['--help']);
    } finally {
      capture.restore();
    }

    const output = capture.text();
    expect(code).toBe(0);

    // Every usage row starts its description in the same column. A label that
    // is exactly as wide as the column used to run straight into the text
    // ("hop <script> --no-waitStart everything at once").
    const rows = output.split('\n').filter((line) => /^ {2}hop\b/.test(line));
    expect(rows.length).toBeGreaterThan(3);

    const descriptionColumns = rows.map((row) => {
      // The description is the first word that starts a capitalised sentence.
      const match = /^ {2}(\S.*?)( {2,})([A-Z]\S.*)$/.exec(row);
      return match === null ? -1 : match[1]!.length + match[2]!.length;
    });
    expect(descriptionColumns.every((column) => column > 0)).toBe(true);
    expect(new Set(descriptionColumns).size).toBe(1);
  });

  it('opens with the hop wordmark and separates its sections with a rule', async () => {
    const capture = captureOutput();
    let code: number;
    try {
      code = await main(['--help']);
    } finally {
      capture.restore();
    }

    const output = capture.text();
    expect(code).toBe(0);
    expect(output).toContain('↗ hop');
    // Every section title is followed by a horizontal rule.
    for (const title of ['Usage', 'Detection', 'Smart startup']) {
      const lines = output.split('\n');
      const index = lines.findIndex((line) => line === title);
      expect(index).toBeGreaterThan(-1);
      expect(lines[index + 1]).toMatch(/^─+$/);
    }
  });
});

describe('main --list', () => {
  let cwd: string;
  let root: string;

  beforeEach(async () => {
    cwd = process.cwd();
    root = await mkdtemp(path.join(tmpdir(), 'hop-list-'));
    await writeFile(
      path.join(root, 'frontend', 'package.json'),
      JSON.stringify({ name: 'frontend', scripts: { dev: 'vite', build: 'vite build' } }),
      'utf8',
    ).catch(async () => {
      await mkdir(path.join(root, 'frontend'), { recursive: true });
      await writeFile(
        path.join(root, 'frontend', 'package.json'),
        JSON.stringify({ name: 'frontend', scripts: { dev: 'vite', build: 'vite build' } }),
        'utf8',
      );
    });
    process.chdir(root);
  });

  afterEach(async () => {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  });

  it('draws the projects as a tree with the ecosystem and the path', async () => {
    const capture = captureOutput();
    let code: number;
    try {
      code = await main(['--list']);
    } finally {
      capture.restore();
    }

    const output = capture.text();
    expect(code).toBe(0);
    expect(output).toContain('↗ hop');
    expect(output).toContain('frontend');
    expect(output).toContain('node');
    // The scripts hang under the project as a tree.
    expect(output).toMatch(/├\s+dev/);
    expect(output).toMatch(/└\s+build/);
  });
});
