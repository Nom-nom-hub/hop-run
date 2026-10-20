#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cancel, groupMultiselect, intro, isCancel, spinner } from '@clack/prompts';
import { Command, CommanderError } from 'commander';
import pc from 'picocolors';
import { changedFiles, dirtyFileCounts, primaryScript } from './git.js';
import { parseJsonText } from './json.js';
import {
  branch,
  CHIP,
  GLYPH,
  padTo,
  rule,
  section,
  STYLE,
  styleForType,
  truncate,
  visibleLength,
  widest,
  wordmark,
  type Style,
} from './theme.js';
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

const PREFIX = STYLE.muted('[hop]');
const CONTINUATION = '      '; // aligns with "[hop] "

const VERSION: string = (() => {
  try {
    const pkg = parseJsonText(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** Lays out `label → description` rows in two aligned columns. */
function helpRows(rows: Array<[string, string]>, gap = 2): string {
  const width = widest(rows.map(([label]) => label));
  return rows.map(([label, description]) => `  ${padTo(label, width + gap)}${description}`).join('\n');
}

/** Lays out `kind · fingerprint → description` rows in three aligned columns. */
function helpRows3(rows: Array<[string, string, string]>, gap = 2): string {
  const kindWidth = widest(rows.map(([kind]) => kind));
  const fingerprintWidth = widest(rows.map(([, fingerprint]) => fingerprint));
  return rows
    .map(
      ([kind, fingerprint, description]) =>
        `  ${padTo(kind, kindWidth + 1)}${padTo(fingerprint, fingerprintWidth + gap)}${description}`,
    )
    .join('\n');
}

const USAGE_ROWS: Array<[string, string]> = [
  ['hop', `Pick scripts interactively ${STYLE.muted('(space toggle · enter run)')}`],
  ['hop <script>', `Run every matching script everywhere ${STYLE.muted('(e.g. hop dev)')}`],
  ['hop <script> --npm', `Node scripts via their package manager ${STYLE.muted('(pre/post hooks run)')}`],
  ['hop <script> --no-wait', `Start everything at once ${STYLE.muted('(skip dependency waits)')}`],
  ['hop --list, -l', 'List detected projects and their scripts'],
  ['hop --help, -h', 'Show this help'],
  ['hop --version, -v', 'Print the version'],
];

const DETECTION_ROWS: Array<[string, string, string]> = [
  ['node', 'package.json', 'the "scripts" object'],
  ['docker', 'Dockerfile / compose', 'docker build · docker compose up/down'],
  ['python', 'requirements / pyproject', 'python main.py · pip install'],
  ['go', 'go.mod', 'go run . · go test ./...'],
];

const HELP = [
  wordmark(STYLE.muted('zero-config project runner')),
  '',
  section('Usage', 46),
  helpRows(USAGE_ROWS.map(([label, description]) => [STYLE.brand(label), description])),
  '',
  section('Detection', 46),
  `  Scans the current directory and up to ${STYLE.strong(String(DEFAULT_MAX_DEPTH))} levels below it, skipping`,
  `  node_modules, .git, dist, build, venv and dot-directories.`,
  '',
  helpRows3(
    DETECTION_ROWS.map(
      ([kind, fingerprint, description]): [string, string, string] => [
        styleForType(kind)(kind),
        STYLE.muted(fingerprint),
        description,
      ],
    ),
  ),
  '',
  `  Output from every script streams with a ${STYLE.muted('[folder]')} tag;`,
  `  ${STYLE.strong('Ctrl+C')} stops every child process hop started.`,
  '',
  section('Smart startup', 46),
  `  A busy port is swapped for the next free one: hop checks ${STYLE.muted('--port')}, ${STYLE.muted('$PORT')}`,
  `  and ${STYLE.muted('.env')}, then hands the child the new ${STYLE.muted('PORT')}. Scripts that reference a`,
  `  sibling's port ${STYLE.muted('(e.g. localhost:4000 or a compose service)')} wait for it to answer,`,
  `  up to 30 s, before they start — add ${STYLE.muted('"hop": { "waitFor": [5432] }')} to pin it.`,
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
  console.error(`${PREFIX} ${STYLE.fail(message)}`);
};

/**
 * The "nothing here" screen: what hop looked for, so the user can see why
 * nothing was found instead of guessing.
 */
function printNothingFound(root: string, reason: string): void {
  console.log();
  console.log(`  ${STYLE.warn(GLYPH.warn)} ${STYLE.strong(reason)}`);
  console.log(`  ${STYLE.muted(`in ${root}`)}`);
  console.log();
  console.log(`  ${STYLE.muted('hop looks for')}`);
  for (const marker of [
    'package.json with a "scripts" object',
    'Dockerfile or docker-compose.yml',
    'main.py, requirements.txt or pyproject.toml',
    'go.mod',
  ]) {
    console.log(`    ${STYLE.muted(GLYPH.bullet)} ${STYLE.muted(marker)}`);
  }
  console.log();
}

const plural = (count: number, word: string): string => `${STYLE.strong(String(count))} ${word}${count === 1 ? '' : 's'}`;

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
    .map((dependency) => `${STYLE.strong(dependency.name)}${STYLE.muted(` :${dependency.port}`)}`)
    .join(STYLE.muted(` ${GLYPH.dot} `));
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
        `${STYLE.warn(GLYPH.warn)} port ${STYLE.strong(String(from))} was blocked ${STYLE.muted(GLYPH.dot)} ` +
          `redirecting ${color(`[${name}]`)} to port ${STYLE.strong(String(to))}`,
      );
    },
    onWaitStart(gate): void {
      waitStartedAt.set(gate, Date.now());
      const wanted = dependencyList(gate);
      const suffix = STYLE.muted(`before starting ${gate.name}`);
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
        settle(gate, `${STYLE.ok(GLYPH.ok)} ${wanted} ${STYLE.muted(`is up ${GLYPH.dot} ${elapsed} ${GLYPH.dot} starting ${gate.name}`)}`);
        return;
      }
      if (outcome === 'timeout') {
        settle(
          gate,
          `${STYLE.warn(GLYPH.warn)} ${wanted} ${STYLE.muted(`not answering after ${elapsed} ${GLYPH.dot} starting ${gate.name} anyway`)}`,
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
  const nameWidth = widest(targets.map((target) => target.name));
  const width = terminalWidth();

  targets.forEach((target, index) => {
    const color = targetColor(index);
    const typeStyle = styleForType(target.type);
    const label = color(padTo(target.name, nameWidth));
    const meta = `${typeStyle(CHIP)} ${STYLE.muted(target.type)} ${STYLE.muted(GLYPH.dot)} ${STYLE.muted(relativeLabel(root, target.path))}`;
    console.log(`\n  ${label}  ${meta}`);

    const scriptNames = Object.keys(target.scripts);
    const scriptWidth = widest(scriptNames);
    for (const [position, script] of scriptNames.entries()) {
      const room = Math.max(24, width - 6 - scriptWidth - 4);
      const command = resolveCommand(target, script, npmMode);
      const isLast = position === scriptNames.length - 1;
      console.log(
        `    ${branch(`${STYLE.brand(padTo(script, scriptWidth))}  ${STYLE.muted(truncate(command, room))}`, isLast)}`,
      );
    }
  });
}

function printRunHeader(specs: RunSpec[]): void {
  const nameWidth = widest(specs.map((spec) => spec.name));
  const scriptWidth = widest(specs.map((spec) => spec.script));
  const width = terminalWidth();

  console.log();
  for (const spec of specs) {
    const color = spec.color ?? STYLE.plain;
    const room = Math.max(24, width - 4 - nameWidth - scriptWidth - 6);
    const name = color(padTo(spec.name, nameWidth));
    const script = STYLE.strong(padTo(spec.script, scriptWidth));
    console.log(`  ${STYLE.muted(GLYPH.bullet)} ${name}  ${script}  ${STYLE.muted(truncate(spec.command, room))}`);
  }
  console.log();
}

function printSummary(results: RunResult[], totalMs: number): number {
  const failed = results.filter((result) => !result.ok);
  const succeeded = results.length - failed.length;
  const total = `${succeeded}/${results.length} scripts succeeded`;
  const elapsed = STYLE.muted(`${GLYPH.dot} ${formatDuration(totalMs)}`);

  console.log();
  if (failed.length === 0) {
    console.log(`  ${STYLE.ok(GLYPH.ok)} ${STYLE.ok(total)} ${elapsed}`);
    console.log();
    return 0;
  }

  console.log(`  ${STYLE.fail(GLYPH.fail)} ${STYLE.fail(total)} ${elapsed}`);
  for (const result of failed) {
    const reason =
      result.error ?? (result.signal !== null ? `signal ${result.signal}` : `exit ${String(result.code)}`);
    console.log(
      `    ${STYLE.fail(GLYPH.fail)} ${result.name} ${STYLE.muted(result.script)} ${STYLE.muted(`(${truncate(reason, 60)})`)}`,
    );
  }
  console.log();
  return 1;
}

function specFor(target: ProjectTarget, script: string, npmMode: boolean, color?: Formatter): RunSpec {
  const command = resolveCommand(target, script, npmMode);
  return {
    name: target.name,
    dir: target.path,
    script,
    command,
    type: target.type,
    ...(target.compose ? { compose: true } : {}),
    ...(isComposeCommand(command) ? { composeCommand: true } : {}),
    ...(color ? { color } : {}),
  };
}

/** True for a `docker compose …` command, whatever produced it. */
function isComposeCommand(command: string): boolean {
  return /^\s*docker\s+compose\b/.test(command);
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
    console.log(`  ${STYLE.warn(GLYPH.warn)} stopped by signal ${STYLE.muted(`${GLYPH.dot} all child processes terminated`)}`);
    return 130;
  }

  return printSummary(results, totalMs);
}

async function runDirect(root: string, targets: ProjectTarget[], script: string, options: RunOptions): Promise<number> {
  const matches = filterByScript(targets, script);

  if (matches.length === 0) {
    if (targets.length === 0) {
      printNothingFound(root, 'no runnable project found');
      return 1;
    }
    fail(`no project defines a script named "${script}"`);
    const names = availableScripts(targets).map((name) => STYLE.brand(name)).join(STYLE.muted(` ${GLYPH.dot} `));
    detail(`${STYLE.muted('available:')} ${names}`);
    return 1;
  }

  log(`running ${STYLE.strong(STYLE.brand(script))} in ${plural(matches.length, 'project')}`);
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
    printNothingFound(root, 'no runnable project found');
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
    const typeStyle = styleForType(target.type);

    // The heading carries the project's identity, its ecosystem and — when
    // there is one — how much work is waiting in the working tree.
    const parts = [color(target.name), `${typeStyle(CHIP)} ${STYLE.muted(target.type)}`];
    if (dirty !== undefined) {
      parts.push(`${STYLE.muted(GLYPH.dot)} ${STYLE.warn(`${dirty} changed`)}`);
    }
    const heading = parts.join(' ');

    groups[heading] = Object.keys(target.scripts).map((script) => {
      const spec = specFor(target, script, options.npmMode, color);
      entries.push(spec);
      const value = entries.length - 1;
      if (script === preselected) {
        initialValues.push(value);
      }
      return {
        value,
        label: STYLE.brand(script),
        hint: truncate(spec.command, Math.max(24, width - 36)),
      };
    });
  });

  intro(wordmark(`${STYLE.muted(plural(targets.length, 'project'))} ${STYLE.muted('detected')}`));

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
      console.error(`${PREFIX} ${line.startsWith('error:') ? STYLE.fail(line) : STYLE.muted(line)}`);
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
      printNothingFound(root, 'no runnable project found');
      return 0;
    }
    const names = availableScripts(targets).map((name) => STYLE.brand(name)).join(STYLE.muted(` ${GLYPH.dot} `));
    console.log();
    console.log(`  ${wordmark(`${STYLE.muted(plural(targets.length, 'project'))} ${STYLE.muted('found')}`)}`);
    console.log();
    console.log(`  ${STYLE.muted('scripts')}  ${names}`);
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
