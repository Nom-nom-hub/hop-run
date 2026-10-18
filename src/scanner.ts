import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type ProjectType = 'node' | 'docker' | 'python' | 'go';

export interface ProjectTarget {
  /** Unique, human friendly name of the project (defaults to the directory name). */
  name: string;
  /** Absolute path to the project directory. */
  path: string;
  /** Primary environment fingerprint found in the directory. */
  type: ProjectType;
  /** Runnable commands, e.g. `{ dev: "vite", build: "tsc" }`. */
  scripts: Record<string, string>;
}

export interface ScanOptions {
  /** How many directory levels below the scan root to crawl. Default: 3. */
  maxDepth?: number;
  /** Extra directory names to skip, on top of the built-in ignore list. */
  ignore?: Iterable<string>;
}

/** Default crawl depth used when `ScanOptions.maxDepth` is not given. */
export const DEFAULT_MAX_DEPTH = 3;

/** Directories that never contain hand-written project roots worth running. */
export const DEFAULT_IGNORED_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'venv',
  '.venv',
  '__pycache__',
  'target',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
];

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/** Priority used to pick the single `type` for a directory carrying several fingerprints. */
const TYPE_PRIORITY: readonly ProjectType[] = ['node', 'docker', 'python', 'go'];

interface RawTarget {
  dir: string;
  type: ProjectType;
  scripts: Record<string, string>;
}

/** Adds `command` under `key`; on collision the key is namespaced as `type:key` so nothing is lost. */
function addScript(scripts: Record<string, string>, key: string, command: string, type: ProjectType): void {
  if (!(key in scripts)) {
    scripts[key] = command;
  } else if (!(`${type}:${key}` in scripts)) {
    scripts[`${type}:${key}`] = command;
  }
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null; // unreadable or invalid JSON is simply "not a fingerprint"
  }
}

async function fingerprintDir(dir: string, names: Set<string>): Promise<RawTarget | null> {
  const scripts: Record<string, string> = {};
  const contributes: Record<ProjectType, boolean> = { node: false, docker: false, python: false, go: false };

  // Node.js / JavaScript: package.json -> everything inside "scripts"
  if (names.has('package.json')) {
    const pkg = await readJsonObject(path.join(dir, 'package.json'));
    const pkgScripts = pkg?.scripts;
    if (typeof pkgScripts === 'object' && pkgScripts !== null) {
      for (const [key, value] of Object.entries(pkgScripts)) {
        if (typeof value === 'string' && value.trim() !== '') {
          addScript(scripts, key, value, 'node');
          contributes.node = true;
        }
      }
    }
  }

  // Docker: Dockerfile / compose files
  if (names.has('Dockerfile') || names.has('Containerfile')) {
    addScript(scripts, 'build', 'docker build .', 'docker');
    contributes.docker = true;
  }
  if (COMPOSE_FILES.some((file) => names.has(file))) {
    addScript(scripts, 'up', 'docker compose up', 'docker');
    addScript(scripts, 'down', 'docker compose down', 'docker');
    contributes.docker = true;
  }

  // Python: requirements.txt / pyproject.toml (+ main.py entry point)
  if (names.has('main.py')) {
    addScript(scripts, 'run', 'python main.py', 'python');
    contributes.python = true;
  }
  if (names.has('requirements.txt')) {
    addScript(scripts, 'install', 'pip install -r requirements.txt', 'python');
    contributes.python = true;
  }
  if (names.has('pyproject.toml')) {
    addScript(scripts, 'install', 'pip install -e .', 'python');
    contributes.python = true;
  }

  // Go: go.mod
  if (names.has('go.mod')) {
    addScript(scripts, 'run', 'go run .', 'go');
    addScript(scripts, 'test', 'go test ./...', 'go');
    contributes.go = true;
  }

  if (Object.keys(scripts).length === 0) {
    return null;
  }

  const type = TYPE_PRIORITY.find((candidate) => contributes[candidate]) ?? 'node';
  return { dir, type, scripts };
}

/** Gives every target a unique name; duplicates fall back to their root-relative path. */
function labelTargets(rawTargets: RawTarget[], root: string): Array<{ raw: RawTarget; name: string }> {
  const byName = new Map<string, RawTarget[]>();
  for (const raw of rawTargets) {
    const base = path.basename(raw.dir);
    const group = byName.get(base);
    if (group) {
      group.push(raw);
    } else {
      byName.set(base, [raw]);
    }
  }

  return rawTargets.map((raw) => {
    const base = path.basename(raw.dir);
    const group = byName.get(base) ?? [];
    if (group.length === 1) {
      return { raw, name: base };
    }
    const relative = path.relative(root, raw.dir);
    const qualified = relative === '' ? `${base} (root)` : relative.split(path.sep).join('/');
    return { raw, name: qualified };
  });
}

function depthOf(dir: string, root: string): number {
  const relative = path.relative(root, dir);
  return relative === '' ? 0 : relative.split(path.sep).length;
}

/**
 * Crawls `rootDir` (plus up to `maxDepth` levels below it) and returns every
 * directory that looks runnable, together with the scripts it exposes.
 */
export async function scan(rootDir: string, options: ScanOptions = {}): Promise<ProjectTarget[]> {
  const maxDepth = options.maxDepth ?? 3;
  const ignored = new Set<string>([...DEFAULT_IGNORED_DIRS, ...(options.ignore ?? [])]);
  const root = path.resolve(rootDir);
  const found: RawTarget[] = [];

  async function visit(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // permission errors etc. are skipped rather than fatal
    }

    const names = new Set(entries.map((entry) => entry.name));
    const target = await fingerprintDir(dir, names);
    if (target) {
      found.push(target);
    }

    if (depth >= maxDepth) {
      return;
    }

    const subdirs = entries
      .filter((entry) => entry.isDirectory() && !ignored.has(entry.name) && !entry.name.startsWith('.'))
      .map((entry) => path.join(dir, entry.name));

    await Promise.all(subdirs.map((subdir) => visit(subdir, depth + 1)));
  }

  await visit(root, 0);

  return labelTargets(found, root)
    .map<ProjectTarget>(({ raw, name }) => ({ name, path: raw.dir, type: raw.type, scripts: raw.scripts }))
    .sort((a, b) => {
      const depth = depthOf(a.path, root) - depthOf(b.path, root);
      return depth !== 0 ? depth : a.name.localeCompare(b.name);
    });
}

/** Returns every target that defines a script with the given name. */
export function filterByScript(targets: ProjectTarget[], script: string): ProjectTarget[] {
  return targets.filter((target) => Object.prototype.hasOwnProperty.call(target.scripts, script));
}

/** Flat list of every script name found during a scan, sorted alphabetically. */
export function availableScripts(targets: ProjectTarget[]): string[] {
  const names = new Set<string>();
  for (const target of targets) {
    for (const script of Object.keys(target.scripts)) {
      names.add(script);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
