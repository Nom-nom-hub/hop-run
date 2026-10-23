import { open, readdir, readFile, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { parseJsonText } from './json.js';

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
  /**
   * True when the directory holds a compose file, whatever its main type is.
   * A directory with both a `package.json` and a compose file is a node
   * project that also publishes container ports.
   */
  compose?: boolean;
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
  // Go's equivalent of node_modules: third-party sources copied into the
  // tree by `go mod vendor`. They are dependencies, not projects.
  'vendor',
];

/**
 * Names that are ambiguous: they are usually build output, but a hand-written
 * project can be called `build` or `out` just as well.
 *
 * Such a directory is still skipped when it holds no project of its own.
 */
const AMBIGUOUS_IGNORED_DIRS: readonly string[] = ['build', 'out', 'target'];

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/** Priority used to pick the single `type` for a directory carrying several fingerprints. */
const TYPE_PRIORITY: readonly ProjectType[] = ['node', 'docker', 'python', 'go'];

/** The real path of `dir`, or undefined when it cannot be resolved. */
async function realPath(dir: string): Promise<string | undefined> {
  try {
    return await realpath(dir);
  } catch {
    return undefined;
  }
}

/**
 * Commands that run a whole workspace instead of one project.
 *
 * A monorepo root that says `turbo dev` starts every package below it, so
 * running that root *and* the packages would start each dev server twice.
 */
const ORCHESTRATOR_COMMAND = /(^|[\s&|])(turbo|nx|lerna|rush|wsrun)\b|(^|[\s&|])npm\s+run\s+--workspaces|(^|[\s&|])pnpm\s+(-r|--recursive)\b|(^|[\s&|])yarn\s+workspaces\b/;

/** True when the command orchestrates the workspace below it. */
export function isOrchestratorCommand(command: string): boolean {
  return ORCHESTRATOR_COMMAND.test(command);
}

interface RawTarget {
  dir: string;
  type: ProjectType;
  scripts: Record<string, string>;
  /** True when the directory holds a compose file, whatever its main type is. */
  compose: boolean;
  /**
   * True when the script orchestrates the workspace below (turbo, nx, lerna,
   * `pnpm -r`, …) instead of running this project's own code.
   */
  orchestrator: boolean;
}

/**
 * Adds `command` under `key`; on collision the key is namespaced as `type:key`
 * so nothing is lost.
 *
 * If that namespaced key is taken as well (the user already has a script called
 * `docker:build`), a counter is appended rather than dropping the command —
 * a detected command must never disappear without a trace.
 */
function addScript(scripts: Record<string, string>, key: string, command: string, type: ProjectType): void {
  if (!(key in scripts)) {
    scripts[key] = command;
    return;
  }
  const namespaced = `${type}:${key}`;
  if (!(namespaced in scripts)) {
    scripts[namespaced] = command;
    return;
  }
  for (let counter = 2; ; counter += 1) {
    const candidate = `${namespaced}:${counter}`;
    if (!(candidate in scripts)) {
      scripts[candidate] = command;
      return;
    }
  }
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = parseJsonText(await readFile(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null; // unreadable or invalid JSON is simply "not a fingerprint"
  }
}

/** How much of a Go file is read to find its package clause. */
const GO_FILE_HEAD_BYTES = 512;

/** A Go package found in a directory. */
interface GoPackage {
  /** The package clause, e.g. `main` or `api`. */
  name: string;
  /** The files that are not tests. */
  files: string[];
  /** The `*_test.go` files. */
  testFiles: string[];
}

/**
 * The package clause of a Go file.
 *
 * The clause is the first thing in the file, after any build tag or
 * comment, so only the head of the file has to be read.
 */
async function readGoPackageName(file: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(GO_FILE_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, GO_FILE_HEAD_BYTES, 0);
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
        continue;
      }
      return /^package\s+(\w+)/.exec(trimmed)?.[1];
    }
    return undefined;
  } catch {
    return undefined; // unreadable file: it simply says nothing about the package
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }
}

