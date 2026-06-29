# Security

This document describes the security posture of Open Review: the trust model,
the read-only review guarantee, service hardening, secret storage, TLS, and
how to report a security issue.

---

## Trust posture

Open Review is a self-hosted, single-operator service. One person (the
operator) installs it on their own VPS and uses it to review their own
repositories or those of their team. There is no multi-tenant architecture and
no shared infrastructure.

The dashboard stores sensitive material (API keys, GitHub tokens, the webhook
secret) and may be reachable on a public IP. It is protected by:

- A password login (argon2id hashed, stored in SQLite)
- HTTPS via Caddy with automatic ACME certificate issuance when a domain is
  set
- A one-time setup token for first-run access before a password is established

The threat model is personal-use / small-team: hardening is applied
proportionally, not gold-plated for a multi-tenant SaaS scenario.

---

## Read-only review guarantee

The review subprocess runs strictly read-only. Two independent enforcement
layers are active for every review:

1. **Tool scoping:** the `claude` subprocess is invoked with
   `--allowedTools "Read,Glob,Grep,Bash(git *)"` so it can only call read-only
   tools. Write, Edit, and arbitrary Bash are not available.

2. **Pre-tool hook:** a `enforce-readonly.sh` hook is wired via an explicit
   settings file passed to the subprocess. The hook applies a default-deny
   policy: any tool call that is not on the read-only list is blocked before
   it executes, regardless of the `--allowedTools` flag.

The subprocess environment carries only the credentials needed for the review
(the AI provider auth token). It does not inherit the host's full environment,
and in particular does not see the dashboard password, the machine key, the
session secret, or the GitHub posting token.

This guarantee is not loosened by the deployment layer. The systemd unit's
`ProtectSystem=strict` and `PrivateTmp=true` provide OS-level reinforcement,
but the two-layer tool enforcement is the primary boundary.

---

## Service hardening

The systemd unit (`open-review.service`) applies the following hardening
directives:

| Directive | Value | Effect |
|-----------|-------|--------|
| `User` / `Group` | `open-review` | Service runs as a dedicated non-root system user |
| `NoNewPrivileges` | `true` | The process and all subprocesses cannot gain new privileges via `setuid`/`setgid` or capabilities |
| `ProtectSystem` | `strict` | The entire filesystem is read-only except for paths explicitly listed in `ReadWritePaths` |
| `ProtectHome` | `true` | Home directories (`/home`, `/root`, `/run/user`) are inaccessible to the service |
| `PrivateTmp` | `true` | The service gets a private, isolated `/tmp` and `/var/tmp`; other services' temp files are not visible |
| `ReadWritePaths` | `/opt/open-review/data /opt/open-review/.open-review` | The only writable paths: the SQLite data directory and the bare-clone repo cache |
| `KillMode` | `control-group` | On stop or restart, `SIGTERM` is sent to the entire cgroup, including all `claude` subprocesses |

The service user (`open-review`) has no login shell (`/usr/sbin/nologin`) and
owns only the install root and its data directory.

---

## Secret storage

Secrets are protected at rest in two ways:

### Environment file

`/etc/open-review/open-review.env` is owned by `open-review:open-review` and
has mode `0600`. It is readable only by the service user and root. It contains
the machine key (`OPEN_REVIEW_SECRET_KEY`), the session secret, and the webhook
secret.

### Encrypted SQLite store

Operator credentials (API keys, GitHub tokens) entered through the dashboard
are encrypted with AES-256-GCM before being written to SQLite. The record
format is `ivHex:tagHex:ciphertextBase64`. The encryption key is the machine
key from the environment file.

The dashboard never returns a full credential value in any response. All stored
secrets are masked to four bullet characters plus the last four characters of
the value before being sent to the browser.

Consequence: losing `/etc/open-review/open-review.env` (specifically
`OPEN_REVIEW_SECRET_KEY`) makes all credentials stored in SQLite unrecoverable.
Back up both paths (see [OPERATIONS.md](OPERATIONS.md#backups)).

---

## TLS

When a domain is set in the dashboard, Caddy obtains and renews a TLS
certificate automatically via ACME (Let's Encrypt / ZeroSSL). No manual
certificate management is required.

The application binds `127.0.0.1` only and is never exposed directly to the
network. All external traffic passes through Caddy, which terminates TLS
before forwarding to the app.

The Caddy admin API is available at `localhost:2019` only. It is not exposed
externally and does not require authentication from the local process. The
application uses this API to reload Caddy when the domain setting changes.

When no domain is set, the dashboard is available over plain HTTP on port 80
via the server IP. In this mode, the first-run setup token and the password
login are the only access controls. Adding a domain and enabling HTTPS is
strongly recommended before entering API keys or GitHub tokens.

---

## Reporting a security issue

To report a security vulnerability, open an issue on the project repository at
`https://github.com/slendertaker/open-review/issues` and mark it with the
`security` label. For sensitive issues that should not be disclosed publicly,
contact the maintainer directly via the GitHub profile linked from the
repository.

Please include a description of the vulnerability, steps to reproduce it, and
the potential impact. Responsible disclosure is appreciated.
