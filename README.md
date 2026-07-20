# Proton NAS Sync

An unofficial, community-maintained Proton Drive uploader for NAS, Docker, and native command-line
use.

This fork keeps local directories backed up to Proton Drive while staying responsive around large
project trees. It is designed for headless systems such as Ugreen NAS, Synology, QNAP, Unraid, and
ordinary Linux servers.

If this NAS-focused fork is useful to you, you can support its development on
[Ko-fi](https://ko-fi.com/robje007).

> [!IMPORTANT]
> This is **one-way synchronization**: local changes are uploaded to Proton Drive. Changes made in
> Proton Drive are not downloaded to the NAS. This project is not affiliated with or endorsed by
> Proton AG.

## What it provides

- A custom browser dashboard for status, queues, mappings, pause/resume, logs, and configuration.
- Optional browser-based Proton authentication with 2FA and two-password account support.
- Published Docker images for AMD64 and ARM64 systems.
- Native CLI operation from source on Linux, macOS, and Windows.
- Multiple local-directory to Proton Drive mappings.
- Configurable concurrency and exclusion patterns.
- Continuous filesystem watching or a one-shot scan.
- Encrypted reusable Proton session storage.

## Installation choices

| Method              | Best for                                      | Availability                |
| ------------------- | --------------------------------------------- | --------------------------- |
| Docker Compose      | Ugreen, Synology, QNAP, Unraid, Linux servers | Published AMD64/ARM64 image |
| Docker CLI          | NAS systems without Compose projects          | Published AMD64/ARM64 image |
| Native source build | Desktop, server, and development use          | Build locally with Bun      |

Docker is the recommended NAS method, but the application is not Docker-only. The CLI, dashboard,
watcher, configuration commands, and native service commands remain available when building from
source.

## Why this fork exists

The upstream project provides the Proton Drive integration. This fork focuses on the failure modes
seen on a real NAS installation:

- restart-safe process locks that detect Docker PID reuse;
- an explicit `unlock` command that only removes verified stale locks;
- lazy, batched scans instead of loading an entire project tree into memory;
- early pruning of `node_modules`, package caches, virtual environments, and other defaults;
- queued jobs are revalidated immediately before upload;
- changing a remote root removes jobs made with the old mapping;
- excluded files already in the queue are discarded safely;
- canonical remote paths, so `/` plus `Projects` never becomes `//Projects`;
- idempotent remote folder creation during concurrent uploads;
- Docker stays online while waiting for authentication—no restart after `auth`;
- optional browser login with 2FA, transport checks, CSRF protection, and throttling;
- state resets no longer restart an already configured onboarding wizard;
- a compact NAS dashboard with clear one-way backup semantics.

## Quick start with Docker Compose

Generate a credential-encryption key:

```bash
openssl rand -base64 32
```

The key may be placed directly in the Compose YAML. This is convenient for NAS interfaces that
manage a project as one file:

```yaml
name: proton-nas-sync

services:
  proton-drive-sync:
    image: ghcr.io/robje007/proton-drive-sync:latest
    container_name: proton-drive-sync
    restart: unless-stopped

    environment:
      KEYRING_PASSWORD: 'PASTE_YOUR_GENERATED_KEY_HERE'
      TZ: 'Europe/Amsterdam'
      DOCKER: '1'
      # WEB_AUTH_ENABLED: '1'
      # WEB_AUTH_ACCESS_TOKEN: 'PASTE_A_SEPARATE_TOKEN_OF_AT_LEAST_32_CHARACTERS'
      # WEB_AUTH_TRUST_PROXY: '1' # only behind an HTTPS reverse proxy

    ports:
      - '4242:4242'

    volumes:
      - proton-drive-config:/config/proton-drive-sync
      - proton-drive-state:/state/proton-drive-sync
      - /your/host/folder:/data/files

    stop_grace_period: 30s

volumes:
  proton-drive-config:
  proton-drive-state:
```

Replace `/your/host/folder` with the real directory on the NAS. In the dashboard, use the
**container path** `/data/files`, not the original host path.

Putting the key directly in YAML means anyone who can read that YAML can read the encryption key.
Restrict access to the file and never commit it to a public repository.

An `.env` file remains an optional alternative; it is not required. To use one, replace the direct
value with:

```yaml
environment:
  KEYRING_PASSWORD: ${KEYRING_PASSWORD}
```

and place `KEYRING_PASSWORD=...` in `.env`. Choose one method and keep the generated value safe:
changing it makes the existing encrypted credentials unreadable.

### Container environment reference

| Variable                | Required         | Purpose                                                          |
| ----------------------- | ---------------- | ---------------------------------------------------------------- |
| `KEYRING_PASSWORD`      | Yes              | Encrypts the reusable Proton session                             |
| `TZ`                    | No               | Container timezone; defaults to UTC                              |
| `DOCKER`                | No               | Enables Docker-aware defaults; already set by the image          |
| `WEB_AUTH_ENABLED`      | No               | Enables the opt-in dashboard login flow                          |
| `WEB_AUTH_ACCESS_TOKEN` | With web login   | Separate token protecting login endpoints; minimum 32 characters |
| `WEB_AUTH_TRUST_PROXY`  | With HTTPS proxy | Trusts forwarded HTTPS information from the reverse proxy        |

Start it:

```bash
sudo docker compose pull
sudo docker compose up -d
```

The dashboard remains available while credentials are missing. Authenticate once:

```bash
sudo docker exec -it proton-drive-sync proton-drive-sync auth
```

The running service detects the new credentials within five seconds. A container restart is not
required.

Open `http://NAS-IP:4242` and create a mapping, for example:

```text
/data/robin/Projects → /backupnas
```

For example, the host mount `/home/robin:/data/robin` means the application sees
`/data/robin/Projects`. Entering `/home/robin/Projects` in the dashboard will fail because that is a
host path, not a container path.

## Dashboard overview

The custom dashboard provides:

- live authentication and connection status;
- pending, active, completed, retry, and blocked queues;
- current local-to-remote mappings;
- pause, resume, retry, and shutdown controls;
- concurrency and exclusion-aware directory configuration;
- live application logs;
- optional secure Proton login; and
- an About page for this community fork.

The dashboard is an administration interface. Keep it on a trusted LAN, behind a VPN, or behind an
authenticated reverse proxy.

## Secure sign-in through the dashboard

Browser sign-in is disabled by default. It supports Proton 2FA and two-password accounts without
storing the login password or verification code. An unfinished authentication flow exists only in
memory and expires after five minutes.

Generate a separate dashboard login token:

```bash
openssl rand -base64 48
```

Never reuse `KEYRING_PASSWORD` as the dashboard token. The values can be placed directly in the
Compose YAML:

```yaml
environment:
  KEYRING_PASSWORD: 'YOUR_EXISTING_ENCRYPTION_KEY'
  TZ: 'Europe/Amsterdam'
  DOCKER: '1'
  WEB_AUTH_ENABLED: '1'
  WEB_AUTH_ACCESS_TOKEN: 'PASTE_A_SEPARATE_TOKEN_OF_AT_LEAST_32_CHARACTERS'
```

If you prefer an `.env` file, use `WEB_AUTH_ACCESS_TOKEN: ${WEB_AUTH_ACCESS_TOKEN}` instead. Both
configuration styles are supported.

With plain HTTP, the sign-in form works only at `http://localhost:4242`. For a NAS dashboard opened
from another device, first configure an HTTPS reverse proxy. Then add:

```yaml
environment:
  WEB_AUTH_TRUST_PROXY: '1'
```

The proxy must set `X-Forwarded-Proto: https`. Do not leave the direct dashboard port reachable from
the LAN when trusting proxy headers. If the reverse proxy runs on the NAS host, bind the port only
to loopback:

```yaml
ports:
  - '127.0.0.1:4242:4242'
```

Also protect the complete dashboard with the reverse proxy's authentication, a VPN, or a strict
firewall rule. `WEB_AUTH_ACCESS_TOKEN` protects the Proton sign-in endpoints; it does not turn the
rest of the dashboard into a multi-user application. After a successful sign-in, the running sync
process detects the new encrypted session automatically—no container restart is needed.

## How mappings work

A mapping connects a path visible to the application with a Proton Drive destination:

```text
/data/projects → /backupnas
/data/photos   → /Photos/NAS
```

Rules and behavior:

- The local path must exist inside the container or on the native host.
- The remote root always begins with `/`.
- Nested or otherwise overlapping local mappings are rejected.
- Changing a remote root invalidates queued work made for the previous destination.
- A root mapping does not produce double-slash remote paths.
- This remains one-way local-to-Proton synchronization.

Test with a small directory before enabling a large project tree.

## Recommended project exclusions

New installations automatically exclude generated dependency/cache directories:

```text
node_modules
.npm
.pnpm-store
.yarn/cache
__pycache__
.venv
venv
```

Source code, dotfiles, build files, and `.git` remain included. Add more exclusions when needed:

```bash
sudo docker exec proton-drive-sync proton-drive-sync config exclude \
  --path / \
  --add '.next' 'dist' 'coverage'
```

List the effective configuration:

```bash
sudo docker exec proton-drive-sync proton-drive-sync config sync-dir --list
sudo docker exec proton-drive-sync proton-drive-sync config exclude --list
```

## Persistent data

| Container path              | Contents                                | Recommended storage      |
| --------------------------- | --------------------------------------- | ------------------------ |
| `/config/proton-drive-sync` | Configuration and encrypted credentials | Persistent named volume  |
| `/state/proton-drive-sync`  | SQLite state, queues, locks, and logs   | Persistent named volume  |
| `/data/...`                 | Local content being uploaded            | Bind mount from NAS/host |

Config and state deliberately use separate volumes. This lets you retain authentication and
mappings while starting with a fresh queue database during a migration.

## CLI reference

Inside Docker, prefix application commands with:

```text
sudo docker exec proton-drive-sync proton-drive-sync
```

| Command                  | Purpose                                   |
| ------------------------ | ----------------------------------------- |
| `auth`                   | Authenticate interactively, including 2FA |
| `auth --logout`          | Remove stored Proton credentials          |
| `status`                 | Show service and authentication status    |
| `config get`             | Display configuration                     |
| `config sync-dir --list` | List local-to-remote mappings             |
| `config exclude --list`  | List exclusions                           |
| `pause` / `resume`       | Pause or resume queue processing          |
| `reconcile`              | Request a full filesystem scan            |
| `logs` / `logs -f`       | Read application logs                     |
| `unlock`                 | Remove only a verified stale process lock |
| `reset`                  | Interactively reset selected state        |

## Safe recovery commands

Check state:

```bash
sudo docker exec proton-drive-sync proton-drive-sync status
```

Clear a stale lock safely:

```bash
sudo docker exec proton-drive-sync proton-drive-sync unlock
```

The command refuses to unlock a verified running process. There is no need to edit SQLite or remove
the complete state volume.

Pause and resume:

```bash
sudo docker exec proton-drive-sync proton-drive-sync pause
sudo docker exec proton-drive-sync proton-drive-sync resume
```

View logs:

```bash
sudo docker logs --tail 100 -f proton-drive-sync
```

## Updating the container

With `pull_policy: always` configured:

```bash
sudo docker compose pull
sudo docker compose up -d
sudo docker logs --tail 100 -f proton-drive-sync
```

Named volumes are preserved. Pin a release rather than `latest` if reproducibility matters:

```yaml
image: ghcr.io/robje007/proton-drive-sync:0.3.0-nas.2
```

## Ugreen and restricted NAS kernels

This Compose setup intentionally contains no container-level `fs.inotify.*` sysctls. Several NAS
kernels reject them with:

```text
sysctl "fs.inotify.max_user_instances" is not in a separate kernel namespace
```

If limits need adjustment, configure them on the NAS host through the vendor-supported mechanism;
do not add them to the container unless the NAS kernel explicitly supports namespaced sysctls.

## Migrating from another image

Credentials and configuration live in `/config/proton-drive-sync`. Sync history and process state
live separately in `/state/proton-drive-sync`.

To keep an existing login, mount the old config volume into the new container. A fresh state volume
is recommended when migrating from a wrapper image that left stale jobs or PID locks. The first scan
will rebuild state in bounded batches and recognize existing remote files and folders.

Never publish `KEYRING_PASSWORD`, `.env`, `credentials.enc`, or a config-volume backup.

## Native source installation

Docker is the maintained release artifact for this fork, but the native CLI remains available from
source for Linux, macOS, and Windows.

Requirements:

- [Bun](https://bun.sh/)
- Git
- the native build prerequisites required by the dependencies on your operating system

Build a standalone binary for the current system:

```bash
git clone https://github.com/Robje007/proton-drive-sync.git
cd proton-drive-sync
bun install
bun run build:css
bun run build:bin
./dist/proton-drive-sync --version
```

Run the interactive setup wizard:

```bash
./dist/proton-drive-sync setup
```

Or run directly in the foreground:

```bash
./dist/proton-drive-sync start --no-daemon
```

Native start-on-login/service management remains available through
`proton-drive-sync service --help`. Native builds receive less NAS-focused testing than the
published container image.

## Troubleshooting

### Local path does not exist

Inspect the paths visible inside the container:

```bash
sudo docker exec proton-drive-sync ls -la /data
sudo docker exec proton-drive-sync ls -la /data/robin
```

Use the container path shown there in the dashboard.

### Another instance is already running

Check status and clear only a verified stale lock:

```bash
sudo docker exec proton-drive-sync proton-drive-sync status
sudo docker exec proton-drive-sync proton-drive-sync unlock
```

Do not manually edit the SQLite state database. The unlock command refuses to remove a lock owned
by a verified live process.

### Authentication disappeared after migration

Verify that the original config volume is mounted at `/config/proton-drive-sync`, the same
`KEYRING_PASSWORD` is configured, and `credentials.enc` exists. Re-authenticate if necessary:

```bash
sudo docker exec -it proton-drive-sync proton-drive-sync auth
```

No restart is required afterward.

### Generated folders are still queued

Check exclusions, add the missing pattern, and reconcile:

```bash
sudo docker exec proton-drive-sync proton-drive-sync config exclude --list
sudo docker exec proton-drive-sync proton-drive-sync config exclude --path / --add 'node_modules'
sudo docker exec proton-drive-sync proton-drive-sync reconcile
```

Queued entries are revalidated before upload, so newly excluded items are discarded safely.

### Dashboard cannot be reached

```bash
sudo docker ps --filter name=proton-drive-sync
sudo docker logs --tail 200 proton-drive-sync
```

Confirm the port mapping and check whether another service already uses host port 4242. For a
mapping such as `4343:4242`, open port 4343 in the browser.

## Security and backups

- Never publish a Compose YAML containing real keys.
- Never publish `credentials.enc`, a config-volume backup, or dashboard tokens.
- Protect the dashboard from untrusted networks.
- Store the encryption key separately from the config-volume backup.
- Test restoring files from Proton Drive; a successful upload is not itself a tested restore.

## Local development

Requirements: Bun and Docker/Podman.

```bash
bun install
bun run build:check
bun test
bun run build:css
bun run build:bin
```

Build the container:

```bash
sudo docker build -f docker/Dockerfile -t proton-nas-sync:dev .
```

## Support

Proton NAS Sync is maintained as an independent community project. You can support continued NAS
testing and development at [ko-fi.com/robje007](https://ko-fi.com/robje007).

## Upstream and license

Proton NAS Sync is a modified version of
[DamianB-BitFlipper/proton-drive-sync](https://github.com/DamianB-BitFlipper/proton-drive-sync).
The original work and this fork are distributed under the GNU General Public License v3.0. Modified
versions must remain under GPL-3.0 when distributed, include the license, provide corresponding
source, and be clearly identified as modified.

See [LICENSE](LICENSE) for the complete license text.
