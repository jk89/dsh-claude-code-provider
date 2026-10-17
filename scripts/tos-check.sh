#!/usr/bin/env bash
# ToS guard: the shipped plugin must not touch Claude credentials, call Anthropic
# endpoints itself, or ship/launch a bundled Claude Code CLI. Exits non-zero on a hit.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
check() { # pattern description
	if grep -rniE "$1" src lib cordis.patch.yml 2>/dev/null; then echo "FAIL: $2"; fail=1; else echo "ok: $2"; fi
}
check '\.credentials|credentials\.json|keychain|security find-generic-password' 'no Claude credential files or keychain access'
check 'api\.anthropic\.com|claude\.ai/|console\.anthropic|oauth|/v1/messages|api/oauth' 'no direct Anthropic endpoints or OAuth'
check 'CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN *[:=] *["'"'"'`]|process\.env\.ANTHROPIC_API_KEY[^ ]* *[!=]=|readFile[^)]*\.claude' 'no reading token values or ~/.claude files'
check 'claude-agent-sdk-(linux|darwin|win32)|extractFromBunfs|@anthropic-ai/claude-agent-sdk/extract' 'no bundled CLI payload'
if ! grep -q 'pathToClaudeCodeExecutable: spec.executable' src/session.ts \
	|| ! grep -q 'pathToClaudeCodeExecutable: this.config.claudePath' src/runtime.ts \
	|| ! grep -q 'pathToClaudeCodeExecutable: this.runtime.config.claudePath' src/adapter.ts; then
	echo "FAIL: every query must launch the installed binary"; fail=1
else
	echo "ok: every query() launches the installed claude binary"
fi
echo "query() call sites (each must pass pathToClaudeCodeExecutable):"
grep -n "query)(\|query(" src/*.ts | grep -v "^src/.*:\s*\*\|import" 
exit $fail
