# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-18

### Added

- Zero-config scanning of the current directory and up to three levels below it
  for Node (`package.json`), Docker (`Dockerfile` / compose), Python
  (`requirements.txt` / `pyproject.toml`) and Go (`go.mod`) projects.
- Interactive picker with per-project groups, select-all rows, and pre-selection
  of projects with uncommitted git changes (their `dev` / `serve` / `start` /
  `run` script), marked with a `· N changed` label.
- Concurrent execution with color-prefixed output, per-script result summary,
  and a clean `Ctrl+C` that kills the entire process tree (no orphaned ports);
  exit codes 0 / 1 / 130.
- `hop <script>` direct mode, `hop --npm` (scripts through the project's package
  manager, pre/post hooks included), `hop --list` inventory.
- Dynamic port conflict resolution: probes `--port`, `$PORT` and `PORT=` in
  `.env*`, walks upward when a port is blocked, rewrites the command's `--port`
  flag when needed, injects the resolved `PORT` into the child, and never hands
  the same port to two projects. Ports published by compose files are reserved
  automatically.
- Dependency handshakes: hop waits for localhost services referenced by `.env`
  files, bundler configs or script commands — and for sibling services that
  publish those ports — before starting dependents. Animated spinner on TTY,
  plain `[hop]` lines otherwise, 30 s timeout breaker, `--no-wait` to skip, and
  explicit `"hop": { "waitFor": [...] }` in `package.json`.
- Test suite covering scanner edge cases, process lifecycle and kill-tree
  behaviour, port planning, health checks, git mapping, CLI and the interactive
  flow.
