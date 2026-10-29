#!/usr/bin/env bash
# Install or update Workbench Kanban in an Obsidian vault.
# Run from the vault root (or any folder below it), or pass --vault.
set -euo pipefail

REPO="${WORKBENCH_REPO:-lihuu/obsidian-workbench}"
PLUGIN_ID="workbench"
ASSETS=(main.js manifest.json styles.css)
RUNNER_ASSET=runner.cjs
VERSION=""
VAULT_ARG=""
FORCE=0
NO_RELOAD=0

usage() {
	cat <<'EOF'
Usage: install-workbench.sh [options]

Install or update Workbench Kanban from GitHub Releases.

Options:
  --vault PATH       Obsidian vault root. Default: auto-detect .obsidian
                    from the current directory or its parents.
  --version VERSION  Release tag to install (default: latest release).
  --force            Reinstall even when the same version is installed.
  --no-reload        Don't try to reload the plugin through the obsidian CLI.
  -h, --help         Show this help.

Examples:
  ./install-workbench.sh
  ./install-workbench.sh --version 0.1.1
  ./install-workbench.sh --vault "$HOME/Obsidian/MyVault"
EOF
}

die() {
	printf 'Error: %s\n' "$*" >&2
	exit 1
}

need_command() {
	command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--vault)
			[ "$#" -ge 2 ] || die "--vault requires a path."
			VAULT_ARG="$2"
			shift 2
			;;
		--version)
			[ "$#" -ge 2 ] || die "--version requires a release tag."
			VERSION="${2#v}"
			shift 2
			;;
		--force)
			FORCE=1
			shift
			;;
		--no-reload)
			NO_RELOAD=1
			shift
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			die "Unknown option: $1 (try --help)"
			;;
	esac
done

detect_vault() {
	local start="$1"
	local dir
	dir="$(cd "$start" 2>/dev/null && pwd -P)" || return 1
	while :; do
		if [ -d "$dir/.obsidian" ]; then
			printf '%s\n' "$dir"
			return 0
		fi
		[ "$dir" = "/" ] && break
		dir="$(dirname "$dir")"
	done
	return 1
}

if [ -n "$VAULT_ARG" ]; then
	VAULT="$(cd "$VAULT_ARG" 2>/dev/null && pwd -P)" || die "Vault path does not exist: $VAULT_ARG"
elif [ -n "${OBSIDIAN_VAULT:-}" ]; then
	VAULT="$(cd "$OBSIDIAN_VAULT" 2>/dev/null && pwd -P)" || die "OBSIDIAN_VAULT does not exist: $OBSIDIAN_VAULT"
else
	SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
	VAULT="$(detect_vault "$PWD" || detect_vault "$SCRIPT_DIR" || true)"
fi

[ -n "${VAULT:-}" ] || die "Could not find an Obsidian vault. Run from the vault root or pass --vault PATH."
[ -d "$VAULT/.obsidian" ] || die "Not an Obsidian vault (missing .obsidian): $VAULT"

PLUGIN_DIR="$VAULT/.obsidian/plugins/$PLUGIN_ID"
CURRENT=""
if [ -f "$PLUGIN_DIR/manifest.json" ]; then
	CURRENT="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PLUGIN_DIR/manifest.json" | head -n 1)"
fi

resolve_latest() {
	if command -v gh >/dev/null 2>&1; then
		local tag
		tag="$(GH_PROMPT_DISABLED=1 gh release view --repo "$REPO" --json tagName --template '{{.tagName}}' 2>/dev/null || true)"
		if [ -n "$tag" ]; then
			printf '%s\n' "${tag#v}"
			return 0
		fi
	fi
	command -v curl >/dev/null 2>&1 || return 1
	local body
	body="$(curl -fsSL --retry 3 "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null || true)"
	TAG_FROM_API="$(printf '%s\n' "$body" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
	[ -n "$TAG_FROM_API" ] || return 1
	printf '%s\n' "${TAG_FROM_API#v}"
}

if [ -z "$VERSION" ]; then
	VERSION="$(resolve_latest || true)"
	[ -n "$VERSION" ] || die "Could not resolve the latest release. Pass --version explicitly."
fi

version_gt() {
	[ "$1" != "$2" ] || return 1
	[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]
}

version_ge() {
	[ "$1" = "$2" ] || version_gt "$1" "$2"
}

if [ "$FORCE" -eq 0 ] && [ -n "$CURRENT" ] && version_gt "$CURRENT" "$VERSION"; then
	die "Installed version $CURRENT is newer than release $VERSION. Use --force to downgrade."
fi

if [ "$FORCE" -eq 0 ] && [ -n "$CURRENT" ] && [ "$CURRENT" = "$VERSION" ]; then
	installed=1
	for asset in "${ASSETS[@]}"; do
		[ -s "$PLUGIN_DIR/$asset" ] || installed=0
	done
	if version_ge "$VERSION" "0.1.2" && [ ! -s "$PLUGIN_DIR/$RUNNER_ASSET" ]; then
		installed=0
	fi
	if [ "$installed" -eq 1 ]; then
		printf 'Workbench Kanban %s is already installed in:\n  %s\n' "$VERSION" "$PLUGIN_DIR"
		printf 'Use --force to reinstall it.\n'
		exit 0
	fi
