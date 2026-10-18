import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { ProjectTarget } from './scanner.js';

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
      timeout: 5_000,
    });
  } catch {
    return null; // not a repository, git missing, or the command failed
  }
}

/** Unquotes one porcelain path (git quotes paths containing spaces/specials). */
function unquote(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

/**
 * Parses `git status --porcelain` (v1) output into repository-relative paths.
 * Rename/copy entries resolve to the new path; untracked directories are kept
 * as-is (the caller matches them by prefix).
 */
export function parsePorcelain(output: string): string[] {
  const files: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.length < 4) {
      continue;
    }
    const status = line.slice(0, 2);
    let rest = line.slice(3);
    if (status.includes('R') || status.includes('C')) {
      const arrow = rest.lastIndexOf(' -> ');
      if (arrow !== -1) {
        rest = rest.slice(arrow + 4);
      }
    }
    const file = unquote(rest.trim());
    if (file !== '') {
      files.push(file);
    }
  }
  return files;
}

/**
 * Absolute paths of every file with uncommitted changes (modified, added,
 * deleted, renamed, untracked). Empty outside a git repository.
 *
 * Paths are resolved against the repository root and can therefore point above
 * the scanned directory as well — callers match them by prefix.
 */
export function changedFiles(cwd: string): string[] {
  const topLevel = git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  if (topLevel === undefined || topLevel === '') {
    return [];
  }
  const output = git(cwd, ['-c', 'core.quotepath=false', 'status', '--porcelain']);
  if (output === null) {
    return [];
  }
  return parsePorcelain(output).map((file) => path.resolve(topLevel, file));
}

/**
 * True when `file` (absolute) lives inside `dir` (absolute). An exact match
 * counts too: `git status --porcelain` reports whole untracked directories as
 * `?? new-project/`, which resolves to the target path itself.
 */
function isInside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Canonical absolute path. Git reports paths through the OS (getcwd), which
 * resolves symlinks — on macOS `/var` becomes `/private/var`, on Windows
 * junctions and 8.3 short names are expanded. Scanned project paths are built
 * from whatever directory hop was started in, so both sides are canonicalized
 * before they are compared. Deleted files, which `git status` still reports,
 * fall back to canonicalizing their parent directory.
 */
function canonical(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    try {
      return path.join(realpathSync.native(path.dirname(file)), path.basename(file));
    } catch {
      return file;
    }
  }
}

/** Targets owning at least one changed file, keyed by target name. */
export function dirtyFileCounts(targets: ProjectTarget[], files: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (files.length === 0) {
    return counts; // nothing changed anywhere: skip the filesystem lookups
  }
  const canonicalFiles = files.map((file) => canonical(file));
  for (const target of targets) {
    const dir = canonical(target.path);
    const own = canonicalFiles.filter((file) => isInside(dir, file)).length;
    if (own > 0) {
      counts.set(target.name, own);
    }
  }
  return counts;
}

/** Targets with uncommitted changes. */
export function dirtyTargets(targets: ProjectTarget[], files: string[]): ProjectTarget[] {
  const dirtyNames = new Set(dirtyFileCounts(targets, files).keys());
  return targets.filter((target) => dirtyNames.has(target.name));
}

/** Preferred script for a dirty target: the one a developer would run on it. */
const PRIMARY_SCRIPTS: readonly string[] = ['dev', 'serve', 'start', 'run', 'up'];

/**
 * Script hop pre-selects for a target with uncommitted changes — the "run this
 * project" script. Falls back to the only script when the target has exactly one.
 */
export function primaryScript(target: ProjectTarget): string | undefined {
  const scripts = Object.keys(target.scripts);
  const preferred = PRIMARY_SCRIPTS.find((name) => scripts.includes(name));
  if (preferred !== undefined) {
    return preferred;
  }
  return scripts.length === 1 ? scripts[0] : undefined;
}
