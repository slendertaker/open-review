#!/usr/bin/env bash
# enforce-readonly.sh -- Fail-closed default-deny PreToolUse hook.
#
# Allows: Read, Glob, Grep, LS, and a strict read-only Bash allowlist
#         (git diff/log/show/status, rg, grep, ls) restricted to RELATIVE,
#         in-repo paths.
# Denies: Edit, Write, WebFetch, MCP/unknown tools; any Bash with shell
#         metacharacters; and any Bash touching absolute paths, $-expansions,
#         home (~/), or parent-directory traversal (../) -- so a prompt-injected
#         PR cannot read host secrets like /etc/passwd or ~/.aws/credentials and
#         quote them into a public review.
#
# cat/head/tail are intentionally NOT allowlisted: the Read tool already covers
# in-repo file reads, and unconstrained cat/tail are a secret-exfiltration vector.
#
# Wired via config/review-settings.json with a catch-all "*" matcher so EVERY
# tool reaches this default-deny gate. Layer 2 of the two-layer sandbox (D-09).

set -euo pipefail

# Read the full JSON payload from stdin.
INPUT=$(cat)

# Extract tool_name and Bash command (if present).
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')
BASH_CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')

# Emit a permissionDecision JSON response via jq so values are ALWAYS escaped.
allow() {
  jq -cn '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow"}}'
  exit 0
}

deny() {
  local reason="${1:-read-only review mode: tool not in the read-only allowlist}"
  jq -cn --arg r "$reason" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

case "$TOOL_NAME" in
  Read|Glob|Grep|LS)
    allow
    ;;
  Bash)
    # 1. Reject shell metacharacters (chaining, pipes, redirects, substitution,
    #    and any $-expansion that could reference env secrets).
    case "$BASH_CMD" in
      *';'* | *'&'* | *'|'* | *'<'* | *'>'* | *'$'* | *'`'* | *$'\n'*)
        deny "read-only review mode: shell metacharacters are not permitted"
        ;;
    esac
    # 2. Reject path escapes -- absolute paths, home expansion, parent-dir traversal.
    #    Note: bare '~' / '..' are allowed so git ref syntax (HEAD~1, main..feature)
    #    keeps working -- only '~/', ' ~', '../', '/..' and absolute paths are rejected.
    case "$BASH_CMD" in
      /* | *' /'* | *'~/'* | *' ~'* | *'../'* | *'/..'*)
        deny "read-only review mode: only relative in-repo paths are permitted (no absolute/home/parent paths)"
        ;;
    esac
    # 3. Strict read-only verb allowlist.
    if printf '%s' "$BASH_CMD" | grep -qE '^(git (diff|log|show|status)|rg|grep|ls)( |$)'; then
      allow
    else
      deny "read-only review mode: Bash command not in read-only allowlist"
    fi
    ;;
  *)
    # Default-deny: Edit, Write, WebFetch, MCP tools, unknown future tools.
    deny "read-only review mode: this tool is not in the read-only allowlist"
    ;;
esac