fi

if command -v gh >/dev/null 2>&1; then
	:
elif ! command -v curl >/dev/null 2>&1; then
	die "Install gh or curl to download the release."
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/workbench-install.XXXXXX")"
BACKUP_DIR=""
ROLLBACK_NEEDED=0
cleanup() {
	local status=$?
	if [ "$ROLLBACK_NEEDED" -eq 1 ] && [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
		for asset in "${ASSETS[@]}"; do
			if [ -f "$BACKUP_DIR/$asset" ]; then
				cp "$BACKUP_DIR/$asset" "$PLUGIN_DIR/$asset" 2>/dev/null || true
			else
				rm -f "$PLUGIN_DIR/$asset" 2>/dev/null || true
			fi
		done
		if [ -f "$BACKUP_DIR/$RUNNER_ASSET" ]; then
			cp "$BACKUP_DIR/$RUNNER_ASSET" "$PLUGIN_DIR/$RUNNER_ASSET" 2>/dev/null || true
		else
			rm -f "$PLUGIN_DIR/$RUNNER_ASSET" 2>/dev/null || true
		fi
	fi
	rm -rf "$TMP_DIR"
	exit "$status"
}
trap cleanup EXIT

download_assets() {
	local tag="$1"
	local dest="$2"
	if command -v gh >/dev/null 2>&1; then
		if GH_PROMPT_DISABLED=1 gh release download "$tag" \
			--repo "$REPO" --dir "$dest" --clobber >/dev/null 2>&1; then
			return 0
		fi
	fi
	command -v curl >/dev/null 2>&1 || return 1
	for asset in "${ASSETS[@]}"; do
		curl -fL --retry 3 --connect-timeout 20 \
			-o "$dest/$asset" \
			"https://github.com/$REPO/releases/download/$tag/$asset" \
			|| return 1
	done
	if version_ge "$tag" "0.1.2"; then
		curl -fL --retry 3 --connect-timeout 20 \
			-o "$dest/$RUNNER_ASSET" \
			"https://github.com/$REPO/releases/download/$tag/$RUNNER_ASSET" \
			|| return 1
	fi
}

printf 'Vault:  %s\n' "$VAULT"
printf 'Plugin: %s\n' "$PLUGIN_DIR"
printf 'Current version: %s\n' "${CURRENT:-not installed}"
printf 'Installing: %s\n' "$VERSION"

download_assets "$VERSION" "$TMP_DIR" || die "Could not download release $VERSION from $REPO."

for asset in "${ASSETS[@]}"; do
	[ -s "$TMP_DIR/$asset" ] || die "Downloaded release is missing $asset."
done
if version_ge "$VERSION" "0.1.2"; then
	[ -s "$TMP_DIR/$RUNNER_ASSET" ] || die "Downloaded release is missing $RUNNER_ASSET."
fi

MANIFEST_ID="$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP_DIR/manifest.json" | head -n 1)"
MANIFEST_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP_DIR/manifest.json" | head -n 1)"
[ "$MANIFEST_ID" = "$PLUGIN_ID" ] || die "Unexpected plugin id in manifest: ${MANIFEST_ID:-empty}"
[ "$MANIFEST_VERSION" = "$VERSION" ] || die "Manifest version $MANIFEST_VERSION does not match release $VERSION."

mkdir -p "$PLUGIN_DIR"
BACKUP_DIR="$TMP_DIR/backup"
mkdir -p "$BACKUP_DIR"
for asset in "${ASSETS[@]}"; do
	if [ -f "$PLUGIN_DIR/$asset" ]; then
		cp "$PLUGIN_DIR/$asset" "$BACKUP_DIR/$asset"
	fi
done
if [ -f "$PLUGIN_DIR/$RUNNER_ASSET" ]; then
	cp "$PLUGIN_DIR/$RUNNER_ASSET" "$BACKUP_DIR/$RUNNER_ASSET"
fi
ROLLBACK_NEEDED=1

for asset in "${ASSETS[@]}"; do
	cp "$TMP_DIR/$asset" "$PLUGIN_DIR/$asset"
done
if [ -f "$TMP_DIR/$RUNNER_ASSET" ]; then
	cp "$TMP_DIR/$RUNNER_ASSET" "$PLUGIN_DIR/$RUNNER_ASSET"
fi

ROLLBACK_NEEDED=0
printf 'Installed Workbench Kanban %s.\n' "$VERSION"

if [ "$NO_RELOAD" -eq 0 ] && command -v obsidian >/dev/null 2>&1; then
	if obsidian plugin:reload id="$PLUGIN_ID" >/dev/null 2>&1; then
		printf 'Reloaded the plugin through the obsidian CLI.\n'
	else
		printf 'Could not reload automatically; reload Obsidian or run: obsidian plugin:reload id=%s\n' "$PLUGIN_ID"
	fi
else
	printf 'Reload Obsidian (or run: obsidian plugin:reload id=%s) to pick up the update.\n' "$PLUGIN_ID"
fi
