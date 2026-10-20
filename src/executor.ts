import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import {
  declaredServicePorts,
  dependencyPorts,
  DEFAULT_HEALTH_TIMEOUT_MS,
  waitForPort,
  type WaitForPortOptions,
  type WaitOutcome,
} from './health.js';
import { planPort, rewriteFlagPort, type PortPlan, type PortSource } from './ports.js';
import type { ProjectType } from './scanner.js';

export type Formatter = (text: string) => string;

/** One command to run: a script inside a scanned project. */
export interface RunSpec {
  /** Display name of the project (used for the `[name]` output tag). */
  name: string;
  /** Absolute working directory for the command. */
  dir: string;
  /** Script name that was selected, e.g. "dev". */
  script: string;
  /** Raw command to execute through the shell. */
  command: string;
  /** Optional tag color; falls back to a rotating palette. */
  color?: Formatter;
  /** Ecosystem of the target; drives per-type environment setup (e.g. PATH for node). */
  type?: ProjectType;
  /** True when the directory holds a compose file that publishes host ports. */
  compose?: boolean;
  /**
   * True when *this* command is the compose one (`docker compose up`). A
   * directory can hold a `package.json` and a compose file at the same time;
   * the compose command owns its published ports and must not be given one.
   */
  composeCommand?: boolean;
}

/** Package manager a node project is using, inferred from its lockfile. */
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface RunResult {
  name: string;
  script: string;
  command: string;
  /** Exit code, or null when the process was killed by a signal / failed to start. */
  code: number | null;
  /** Terminating signal, if any. */
  signal: NodeJS.Signals | null;
  ok: boolean;
  durationMs: number;
  /** Set when the process could not be spawned at all. */
  error?: string;
}

export interface RunSummary {
  results: RunResult[];
  /** True when hop itself received SIGINT/SIGTERM and stopped the children. */
  interrupted: boolean;
  /** The signal hop received, when interrupted. */
  signal: NodeJS.Signals | null;
}

/** A port hop moved out of the way before starting a child. */
export interface PortRedirect {
  name: string;
  script: string;
  /** The port the project asked for. */
  from: number;
  /** The port hop uses instead. */
  to: number;
  source: PortSource;
  color: Formatter;
}

/** One service a spec waits for before it is spawned. */
export interface DependencyRef {
  /** Name of the service owning the port, or `port 5432` when nothing does. */
  name: string;
  port: number;
  /** True when the port was requested explicitly via `hop.waitFor`. */
  explicit: boolean;
}

/** A spec that is held back until its dependencies accept connections. */
export interface DependencyGate {
  name: string;
  script: string;
  color: Formatter;
  dependencies: DependencyRef[];
  /** Children already running when the wait starts (0 → an animated spinner is safe). */
  running: number;
}

/** UI callbacks fired for port swaps and dependency handshakes. */
export interface RunHooks {
  onPortRedirect?(redirect: PortRedirect): void;
  onWaitStart?(gate: DependencyGate): void;
  onWaitEnd?(gate: DependencyGate, outcome: WaitOutcome): void;
}

export interface ExecutorOptions {
  /** Where prefixed output is written. Defaults to `process.stdout`. */
  stream?: Pick<NodeJS.WriteStream, 'write'>;
  /** Install SIGINT/SIGTERM handlers that kill every child. Default true. */
  registerSignalHandlers?: boolean;
  /** How long children get to exit on their own before the hard kill. Default 5000 ms. */
  killTimeoutMs?: number;
  /** Extra environment variables for the children. */
  env?: NodeJS.ProcessEnv;
  /** UI callbacks for port swaps and dependency waits. */
  hooks?: RunHooks;
  /** Wait for dependency ports before spawning their consumers. Default true. */
  waitForDependencies?: boolean;
  /** How long to wait for a single dependency. Default 30 s. */
  healthTimeoutMs?: number;
  /** Delay between health probes. Default 250 ms. */
  healthIntervalMs?: number;
}

const PALETTE: readonly Formatter[] = [pc.cyan, pc.magenta, pc.green, pc.yellow, pc.blue, pc.white];

const GLYPH = { ok: '✔', fail: '✖', warn: '⚠' } as const;

/** Deterministic color per position, so the menu and the log tags agree. */
export function colorForTarget(index: number): Formatter {
  const color = PALETTE[index % PALETTE.length];
  return color ?? ((text: string) => text);
}

interface LineSplitter {
  push(chunk: string): void;
  flush(): void;
}

/** Buffers raw chunks and emits complete lines as they arrive. */
function createLineSplitter(onLine: (line: string) => void): LineSplitter {
  let buffer = '';
  const emit = (line: string): void => onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  return {
    push(chunk: string): void {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        emit(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    },
    flush(): void {
      if (buffer.length > 0) {
        emit(buffer);
        buffer = '';
      }
    },
  };
}

/**
 * Kills the whole process tree of `child`.
 *
 * POSIX children are spawned detached (their own process group) so the group
 * can be signalled with a negative pid. Windows has no process groups to
 * signal, so `taskkill /T` is used instead.
 */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      });
    } catch {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  } else {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }
}

