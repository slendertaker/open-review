#!/usr/bin/env bash
# Open Review installer -- idempotent Debian/Ubuntu setup script.
# Usage: curl -fsSL <raw-url> | bash
#        Or: bash install.sh (run as root or via sudo)
#
# Re-running performs an in-place upgrade (git pull + npm ci + build + restart)
# without rotating the machine key or overwriting the existing EnvironmentFile.
set -euo pipefail

# ---------------------------------------------------------------------------
# 0) Preflight
# ---------------------------------------------------------------------------

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: this installer must run as root. Re-run with: sudo bash install.sh" >&2
  exit 1
fi

command -v apt-get >/dev/null 2>&1 || {
  echo "Error: Debian/Ubuntu (apt) is required. Other distributions are not supported." >&2
  exit 1
}

INSTALL_ROOT=/opt/open-review
SVC_USER=open-review
ENV_DIR=/etc/open-review
ENV_FILE="$ENV_DIR/open-review.env"

# Allow overriding the repo URL (e.g. for testing a fork) via environment variable.
REPO_URL="${OPEN_REVIEW_REPO_URL:-https://github.com/slendertaker/open-review.git}"

echo "==> Open Review installer"
echo "    Install root : $INSTALL_ROOT"
echo "    Service user : $SVC_USER"
echo "    Repo URL     : $REPO_URL"
echo ""

# ---------------------------------------------------------------------------
# 1) apt prerequisites for native addons and tooling
# ---------------------------------------------------------------------------

echo "==> Installing apt prerequisites..."
apt-get update -qq
apt-get install -y ca-certificates curl gnupg git build-essential python3 openssl

# ---------------------------------------------------------------------------
# 2) Node 22 via NodeSource (idempotent)
# ---------------------------------------------------------------------------

NODE_MAJOR=""
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v | cut -d. -f1 | tr -d 'v')"
fi

if [ "$NODE_MAJOR" != "22" ]; then
  echo "==> Installing Node.js 22 via NodeSource..."
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  cat > /etc/apt/sources.list.d/nodesource.sources <<'SRC'
Types: deb
URIs: https://deb.nodesource.com/node_22.x/
Suites: nodistro
Components: main
Signed-By: /etc/apt/keyrings/nodesource.gpg
SRC
  apt-get update -qq
  apt-get install -y nodejs
else
  echo "==> Node.js 22 already installed, skipping."
fi

echo "    Node version : $(node -v)"

# ---------------------------------------------------------------------------
# 3) Caddy via apt (idempotent)
# ---------------------------------------------------------------------------

if ! command -v caddy >/dev/null 2>&1; then
  echo "==> Installing Caddy..."
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y caddy
else
  echo "==> Caddy already installed, skipping."
fi

echo "    Caddy version: $(caddy version)"

# ---------------------------------------------------------------------------
# 4) Dedicated system user (idempotent)
# ---------------------------------------------------------------------------

if ! id "$SVC_USER" >/dev/null 2>&1; then
  echo "==> Creating system user '$SVC_USER'..."
  useradd --system --home-dir "$INSTALL_ROOT" --shell /usr/sbin/nologin "$SVC_USER"
else
  echo "==> User '$SVC_USER' already exists, skipping."
fi

# ---------------------------------------------------------------------------
# 5) Clone or update the repository
# ---------------------------------------------------------------------------

if [ -d "$INSTALL_ROOT/.git" ]; then
  echo "==> Updating existing install (upgrade)..."
  sudo -u "$SVC_USER" git -C "$INSTALL_ROOT" pull --ff-only
else
  echo "==> Cloning repository into $INSTALL_ROOT..."
  git clone --depth 1 "$REPO_URL" "$INSTALL_ROOT"
fi

# Ensure ownership before build so the service user can write npm cache, etc.
chown -R "$SVC_USER":"$SVC_USER" "$INSTALL_ROOT"

# Create required data directories owned by the service user.
mkdir -p "$INSTALL_ROOT/data" "$INSTALL_ROOT/.open-review"
chown "$SVC_USER":"$SVC_USER" "$INSTALL_ROOT/data" "$INSTALL_ROOT/.open-review"

# ---------------------------------------------------------------------------
# 6) Build as the service user
# ---------------------------------------------------------------------------

echo "==> Building (npm ci + npm run build) as '$SVC_USER'..."
# Run as the service user so node-gyp artifacts and npm cache are owned correctly.
# npm run build (not bare tsc) is required -- it copies schema.sql into dist/.
sudo -u "$SVC_USER" bash -lc "cd $INSTALL_ROOT && npm ci && npm run build"

# ---------------------------------------------------------------------------
# 7) Generate infra secrets ONLY when the EnvironmentFile is absent
# ---------------------------------------------------------------------------

mkdir -p "$ENV_DIR"
chmod 700 "$ENV_DIR"

# Track whether this is a first install so we can print the webhook secret once.
GENERATED_WEBHOOK_SECRET=""

