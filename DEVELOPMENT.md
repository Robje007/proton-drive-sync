# Development

## Requirements

- [Bun](https://bun.sh) - JavaScript runtime and package manager

## Setup

```bash
git clone https://github.com/Robje007/proton-drive-sync
cd proton-drive-sync
make install
```

## Running Locally

The canonical way to develop is via the `make dev` command, which runs the app directly with bun in watch mode (auto-reload on file changes):

```bash
make dev
```

This runs `start --no-daemon` automatically. Use `Ctrl+C` to stop.

For one-off CLI commands, use `make run`:

```bash
make run ARGS="status"
```

## Make Commands

| Command           | Description                             |
| ----------------- | --------------------------------------- |
| `make install`    | Install dependencies                    |
| `make dev ARGS=…` | Run with auto-reload on file changes    |
| `make run ARGS=…` | Run one-off commands (builds first)     |
| `make pre-commit` | Run lint, format, and type-check        |
| `make db-inspect` | Open Drizzle Studio to inspect database |
| `make help`       | Show all available commands             |

## Container development

Build and smoke-test the same image used by NAS installations:

```bash
sudo docker build -f docker/Dockerfile -t proton-nas-sync:dev .
sudo docker run --rm --entrypoint proton-drive-sync proton-nas-sync:dev --version
```

## Publishing

To publish a new version:

1. Update version in `package.json`
2. Merge the version change into `main`

The auto-tag workflow creates the version tag and dispatches the multi-architecture container
build. Verify both AMD64 and ARM64 jobs and the final GHCR manifest before announcing the release.
