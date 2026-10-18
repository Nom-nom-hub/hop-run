import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { availableScripts, filterByScript, scan } from '../src/scanner.js';

type Tree = { [name: string]: string | Tree };

async function writeTree(root: string, tree: Tree): Promise<void> {
  for (const [name, value] of Object.entries(tree)) {
    const target = path.join(root, name);
    if (typeof value === 'string') {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, value, 'utf8');
    } else {
      await mkdir(target, { recursive: true });
      await writeTree(target, value);
    }
  }
}

const pkg = (scripts: Record<string, unknown>): string => JSON.stringify({ name: 'fixture', scripts });

describe('scan', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hop-scan-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('detects node projects in subdirectories and extracts their scripts', async () => {
    await writeTree(root, {
      frontend: { 'package.json': pkg({ dev: 'vite', build: 'tsc && vite build' }) },
      backend: { 'package.json': pkg({ start: 'node server.js' }) },
    });

    const targets = await scan(root);

    expect(targets.map((target) => target.name)).toEqual(['backend', 'frontend']);
    expect(targets[0]).toMatchObject({
      type: 'node',
      path: path.join(root, 'backend'),
      scripts: { start: 'node server.js' },
    });
    expect(targets[1]?.scripts).toEqual({ dev: 'vite', build: 'tsc && vite build' });
  });

  it('also treats the scan root itself as a project', async () => {
    await writeTree(root, {
      'package.json': pkg({ dev: 'vite' }),
      frontend: { 'package.json': pkg({ build: 'vite build' }) },
    });

    const targets = await scan(root);

    expect(targets).toHaveLength(2);
    expect(targets[0]?.path).toBe(root);
    expect(targets[0]?.name).toBe(path.basename(root));
    expect(targets[1]?.name).toBe('frontend');
  });

  it('detects docker projects (Dockerfile and compose file)', async () => {
    await writeTree(root, {
      database: { 'docker-compose.yml': 'services: {}' },
      image: { Dockerfile: 'FROM node:20' },
    });

    const targets = await scan(root);

    expect(targets.map((target) => [target.name, target.type])).toEqual([
      ['database', 'docker'],
      ['image', 'docker'],
    ]);
    expect(targets[0]?.scripts).toEqual({ up: 'docker compose up', down: 'docker compose down' });
    expect(targets[1]?.scripts).toEqual({ build: 'docker build .' });
  });

  it('detects python projects', async () => {
    await writeTree(root, {
      api: { 'requirements.txt': 'flask', 'main.py': 'print("hi")' },
      tooling: { 'pyproject.toml': '[project]' },
    });

    const targets = await scan(root);

    expect(targets[0]).toMatchObject({
      name: 'api',
      type: 'python',
      scripts: { run: 'python main.py', install: 'pip install -r requirements.txt' },
    });
    expect(targets[1]?.scripts).toEqual({ install: 'pip install -e .' });
  });

  it('detects go projects', async () => {
    await writeTree(root, { service: { 'go.mod': 'module example.com/service' } });

    const targets = await scan(root);

    expect(targets).toEqual([
      {
        name: 'service',
        path: path.join(root, 'service'),
        type: 'go',
        scripts: { run: 'go run .', test: 'go test ./...' },
      },
    ]);
  });

  it('skips ignored directories such as node_modules, .git, dist, build and venv', async () => {
    await writeTree(root, {
      frontend: { 'package.json': pkg({ dev: 'vite' }) },
      node_modules: { hoisted: { 'package.json': pkg({ dev: 'should-not-appear' }) } },
      dist: { 'package.json': pkg({ build: 'should-not-appear' }) },
      build: { 'pyproject.toml': '[project]' },
      venv: { 'requirements.txt': '' },
      '.git': { hooks: { 'package.json': pkg({ postinstall: 'should-not-appear' }) } },
    });

    const targets = await scan(root);

    expect(targets.map((target) => target.name)).toEqual(['frontend']);
  });

  it('crawls at most 3 levels deep by default', async () => {
    await writeTree(root, {
      a: { b: { c: { 'go.mod': 'module example.com/deep', d: { 'package.json': pkg({ dev: 'too-deep' }) } } } },
    });

    const targets = await scan(root);

    expect(targets.map((target) => target.name)).toEqual(['c']);
  });

  it('honours a custom maxDepth', async () => {
    await writeTree(root, { a: { b: { c: { 'go.mod': 'module example.com/deep' } } } });

    expect((await scan(root, { maxDepth: 2 })).map((target) => target.name)).toEqual([]);
    expect((await scan(root, { maxDepth: 3 })).map((target) => target.name)).toEqual(['c']);
  });

  it('merges several fingerprints in one directory and namespaces colliding keys', async () => {
    await writeTree(root, {
      backend: {
        'package.json': pkg({ dev: 'tsx watch src/index.ts', build: 'tsc' }),
        Dockerfile: 'FROM node:20',
        'docker-compose.yml': 'services: {}',
      },
    });

    const targets = await scan(root);

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      name: 'backend',
      type: 'node',
      scripts: {
        dev: 'tsx watch src/index.ts',
        build: 'tsc',
        'docker:build': 'docker build .',
        up: 'docker compose up',
        down: 'docker compose down',
      },
    });
  });

  it('ignores package.json files without usable scripts', async () => {
    await writeTree(root, {
      empty: { 'package.json': JSON.stringify({ name: 'empty' }) },
      weird: { 'package.json': pkg({ dev: 42, '': '', build: 'vite build' }) },
      blank: { 'package.json': 'not json at all' },
    });

    const targets = await scan(root);

    expect(targets.map((target) => target.name)).toEqual(['weird']);
    expect(targets[0]?.scripts).toEqual({ build: 'vite build' });
  });

  it('qualifies duplicate directory names with their relative path', async () => {
    await writeTree(root, {
      apps: { web: { 'package.json': pkg({ dev: 'vite' }) }, api: { 'package.json': pkg({ dev: 'node .' }) } },
      services: { api: { 'package.json': pkg({ dev: 'go run .' }) } },
    });

    const targets = await scan(root);

    expect(targets.map((target) => target.name)).toEqual(['apps/api', 'services/api', 'web']);
  });

  it('qualifies the scan root when a subfolder shares its name', async () => {
    const base = path.basename(root);
    await writeTree(root, {
      'package.json': pkg({ dev: 'vite' }),
      [base]: { 'package.json': pkg({ dev: 'node .' }) },
    });

    const targets = await scan(root);

    expect(targets.map((target) => target.name)).toEqual([`${base} (root)`, base]);
    expect(targets.map((target) => target.path)).toEqual([root, path.join(root, base)]);
  });

  it('namespaces docker scripts that collide with node scripts', async () => {
    await writeTree(root, {
      api: {
        'package.json': pkg({ up: 'node scripts/up.js', build: 'tsc' }),
        'docker-compose.yml': 'services: {}',
      },
    });

    const targets = await scan(root);

    expect(targets[0]?.scripts).toEqual({
      up: 'node scripts/up.js',
      build: 'tsc',
      'docker:up': 'docker compose up',
      down: 'docker compose down',
    });
    expect(filterByScript(targets, 'build').map((target) => target.name)).toEqual(['api']);
    expect(filterByScript(targets, 'docker:up').map((target) => target.name)).toEqual(['api']);
  });

  it('finds a project exactly on the depth boundary and nothing deeper', async () => {
    await writeTree(root, {
      one: { two: { three: { 'go.mod': 'module example.com/boundary', four: { 'pyproject.toml': '[project]' } } } },
    });

    const targets = await scan(root);

    expect(targets.map((target) => target.name)).toEqual(['three']);
  });

  it('treats maxDepth 0 as "the scan root only"', async () => {
    await writeTree(root, {
      'package.json': pkg({ dev: 'vite' }),
      child: { 'package.json': pkg({ dev: 'node .' }) },
    });

    expect((await scan(root, { maxDepth: 0 })).map((target) => target.name)).toEqual([path.basename(root)]);
  });

  it('skips ignored directories at every depth', async () => {
    await writeTree(root, {
      one: {
        two: {
          'package.json': pkg({ dev: 'yes' }),
          node_modules: { pkg: { 'package.json': pkg({ dev: 'nope' }) } },
          dist: { 'package.json': pkg({ build: 'nope' }) },
          nested: { venv: { 'requirements.txt': '' } },
        },
      },
    });

    expect((await scan(root)).map((target) => target.name)).toEqual(['two']);
  });

  it('does not follow junctions that point back into the tree', async () => {
    await writeTree(root, { app: { 'package.json': pkg({ dev: 'vite' }) } });
    await symlink(root, path.join(root, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');

    const targets = await scan(root);

    expect(targets.map((target) => target.name)).toEqual(['app']);
  });

  it('returns an empty array for directories with nothing runnable', async () => {
    await writeTree(root, { docs: { 'readme.md': 'hello' } });

    expect(await scan(root)).toEqual([]);
  });
});

describe('filterByScript / availableScripts', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hop-filter-'));
    await writeTree(root, {
      frontend: { 'package.json': pkg({ dev: 'vite', build: 'vite build' }) },
      backend: { 'package.json': pkg({ start: 'node server.js' }) },
      database: { 'docker-compose.yml': 'services: {}' },
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds every target exposing a script name', async () => {
    const targets = await scan(root);

    expect(filterByScript(targets, 'dev').map((target) => target.name)).toEqual(['frontend']);
    expect(filterByScript(targets, 'up').map((target) => target.name)).toEqual(['database']);
    expect(filterByScript(targets, 'deploy')).toEqual([]);
  });

  it('lists all script names found across targets', async () => {
    const targets = await scan(root);

    expect(availableScripts(targets)).toEqual(['build', 'dev', 'down', 'start', 'up']);
  });
});
