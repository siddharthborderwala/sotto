#!/usr/bin/env bash
# One-line install for Sotto:
#
#   curl -fsSL bldr.sh/sotto | bash
#
# Downloads Sotto into ~/.sotto (or $SOTTO_DIR) and runs its installer. Running it again
# updates an existing copy. Read it first if you like: it only uses git, Homebrew and the
# repository's own scripts/install.sh.
set -euo pipefail

REPO="https://github.com/siddharthborderwala/sotto.git"
DIR="${SOTTO_DIR:-$HOME/.sotto}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "Sotto runs on macOS."
[ "$(uname -m)" = arm64 ] || fail "Sotto needs a Mac with Apple silicon (M1 or later)."
command -v brew >/dev/null || fail "Sotto needs Homebrew. Install it from https://brew.sh, then run this again."
command -v git >/dev/null || brew install git

if [ -d "$DIR/.git" ]; then
  say "Updating Sotto in $DIR"
  git -C "$DIR" pull --ff-only --quiet
else
  [ -e "$DIR" ] && fail "$DIR exists but isn't a Sotto checkout. Move it, or set SOTTO_DIR to another folder."
  say "Downloading Sotto to $DIR"
  git clone --quiet --depth 1 "$REPO" "$DIR"
fi

# Piped through bash, stdin is this script, not the keyboard: hand the installer the terminal
# so it can still ask its one question (clean-up).
if { : </dev/tty; } 2>/dev/null; then
  exec "$DIR/scripts/install.sh" < /dev/tty
else
  exec "$DIR/scripts/install.sh"
fi
