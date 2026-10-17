#!/usr/bin/env bash
# Apply (or check, or revert) the two dsh core patches dsh-claude-code-provider needs.
# A file is only ever replaced when it is byte-identical to the known original
# (or already patched); anything else is left alone and reported.
#
#   scripts/apply-patches.sh [--check | --revert] [DSH_PACKAGE_DIR]
#
# DSH_PACKAGE_DIR is the installed @deepseek-ai/dsh package. Without it, the
# script follows the `dsh` on PATH, then looks in the npx cache.
set -euo pipefail

DSH_VERSION=0.2.0-rc.1
PATCHES="$(cd "$(dirname "$0")/../patches" && pwd)"
PACKAGES=(dsh-agent-loop dsh-compaction-basic)

mode=apply
case "${1:-}" in
	--check) mode=check; shift ;;
	--revert) mode=revert; shift ;;
	-h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

is_dsh() { [ -f "$1/package.json" ] && [ "$(node -p "require('$1/package.json').name" 2>/dev/null)" = "@deepseek-ai/dsh" ]; }

dsh_pkg="${1:-}"
if [ -z "$dsh_pkg" ] && command -v dsh >/dev/null 2>&1; then
	candidate="$(dirname "$(dirname "$(readlink -f "$(command -v dsh)")")")"
	is_dsh "$candidate" && dsh_pkg="$candidate"
fi
if [ -z "$dsh_pkg" ]; then
	found="$(grep -l "\"version\": \"$DSH_VERSION\"" "$HOME"/.npm/_npx/*/node_modules/@deepseek-ai/dsh/package.json 2>/dev/null | head -1 || true)"
	[ -n "$found" ] && dsh_pkg="$(dirname "$found")"
fi
if [ -z "$dsh_pkg" ] || ! is_dsh "$dsh_pkg"; then
	echo "ERROR: @deepseek-ai/dsh not found; pass its package directory" >&2
	exit 1
fi

version="$(node -p "require('$dsh_pkg/package.json').version")"
echo "dsh $version at $dsh_pkg"
if [ "$version" != "$DSH_VERSION" ]; then
	echo "ERROR: these patches are for dsh $DSH_VERSION, not $version" >&2
	exit 1
fi

# Check every file before changing any, so a run never leaves dsh half patched.
declare -A file state
for pkg in "${PACKAGES[@]}"; do
	file[$pkg]="$(dirname "$(node -p "require.resolve('@deepseek-ai/$pkg/package.json', { paths: ['$dsh_pkg'] })")")/lib/index.js"
	if cmp -s "${file[$pkg]}" "$PATCHES/$pkg-$DSH_VERSION-index.patched.js"; then state[$pkg]=patched
	elif cmp -s "${file[$pkg]}" "$PATCHES/$pkg-$DSH_VERSION-index.orig.js"; then state[$pkg]=original
	else
		echo "ERROR: $pkg: ${file[$pkg]} matches neither the original nor the patch; nothing changed" >&2
		exit 1
	fi
	if [ "$mode" != check ] && [ ! -w "${file[$pkg]}" ]; then
		echo "ERROR: $pkg: ${file[$pkg]} is not writable; run this as the file's owner (e.g. with sudo); nothing changed" >&2
		exit 1
	fi
done

changed=0
for pkg in "${PACKAGES[@]}"; do
	case "$mode:${state[$pkg]}" in
		check:*) echo "$pkg: ${state[$pkg]}" ;;
		apply:patched|revert:original) echo "$pkg: already ${state[$pkg]}" ;;
		apply:original) cp "$PATCHES/$pkg-$DSH_VERSION-index.patched.js" "${file[$pkg]}"; echo "$pkg: patched"; changed=1 ;;
		revert:patched) cp "$PATCHES/$pkg-$DSH_VERSION-index.orig.js" "${file[$pkg]}"; echo "$pkg: reverted"; changed=1 ;;
	esac
done
[ $changed -eq 1 ] && echo "restart dsh for this to take effect"
exit 0
