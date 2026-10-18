#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cancel, groupMultiselect, intro, isCancel, spinner } from '@clack/prompts';
import { Command, CommanderError } from 'commander';
import pc from 'picocolors';
import { changedFiles, dirtyFileCounts, primaryScript } from './git.js';
import { availableScripts, DEFAULT_MAX_DEPTH, filterByScript, scan, type ProjectTarget } from './scanner.js';
import {
  colorForTarget,
  detectPackageManager,
  formatDuration,
  packageManagerCommand,
  runScripts,
  type DependencyGate,
  type Formatter,
  type RunHooks,
  type RunResult,
  type RunSpec,
} from './executor.js';

export { scan, filterByScript, runScripts };

const GLYPH = { ok: '✔', fail: '✖', warn: '⚠', dot: '·' } as const;
const PREFIX = pc.dim('[hop]');
const CONTINUATION = '      '; // aligns with "[hop] "

const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const HELP = [
  `${pc.bold('hop')} ${pc.dim('— zero-config project runner')}`,
  '',
  pc.bold('Usage'),
  `  ${pc.cyan('hop'.padEnd(22))}Pick scripts interactively ${pc.dim('(space toggle · enter run)')}`,
  `  ${pc.cyan('hop <script>'.padEnd(22))}Run every matching script everywhere ${pc.dim('(e.g. hop dev)')}`,
  `  ${pc.cyan('hop <script> --npm'.padEnd(22))}Node scripts via their package manager ${pc.dim('(pre/post hooks run)')}`,
  `  ${pc.cyan('hop <script> --no-wait'.padEnd(22))}Start everything at once ${pc.dim('(skip dependency waits)')}`,
  `  ${pc.cyan('hop --list, -l'.padEnd(22))}List detected projects and their scripts`,
  `  ${pc.cyan('hop --help, -h'.padEnd(22))}Show this help`,
  `  ${pc.cyan('hop --version, -v'.padEnd(22))}Print the version`,
  '',
  pc.bold('Detection'),
  `  Scans the current directory and up to ${DEFAULT_MAX_DEPTH} levels below it, skipping`,
  `  node_modules, .git, dist, build, venv and dot-directories.`,
  '',
  `  ${pc.dim('node'.padEnd(8))}package.json             the "scripts" object`,
  `  ${pc.dim('docker'.padEnd(8))}Dockerfile / compose     docker build · docker compose up/down`,
  `  ${pc.dim('python'.padEnd(8))}requirements / pyproject python main.py · pip install`,
  `  ${pc.dim('go'.padEnd(8))}go.mod                   go run . · go test ./...`,
  '',
  `  Output from every script streams with a ${pc.dim('[folder]')} tag;`,
  `  ${pc.bold('Ctrl+C')} stops every child process hop started.`,
  '',
  pc.bold('Smart startup'),
  `  A busy port is swapped for the next free one: hop checks ${pc.dim('--port')}, ${pc.dim('$PORT')}`,
  `  and ${pc.dim('.env')}, then hands the child the new ${pc.dim('PORT')}. Scripts that reference a`,
  `  sibling's port ${pc.dim('(e.g. localhost:4000 or a compose service)')} wait for it to answer,`,
  `  up to 30 s, before they start — add ${pc.dim('"hop": { "waitFor": [5432] }')} to pin it.`,
  '',
  `  In a git repository, projects with uncommitted changes are pre-selected.`,
].join('\n');

const log = (message: string): void => {
  console.log(`${PREFIX} ${message}`);
};

const detail = (message: string): void => {
  console.log(`${CONTINUATION}${message}`);
};

const fail = (message: string): void => {
  console.error(`${PREFIX} ${pc.red(message)}`);
};

const plural = (count: number, word: string): string => `${pc.bold(String(count))} ${word}${count === 1 ? '' : 's'}`;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function maxWidth(values: string[]): number {
  return values.reduce((max, value) => Math.max(max, value.length), 0);
}

function terminalWidth(): number {
  const columns = process.stdout.columns;
  return typeof columns === 'number' && columns >= 60 ? columns : 100;
}

function relativeLabel(root: string, dir: string): string {
  const relative = path.relative(root, dir);
  if (relative === '') {
    return '.';
  }
  const label = relative.split(path.sep).join('/');
  return label.startsWith('..') ? label : `./${label}`;
}

/** Project column colors stay stable between menu, listing and log tags. */
function targetColor(index: number): Formatter {
  return colorForTarget(index);
}

/** The command hop will execute: raw script text, or a package-manager run under `--npm`. */
function resolveCommand(target: ProjectTarget, script: string, npmMode: boolean): string {
  if (npmMode && target.type === 'node') {
    return packageManagerCommand(detectPackageManager(target.path), script);
  }
  return target.scripts[script] ?? '';
}

