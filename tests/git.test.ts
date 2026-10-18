import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changedFiles, dirtyFileCounts, dirtyTargets, parsePorcelain, primaryScript } from '../src/git.js';
import type { ProjectTarget } from '../src/scanner.js';

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const hasGit = gitAvailable();

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}

async function writePath(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

/** Case-insensitive containment: git may report a differently-cased root on Windows. */
function listsPath(files: string[], expected: string): boolean {
  const wanted = path.resolve(expected).toLowerCase();
  return files.some((file) => path.resolve(file).toLowerCase() === wanted);
}

describe('parsePorcelain', () => {
  it('maps every status to its path', () => {
    const output = [
      ' M src/app.ts',
      'A  added.md',
      ' D removed.md',
      '?? new-folder/',
      'R  old.txt -> renamed.txt',
      'R  "old name.txt" -> "new name.txt"',
      ' M "with space.ts"',
      ' M "quo\\"te.ts"',
      '',
    ].join('\n');

    expect(parsePorcelain(output)).toEqual([
      'src/app.ts',
      'added.md',
      'removed.md',
      'new-folder/',
      'renamed.txt',
      'new name.txt',
      'with space.ts',
      'quo"te.ts',
    ]);
  });

  it('ignores blank and malformed lines', () => {
    expect(parsePorcelain('')).toEqual([]);
    expect(parsePorcelain('\n  \n')).toEqual([]);
  });
});

describe('dirtyFileCounts / dirtyTargets', () => {
  let root: string;
  let targets: ProjectTarget[];

  beforeEach(async () => {
    // Canonicalize: git reports real paths (macOS /var → /private/var, Windows
    // junctions and 8.3 short names), so expectations must use the same form.
    root = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'hop-git-')));
    targets = [
      { name: 'frontend', path: path.join(root, 'frontend'), type: 'node', scripts: { dev: 'vite' } },
      { name: 'backend', path: path.join(root, 'backend'), type: 'node', scripts: { start: 'node server.js' } },
      { name: 'app', path: path.join(root, 'app'), type: 'node', scripts: { dev: 'node .' } },
    ];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('counts changed files per target and lists the dirty ones', () => {
    const files = [
      path.join(root, 'frontend', 'src', 'a.ts'),
      path.join(root, 'frontend', 'README.md'),
      path.join(root, 'backend', 'server.ts'),
      path.join(root, 'loose.txt'),
    ];

    const counts = dirtyFileCounts(targets, files);
    expect([...counts]).toEqual([
      ['frontend', 2],
      ['backend', 1],
    ]);
    expect(dirtyTargets(targets, files).map((target) => target.name)).toEqual(['frontend', 'backend']);
  });

  it('counts an untracked target directory itself', () => {
    const counts = dirtyFileCounts(targets, [path.join(root, 'frontend')]);

    expect(counts.get('frontend')).toBe(1);
  });

  it('does not match sibling directories that only share a prefix', () => {
    const counts = dirtyFileCounts(targets, [path.join(root, 'app-extra', 'x.ts')]);

    expect(counts.size).toBe(0);
  });

  it('ignores files outside every target', () => {
    const counts = dirtyFileCounts(targets, [path.join(root, 'docs', 'guide.md')]);

    expect(counts.size).toBe(0);
  });
});

describe('primaryScript', () => {
  const target = (scripts: Record<string, string>): ProjectTarget => ({
    name: 'app',
    path: 'C:/app',
    type: 'node',
    scripts,
  });

  it('prefers the script a developer would run', () => {
    expect(primaryScript(target({ build: 'tsc', dev: 'vite', test: 'vitest' }))).toBe('dev');
    expect(primaryScript(target({ build: 'tsc', serve: 'serve -s dist' }))).toBe('serve');
    expect(primaryScript(target({ build: 'go build', start: 'go run .' }))).toBe('start');
    expect(primaryScript(target({ up: 'docker compose up', down: 'docker compose down' }))).toBe('up');
  });

  it('falls back to a lone script but stays quiet when the choice is unclear', () => {
    expect(primaryScript(target({ deploy: 'fly deploy' }))).toBe('deploy');
    expect(primaryScript(target({ build: 'tsc', test: 'vitest' }))).toBeUndefined();
    expect(primaryScript(target({}))).toBeUndefined();
  });
});

