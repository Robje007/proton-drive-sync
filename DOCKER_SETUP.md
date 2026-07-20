# Docker and NAS setup

The published image supports Linux AMD64 and ARM64:

```text
ghcr.io/robje007/proton-drive-sync:latest
```

Docker is recommended for NAS installations. For native source builds, see the main
[README](README.md#native-source-installation).

## Self-contained Compose YAML

Generate a credential-encryption key:

```bash
openssl rand -base64 32
```

Paste it directly into the configuration if you do not want a separate `.env` file:

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
      - /your/host/folder:/data/files

    stop_grace_period: 30s

volumes:
  proton-drive-config:
  proton-drive-state:
```

The direct key is stored as plain text in the Compose definition. Restrict access to the file or
NAS project configuration. An `.env` reference remains available as an optional alternative.

## Start and authenticate

```bash
sudo docker compose pull
sudo docker compose up -d
sudo docker logs --tail 100 -f proton-drive-sync
```

Authenticate in the terminal:

```bash
sudo docker exec -it proton-drive-sync proton-drive-sync auth
```

The running service detects credentials without a restart. Open `http://NAS-IP:4242` and add the
container path `/data/files` as a sync directory.

## Path mapping

Docker sees only explicitly mounted host directories:

```yaml
volumes:
  - /home/robin:/data/robin
  - /volume/photos:/data/photos
```

Use `/data/robin` and `/data/photos` in the dashboard. The host paths on the left do not exist
inside the container.

## Secure web authentication

Browser login requires an additional token:

```bash
openssl rand -base64 48
```

Add it directly to the service environment:

```yaml
environment:
  KEYRING_PASSWORD: 'YOUR_EXISTING_KEY'
  TZ: 'Europe/Amsterdam'
  DOCKER: '1'
  WEB_AUTH_ENABLED: '1'
  WEB_AUTH_ACCESS_TOKEN: 'PASTE_A_SEPARATE_TOKEN_OF_AT_LEAST_32_CHARACTERS'
```

Remote browser login requires an HTTPS reverse proxy and:

```yaml
WEB_AUTH_TRUST_PROXY: '1'
```

The proxy must set `X-Forwarded-Proto: https`. Block direct LAN access to port 4242 when proxy
headers are trusted.

## Persistent volumes

| Container path              | Contents                                |
| --------------------------- | --------------------------------------- |
| `/config/proton-drive-sync` | Configuration and encrypted credentials |
| `/state/proton-drive-sync`  | SQLite state, queues, locks, and logs   |
| `/data/...`                 | Mounted local files                     |

Back up the config volume together with the separately stored encryption key. Never publish either.

## Useful commands

```bash
sudo docker exec proton-drive-sync proton-drive-sync --version
sudo docker exec proton-drive-sync proton-drive-sync status
sudo docker exec proton-drive-sync proton-drive-sync config sync-dir --list
sudo docker exec proton-drive-sync proton-drive-sync config exclude --list
sudo docker exec proton-drive-sync proton-drive-sync pause
sudo docker exec proton-drive-sync proton-drive-sync resume
sudo docker exec proton-drive-sync proton-drive-sync reconcile
sudo docker exec proton-drive-sync proton-drive-sync unlock
sudo docker logs --tail 200 -f proton-drive-sync
```

## Updating

```bash
sudo docker compose pull
sudo docker compose up -d
```

Named volumes remain intact. Keep the same `KEYRING_PASSWORD` after an update.

## NAS kernel restrictions

Do not add container-level `fs.inotify.*` sysctls on Ugreen or other restricted NAS kernels. Some
kernels reject them because those settings are not namespaced. Configure host limits only through a
vendor-supported mechanism.

## Troubleshooting

### Local path does not exist

```bash
sudo docker exec proton-drive-sync ls -la /data
```

Use the displayed container path in the dashboard.

### Missing authentication

Confirm that the correct config volume and original `KEYRING_PASSWORD` are configured. Then run:

```bash
sudo docker exec -it proton-drive-sync proton-drive-sync auth
```

### Stale process lock

```bash
sudo docker exec proton-drive-sync proton-drive-sync status
sudo docker exec proton-drive-sync proton-drive-sync unlock
```

The unlock command refuses to remove the lock of a verified live process.