/** What a gated spec is waiting for, e.g. `backend :4000 · database :5432`. */
function dependencyList(gate: DependencyGate): string {
  return gate.dependencies
    .map((dependency) => `${pc.bold(dependency.name)}${pc.dim(` :${dependency.port}`)}`)
    .join(pc.dim(` ${GLYPH.dot} `));
}

interface RunUi {
  hooks: RunHooks;
  /** stdout wrapper that keeps child output from fighting the spinner. */
  stream: Pick<NodeJS.WriteStream, 'write'>;
}

/**
 * Builds the handshake UI: an animated clack spinner while a dependency comes
 * up, downgraded to plain `[hop]` lines as soon as anything else writes to the
 * terminal (child output, notices, a second wait).
 */
function createRunUi(): RunUi {
  const spin = process.stdout.isTTY === true ? spinner() : null;
  const waitStartedAt = new WeakMap<DependencyGate, number>();
  let spinOwner: DependencyGate | null = null;

  const haltSpinner = (): void => {
    if (spinOwner !== null) {
      spin?.clear(); // erase the animated line without leaving residue
      spinOwner = null;
    }
  };

  const note = (message: string): void => {
    haltSpinner();
    log(message);
  };

  const settle = (gate: DependencyGate, message: string): void => {
    if (spinOwner === gate) {
      spinOwner = null;
      spin?.stop(message);
      return;
    }
    note(message);
  };

  const hooks: RunHooks = {
    onPortRedirect({ name, from, to, color }): void {
      note(
        `${pc.yellow(GLYPH.warn)} port ${pc.bold(String(from))} was blocked ${pc.dim(GLYPH.dot)} ` +
          `redirecting ${color(`[${name}]`)} to port ${pc.bold(String(to))}`,
      );
    },
    onWaitStart(gate): void {
      waitStartedAt.set(gate, Date.now());
      const wanted = dependencyList(gate);
      const suffix = pc.dim(`before starting ${gate.name}`);
      // Only animate while hop is the only thing writing to the terminal.
      if (spin !== null && spinOwner === null && gate.running === 0) {
        spinOwner = gate;
        spin.start(`waiting for ${wanted} ${suffix}`);
        return;
      }
      note(`waiting for ${wanted} ${suffix}`);
    },
    onWaitEnd(gate, outcome): void {
      const wanted = dependencyList(gate);
      const elapsed = formatDuration(Date.now() - (waitStartedAt.get(gate) ?? Date.now()));
      if (outcome === 'ready') {
        settle(gate, `${pc.green(GLYPH.ok)} ${wanted} ${pc.dim(`is up ${GLYPH.dot} ${elapsed} ${GLYPH.dot} starting ${gate.name}`)}`);
        return;
      }
      if (outcome === 'timeout') {
        settle(
          gate,
          `${pc.yellow(GLYPH.warn)} ${wanted} ${pc.dim(`not answering after ${elapsed} ${GLYPH.dot} starting ${gate.name} anyway`)}`,
        );
        return;
      }
      haltSpinner(); // aborted (Ctrl+C): the interrupt banner is printed by the executor
    },
  };

  const stream: RunUi['stream'] = {
    write(text: string): boolean {
      haltSpinner();
      return process.stdout.write(text);
    },
  };

  return { hooks, stream };
}

function printProjectList(root: string, targets: ProjectTarget[], npmMode: boolean): void {
  const nameWidth = maxWidth(targets.map((target) => target.name));
  const width = terminalWidth();

  targets.forEach((target, index) => {
    const color = targetColor(index);
    const meta = `${pc.dim(target.type.padEnd(6))} ${pc.dim(relativeLabel(root, target.path))}`;
    console.log(`\n  ${color(target.name.padEnd(nameWidth))}  ${meta}`);

    const scriptNames = Object.keys(target.scripts);
    const scriptWidth = maxWidth(scriptNames);
    for (const script of scriptNames) {
      const room = Math.max(24, width - 4 - scriptWidth - 4);
      const command = resolveCommand(target, script, npmMode);
      console.log(`    ${pc.cyan(script.padEnd(scriptWidth))}  ${pc.dim(truncate(command, room))}`);
    }
  });
}

function printRunHeader(specs: RunSpec[]): void {
  const nameWidth = maxWidth(specs.map((spec) => spec.name));
  const scriptWidth = maxWidth(specs.map((spec) => spec.script));
  const width = terminalWidth();

  console.log();
  for (const spec of specs) {
    const color = spec.color ?? ((text: string) => text);
    const room = Math.max(24, width - 2 - nameWidth - scriptWidth - 4);
    const label = `${color(spec.name.padEnd(nameWidth))}  ${pc.bold(spec.script.padEnd(scriptWidth))}`;
    console.log(`  ${label}  ${pc.dim(truncate(spec.command, room))}`);
  }
  console.log();
}

