# Open Review

A self-hosted, open-source bot that automatically reviews GitHub pull requests
using top-tier coding agents. It listens for PR events, runs a coding agent
headlessly inside a sandboxed read-only checkout to gather real cross-file
context, and posts severity-labeled inline comments plus a summary back on the
PR. Everything is configured and monitored from a built-in web dashboard, and
the whole service installs on a tiny 1-core / 2 GB VPS with a single command.

Claude Code is the review engine. OpenAI Codex drops in behind the same
provider interface without touching the webhook, queue, or posting layers. Open
Review is for individual developers and small teams who want CodeRabbit-grade
review at near-zero marginal cost on their own infrastructure.

---

## Requirements

- A 1-core / 2 GB Debian or Ubuntu VPS (the target operating envelope)
- A GitHub account -- App mode is primary (bot identity, per-installation
  tokens); a Personal Access Token is the single-repo fallback
- An Anthropic credential: a Claude OAuth token
  (`CLAUDE_CODE_OAUTH_TOKEN`) or an API key (`ANTHROPIC_API_KEY`)

---

## Install

Run the installer as root on your VPS:

```sh
curl -fsSL https://raw.githubusercontent.com/slendertaker/open-review/main/install.sh | sudo bash
```

The installer is idempotent. Re-running it upgrades the service in place
(git pull, rebuild, restart) without rotating the machine key or overwriting
existing secrets.

The installer provisions:

- Node.js 22 via NodeSource
- Caddy (automatic HTTPS reverse proxy)
- The `open-review` system user
- The application at `/opt/open-review`
- The systemd unit `open-review.service` (enabled and started)
- Infra secrets at `/etc/open-review/open-review.env` (mode 0600, owned by
  `open-review`)

On completion the installer prints the dashboard URL. If no domain was
supplied, it also prints the first-run setup URL with a one-time token
(see "Guided setup" below).

---

## Unattended vs guided setup

### Unattended

Export credentials before running the installer. The installer writes them
into the environment file and the service picks them up on first start.

```sh
export OPEN_REVIEW_WEBHOOK_SECRET="<your-webhook-secret>"
export CLAUDE_CODE_OAUTH_TOKEN="<your-claude-token>"
# -- or -- export ANTHROPIC_API_KEY="sk-ant-..."
export GITHUB_APP_ID="<app-id>"
export GITHUB_APP_PRIVATE_KEY_PATH="/path/to/private.pem"
# PAT fallback: export GITHUB_TOKEN="ghp_..."
export OPEN_REVIEW_REPOS="owner/repo1,owner/repo2"   # empty = all installed repos
export OPEN_REVIEW_DOMAIN="review.example.com"        # omit for IP-only HTTP mode

curl -fsSL https://raw.githubusercontent.com/slendertaker/open-review/main/install.sh | sudo bash
```

Accepted credential variables (all optional for unattended passthrough):

| Variable | Purpose |
|----------|---------|
| `OPEN_REVIEW_WEBHOOK_SECRET` | HMAC secret for GitHub webhook -- auto-generated if absent |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude subscription OAuth token (primary auth) |
| `ANTHROPIC_API_KEY` | Anthropic API key (secondary auth) |
| `GITHUB_TOKEN` | GitHub Personal Access Token (PAT mode) |
| `GITHUB_APP_ID` | GitHub App ID (App mode) |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Path to the GitHub App private key PEM file |
| `OPEN_REVIEW_REPOS` | Comma-separated list of `owner/repo` pairs to review |
| `OPEN_REVIEW_DOMAIN` | Dashboard domain (enables HTTPS via Caddy ACME) |
| `OPEN_REVIEW_PROVIDER` | AI provider: `claude` (default) |

### Guided setup

Run the installer with no credentials. The installer generates infra secrets
automatically, prints the GitHub webhook secret once (save it -- it is only
shown once), and prints a first-run URL:

```
http://<your-vps-ip>/setup?token=<SETUP_TOKEN>
```

Open that URL in your browser to set the dashboard password and enter your
credentials. The dashboard is the single secret-entry surface; there is no
interactive CLI prompt.

You can also find the setup URL in the service journal after install:

```sh
journalctl -u open-review -n 50 | grep 'FIRST RUN'
```

### GitHub App setup

App mode gives Open Review a bot identity and per-installation tokens. To
create a GitHub App:

1. Go to GitHub Settings > Developer settings > GitHub Apps > New GitHub App
2. Set the webhook URL to `https://<your-domain>/webhook` (or
   `http://<vps-ip>/webhook` for IP mode)
3. Paste the webhook secret from the installer output
4. Grant permissions: Pull requests (read/write), Contents (read)
5. Subscribe to the `pull_request` event
6. Generate and download a private key
7. Install the App on the target repositories
8. Supply `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` (unattended) or
   enter them in the dashboard (guided)

---

## Configuration

After first boot the dashboard owns all settings and secrets. Changes apply
on the next review without a restart. The environment file at
`/etc/open-review/open-review.env` is only written on first install; all
subsequent configuration is stored in the dashboard and read at job-start
time.

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for the full configuration
reference, including all accepted environment variable names and defaults.

---

## TLS / domain

Set a domain in the dashboard Access section to enable automatic HTTPS via
Caddy. Caddy handles ACME certificate issuance and renewal with no extra
configuration.

With no domain set, the dashboard is reachable over HTTP on the server IP.
The app binds `127.0.0.1` only and is never exposed directly; Caddy proxies
all traffic.

---

## Operations

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for service control commands,
the upgrade procedure, the configuration reference, memory tuning, and backup
guidance.

---

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for the read-only review guarantee,
service hardening details, secret storage, and TLS posture.

---

## License

MIT. See [LICENSE](LICENSE).
