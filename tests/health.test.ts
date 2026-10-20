import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findFreePort } from '../src/ports.js';
import {
  composeHostPortsFromText,
  declaredServicePorts,
  dependencyPorts,
  explicitWaitFor,
  hostPortFromMapping,
  isPortOpen,
  referencedPortsInText,
  waitForPort,
} from '../src/health.js';

interface HeldPort {
  port: number;
  close(): Promise<void>;
}

/** Starts a throwaway TCP server (0 = let the OS choose). */
function holdPort(port = 0): Promise<HeldPort> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer();
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1' }, () => {
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : port;
      resolve({
        port: bound,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * Random per-process phase so two suites running at once (hop can start this
 * repo's `test` and `test:watch` scripts in parallel) never hunt the same
 * ports. The 22_500 base and the phase below 1000 keep this band clear of the
 * 21_000 band in ports.test.ts and the 24_000+ bands in executor.test.ts.
 */
const PORT_PHASE = Math.floor(Math.random() * 1_000);

async function pickFreePort(start = 22_500): Promise<number> {
  const port = await findFreePort(start + PORT_PHASE);
  if (port === null) {
    throw new Error(`no free port above ${start}`);
  }
  return port;
}

describe('isPortOpen', () => {  it('sees a listening server and a closed port', async () => {
    const held = await holdPort();

    expect(await isPortOpen(held.port)).toBe(true);
    await held.close();
    expect(await isPortOpen(held.port)).toBe(false);
  });

  it('reports an unused port as closed', async () => {
    const free = await pickFreePort();
    expect(await isPortOpen(free, '127.0.0.1', 200)).toBe(false);
  });
});

describe('waitForPort', () => {
  it('returns ready as soon as the service accepts connections', async () => {
    const free = await pickFreePort();
    let held: HeldPort | undefined;

    setTimeout(() => {
      void holdPort(free).then((server) => {
        held = server;
      });
    }, 120);

    try {
      const outcome = await waitForPort(free, { timeoutMs: 4_000, intervalMs: 25 });
      expect(outcome).toBe('ready');
    } finally {
      await held?.close();
    }
  });

  it('times out when nothing ever listens', async () => {
    const outcome = await waitForPort(9_999, {
      timeoutMs: 80,
      intervalMs: 10,
      probe: async () => false,
    });

    expect(outcome).toBe('timeout');
  });

  it('stops early when the caller aborts', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);

    const startedAt = Date.now();
    const outcome = await waitForPort(9_999, {
      timeoutMs: 10_000,
      intervalMs: 10,
      probe: async () => false,
      signal: controller.signal,
    });

    expect(outcome).toBe('aborted');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('probes the requested port on the default host', async () => {
    const calls: Array<[number, string]> = [];
    const outcome = await waitForPort(4_321, {
      probe: async (port, host) => {
        calls.push([port, host]);
        return true;
      },
    });

    expect(outcome).toBe('ready');
    expect(calls).toEqual([[4_321, '127.0.0.1']]);
  });
});

describe('referencedPortsInText', () => {
  it('collects localhost-style references and de-duplicates them', () => {
    expect(referencedPortsInText('http://localhost:3000/api')).toEqual([3000]);
    expect(referencedPortsInText('API=http://127.0.0.1:8080 db=localhost:5432 localhost:8080')).toEqual([8080, 5432]);
    expect(referencedPortsInText('[::1]:9000')).toEqual([9000]);
  });

  it('ignores remote hosts, invalid ports and non-local names', () => {
    expect(referencedPortsInText('example.com:3000 redis://cache:6379 localhost:99999')).toEqual([]);
    expect(referencedPortsInText('plain text')).toEqual([]);
  });
});

describe('explicitWaitFor', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hop-waitfor-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads ports and urls from "hop": { "waitFor": [...] }', async () => {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'api', hop: { waitFor: [5432, 'localhost:8080', 'http://127.0.0.1:9000/health', 'nonsense', 0] } }),
      'utf8',
    );

    expect(explicitWaitFor(root)).toEqual([5432, 8080, 9000]);
  });

  it('returns nothing without a package.json, without the field or on broken JSON', async () => {
    expect(explicitWaitFor(root)).toEqual([]);

    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'api' }), 'utf8');
    expect(explicitWaitFor(root)).toEqual([]);

    await writeFile(path.join(root, 'package.json'), 'not json', 'utf8');
    expect(explicitWaitFor(root)).toEqual([]);
  });

  it('reads the config from a package.json that carries a UTF-8 byte order mark', async () => {
    // A BOM would otherwise make JSON.parse throw and silently drop the
    // explicit wait — the dependency would then start too early.
    await writeFile(
      path.join(root, 'package.json'),
      `﻿${JSON.stringify({ name: 'api', hop: { waitFor: [5432] } })}`,
      'utf8',
    );

    expect(explicitWaitFor(root)).toEqual([5432]);
  });
});