function printSummary(results: RunResult[], totalMs: number): number {
  const failed = results.filter((result) => !result.ok);
  const succeeded = results.length - failed.length;
  const total = `${succeeded}/${results.length} scripts succeeded`;

  console.log();
  if (failed.length === 0) {
    console.log(`  ${pc.green(GLYPH.ok)} ${total} ${pc.dim(`${GLYPH.dot} ${formatDuration(totalMs)}`)}`);
    return 0;
  }

  console.log(`  ${pc.red(GLYPH.fail)} ${total} ${pc.dim(`${GLYPH.dot} ${formatDuration(totalMs)}`)}`);
  for (const result of failed) {
    const reason =
      result.error ?? (result.signal !== null ? `signal ${result.signal}` : `exit ${String(result.code)}`);
    console.log(
      `    ${pc.red(GLYPH.fail)} ${result.name} ${pc.dim(result.script)} ${pc.dim(`(${truncate(reason, 60)})`)}`,
    );
  }
  return 1;
}

function specFor(target: ProjectTarget, script: string, npmMode: boolean, color?: Formatter): RunSpec {
  return {
    name: target.name,
    dir: target.path,
    script,
    command: resolveCommand(target, script, npmMode),
    type: target.type,
    ...(color ? { color } : {}),
  };
}

/** Flags every command path shares. */
interface RunOptions {
  npmMode: boolean;
  waitForDependencies: boolean;
}

async function execute(specs: RunSpec[], options: RunOptions): Promise<number> {
  printRunHeader(specs);

  const startedAt = Date.now();
  const ui = createRunUi();
  const { results, interrupted } = await runScripts(specs, {
    stream: ui.stream,
    hooks: ui.hooks,
    waitForDependencies: options.waitForDependencies,
  });
  const totalMs = Date.now() - startedAt;

  if (interrupted) {
    console.log();
    console.log(`  ${pc.yellow(GLYPH.warn)} stopped by signal ${pc.dim(`${GLYPH.dot} all child processes terminated`)}`);
    return 130;
  }

  return printSummary(results, totalMs);
}

async function runDirect(root: string, targets: ProjectTarget[], script: string, options: RunOptions): Promise<number> {
  const matches = filterByScript(targets, script);

  if (matches.length === 0) {
    if (targets.length === 0) {
      fail(`no runnable project found in ${pc.bold(root)} ${pc.dim(`(scanned ${DEFAULT_MAX_DEPTH} levels deep)`)}`);
      return 1;
    }
    fail(`no project defines a script named "${script}"`);
    const names = availableScripts(targets).map((name) => pc.cyan(name)).join(pc.dim(` ${GLYPH.dot} `));
    detail(`${pc.dim('available:')} ${names}`);
    return 1;
  }

  log(`running ${pc.bold(script)} in ${plural(matches.length, 'project')}`);
  return execute(matches.map((target, index) => specFor(target, script, options.npmMode, targetColor(index))), options);
}

/**
 * clack's readline leaves `process.stdin` referenced once the menu is done,
 * which would keep hop's event loop alive forever after an interactive run.
 * Release it so the process exits as soon as the children are done.
 */
function releaseStdin(): void {
  try {
    process.stdin.pause();
    process.stdin.unref?.();
  } catch {
    // stdin may already be torn down — nothing to release then.
  }
}