if [ ! -f "$ENV_FILE" ]; then
  echo "==> Generating infra secrets (first install)..."

  SECRET_KEY="$(openssl rand -hex 32)"
  SESSION_SECRET="$(openssl rand -base64 48)"
  # Accept an operator-supplied webhook secret for unattended installs,
  # or generate one automatically.
  WEBHOOK_SECRET="${OPEN_REVIEW_WEBHOOK_SECRET:-$(openssl rand -hex 32)}"
  GENERATED_WEBHOOK_SECRET="$WEBHOOK_SECRET"

  # Render the EnvironmentFile from the template.
  # Substitute placeholders and append any operator credentials present in
  # the installer's own environment (unattended passthrough).
  sed \
    -e "s|__SECRET_KEY__|$SECRET_KEY|g" \
    -e "s|__SESSION_SECRET__|$SESSION_SECRET|g" \
    -e "s|__WEBHOOK_SECRET__|$WEBHOOK_SECRET|g" \
    "$INSTALL_ROOT/deploy/open-review.env.tmpl" > "$ENV_FILE"

  # Append operator credentials if provided in the installer's environment.
  # Only written when non-empty -- guided mode omits them (entered via dashboard).
  {
    [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]       && echo "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN"   || true
    [ -n "${ANTHROPIC_API_KEY:-}" ]             && echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"               || true
    [ -n "${GITHUB_TOKEN:-}" ]                  && echo "GITHUB_TOKEN=$GITHUB_TOKEN"                         || true
    [ -n "${GITHUB_APP_ID:-}" ]                 && echo "GITHUB_APP_ID=$GITHUB_APP_ID"                       || true
    [ -n "${GITHUB_APP_PRIVATE_KEY_PATH:-}" ]   && echo "GITHUB_APP_PRIVATE_KEY_PATH=$GITHUB_APP_PRIVATE_KEY_PATH" || true
    [ -n "${OPEN_REVIEW_REPOS:-}" ]             && echo "OPEN_REVIEW_REPOS=$OPEN_REVIEW_REPOS"               || true
    [ -n "${OPEN_REVIEW_DOMAIN:-}" ]            && echo "OPEN_REVIEW_DOMAIN=$OPEN_REVIEW_DOMAIN"             || true
    [ -n "${OPEN_REVIEW_PROVIDER:-}" ]          && echo "OPEN_REVIEW_PROVIDER=$OPEN_REVIEW_PROVIDER"         || true
  } >> "$ENV_FILE"

  chmod 600 "$ENV_FILE"
  chown "$SVC_USER":"$SVC_USER" "$ENV_FILE"

else
  echo "==> EnvironmentFile exists -- skipping secret generation (upgrade, secrets preserved)."
fi

# ---------------------------------------------------------------------------
# 8) Render and install the systemd unit and Caddyfile, then enable + start
# ---------------------------------------------------------------------------

echo "==> Installing systemd unit..."
# Substitute the install root placeholder (currently hardcoded; no placeholder
# in the template since /opt/open-review is the fixed install root).
cp "$INSTALL_ROOT/deploy/open-review.service.tmpl" /etc/systemd/system/open-review.service

echo "==> Rendering Caddyfile..."
if [ -n "${OPEN_REVIEW_DOMAIN:-}" ]; then
  # Domain mode: Caddy handles ACME HTTPS automatically.
  cat > /etc/caddy/Caddyfile <<CADDYEOF
${OPEN_REVIEW_DOMAIN} {
    reverse_proxy 127.0.0.1:${OPEN_REVIEW_PORT:-3000}
}
CADDYEOF
else
  # IP-only mode: plain HTTP on port 80.
  cat > /etc/caddy/Caddyfile <<CADDYEOF
:80 {
    reverse_proxy 127.0.0.1:${OPEN_REVIEW_PORT:-3000}
}
CADDYEOF
fi

echo "==> Enabling and starting open-review service..."
systemctl daemon-reload
systemctl enable --now open-review.service

echo "==> Reloading Caddy..."
systemctl reload caddy || systemctl restart caddy

# ---------------------------------------------------------------------------
# 9) Print dashboard URL and instructions
# ---------------------------------------------------------------------------

echo ""
echo "======================================================"
echo " Open Review installed successfully!"
echo "======================================================"
echo ""

# Print the webhook secret once (only on first install) so the operator can
# paste it into the GitHub webhook configuration.
# Never log this into journald -- stdout only.
if [ -n "$GENERATED_WEBHOOK_SECRET" ]; then
  echo "  GitHub webhook secret (save this now -- shown only once):"
  echo "    $GENERATED_WEBHOOK_SECRET"
  echo ""
  echo "  Paste the above value into your GitHub webhook settings"
  echo "  under 'Secret' when configuring the webhook URL."
  echo ""
fi

# Determine and print the dashboard URL.
if [ -n "${OPEN_REVIEW_DOMAIN:-}" ]; then
  DASHBOARD_URL="https://${OPEN_REVIEW_DOMAIN}"
  echo "  Dashboard: $DASHBOARD_URL"
else
  # Attempt to detect the public IP for a helpful hint.
  PUBLIC_IP="$(curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null || echo '<your-vps-ip>')"
  DASHBOARD_URL="http://${PUBLIC_IP}"
  echo "  Dashboard: $DASHBOARD_URL"
  echo ""
  echo "  The first-run setup URL (with one-time token) is in the service journal."
  echo "  Run the following to find it:"
  echo "    journalctl -u open-review -n 50 | grep 'FIRST RUN'"
fi

echo ""
echo "  Check service status:"
echo "    systemctl status open-review"
echo ""
