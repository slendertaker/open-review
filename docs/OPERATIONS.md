# Operations Guide

This guide covers day-to-day operation of the Open Review service: starting
and stopping the service, reading logs, upgrading, tuning memory, and taking
backups.

---

## Service control

Open Review runs as the `open-review.service` systemd unit. Use the standard
systemctl commands:

```sh
# Check service status
systemctl status open-review

# Restart the service
systemctl restart open-review

# Stop the service
systemctl stop open-review

# Enable the service to start on boot (done by the installer)
systemctl enable open-review
```

### Viewing logs

Logs are captured by journald. The service emits structured JSON via pino:

```sh
# Tail the last 100 lines
journalctl -u open-review -n 100

# Follow live output
journalctl -u open-review -f

# Scan for the first-run setup URL (useful after a fresh install)
journalctl -u open-review -n 50 | grep 'FIRST RUN'
```

---

## Upgrading

Re-run the installer to upgrade in place:

```sh
curl -fsSL https://raw.githubusercontent.com/slendertaker/open-review/main/install.sh | sudo bash
```

The installer performs a `git pull`, rebuilds (`npm ci && npm run build`), and
restarts the service. It does **not** regenerate the environment file or rotate
the machine key on upgrade -- your existing secrets are preserved.

Specifically, on upgrade the installer skips the "generate infra secrets" step
if `/etc/open-review/open-review.env` already exists. The following are never
overwritten:

- `/etc/open-review/open-review.env` (machine key, session secret, webhook
  secret, and any credentials you seeded)
- `/opt/open-review/data/` (the SQLite database, WAL files, and the machine
  key file)

---

## Configuration reference

After first boot, the dashboard owns all settings and secrets. The environment
file at `/etc/open-review/open-review.env` is the boot seed -- values in it
are loaded into SQLite on first start only (one-way bootstrap). After that,
changes made in the dashboard take effect on the next review without a restart.

For first-boot seeding via environment variables (unattended install), the
accepted variable names and their defaults are:

| Variable | Default | Description |
|----------|---------|-------------|
| `OPEN_REVIEW_WEBHOOK_SECRET` | required | HMAC secret for webhook verification |
| `OPEN_REVIEW_SECRET_KEY` | generated | AES-256-GCM encryption key (64 hex chars) |
| `OPEN_REVIEW_SESSION_SECRET` | generated | Session signing secret (base64) |
| `OPEN_REVIEW_PORT` | `3000` | Fastify listen port (Caddy proxies to this) |
| `OPEN_REVIEW_HOST` | `127.0.0.1` | Fastify bind address |
| `OPEN_REVIEW_DB_PATH` | `data/open-review.db` | SQLite database path (relative to install root) |
| `OPEN_REVIEW_LOG_LEVEL` | `info` | Pino log level (`trace`, `debug`, `info`, `warn`, `error`) |
| `CLAUDE_CODE_OAUTH_TOKEN` | unset | Claude subscription OAuth token (primary auth) |
| `ANTHROPIC_API_KEY` | unset | Anthropic API key (secondary auth) |
| `GITHUB_APP_ID` | unset | GitHub App ID (App mode) |
| `GITHUB_APP_PRIVATE_KEY_PATH` | unset | Path to GitHub App private key PEM |
| `OPEN_REVIEW_REPOS` | unset | Comma-separated `owner/repo` allowlist (empty = all) |
| `OPEN_REVIEW_DOMAIN` | unset | Dashboard domain; enables Caddy ACME HTTPS when set |
| `OPEN_REVIEW_PROVIDER` | `claude` | AI provider (`claude` is the only v1 option) |
| `OPEN_REVIEW_MIN_SEVERITY` | `medium` | Minimum finding severity to post (`low`, `medium`, `high`, `critical`) |
| `OPEN_REVIEW_SKIP_DRAFTS` | `true` | Skip draft pull requests |
| `OPEN_REVIEW_SKIP_FORKS` | `true` | Skip pull requests from forks |
| `OPEN_REVIEW_IGNORE_GLOBS` | lockfiles, dist, build | Comma-separated glob list excluded from the diff |

---

## Memory tuning

The service targets a 1-core / 2 GB VPS. Memory is bounded at two layers:

### App-layer caps (inner layer)

These are baked into the application and the systemd unit:

- **Node.js heap cap:** `--max-old-space-size=384` (384 MB; set via
  `NODE_OPTIONS` in the unit)
- **Concurrency cap:** 1 concurrent review (sequential by default)
- **Diff truncation:** diffs larger than 500 KB are truncated before being
  sent to the AI provider

### cgroup caps (outer layer)

The systemd unit sets cgroup memory bounds over the entire process group
(the Node.js host process and all `claude` subprocesses it spawns):

```
MemoryHigh=1200M
MemoryMax=1536M
TasksMax=512
OOMPolicy=continue
```

`MemoryHigh` is a soft limit: the kernel applies memory pressure once usage
exceeds this value, throttling allocation to keep the cgroup below `MemoryMax`.
`MemoryMax` is a hard limit: if a process would push the cgroup over this
ceiling, the kernel OOM-kills the heaviest process in the cgroup (typically
the `claude` subprocess reviewing a large PR).

`OOMPolicy=continue` tells systemd that when the OOM killer fires inside the
cgroup, it should **not** stop the service. The Node.js host process stays
alive, and the job runner records the review as failed in the dashboard
rather than taking down the whole service.

### Adjusting the limits

If a normal review is being starved (the dashboard shows frequent OOM-killed
reviews for typical PR sizes), raise `MemoryHigh` and `MemoryMax` via a
systemd drop-in:

```sh
# Create a drop-in directory
mkdir -p /etc/systemd/system/open-review.service.d

# Write the override
cat > /etc/systemd/system/open-review.service.d/memory.conf <<'EOF'
[Service]
MemoryHigh=1536M
MemoryMax=2048M
EOF

# Apply
systemctl daemon-reload
systemctl restart open-review
```

The starting values (1200M / 1536M) are tuned to a 2 GB box with Caddy and
OS overhead sharing the same RAM budget.

---

## Backups

Two paths on disk must be backed up to survive a full server loss:

| Path | Contents | Why critical |
|------|----------|--------------|
| `/opt/open-review/data/` | SQLite database and WAL files (`open-review.db`, `open-review.db-wal`, `open-review.db-shm`) | Stores review history, settings, and encrypted secrets |
| `/etc/open-review/open-review.env` | Machine key, session secret, webhook secret, and seeded credentials | Losing `OPEN_REVIEW_SECRET_KEY` makes all stored encrypted secrets unrecoverable |

A minimal backup command:

```sh
tar czf open-review-backup-$(date +%Y%m%d).tar.gz \
  /opt/open-review/data/ \
  /etc/open-review/open-review.env
```

Restore: extract to the same paths, set ownership to `open-review:open-review`
on `data/`, set mode `0600` on `open-review.env`, and restart the service.