export function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/**
 * `node_modules/.bin` folders for `from` and every ancestor, nearest first.
 * Mirrors what `npm run` puts on PATH, so hoisted monorepo installs work too.
 */
function nodeBinPaths(from: string): string[] {
  const paths: string[] = [];
  let current = path.resolve(from);
  for (;;) {
    paths.push(path.join(current, 'node_modules', '.bin'));
    const parent = path.dirname(current);
    if (parent === current) {
      return paths;
    }
    current = parent;
  }
}

/** Finds the key of `name` in `env`, honouring Windows' case-insensitive names. */
function envKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const insensitive = process.platform === 'win32';
  const wanted = insensitive ? name.toLowerCase() : name;
  return Object.keys(env).find((candidate) => (insensitive ? candidate.toLowerCase() : candidate) === wanted);
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = envKey(env, name);
  return key === undefined ? undefined : env[key];
}

/** Sets `name`, overwriting a differently-cased original instead of adding a duplicate. */
function setEnv(env: NodeJS.ProcessEnv, name: string, value: string): void {
  env[envKey(env, name) ?? name] = value;
}

/** Forces `prepend` to the front of the PATH variable, whichever casing it uses. */
function prependPath(env: NodeJS.ProcessEnv, prepend: string[]): void {
  const key = envKey(env, 'PATH');
  const current = key !== undefined ? (env[key] ?? '') : '';
  const value = [...prepend, current].filter((entry) => entry !== '').join(path.delimiter);
  if (key !== undefined) {
    env[key] = value;
  } else {
    env.PATH = value;
  }
}

/** Per-target environment: npm-style PATH and lifecycle variables for node targets. */
function environmentFor(spec: RunSpec, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (spec.type !== 'node') {
    return base;
  }
  const env: NodeJS.ProcessEnv = { ...base };
  const binPaths = nodeBinPaths(spec.dir).filter((binPath) => existsSync(binPath));
  if (binPaths.length > 0) {
    prependPath(env, binPaths);
  }
  setEnv(env, 'npm_lifecycle_event', spec.script);
  setEnv(env, 'npm_lifecycle_script', spec.command);
  return env;
}

/** Lockfiles checked (in this order) when inferring the package manager. */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

/**
 * Infers the package manager for `from` from the nearest lockfile, walking up
 * through ancestors so packages in a monorepo pick up the root's manager.
 * Falls back to npm.
 */
