#!/usr/bin/env bash
# Phase 8 D-01: confirm the compat-alias declarations are removed from dashboard.css.
# Exits 0 (PASS) only when zero alias declarations remain; nonzero (FAIL) otherwise.
set -euo pipefail
cd "$(dirname "$0")/.."
PATTERN='--color-ink|--color-ink-deep|--color-charcoal|--color-body|--color-mute|--color-ash|--color-hairline|--color-hairline-strong|--color-canvas|--color-surface-soft|--color-surface-card|--color-surface-dark|--spacing-xxs|--spacing-xs|--spacing-sm|--spacing-md|--spacing-lg|--spacing-xl|--spacing-xxl|--spacing-section|--rounded-sm'
COUNT=$(grep -cE -- "$PATTERN" public/styles/dashboard.css || true)
if [ "$COUNT" = "0" ]; then
  echo "PASS: 0 compat-alias declarations in dashboard.css"
  exit 0
else
  echo "FAIL: $COUNT compat-alias declarations remain in dashboard.css"
  grep -nE -- "$PATTERN" public/styles/dashboard.css
  exit 1
fi
