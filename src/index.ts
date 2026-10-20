#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
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
import { App } from './ui/App.js';
import { isInteractive, mount, renderOnce } from './ui/render.js';
import { Help, ListScreen } from './ui/Screens.js';
import type { PickerProject } from './ui/Picker.js';
import { createRunController } from './ui/controller.js';
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
  /** stdout wrapper for the child output. */
  stream: Pick<NodeJS.WriteStream, 'write'>;
}

/**
 * Builds the handshake UI for the plain (non-TTY) path: a `[hop]` line for
 * every port swap and dependency wait.
 */
function createRunUi(): RunUi {
  const waitStartedAt = new WeakMap<DependencyGate, number>();

  const note = (message: string): void => {
    log(message);
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
      note(`waiting for ${wanted} ${suffix}`);
    },
    onWaitEnd(gate, outcome): void {
      const wanted = dependencyList(gate);
      const elapsed = formatDuration(Date.now() - (waitStartedAt.get(gate) ?? Date.now()));
      if (outcome === 'ready') {
        note(
          `${STYLE.ok(GLYPH.ok)} ${wanted} ${STYLE.muted(`is up ${GLYPH.dot} ${elapsed} ${GLYPH.dot} starting ${gate.name}`)}`,
        );
        return;
      }
      if (outcome === 'timeout') {
        note(
          `${STYLE.warn(GLYPH.warn)} ${wanted} ${STYLE.muted(`not answering after ${elapsed} ${GLYPH.dot} starting ${gate.name} anyway`)}`,
        );
        return;
      }
      // aborted (Ctrl+C): the interrupt banner is printed by the executor
    },
  };

  const stream: RunUi['stream'] = {
    write(text: string): boolean {
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
  const startedAt = Date.now();

  // With a terminal, the run is a live board: one row per project, updated
  // in place, with the child output underneath. Without one, the output is
  // a plain, line-oriented log.
  if (isInteractive()) {
    return executeWithInterface(specs, options, startedAt);
  }

  printRunHeader(specs);
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

/**
 * Runs the scripts with the Ink interface up.
 *
 * The executor writes its child output into the controller, which the board
 * renders; when everything has settled, the summary replaces the board.
 */
async function executeWithInterface(
  specs: RunSpec[],
  options: RunOptions,
  startedAt: number,
): Promise<number> {
  const controller = createRunController();

  // Register the rows first, so the board has something to draw.
  for (const spec of specs) {
    controller.startRow(spec.name, spec.script, spec.command);
    controller.updateRow(spec.name, spec.script, { phase: 'starting' });
  }

  const instance = mount(
    React.createElement(App, {
      view: 'running',
      projects: [],
      controller,
      onPick: () => undefined,
      onCancel: () => undefined,
    }),
  );

  const stream: Pick<NodeJS.WriteStream, 'write'> = {
    write(text: string): boolean {
      for (const line of text.split('\n')) {
        if (line.trim() !== '') {
          // The executor colours its tag; the board draws its own, so the
          // escape codes are stripped here.
          controller.addLog(line.replace(/\u001b\[[0-9;]*m/g, ''));
        }
      }
      return true;
    },
  };

  const hooks = createInterfaceHooks(controller);

  let summary;
  let interrupted = false;
  try {
    const outcome = await runScripts(specs, {
      stream,
      hooks,
      waitForDependencies: options.waitForDependencies,
      // The board shows the outcome of every script itself.
      quiet: true,
    });
    interrupted = outcome.interrupted;
    for (const result of outcome.results) {
      controller.finishRow(result);
    }
    summary = outcome.results.map((result) => ({
      name: result.name,
      script: result.script,
      ok: result.ok,
      reason:
        result.error ??
        (result.ok ? undefined : result.signal !== null ? `signal ${result.signal}` : `exit ${String(result.code)}`),
      durationMs: result.durationMs,
    }));
    controller.finish(Date.now() - startedAt);
    // Give React a frame to paint the finished board before it is torn down.
    await new Promise((resolve) => setTimeout(resolve, 60));
  } finally {
    // The board is replaced by the summary, so it is unmounted before the
    // summary is drawn.
    instance.unmount();
    releaseStdin();
  }

  const totalMs = Date.now() - startedAt;

  if (interrupted) {
    console.log();
    console.log(`  ${STYLE.warn(GLYPH.warn)} stopped by signal ${STYLE.muted(`${GLYPH.dot} all child processes terminated`)}`);
    return 130;
  }

  // The board already drew the summary, so the plain one is not repeated.
  const failed = (summary ?? []).filter((row) => !row.ok).length;
  return failed === 0 ? 0 : 1;
}

/** Feeds the executor's events into the board. */
function createInterfaceHooks(controller: ReturnType<typeof createRunController>): RunHooks {
  return {
    onPortRedirect({ name, script, from, to }): void {
      controller.updateRow(name, script, { port: to });
      controller.addLog(`${GLYPH.warn} port ${from} was blocked · ${name} moved to ${to}`);
    },
    onWaitStart(gate): void {
      const wanted = gate.dependencies.map((dependency) => `${dependency.name} :${dependency.port}`).join(' · ');
      controller.updateRow(gate.name, gate.script, { phase: 'waiting', waitingFor: wanted });
    },
    onWaitEnd(gate, outcome): void {
      if (outcome === 'ready' || outcome === 'timeout') {
        controller.updateRow(gate.name, gate.script, { phase: 'starting', waitingFor: undefined });
      }
    },
    onSpawn(name, script): void {
      controller.updateRow(name, script, { phase: 'running' });
    },
  };
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

  const projects: PickerProject[] = targets.map((target) => {
    const dirty = dirtyCounts.get(target.name);
    const suggested = dirty === undefined ? undefined : primaryScript(target);
    return {
      name: target.name,
      type: target.type,
      scripts: Object.keys(target.scripts),
      commands: Object.fromEntries(
        Object.keys(target.scripts).map((script) => [script, resolveCommand(target, script, options.npmMode)]),
      ),
      ...(dirty !== undefined ? { changed: dirty } : {}),
      ...(suggested !== undefined ? { suggested } : {}),
    };
  });

  // Without a terminal there is nothing to press keys on, so hop falls back
  // to a plain prompt that names the script to run.
  if (!isInteractive()) {
    return runInteractivePlain(root, targets, projects, options);
  }

  const specs = await pickWithInterface(projects, targets, options);
  if (specs === null) {
    return 130; // cancelled with Escape or Ctrl+C
  }
  if (specs.length === 0) {
    log('nothing selected');
    return 0;
  }

  return execute(specs, options);
}

/**
 * Runs the scripts through the Ink interface.
 *
 * Returns the specs to run, or `null` when the user cancelled.
 */
async function pickWithInterface(
  projects: PickerProject[],
  targets: ProjectTarget[],
  options: RunOptions,
): Promise<RunSpec[] | null> {
  let resolvePick: ((specs: RunSpec[] | null) => void) | null = null;
  const picked = new Promise<RunSpec[] | null>((resolve) => {
    resolvePick = resolve;
  });

  const onPick = (chosen: Map<string, string[]>): void => {
    const specs: RunSpec[] = [];
    targets.forEach((target, index) => {
      const scripts = chosen.get(target.name) ?? [];
      for (const script of scripts) {
        specs.push(specFor(target, script, options.npmMode, targetColor(index)));
      }
    });
    resolvePick?.(specs);
  };

  const onCancel = (): void => {
    resolvePick?.(null);
  };

  const instance = mount(
    React.createElement(App, { view: 'picker', projects, onPick, onCancel }),
  );

  try {
    return await picked;
  } finally {
    instance.unmount();
    releaseStdin();
  }
}

/**
 * The fallback picker for pipes, files and CI logs: name the script and hop
 * runs every project that has it.
 */
async function runInteractivePlain(
  root: string,
  targets: ProjectTarget[],
  projects: PickerProject[],
  options: RunOptions,
): Promise<number> {
  const names = availableScripts(targets);
  const scriptWidth = widest(projects.flatMap((project) => project.scripts));

  console.log();
  console.log(`  ${wordmark(`${STYLE.muted(plural(targets.length, 'project'))} ${STYLE.muted('detected')}`)}`);
  console.log();
  console.log(`  ${STYLE.muted('scripts')}  ${names.map((name) => STYLE.brand(name)).join(STYLE.muted(` ${GLYPH.dot} `))}`);
  console.log();
  for (const project of projects) {
    const typeStyle = styleForType(project.type);
    const changed = project.changed;
    const meta = [`${typeStyle(CHIP)} ${STYLE.muted(project.type)}`];
    if (changed !== undefined) {
      meta.push(STYLE.warn(`${changed} changed`));
    }
    console.log(`  ${STYLE.brand(project.name)} ${STYLE.muted(GLYPH.dot)} ${meta.join(STYLE.muted(` ${GLYPH.dot} `))}`);
    for (const script of project.scripts) {
      const suggested = project.suggested === script;
      const mark = suggested ? STYLE.ok(GLYPH.ok) : STYLE.muted(GLYPH.branch);
      console.log(
        `    ${mark} ${STYLE.brand(padTo(script, scriptWidth))} ${STYLE.muted(project.commands[script] ?? '')}`,
      );
    }
    console.log();
  }
  console.log(`  ${STYLE.muted('run a script with')} ${STYLE.strong('hop <script>')}`);
  console.log();
  releaseStdin();
  return 0;
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
    if (isInteractive()) {
      await renderOnce(React.createElement(Help, { maxDepth: DEFAULT_MAX_DEPTH }));
    } else {
      console.log(HELP);
    }
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
    if (isInteractive()) {
      await renderOnce(
        React.createElement(ListScreen, {
          root,
          projects: targets.map((target) => ({
            name: target.name,
            type: target.type,
            path: relativeLabel(root, target.path),
            scripts: Object.fromEntries(
              Object.keys(target.scripts).map((script) => [script, resolveCommand(target, script, runOptions.npmMode)]),
            ),
          })),
          npmMode: runOptions.npmMode,
        }),
      );
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
