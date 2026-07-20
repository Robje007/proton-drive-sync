# Proton NAS Sync

An unofficial Proton Drive sync client for NAS, Docker, and native command-line use. It includes a
custom dashboard, safe upload backups, and an opt-in **two-way sync beta**.

[Support development on Ko-fi](https://ko-fi.com/robje007)

> This community project is not affiliated with or endorsed by Proton AG. Two-way sync is beta and
> should first be tested with a small, backed-up folder.

## Features

- Upload-only backup or two-way beta, selectable per folder mapping.
- Remote event monitoring with a periodic reconciliation safety net.
- Atomic downloads: a partial download never replaces the destination file.
- Simultaneous edits keep both versions in `.proton-sync-conflicts`.
- Remote deletes move the local copy to `.proton-sync-recovery`.
- Dashboard for mappings, queues, logs, pause/resume, and optional secure sign-in.
- Large-tree scanning with useful defaults such as `node_modules` and `.venv` exclusions.
- Docker images for AMD64 and ARM64, plus native CLI support.
- Official `@protontech/drive-sdk` 0.19.2 integration.

## Docker quick start

Generate a key for encrypting the stored Proton session:

```bash
openssl rand -base64 32
```

Paste that key directly into this Compose configuration—no separate `.env` file is required:

```yaml
name: proton-nas-sync

services:
  proton-drive-sync:
    image: ghcr.io/robje007/proton-drive-sync:latest
    pull_policy: always
    container_name: proton-drive-sync
    restart: unless-stopped

    environment:
      KEYRING_PASSWORD: 'PASTE_YOUR_GENERATED_KEY_HERE'
      TZ: 'Europe/Amsterdam'
      DOCKER: '1'

    ports:
      - '4242:4242'

    volumes:
      - proton-drive-config:/config/proton-drive-sync
      - proton-drive-state:/state/proton-drive-sync
      - /home/robin:/data/robin

    stop_grace_period: 30s

volumes:
  proton-drive-config:
  proton-drive-state:
```

Keep `KEYRING_PASSWORD` unchanged after authentication. Anyone who can read the Compose YAML can
read this key, so restrict access to the configuration and never commit it.

Start the container:

```bash
sudo docker compose up -d
sudo docker exec -it proton-drive-sync proton-drive-sync auth
sudo docker logs --tail 100 -f proton-drive-sync
```

The service notices saved authentication automatically; a restart after `auth` is not required.
Open `http://NAS-IP:4242` and add a mapping such as:

```text
/data/robin/Projects → /backupnas
```

Use the path **inside the container**. With `/home/robin:/data/robin`, the dashboard must use
`/data/robin`, not `/home/robin`.

## Upload-only or two-way beta

Every mapping has its own direction:

- **NAS → Drive** is the default. Local additions, changes, moves, and deletes are sent to Drive.
- **Two-way (beta)** also downloads changes made in Proton Drive.

Enable two-way in **Settings → Backup configuration → Direction**. Existing configurations without
a direction remain upload-only after upgrading.

For a new native or Docker CLI mapping, add `--two-way`:

```bash
sudo docker exec proton-drive-sync proton-drive-sync config sync-dir \
  --add /data/robin/Projects --remote /backupnas --two-way
```

The first two-way scan is deliberately conservative:

- Equal files are adopted without another transfer.
- If different local and remote files already have the same path, the remote version is downloaded
  to `.proton-sync-conflicts/<timestamp>/...`.
- If both sides change after the baseline, both versions are kept in the same way.
- A remote delete moves the local version to `.proton-sync-recovery/<timestamp>/...`.
- Safety and temporary folders are never uploaded.

After inspecting a conflict, keep the desired file at its normal path and edit or replace it once;
that intentional local change is then uploaded.

The beta is built on the official SDK's download and Drive-event APIs. Proton currently labels its
SDK as not generally available for third-party production applications, so keep another backup of
important data and expect beta behavior to evolve.

## Upgrade without losing configuration

The named `config` and `state` volumes contain authentication, mappings, and sync history. A normal
image upgrade preserves them:

```bash
sudo docker compose pull
sudo docker compose up -d
sudo docker logs --tail 100 -f proton-drive-sync
```

Do **not** run `sudo docker compose down -v`; `-v` deletes the named volumes. Also keep the existing
`KEYRING_PASSWORD`, config volume name, and state volume name unchanged.

To confirm the running image:

```bash
sudo docker inspect proton-drive-sync --format '{{.Config.Image}}'
sudo docker exec proton-drive-sync proton-drive-sync --version
```

## Useful Docker commands

```bash
# Show mappings
sudo docker exec proton-drive-sync proton-drive-sync config sync-dir --list

# Show exclusions
sudo docker exec proton-drive-sync proton-drive-sync config exclude --list

# Authenticate again
sudo docker exec -it proton-drive-sync proton-drive-sync auth

# Safely clear a verified stale process lock
sudo docker exec proton-drive-sync proton-drive-sync unlock

# Restart and follow logs
sudo docker restart proton-drive-sync
sudo docker logs --tail 100 -f proton-drive-sync
```

## Optional dashboard sign-in

CLI authentication is the simplest choice. Browser sign-in is disabled by default. To enable it,
generate a separate access token:

```bash
openssl rand -base64 48
```

Add both values directly under the Compose `environment` section:

```yaml
WEB_AUTH_ENABLED: '1'
WEB_AUTH_ACCESS_TOKEN: 'PASTE_A_SEPARATE_TOKEN_OF_AT_LEAST_32_CHARACTERS'
```

Never reuse `KEYRING_PASSWORD` as this token. Browser sign-in over plain HTTP is limited to
`localhost`. For access from another machine, place the dashboard behind an authenticated HTTPS
reverse proxy or VPN. Only then add `WEB_AUTH_TRUST_PROXY: '1'` and bind the direct port to
`127.0.0.1:4242:4242`.

## Native installation

Docker is recommended on a NAS, but the application is not Docker-only. A native build requires
[Bun](https://bun.sh/), Git, a C/C++ build toolchain, Python, and the platform dependencies needed
by `keytar`.

```bash
git clone https://github.com/Robje007/proton-drive-sync.git
cd proton-drive-sync
bun install
bun run build
bun link
proton-drive-sync auth
proton-drive-sync config
proton-drive-sync start
```

Native configuration is stored below the normal platform config/state directories. Run
`proton-drive-sync config --help` for non-interactive commands and `proton-drive-sync start --help`
for one-shot, watch, dry-run, and service options.

## Exclusions

New configurations exclude common generated dependency directories:

```text
node_modules
.npm
.pnpm-store
.yarn/cache
__pycache__
.venv
venv
```

Your source, dotfiles, and `.git` directory remain included unless you exclude them yourself. Large
generated directories should be excluded instead of synchronized.

## Troubleshooting

### “Local path does not exist”

Use the container-side mount path, for example `/data/robin/Projects`.

### “Another instance is already running”

Do not start a second sync process with `docker exec`. The container already runs it. If no process
is actually active, use the `unlock` command shown above.

### Dashboard is not reachable

Check `sudo docker ps` for `0.0.0.0:4242->4242/tcp`, then inspect the logs. The dashboard must bind
to `0.0.0.0` inside Docker; the image handles this automatically.

### A project generates thousands of jobs

Exclude dependency, cache, build-output, and virtual-environment folders. Source-control working
trees usually do not need `node_modules` synchronized.

## Development

```bash
bun install
bun run build:check
bun test
bun run build
```

Contributions and beta reports are welcome on GitHub. This project is GPL-3.0 licensed.

[Ko-fi: ko-fi.com/robje007](https://ko-fi.com/robje007)