describe('changedFiles (live repository)', () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    // Canonicalize: `git rev-parse --show-toplevel` returns the real path, and
    // the temp directory may be behind a symlink (macOS App Translocation,
    // Windows raw `%TEMP%`, CI sandboxes).
    root = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'hop-gitrepo-')));
    repo = path.join(root, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'hop@test.local']);
    git(repo, ['config', 'user.name', 'hop']);
    git(repo, ['config', 'core.autocrlf', 'false']);

    await writePath(path.join(repo, 'frontend', 'src', 'app.ts'), 'export const app = 1;\n');
    await writePath(path.join(repo, 'frontend', 'src', 'untouched.ts'), 'export const untouched = 1;\n');
    await writePath(path.join(repo, 'backend', 'server.ts'), 'export const server = 1;\n');
    await writePath(path.join(repo, 'docs', 'guide.md'), '# guide\n');
    await writePath(path.join(repo, 'old.txt'), 'old\n');
    git(repo, ['add', '-A']);
    git(repo, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const maybe = hasGit ? it : it.skip;

  maybe('lists modified, untracked, renamed and deleted files with absolute paths', async () => {
    await writePath(path.join(repo, 'frontend', 'src', 'app.ts'), 'export const app = 2;\n');
    await writePath(path.join(repo, 'frontend', 'src', 'new file.ts'), 'export const fresh = 1;\n');
    await writePath(path.join(repo, 'frontend', 'src', 'generated', 'out.ts'), 'export const out = 1;\n');
    await writePath(path.join(repo, 'backend', 'server.ts'), 'export const server = 2;\n');
    git(repo, ['mv', 'old.txt', 'renamed.txt']);
    git(repo, ['rm', '-q', 'docs/guide.md']);

    const files = changedFiles(repo);

    expect(listsPath(files, path.join(repo, 'frontend', 'src', 'app.ts'))).toBe(true);
    expect(listsPath(files, path.join(repo, 'frontend', 'src', 'new file.ts'))).toBe(true);
    expect(listsPath(files, path.join(repo, 'frontend', 'src', 'generated'))).toBe(true);
    expect(listsPath(files, path.join(repo, 'backend', 'server.ts'))).toBe(true);
    expect(listsPath(files, path.join(repo, 'renamed.txt'))).toBe(true);
    expect(listsPath(files, path.join(repo, 'docs', 'guide.md'))).toBe(true);
    expect(listsPath(files, path.join(repo, 'frontend', 'src', 'untouched.ts'))).toBe(false);

    const targets: ProjectTarget[] = [
      { name: 'frontend', path: path.join(repo, 'frontend'), type: 'node', scripts: { dev: 'vite' } },
      { name: 'backend', path: path.join(repo, 'backend'), type: 'node', scripts: { start: 'node server.js' } },
      { name: 'docs-only', path: path.join(repo, 'docs'), type: 'node', scripts: { dev: 'x' } },
    ];
    expect(dirtyTargets(targets, files).map((target) => target.name)).toEqual(['frontend', 'backend', 'docs-only']);
  });

  maybe('resolves repository-relative paths even from a subdirectory', async () => {
    await writePath(path.join(repo, 'backend', 'server.ts'), 'export const server = 3;\n');

    const fromRoot = changedFiles(repo);
    const fromSubdir = changedFiles(path.join(repo, 'frontend', 'src'));

    expect(fromSubdir).toEqual(fromRoot);
    expect(listsPath(fromSubdir, path.join(repo, 'backend', 'server.ts'))).toBe(true);
  });

  maybe('matches scanned targets reached through a symlinked path', async () => {
    // A hop run started behind a symlink/junction sees project paths through the
    // link while git reports the real location; the mapping must still match.
    const link = path.join(root, 'linked');
    await symlink(repo, link, process.platform === 'win32' ? 'junction' : 'dir');
    await writePath(path.join(repo, 'backend', 'server.ts'), 'export const server = 4;\n');

    const files = changedFiles(link);
    const targets: ProjectTarget[] = [
      { name: 'backend', path: path.join(link, 'backend'), type: 'node', scripts: { start: 'node server.js' } },
    ];

    expect(dirtyFileCounts(targets, files).get('backend')).toBe(1);
    expect(dirtyTargets(targets, files).map((target) => target.name)).toEqual(['backend']);
  });

  maybe('returns nothing for a clean working tree', () => {
    expect(changedFiles(repo)).toEqual([]);
  });
});

describe('changedFiles (outside a repository)', () => {
  it('returns an empty list', async () => {
    const bare = await mkdtemp(path.join(tmpdir(), 'hop-nogit-'));
    try {
      expect(changedFiles(bare)).toEqual([]);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
