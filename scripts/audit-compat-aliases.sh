#!/usr/bin/env bash
# Phase 8 D-01: audit for retired OpenCode compat-alias token names in views/.
# Exits 0 (PASS) only when zero alias usages remain; nonzero (FAIL) otherwise.
set -euo pipefail
cd "$(dirname "$0")/.."
PATTERN='color-mute|color-body|color-ash|color-hairline|color-ink|color-canvas|color-charcoal|color-surface-soft|color-surface-card|color-surface-dark|spacing-xxs|spacing-xs|spacing-sm|spacing-md|spacing-lg|spacing-xl|spacing-xxl|spacing-section|rounded-sm'
COUNT=$(grep -rnE "$PATTERN" views/ | wc -l | tr -d ' ' || true)
if [ "$COUNT" = "0" ]; then
  echo "PASS: 0 compat-alias usages in views/"
  exit 0
else
  echo "FAIL: $COUNT compat-alias usages remain in views/"
  grep -rnE "$PATTERN" views/
  exit 1
fi
