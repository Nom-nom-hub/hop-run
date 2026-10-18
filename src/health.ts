import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parsePort } from './ports.js';
import type { ProjectType } from './scanner.js';

/** How long a single TCP connect probe may take before it counts as "down". */
const PROBE_TIMEOUT_MS = 400;
/** Default ceiling for waiting on one dependency. */
export const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_INTERVAL_MS = 250;

/**
 * TCP connect probe: true when something accepts connections on `host:port`.
 * Used for services hop did not start itself (databases, containers, APIs).
 */
export function isPortOpen(port: number, host = '127.0.0.1', timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;

    const finish = (open: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(open);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type WaitOutcome = 'ready' | 'timeout' | 'aborted';

export interface WaitForPortOptions {
  /** Give up after this long. Default 30 s. */
  timeoutMs?: number;
  /** Delay between probes. Default 250 ms. */
  intervalMs?: number;
  host?: string;
  /** Abort the wait (Ctrl+C, dependency unreachable, …). */
  signal?: AbortSignal;
  /** Probe implementation; overridable for tests. */
  probe?: (port: number, host: string) => Promise<boolean>;
}

/**
 * Polls `port` until something listens on it.
 *
 * Resolves `ready` as soon as the port accepts a connection, `timeout` when the
 * deadline passes, and `aborted` when the caller cancelled the wait.
 */
export async function waitForPort(port: number, options: WaitForPortOptions = {}): Promise<WaitOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const host = options.host ?? '127.0.0.1';
  const probe = options.probe ?? isPortOpen;
  const deadline = Date.now() + timeoutMs;
  const aborted = (): boolean => options.signal?.aborted === true;

  for (;;) {
    if (aborted()) {
      return 'aborted';
    }
    if (await probe(port, host)) {
      return 'ready';
    }
    if (aborted()) {
      return 'aborted';
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return 'timeout';
    }
    await sleep(Math.min(intervalMs, remaining), options.signal);
  }
}

/** `localhost:8080`, `127.0.0.1:5432`, `[::1]:3000` references inside text. */
const LOCAL_REFERENCE = /(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})/g;

/** Every localhost-style port mentioned in `text` (deduplicated, in order). */
export function referencedPortsInText(text: string): number[] {
  const ports: number[] = [];
  for (const match of text.matchAll(LOCAL_REFERENCE)) {
    const port = parsePort(match[1]);
    if (port !== undefined && !ports.includes(port)) {
      ports.push(port);
    }
  }
  return ports;
}

/** Files whose contents tend to name the services a project talks to. */
const DEPENDENCY_SOURCE_FILES: readonly string[] = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.dev',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'nuxt.config.ts',
];

/**
 * Explicit dependency list from a project's `package.json`:
 * `"hop": { "waitFor": [5432, "localhost:8080"] }`.
 */
export function explicitWaitFor(dir: string): number[] {
  const file = path.join(dir, 'package.json');
  if (!existsSync(file)) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const hop = (parsed as { hop?: unknown } | null)?.hop;
  const waitFor = (hop as { waitFor?: unknown } | null | undefined)?.waitFor;
  if (!Array.isArray(waitFor)) {
    return [];
  }

  const ports: number[] = [];
  for (const entry of waitFor) {
    if (typeof entry === 'number') {
      const port = parsePort(entry);
      if (port !== undefined) {
        ports.push(port);
      }
      continue;
    }
    if (typeof entry === 'string') {
      const direct = parsePort(entry.trim());
      const referenced = referencedPortsInText(entry);
      for (const port of direct !== undefined ? [direct] : referenced) {
        if (!ports.includes(port)) {
          ports.push(port);
        }
      }
    }
  }
  return ports;
}

/**
 * Ports a command wants to reach, split by how sure hop is:
 * `explicit` (hop.waitFor) is always waited for, `referenced` only when a
 * sibling spec actually exposes the port.
 */
export function dependencyPorts(source: { dir: string; command?: string }): { explicit: number[]; referenced: number[] } {
  const explicit = explicitWaitFor(source.dir);
  const referenced: number[] = [];

  for (const file of DEPENDENCY_SOURCE_FILES) {
    const full = path.join(source.dir, file);
    if (!existsSync(full)) {
      continue;
    }
    try {
      for (const port of referencedPortsInText(readFileSync(full, 'utf8'))) {
        if (!referenced.includes(port)) {
          referenced.push(port);
        }
      }
    } catch {
      // unreadable: ignore
    }
  }
  if (source.command !== undefined) {
    for (const port of referencedPortsInText(source.command)) {
      if (!referenced.includes(port)) {
        referenced.push(port);
      }
    }
  }
  return { explicit, referenced: referenced.filter((port) => !explicit.includes(port)) };
}

const COMPOSE_FILES: readonly string[] = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/** Host port from one compose `ports:` list entry such as `"127.0.0.1:5432:5432"`. */
export function hostPortFromMapping(line: string): number | undefined {
  const stripped = line
    .replace(/^\s*-\s*/, '')
    .replace(/#.*$/, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\/\w+$/, ''); // drop /tcp, /udp
  const parts = stripped.split(':');
  if (parts.length === 2) {
    return parsePort(parts[0]); // "8080:80"
  }
  if (parts.length === 3) {
    return parsePort(parts[1]); // "127.0.0.1:5432:5432"
  }
  return undefined; // container-only port: the host port is random
}

/** Host ports published by the compose file's `ports:` blocks (short syntax). */
export function composeHostPortsFromText(text: string): number[] {
  const ports: number[] = [];
  let inPorts = false;
  let portsIndent = 0;

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || /^\s*#/.test(line)) {
      continue;
    }
    const indent = line.length - line.trimStart().length;

    if (/^\s*ports\s*:/.test(line)) {
      inPorts = true;
      portsIndent = indent;
      continue;
    }
    if (inPorts && /^\s*-/.test(line) && indent > portsIndent) {
      const port = hostPortFromMapping(line);
      if (port !== undefined && !ports.includes(port)) {
        ports.push(port);
      }
      continue;
    }
    if (inPorts && indent <= portsIndent) {
      inPorts = false;
    }
  }
  return ports;
}

/** Host ports a docker/compose target is expected to publish. */
export function declaredServicePorts(target: { path: string; type?: ProjectType }): number[] {
  if (target.type !== 'docker') {
    return [];
  }
  for (const file of COMPOSE_FILES) {
    const full = path.join(target.path, file);
    if (!existsSync(full)) {
      continue;
    }
    try {
      const ports = composeHostPortsFromText(readFileSync(full, 'utf8'));
      if (ports.length > 0) {
        return ports;
      }
    } catch {
      // unreadable compose file: no declared ports
    }
  }
  return [];
}
