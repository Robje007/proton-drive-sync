# Proton NAS Sync

An unofficial, NAS-focused Proton Drive uploader with a Docker-first dashboard.

This fork keeps local directories backed up to Proton Drive while staying responsive around large
project trees. It is designed for headless systems such as Ugreen NAS, Synology, QNAP, Unraid, and
ordinary Linux servers.

If this NAS-focused fork is useful to you, you can support its development on
[Ko-fi](https://ko-fi.com/robje007).

> [!IMPORTANT]
> This is **one-way synchronization**: local changes are uploaded to Proton Drive. Changes made in
> Proton Drive are not downloaded to the NAS. This project is not affiliated with or endorsed by
> Proton AG.

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

Create `.env`:

```dotenv
KEYRING_PASSWORD=replace-with-the-generated-value
TZ=Europe/Amsterdam
DASHBOARD_PORT=4242
```

Use this Compose file:

```yaml
name: proton-nas-sync

services:
  proton-drive-sync:
    image: ghcr.io/robje007/proton-drive-sync:latest
    container_name: proton-drive-sync
    restart: unless-stopped

    environment:
      KEYRING_PASSWORD: ${KEYRING_PASSWORD}
      TZ: ${TZ:-UTC}
      DOCKER: '1'
      # WEB_AUTH_ENABLED: '1'
      # WEB_AUTH_ACCESS_TOKEN: ${WEB_AUTH_ACCESS_TOKEN}
      # WEB_AUTH_TRUST_PROXY: '1' # only behind an HTTPS reverse proxy

    ports:
      - '${DASHBOARD_PORT:-4242}:4242'

    volumes:
      - proton-drive-config:/config/proton-drive-sync
      - proton-drive-state:/state/proton-drive-sync
      - /home/robin:/data/robin

    stop_grace_period: 30s

volumes:
  proton-drive-config:
  proton-drive-state:
```

Until a prebuilt package has been published, replace `image:` with:

```yaml
build:
  context: .
  dockerfile: docker/Dockerfile
```

Start it:

```bash
sudo docker compose up -d --build
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

## Secure sign-in through the dashboard

Browser sign-in is disabled by default. It supports Proton 2FA and two-password accounts without
storing the login password or verification code. An unfinished authentication flow exists only in
memory and expires after five minutes.

Generate a separate dashboard login token:

```bash
openssl rand -base64 48
```

Add it to `.env` and never reuse `KEYRING_PASSWORD`:

```dotenv
WEB_AUTH_ACCESS_TOKEN=replace-with-the-generated-value
```

Then add these variables to the container:

```yaml
environment:
  WEB_AUTH_ENABLED: '1'
  WEB_AUTH_ACCESS_TOKEN: ${WEB_AUTH_ACCESS_TOKEN}
```

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