export function detectPackageManager(from: string): PackageManager {
  let current = path.resolve(from);
  for (;;) {
    for (const [file, manager] of LOCKFILES) {
      if (existsSync(path.join(current, file))) {
        return manager;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return 'npm';
    }
    current = parent;
  }
}

const SAFE_SCRIPT_NAME = /^[\w:@/.-]+$/;

/**
 * Command that runs `script` through `manager`, honouring `pre*`/`post*` hooks
 * and the manager's own environment (npm_config_*, workspaces, …).
 */
export function packageManagerCommand(manager: PackageManager, script: string): string {
  const name = SAFE_SCRIPT_NAME.test(script) ? script : JSON.stringify(script);
  return `${manager} run ${name}`;
}

const identity: Formatter = (text) => text;

/**
 * Runs every spec concurrently, streaming stdout/stderr with a `[project]` tag.
 * Resolves once all children have exited (or been stopped after a signal).
 *
 * Before spawning, hop resolves the port each project wants to listen on
 * (`--port`, `$PORT`, `.env`) and swaps it for a free port when it is taken.
 * Projects whose files reference another selected service's port are held back
 * until that port accepts connections.
 */
export async function runScripts(specs: RunSpec[], options: ExecutorOptions = {}): Promise<RunSummary> {
  if (specs.length === 0) {
    return { results: [], interrupted: false, signal: null };
  }

  const stream = options.stream ?? process.stdout;
  const killTimeoutMs = options.killTimeoutMs ?? 5_000;
  const useSignalHandlers = options.registerSignalHandlers ?? true;
  const hooks = options.hooks;
  const waitForDependencies = options.waitForDependencies ?? true;
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const maxNameLength = specs.reduce((max, spec) => Math.max(max, spec.name.length), 0);

  const baseEnv: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  if (envValue(baseEnv, 'FORCE_COLOR') === undefined && envValue(baseEnv, 'NO_COLOR') === undefined) {
    setEnv(baseEnv, 'FORCE_COLOR', '1'); // keep tool output colored even though we pipe it
  }

  const colors = specs.map((spec, index) => spec.color ?? colorForTarget(index));

  const children = new Set<ChildProcess>();
  /**
   * Children that have already written something. The animated spinner is
   * only safe while nothing else is writing to the terminal, and that is
   * about the output — not about how many children happen to exist.
   */
  let producedOutput = false;
  let interrupted = false;
  let interruptSignal: NodeJS.Signals | null = null;
  let forceTimer: NodeJS.Timeout | undefined;
  const abort = new AbortController();

  const write = (text: string): void => {
    producedOutput = true;
    stream.write(text);
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (interrupted) {
      for (const child of children) {
        killProcessTree(child, 'SIGKILL'); // second Ctrl+C: stop asking nicely
      }
      return;
    }
    interrupted = true;
    interruptSignal = signal;
    abort.abort();
    write(`${pc.dim('[hop]')} ${pc.yellow(GLYPH.warn)} received ${signal} — stopping ${children.size} process(es)…\n`);
    for (const child of children) {
      killProcessTree(child, 'SIGTERM');
    }
    forceTimer = setTimeout(() => {
      for (const child of children) {
        killProcessTree(child, 'SIGKILL');
      }
    }, killTimeoutMs);
    if (typeof forceTimer.unref === 'function') {
      forceTimer.unref();
    }
  };

  const signalNames: NodeJS.Signals[] =
    process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  if (useSignalHandlers) {
    for (const name of signalNames) {
      process.on(name as 'SIGINT', onSignal);
    }
  }

  // --- port planning ---------------------------------------------------------
  // Compose ports are reserved up front: a node app that also wants 5432 is
  // moved aside even before the container that owns 5432 comes up. A service
  // directory may hold a compose file *and* be a node project, so the compose
  // files are consulted for every spec.
  const reserved = new Set<number>();
  const services = new Map<number, string>(); // port → name of the spec that exposes it
  for (const spec of specs) {
    for (const port of declaredServicePorts({ path: spec.dir, type: spec.type, compose: spec.compose })) {
      reserved.add(port);
      if (!services.has(port)) {
        services.set(port, spec.name);
      }
    }
  }

  const plans = new Map<RunSpec, PortPlan>();
  /** Original port → the port the service actually listens on now. */
  const redirects = new Map<number, number>();
  for (const [index, spec] of specs.entries()) {
    if (spec.composeCommand === true) {
      continue; // compose files own their published ports; hop only reads them
    }
    const plan = await planPort({ env: baseEnv, dir: spec.dir, command: spec.command, reserved });
    if (plan === undefined) {
      continue;
    }
    plans.set(spec, plan);
    if (!services.has(plan.target)) {
      services.set(plan.target, spec.name);
    }
    if (plan.changed && !services.has(plan.port)) {
      // The configured port moved, but a sibling may still refer to the
      // original one. Keeping it mapped to the same service means the
      // dependency gate still fires instead of letting the consumer start
      // early and talk to whatever else owns that port.
      services.set(plan.port, spec.name);
      redirects.set(plan.port, plan.target);
    }
    if (plan.changed) {
      hooks?.onPortRedirect?.({
        name: spec.name,
        script: spec.script,
        from: plan.port,
        to: plan.target,
        source: plan.source,
        color: colors[index] ?? identity,
      });
    }
  }

  // --- dependency handshakes ---------------------------------------------------
  const gates = new Map<RunSpec, DependencyGate>();
  if (waitForDependencies) {
    for (const [index, spec] of specs.entries()) {
      if (spec.composeCommand === true) {
        continue; // containers orchestrate their own startup order
      }
      const ownPort = plans.get(spec)?.target;
      const { explicit, referenced } = dependencyPorts({ dir: spec.dir, command: spec.command });
      const pending = new Map<number, DependencyRef>();

      for (const port of explicit) {
        if (port === ownPort) {
          continue;
        }
        // Explicit waits are honoured even when hop is not starting the service.
        pending.set(port, { name: services.get(port) ?? 'localhost', port, explicit: true });
      }
      for (const port of referenced) {
        if (port === ownPort || pending.has(port)) {
          continue;
        }
        // Heuristic references only gate when another selected spec exposes the port.
        const owner = services.get(port);
        if (owner !== undefined && owner !== spec.name) {
          pending.set(port, { name: owner, port, explicit: false });
        }
      }

      // A referenced port that was redirected has to be waited for on its new
      // home — the service will never answer on the old one.
      for (const dependency of pending.values()) {
        const moved = redirects.get(dependency.port);
        if (moved !== undefined) {
          dependency.port = moved;
        }
      }

      if (pending.size > 0) {
        gates.set(spec, {
          name: spec.name,
          script: spec.script,
          color: colors[index] ?? identity,
          dependencies: [...pending.values()],
          running: 0, // filled in right before the wait starts
        });
      }
    }
  }

  const launch = (spec: RunSpec, index: number): Promise<RunResult> =>
    new Promise<RunResult>((resolve) => {
      const color = colors[index] ?? identity;
      const tag = `${pc.dim('[')}${color(spec.name.padEnd(maxNameLength))}${pc.dim(']')}`;
      const startedAt = Date.now();
      let settled = false;

      const plan = plans.get(spec);
      const childEnv: NodeJS.ProcessEnv = { ...environmentFor(spec, baseEnv) };
      let command = spec.command;
      if (plan !== undefined) {
        // Real env beats dotenv in every mainstream framework, so injecting
        // PORT is enough to move an app that reads PORT= from .env.
        setEnv(childEnv, 'PORT', String(plan.target));
        if (plan.changed && plan.source === 'flag') {
          command = rewriteFlagPort(command, plan.port, plan.target);
        }
      }

      const line = (text: string): void => write(`${tag} ${text}\n`);
      const outSplit = createLineSplitter(line);
      const errSplit = createLineSplitter(line);

      const finish = (code: number | null, signal: NodeJS.Signals | null, error?: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        outSplit.flush();
        errSplit.flush();
        const durationMs = Date.now() - startedAt;
        const result: RunResult = {
          name: spec.name,
          script: spec.script,
          command,
          code,
          signal,
          ok: error === undefined && code === 0,
          durationMs,
        };
        const label = `${color(spec.name)} ${spec.script}`;
        if (error !== undefined) {
          result.error = error;
          write(`${pc.dim('[hop]')} ${pc.red(GLYPH.fail)} ${label} ${pc.dim('·')} ${pc.red(`failed to start: ${error}`)}\n`);
        } else if (code === 0) {
          write(`${pc.dim('[hop]')} ${pc.green(GLYPH.ok)} ${label} ${pc.dim(`· ${formatDuration(durationMs)}`)}\n`);
        } else {
          const reason = signal !== null ? `signal ${signal}` : `exit ${String(code)}`;
          write(
            `${pc.dim('[hop]')} ${pc.red(GLYPH.fail)} ${label} ${pc.dim('·')} ${pc.red(reason)} ${pc.dim(`· ${formatDuration(durationMs)}`)}\n`,
          );
        }
        resolve(result);
      };

      let child: ChildProcess;
      try {
        child = spawn(command, {
          cwd: spec.dir,
          shell: true,
          detached: process.platform !== 'win32',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childEnv,
        });
      } catch (error) {
        finish(null, null, error instanceof Error ? error.message : String(error));
        return;
      }

      children.add(child);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => outSplit.push(chunk));
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => errSplit.push(chunk));

      // A stdio socket can fail on its own — e.g. when the working directory
      // is so long that the process cannot be created. Without a handler the
      // socket's 'error' event is uncaught and takes hop down with it.
      child.stdout?.on('error', () => undefined);
      child.stderr?.on('error', () => undefined);

      child.once('error', (error) => {
        children.delete(child);
        finish(null, null, error.message);
      });
      child.once('close', (code, signal) => {
        children.delete(child);
        finish(code, signal);
      });
    });

  const tasks = specs.map(async (spec, index) => {
    const gate = gates.get(spec);
    if (gate !== undefined) {
      // The spinner is only safe while no child has written yet — the number
      // of running children says nothing about that.
      gate.running = producedOutput ? children.size : 0;
      hooks?.onWaitStart?.(gate);
      let outcome: WaitOutcome = 'ready';
      // All dependencies share one deadline: three dead ports must not cost
      // three times the timeout.
      const deadline = Date.now() + healthTimeoutMs;
      for (const dependency of gate.dependencies) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          outcome = 'timeout';
          break;
        }
        const waitOptions: WaitForPortOptions = { timeoutMs: remaining, signal: abort.signal };
        if (options.healthIntervalMs !== undefined) {
          waitOptions.intervalMs = options.healthIntervalMs;
        }
        outcome = await waitForPort(dependency.port, waitOptions);
        if (outcome !== 'ready') {
          break;
        }
      }
      hooks?.onWaitEnd?.(gate, outcome);
      if (outcome === 'aborted') {
        const stopped: RunResult = {
          name: spec.name,
          script: spec.script,
          command: spec.command,
          code: null,
          signal: null,
          ok: false,
          durationMs: 0,
          error: 'not started (interrupted)',
        };
        return stopped;
      }
    }
    return launch(spec, index);
  });

  try {
    const results = await Promise.all(tasks);
    return { results, interrupted, signal: interruptSignal };
  } finally {
    if (forceTimer !== undefined) {
      clearTimeout(forceTimer);
    }
    if (useSignalHandlers) {
      for (const name of signalNames) {
        process.off(name as 'SIGINT', onSignal);
      }
    }
  }
}