/**
 * The Go packages in a directory, grouped by their package clause.
 *
 * A directory can hold several packages side by side, and naming only the
 * files of one of them is what keeps `go run` from failing with
 * "found packages main and lib".
 */
async function readGoPackages(dir: string, goFiles: string[]): Promise<GoPackage[]> {
  const groups = new Map<string, GoPackage>();
  for (const name of goFiles) {
    const packageName = await readGoPackageName(path.join(dir, name));
    if (packageName === undefined) {
      continue;
    }
    let group = groups.get(packageName);
    if (!group) {
      group = { name: packageName, files: [], testFiles: [] };
      groups.set(packageName, group);
    }
    if (name.endsWith('_test.go')) {
      group.testFiles.push(name);
    } else {
      group.files.push(name);
    }
  }
  return [...groups.values()];
}

/** What the scanner knows about the Go code in one directory. */
interface GoContext {
  /** The directory holds a `go.mod` of its own. */
  hasModule: boolean;
  /**
   * A module is in reach — this directory has a `go.mod`, or one of its
   * ancestors does, or a `go.work` puts it in a workspace.
   *
   * It changes the commands: inside a module `go run .` works, outside one
   * it refuses to start.
   */
  inModule: boolean;
  /** The packages found in this directory. */
  packages: GoPackage[];
}

