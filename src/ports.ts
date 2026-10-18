import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** Where a preferred port was found. */
export type PortSource = 'flag' | 'env' | 'dotenv';

export interface PortPreference {
  port: number;
  source: PortSource;
}

export interface PortPlan extends PortPreference {
  /** The port the child should actually use (equals `port` when nothing was swapped). */
  target: number;
  /** True when `target` differs from the preferred port. */
  changed: boolean;
  /** True when the preferred port was taken and no free port was found nearby. */
  exhausted: boolean;
}

const MIN_PORT = 1;
const MAX_PORT = 65_535;
const PROBE_TIMEOUT_MS = 1_000;

/** Normalises a port number or numeric string into 1…65535, or undefined. */
export function parsePort(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT ? value : undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d{1,5}$/.test(trimmed)) {
    return undefined;
  }
  const port = Number(trimmed);
  return port >= MIN_PORT && port <= MAX_PORT ? port : undefined;
}

/**
 * True when nothing is listening on `host:port`.
 *
 * The check is a real bind attempt (`exclusive: true`), not a connect: it
 * therefore also reports ports that are reserved by the OS or held by a
 * process that is not accepting connections yet.
 */
export function isPortFree(port: number, host = '127.0.0.1', timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;

    const finish = (free: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // close() releases the probe handle before the caller binds for real.
      server.close(() => resolve(free));
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    server.once('error', () => finish(false)); // EADDRINUSE / EACCES / excluded ranges
    server.once('listening', () => finish(true));
    server.listen({ port, host, exclusive: true });
  });
}

export interface FindFreePortOptions {
  host?: string;
  /** Ports already promised to siblings in this run; never handed out twice. */
  reserved?: ReadonlySet<number>;
  /** How many ports above `start` to try. Default 100. */
  limit?: number;
}

/** First free port at or above `start`, skipping `reserved`. Null when none is found. */
export async function findFreePort(start: number, options: FindFreePortOptions = {}): Promise<number | null> {
  const limit = options.limit ?? 100;
  const last = Math.min(MAX_PORT, start + limit - 1);
  for (let port = Math.max(MIN_PORT, start); port <= last; port += 1) {
    if (options.reserved?.has(port)) {
      continue;
    }
    if (await isPortFree(port, options.host)) {
      return port;
    }
  }
  return null;
}

function stripQuotes(value: string): string {
  const first = value[0];
  const last = value[value.length - 1];
  if (value.length >= 2 && (first === '"' || first === "'") && last === first) {
    return value.slice(1, -1);
  }
  return value;
}

/** `PORT=3000` from dotenv-style text; the first valid entry wins. */
export function portFromEnvContent(content: string): number | undefined {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const match = /^(?:export\s+)?PORT\s*=\s*(.+)$/i.exec(line);
    if (match?.[1] === undefined) {
      continue;
    }
    const value = stripQuotes(match[1].split(/\s+#/)[0]?.trim() ?? '');
    const port = parsePort(value);
    if (port !== undefined) {
      return port;
    }
  }
  return undefined;
}

/** Dotenv files checked (in order) for a PORT preference. */
export const DOTENV_FILES: readonly string[] = ['.env', '.env.local', '.env.development', '.env.dev'];

/** Reads the first `PORT=` found in the project's dotenv files. */
export function readDotenvPort(dir: string): number | undefined {
  for (const file of DOTENV_FILES) {
    const full = path.join(dir, file);
    if (!existsSync(full)) {
      continue;
    }
    try {
      const port = portFromEnvContent(readFileSync(full, 'utf8'));
      if (port !== undefined) {
        return port;
      }
    } catch {
      // unreadable env file: keep looking
    }
  }
  return undefined;
}

const FLAG_PORT = /(^|\s)--port(?:=|\s+)(\d{1,5})(?=\s|$)/;

/** `--port 3000` / `--port=3000` inside a script command. */
export function readFlagPort(command: string): number | undefined {
  const match = FLAG_PORT.exec(command);
  return match?.[2] === undefined ? undefined : parsePort(match[2]);
}

/** Rewrites `from` to `to` inside an existing `--port` flag. */
export function rewriteFlagPort(command: string, from: number, to: number): string {
  return command.replace(new RegExp(`(--port(?:=|\\s+))${from}(?=\\s|$)`), `$1${to}`);
}

function envPort(env: NodeJS.ProcessEnv | undefined): number | undefined {
  if (env === undefined) {
    return undefined;
  }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PORT') {
      const port = parsePort(env[key]);
      if (port !== undefined) {
        return port;
      }
    }
  }
  return undefined;
}

/**
 * Best guess at the port a command intends to listen on.
 * Priority: an explicit `--port` flag, then `$PORT`, then the project's `.env`.
 */
export function preferredPort(input: { env?: NodeJS.ProcessEnv; dir: string; command: string }): PortPreference | undefined {
  const fromFlag = readFlagPort(input.command);
  if (fromFlag !== undefined) {
    return { port: fromFlag, source: 'flag' };
  }
  const fromEnv = envPort(input.env);
  if (fromEnv !== undefined) {
    return { port: fromEnv, source: 'env' };
  }
  const fromDotenv = readDotenvPort(input.dir);
  if (fromDotenv !== undefined) {
    return { port: fromDotenv, source: 'dotenv' };
  }
  return undefined;
}

export interface PlanPortOptions {
  env?: NodeJS.ProcessEnv;
  dir: string;
  command: string;
  /** Shared across the run; the chosen port is added to it. */
  reserved?: Set<number>;
  host?: string;
  /** How many ports above the preferred one to try. Default 100. */
  limit?: number;
}

/**
 * Resolves the port a spec should run on: the preferred one when it is free,
 * otherwise the next free port above it (never one that a sibling already owns).
 * Returns undefined when the command has no discoverable port preference.
 */
export async function planPort(options: PlanPortOptions): Promise<PortPlan | undefined> {
  const preference = preferredPort(options);
  if (preference === undefined) {
    return undefined;
  }

  const { port, source } = preference;
  const reserved = options.reserved;
  const taken = reserved?.has(port) ?? false;

  if (!taken && (await isPortFree(port, options.host))) {
    reserved?.add(port);
    return { port, source, target: port, changed: false, exhausted: false };
  }

  const free = await findFreePort(port + 1, { reserved, host: options.host, limit: options.limit });
  if (free === null) {
    // Nothing usable nearby: keep the original port and let the child report it.
    return { port, source, target: port, changed: false, exhausted: true };
  }
  reserved?.add(free);
  return { port, source, target: free, changed: true, exhausted: false };
}
