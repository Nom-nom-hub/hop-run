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

/**
 * Unquotes one porcelain path (git quotes paths containing spaces/specials).
 *
 * Git's C-style quoting is *not* JSON: a non-ASCII character is written as a
 * sequence of octal escapes for its UTF-8 *bytes* (`\303\251` for `é`),
 * which `JSON.parse` rejects. The escapes are decoded here so that a file
 * named `café.txt` still maps onto the project that owns it.
 */
function unquote(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) {
    return raw;
  }
  const inner = raw.slice(1, -1);

  // Octal escapes stand for raw bytes, so they are collected and decoded as
  // UTF-8 in one go; a lone byte would become a replacement character.
  const bytes: number[] = [];
  let out = '';
  let copied = 0; // how much of `inner` has been copied to `out` verbatim

  const flushBytes = (): void => {
    if (bytes.length > 0) {
      out += Buffer.from(bytes).toString('utf8');
      bytes.length = 0;
    }
  };

  const pattern = /\\(?:([0-7]{1,3})|(.))/gs;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(inner)) !== null) {
    const octal = match[1];
    if (octal !== undefined) {
      if (bytes.length === 0) {
        // Start of a byte run: the plain text before it comes first.
        out += inner.slice(copied, match.index);
      }
      copied = match.index + match[0].length;
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }

    // The byte run ends here, so it is decoded before the text that follows.
    flushBytes();
    out += inner.slice(copied, match.index); // the plain text before the escape
    copied = match.index + match[0].length;

    switch (match[2]) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'v':
        out += '\v';
        break;
      case '"':
        out += '"';
        break;
      case '\\':
        out += '\\';
        break;
      default:
        out += match[2] ?? match[0];
        break;
    }
  }

  flushBytes();
  out += inner.slice(copied); // the plain text after the last escape
  return out;
}

/**
 * Finds the " -> " separator of a rename entry, ignoring an arrow that is
 * inside a quoted path.
 *
 * Git quotes a path only when it contains special characters, and the
 * separator between the old and the new path is written unquoted. A file can
 * also be renamed to a name that itself contains " -> ", so the *first*
 * separator outside quotes is the right one.
 */
function findRenameArrow(text: string): number {
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      index += 1; // skip the escaped character
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && text.startsWith(' -> ', index)) {
      return index;
    }
  }
  return -1;
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
      const arrow = findRenameArrow(rest);
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
  // `-uall` lists every untracked file individually. Without it git collapses a
  // whole untracked directory into one `?? dir/` entry, which would hide a
  // newly created project that lives inside that directory.
  const output = git(cwd, ['-c', 'core.quotepath=false', 'status', '--porcelain', '-uall']);
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
 * before they are compared.
 *
 * Paths that do not exist yet (deleted files, or unit tests using synthetic
 * trees) are canonicalized through their nearest existing ancestor, keeping the
 * missing segments as-is.
 */
function canonical(target: string): string {
  const resolved = path.resolve(target);
  const missing: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return resolved; // nothing along the path exists
      }
      missing.push(path.basename(current));
      current = parent;
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