describe('dependencyPorts', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hop-deps-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('collects references from env files and the command itself', async () => {
    await writeFile(path.join(root, '.env'), 'VITE_API_URL=http://localhost:4000\n', 'utf8');

    const { explicit, referenced } = dependencyPorts({
      dir: root,
      command: 'node -e "fetch(\'http://127.0.0.1:9000\')"',
    });

    expect(explicit).toEqual([]);
    expect(referenced).toEqual([4000, 9000]);
  });

  it('reads proxy targets from bundler config files', async () => {
    await writeFile(
      path.join(root, 'vite.config.ts'),
      'export default { server: { proxy: { "/api": "http://localhost:5174" } } };\n',
      'utf8',
    );

    expect(dependencyPorts({ dir: root }).referenced).toEqual([5174]);
  });

  it('keeps explicit ports out of the heuristic list', async () => {
    await writeFile(path.join(root, '.env'), 'DB=localhost:5432\n', 'utf8');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ hop: { waitFor: [5432, 6379] } }), 'utf8');

    const { explicit, referenced } = dependencyPorts({ dir: root });

    expect(explicit).toEqual([5432, 6379]);
    expect(referenced).toEqual([]);
  });

  it('ignores ports that only appear in a comment', async () => {
    // A commented-out or legacy URL is not a live dependency — waiting for a
    // port nobody serves would stall the run for the full timeout.
    await writeFile(
      path.join(root, '.env'),
      '# legacy API lived on http://localhost:4000\nDB=postgres://x@localhost:5432/db\n',
      'utf8',
    );

    expect(dependencyPorts({ dir: root }).referenced).toEqual([5432]);
  });
});

describe('compose port parsing', () => {
  it('understands the common short-syntax mappings', () => {
    expect(hostPortFromMapping('- "8080:80"')).toBe(8080);
    expect(hostPortFromMapping('- 8080:80')).toBe(8080);
    expect(hostPortFromMapping('- "127.0.0.1:5432:5432"')).toBe(5432);
    expect(hostPortFromMapping('- "8080:80/tcp"')).toBe(8080);
    expect(hostPortFromMapping('- "5432:5432" # db')).toBe(5432);
  });

  it('ignores container-only and non-numeric entries', () => {
    expect(hostPortFromMapping('- 5432')).toBeUndefined();
    expect(hostPortFromMapping('- "${DB_PORT}:5432"')).toBeUndefined();
  });

  it('collects published ports from every service', () => {
    const compose = [
      'services:',
      '  db:',
      '    image: postgres',
      '    ports:',
      '      - "5432:5432"',
      '    environment:',
      '      POSTGRES_PASSWORD: secret',
      '  cache:',
      '    image: redis',
      '    ports:',
      '      - 6379:6379',
      '      - "127.0.0.1:6380:6379"',
      '    expose:',
      '      - "8080"',
      '  web:',
      '    image: app',
      '    ports: []',
    ].join('\n');

    expect(composeHostPortsFromText(compose)).toEqual([5432, 6379, 6380]);
    expect(composeHostPortsFromText('services:\n  db:\n    image: postgres\n')).toEqual([]);
  });
});

describe('declaredServicePorts', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hop-compose-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads published ports from a docker target', async () => {
    await mkdir(path.join(root, 'database'), { recursive: true });
    await writeFile(
      path.join(root, 'database', 'docker-compose.yml'),
      'services:\n  db:\n    image: postgres\n    ports:\n      - "5432:5432"\n',
      'utf8',
    );

    expect(declaredServicePorts({ path: path.join(root, 'database'), type: 'docker' })).toEqual([5432]);
    expect(declaredServicePorts({ path: path.join(root, 'database'), type: 'node' })).toEqual([]);
  });

  it('returns nothing for a compose file without published ports', async () => {
    await writeFile(path.join(root, 'compose.yml'), 'services:\n  worker:\n    image: busybox\n', 'utf8');

    expect(declaredServicePorts({ path: root, type: 'docker' })).toEqual([]);
  });

  it('reads published ports from a node project that also holds a compose file', async () => {
    // A service directory with a package.json *and* a compose file still
    // publishes those ports; hop has to know them to keep them reserved.
    await writeFile(
      path.join(root, 'docker-compose.yml'),
      'services:\n  db:\n    image: postgres\n    ports:\n      - "5432:5432"\n',
      'utf8',
    );

    expect(declaredServicePorts({ path: root, type: 'node', compose: true })).toEqual([5432]);
  });
});