async function runInteractive(root: string, targets: ProjectTarget[], options: RunOptions): Promise<number> {
  if (targets.length === 0) {
    log(`no runnable project found in ${pc.bold(root)} ${pc.dim(`(scanned ${DEFAULT_MAX_DEPTH} levels deep)`)}`);
    detail(pc.dim('looking for package.json · Dockerfile / compose · requirements.txt / pyproject.toml · go.mod'));
    return 0;
  }

  // Uncommitted files tell hop what the developer is working on right now.
  const dirtyCounts = dirtyFileCounts(targets, changedFiles(root));

  const entries: RunSpec[] = [];
  const groups: Record<string, Array<{ value: number; label: string; hint: string }>> = {};
  const initialValues: number[] = [];
  const width = terminalWidth();

  targets.forEach((target, targetIndex) => {
    const color = targetColor(targetIndex);
    const dirty = dirtyCounts.get(target.name);
    const preselected = dirty === undefined ? undefined : primaryScript(target);
    const label = color(target.name);
    const heading = dirty === undefined ? label : `${label} ${pc.dim(`${GLYPH.dot} ${dirty} changed`)}`;

    groups[heading] = Object.keys(target.scripts).map((script) => {
      const spec = specFor(target, script, options.npmMode, color);
      entries.push(spec);
      const value = entries.length - 1;
      if (script === preselected) {
        initialValues.push(value);
      }
      return {
        value,
        label: script,
        hint: truncate(spec.command, Math.max(24, width - 36)),
      };
    });
  });

  intro(`${pc.bold('hop')} ${pc.dim(GLYPH.dot)} ${plural(targets.length, 'project')} ${pc.dim('detected')}`);

  const picked = await groupMultiselect<number>({
    message: 'Select scripts to run',
    options: groups,
    initialValues,
    required: false,
  });

  try {
    if (isCancel(picked)) {
      cancel('canceled — nothing was started');
      return 130; // cancelled with Ctrl+C
    }
    if (picked.length === 0) {
      cancel('nothing selected');
      return 0;
    }

    const specs = picked
      .map((index) => entries[index])
      .filter((spec): spec is RunSpec => spec !== undefined);

    return await execute(specs, options);
  } finally {
    releaseStdin();
  }
}

/**
 * True when this module was launched as the CLI entry point (as opposed to
 * being imported as a library).
 *
 * Paths are compared after `realpathSync` because global installs (`npm link`,
 * `npm i -g`) execute the CLI through a symlink/junction: `process.argv[1]`
 * carries the link path while `import.meta.url` is the resolved real path.
 */
export function isCliEntry(entry: string | undefined, moduleUrl: string): boolean {
  if (entry === undefined) {
    return false;
  }
  try {
    const realEntry = realpathSync(path.resolve(entry));
    const realSelf = realpathSync(fileURLToPath(moduleUrl));
    return comparePaths(realEntry, realSelf);
  } catch {
    return false;
  }
}

function comparePaths(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Commander writes its errors through here so they match hop's look. */
function writeErr(text: string): void {
  text
    .trimEnd()
    .split('\n')
    .forEach((line) => {
      console.error(`${PREFIX} ${line.startsWith('error:') ? pc.red(line) : pc.dim(line)}`);
    });
}

function createProgram(): Command {
  const program = new Command();
  program
    .name('hop')
    .usage('[script] [options]')
    .description('Zero-config project runner — scan, pick, run.')
    .argument('[script]', 'run this script in every matching project')
    .option('--npm', 'run node scripts through their package manager (pre/post hooks run)')
    .option('--no-wait', 'start every script at once, without waiting for dependencies')
    .option('-l, --list', 'list detected projects and their scripts')
    .helpOption(false) // hop prints its own styled help
    .option('-h, --help', 'show this help')
    .version(VERSION, '-v, --version', 'print the version')
    .showHelpAfterError('run "hop --help" for usage')
    .exitOverride()
    .configureOutput({ writeErr });
  return program;
}

export async function main(argv: string[]): Promise<number> {
  const program = createProgram();
  try {
    program.parse(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      // --version already printed to stdout; parse errors already went to stderr.
      return error.exitCode === 0 ? 0 : 1;
    }
    throw error;
  }

  const options = program.opts<{ npm?: boolean; list?: boolean; help?: boolean; wait?: boolean }>();
  if (options.help === true) {
    console.log(HELP);
    return 0;
  }

  const root = process.cwd();
  const runOptions: RunOptions = {
    npmMode: options.npm === true,
    waitForDependencies: options.wait !== false,
  };
  const targets = await scan(root);

  if (options.list === true) {
    if (targets.length === 0) {
      log(`no runnable project found in ${pc.bold(root)} ${pc.dim(`(scanned ${DEFAULT_MAX_DEPTH} levels deep)`)}`);
      return 0;
    }
    const names = availableScripts(targets).map((name) => pc.cyan(name)).join(pc.dim(` ${GLYPH.dot} `));
    log(`${plural(targets.length, 'project')} under ${pc.bold(root)}`);
    detail(`${pc.dim('scripts:')} ${names}`);
    printProjectList(root, targets, runOptions.npmMode);
    console.log();
    return 0;
  }

  const script = program.processedArgs[0] as string | undefined;
  if (script !== undefined) {
    return runDirect(root, targets, script, runOptions);
  }
  return runInteractive(root, targets, runOptions);
}

const isDirectRun = isCliEntry(process.argv[1], import.meta.url);

if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
      if (code === 130) {
        // Safety net: never hang on a stray handle after an interrupt.
        const timer = setTimeout(() => process.exit(130), 250);
        timer.unref();
      }
    })
    .catch((error: unknown) => {
      fail(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