async function fingerprintDir(dir: string, names: Set<string>, go: GoContext): Promise<RawTarget | null> {
  const scripts: Record<string, string> = {};
  const contributes: Record<ProjectType, boolean> = { node: false, docker: false, python: false, go: false };

  // Node.js / JavaScript: package.json -> everything inside "scripts"
  let orchestrator = false;
  if (names.has('package.json')) {
    const pkg = await readJsonObject(path.join(dir, 'package.json'));
    const pkgScripts = pkg?.scripts;
    // An array is not a script map: treating it as one would invent script
    // names like "0" and "1".
    if (typeof pkgScripts === 'object' && pkgScripts !== null && !Array.isArray(pkgScripts)) {
      for (const [key, value] of Object.entries(pkgScripts)) {
        if (typeof value === 'string' && value.trim() !== '') {
          addScript(scripts, key, value, 'node');
          contributes.node = true;
          if (isOrchestratorCommand(value)) {
            orchestrator = true;
          }
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
  const compose = COMPOSE_FILES.some((file) => names.has(file));

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

  // Go: a module, or the sources of a program that has no module yet.
  const main = go.packages.find((pkg) => pkg.name === 'main');
  if (go.hasModule) {
    // A module: its own commands work from the root. `go run .` only works
    // when the root is itself a program, so it is offered only then.
    addScript(scripts, 'test', 'go test ./...', 'go');
    if (main && main.files.length > 0) {
      addScript(scripts, 'run', 'go run .', 'go');
    }
    contributes.go = true;
  } else if (main && main.files.length > 0) {
    // A program without a module of its own. Inside a module `go run .`
    // works; outside one it refuses to start ("go.mod file not found"),
    // and naming the files is the way to run it.
    if (go.inModule) {
      addScript(scripts, 'run', 'go run .', 'go');
    } else {
      addScript(scripts, 'run', `go run ${main.files.join(' ')}`, 'go');
    }
    if (main.testFiles.length > 0) {
      addScript(scripts, 'test', go.inModule ? 'go test .' : `go test ${[...main.files, ...main.testFiles].join(' ')}`, 'go');
    }
    contributes.go = true;
  } else {
    // No program here, but a library can still be tested.
    const testable = go.packages.find((pkg) => pkg.testFiles.length > 0);
    if (testable) {
      addScript(scripts, 'test', go.inModule ? 'go test .' : `go test ${[...testable.files, ...testable.testFiles].join(' ')}`, 'go');
      contributes.go = true;
    }
  }

  if (Object.keys(scripts).length === 0) {
    return null;
  }

  const type = TYPE_PRIORITY.find((candidate) => contributes[candidate]) ?? 'node';
  return { dir, type, scripts, compose, orchestrator };
}

/**
 * Gives every target a unique name.
 *
 * Duplicates fall back to their root-relative path. The fallback is not
 * guaranteed to be unique on its own (a directory can literally be called
 * "app (root)"), so a counter is appended until the name is free — otherwise
 * two targets would share a name, merge their dirty counts and overwrite each
 * other in the interactive menu.
 */
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

  const used = new Set<string>();
  const take = (preferred: string): string => {
    if (!used.has(preferred)) {
      used.add(preferred);
      return preferred;
    }
    for (let counter = 2; ; counter += 1) {
      const candidate = `${preferred} (${counter})`;
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
  };

  return rawTargets.map((raw) => {
    const base = path.basename(raw.dir);
    const group = byName.get(base) ?? [];
    if (group.length === 1) {
      return { raw, name: take(base) };
    }
    const relative = path.relative(root, raw.dir);
    const qualified = relative === '' ? `${base} (root)` : relative.split(path.sep).join('/');
    return { raw, name: take(qualified) };
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
  /**
   * Real paths already crawled. A symlinked directory is followed — projects
   * often live behind one — but a link that points back into the tree would
   * loop forever, so the real path decides.
   */
  const visitedRealPaths = new Set<string>();

  async function visit(dir: string, depth: number, insideModule: boolean): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // permission errors etc. are skipped rather than fatal
    }

    const names = new Set(entries.map((entry) => entry.name));
    const goFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.go'))
      .map((entry) => entry.name)
      .sort();
    const hasModule = names.has('go.mod');
    // A `go.work` puts the whole tree in a workspace, which is a module
    // context just like a `go.mod` is.
    const inModule = insideModule || hasModule || names.has('go.work');
    // A `build`/`out`/`target` directory is build output: the manifest it may
    // hold is an artifact, not a project. Projects *inside* it are still found.
    // A go.mod is the exception — Go never writes one into build output, so
    // it is proof of a real module.
    const isBuildOutput =
      depth > 0 && AMBIGUOUS_IGNORED_DIRS.includes(path.basename(dir)) && !hasModule;
    const target = isBuildOutput
      ? null
      : await fingerprintDir(dir, names, {
          hasModule,
          inModule,
          packages: await readGoPackages(dir, goFiles),
        });
    if (target) {
      found.push(target);
    }

    if (depth >= maxDepth) {
      return;
    }

    const subdirs: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      if (entry.name.startsWith('.')) {
        continue;
      }
      const subdir = path.join(dir, entry.name);
      if (ignored.has(entry.name) && !AMBIGUOUS_IGNORED_DIRS.includes(entry.name)) {
        continue; // node_modules, .git, dist, venv, … are never crawled
      }
      // Every directory is checked against its real path, so a junction that
      // points back at an ancestor is skipped instead of looping.
      const real = await realPath(subdir);
      if (real === undefined || visitedRealPaths.has(real)) {
        continue;
      }
      visitedRealPaths.add(real);
      subdirs.push(subdir);
    }

    await Promise.all(subdirs.map((subdir) => visit(subdir, depth + 1, inModule)));
  }

  await visit(root, 0, false);

  // A monorepo root that orchestrates its workspace (`turbo dev`) would start
  // every package below it *and* the packages themselves. The root is dropped
  // when there are other projects below it; on its own it is still the only
  // thing that can run.
  const belowRoot = found.filter((raw) => raw.dir !== root);
  const kept = found.filter((raw) => {
    if (raw.dir !== root || !raw.orchestrator) {
      return true;
    }
    return belowRoot.length === 0;
  });

  return labelTargets(kept, root)
    .map<ProjectTarget>(({ raw, name }) => ({
      name,
      path: raw.dir,
      type: raw.type,
      scripts: raw.scripts,
      ...(raw.compose ? { compose: true } : {}),
    }))
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
