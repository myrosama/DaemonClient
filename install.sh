#!/usr/bin/env bash
#
# DaemonClient — bootstrap.
#
#   curl -fsSL https://raw.githubusercontent.com/myrosama/DaemonClient/main/install.sh | sh
#
# This is the first thing a stranger runs, piped into a shell, on a machine we
# know nothing about. It has one job: get a working Node and the project source
# onto this machine, then hand over to the installer.
#
# It is fetched from GitHub rather than from daemonclient.uz on purpose. A
# script we host is a host of ours in the install path, and it is precisely the
# file an attacker would want to change. Here it sits in public source, at the
# same host you already have to trust to get the code at all.
#
# Rules this script holds itself to, because you are piping it into a shell:
#
#   * No sudo. Ever. Nothing is installed system-wide. If something cannot be
#     done without root, it prints the command and stops.
#   * Downloads are verified against the publisher's checksums, not trusted
#     because they arrived over TLS.
#   * Pinned to a release tag, never a moving branch, so two people running
#     this on the same day get the same bytes.
#   * Everything lands in ~/.daemonclient. Uninstall is one rm -rf.
#   * Short enough to read before you run it. That is the deal.
#
# Read it first if you like:
#   curl -fsSL https://raw.githubusercontent.com/myrosama/DaemonClient/main/install.sh | less

set -euo pipefail

REPO="${DC_REPO:-myrosama/DaemonClient}"
HOME_DIR="${DC_HOME:-$HOME/.daemonclient}"
SRC_DIR="$HOME_DIR/src"
NODE_DIR="$HOME_DIR/node"
MIN_NODE=18

# ── output ───────────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Z=$'\033[0m'
else
  B=''; DIM=''; R=''; G=''; Z=''
fi
say()  { printf '%s\n' "$*"; }
step() { printf '%s→%s %s\n' "$B" "$Z" "$*"; }
ok()   { printf '%s✓%s %s\n' "$G" "$Z" "$*"; }
die()  { printf '\n%s✗%s %s\n' "$R" "$Z" "$1" >&2; shift; for l in "$@"; do printf '  %s%s%s\n' "$DIM" "$l" "$Z" >&2; done; exit 1; }

# ── P1 · platform and prerequisites ──────────────────────────────────────────

# Map uname output to the Node distribution's naming. Anything else stops here
# rather than half-working — a wrong tarball fails later and less clearly.
detect_platform() {
  local os="${1:-$(uname -s)}" arch="${2:-$(uname -m)}" o a
  case "$os" in
    Linux)  o=linux ;;
    Darwin) o=darwin ;;
    *) die "DaemonClient's installer does not support $os." \
           "It runs on Linux and macOS. On Windows, use WSL." ;;
  esac
  case "$arch" in
    x86_64|amd64)  a=x64 ;;
    aarch64|arm64) a=arm64 ;;
    *) die "Unsupported CPU architecture: $arch (on $os)." \
           "Supported: x86_64 and arm64." ;;
  esac
  printf '%s-%s\n' "$o" "$a"
}

require_cmd() {
  local cmd="$1" hint="${2:-}"
  command -v "$cmd" >/dev/null 2>&1 && return 0
  die "\`$cmd\` is required and was not found." \
      "${hint:-Install it with your package manager, then run this again.}"
}

# ── P2 · Node, without touching the system ───────────────────────────────────

# True when the given `node --version` string is new enough.
node_ok() {
  local v="${1:-}"
  v="${v#v}"
  case "$v" in
    ''|*[!0-9.]*[!0-9.]*) ;;   # obvious junk falls through to the digit test
  esac
  local major="${v%%.*}"
  case "$major" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$major" -ge "$MIN_NODE" ]
}

# The reason fetching a runtime is acceptable at all: we check what we got.
verify_checksum() {
  local file="$1" sums="$2" want got
  want="$(awk -v f="$(basename "$file")" '$2 == f || $2 == "./"f { print $1 }' "$sums" | head -n1)"
  [ -n "$want" ] || { say "no checksum published for $(basename "$file")" >&2; return 1; }

  if command -v sha256sum >/dev/null 2>&1; then
    got="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    got="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    say "no sha256 tool available to verify the download" >&2; return 1
  fi

  [ "$want" = "$got" ] || {
    say "checksum mismatch for $(basename "$file")" >&2
    say "  expected $want" >&2
    say "  got      $got" >&2
    return 1
  }
}

ensure_node() {
  local platform="$1"
  if command -v node >/dev/null 2>&1 && node_ok "$(node --version 2>/dev/null || echo '')"; then
    ok "Node $(node --version) — using the one already installed"
    return 0
  fi
  if [ -x "$NODE_DIR/bin/node" ] && node_ok "$("$NODE_DIR/bin/node" --version)"; then
    PATH="$NODE_DIR/bin:$PATH"; export PATH
    ok "Node $(node --version) — from a previous run of this script"
    return 0
  fi

  step "Node $MIN_NODE+ not found — fetching a private copy (no sudo, nothing system-wide)"
  local lts tarball url tmp
  lts="$(curl -fsSL https://nodejs.org/dist/index.json \
        | tr '{' '\n' | grep '"lts":"[A-Z]' | head -n1 \
        | sed -n 's/.*"version":"\(v[0-9.]*\)".*/\1/p')"
  [ -n "$lts" ] || die "Could not work out the current Node LTS version." \
                       "Install Node $MIN_NODE+ from https://nodejs.org and run this again."

  tarball="node-$lts-$platform.tar.xz"
  url="https://nodejs.org/dist/$lts"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  step "Downloading $tarball"
  curl -fsSL -o "$tmp/$tarball" "$url/$tarball" || die "Could not download Node from $url/$tarball."
  curl -fsSL -o "$tmp/SHASUMS256.txt" "$url/SHASUMS256.txt" || die "Could not download Node's checksums."

  verify_checksum "$tmp/$tarball" "$tmp/SHASUMS256.txt" \
    || die "The Node download did not match its published checksum. Nothing was installed." \
           "This is what that check is for. Try again; if it keeps happening, say so in an issue."
  ok "Checksum verified"

  mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/$tarball" -C "$NODE_DIR" --strip-components=1
  PATH="$NODE_DIR/bin:$PATH"; export PATH
  ok "Node $(node --version) installed to $NODE_DIR"
}

# ── P3 · the source, pinned to a release ─────────────────────────────────────

latest_release_tag() {
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1
}

fetch_source() {
  local tag
  tag="$(latest_release_tag || true)"

  # No fallback to main, deliberately. A moving branch means two people running
  # the same command on the same day get different code, and a bad commit
  # reaches everyone instantly. Better to stop and say why.
  [ -n "$tag" ] || die "This project has published no releases yet, so there is nothing stable to install." \
                       "Watch https://github.com/$REPO/releases — the first release is coming." \
                       "To try the development version anyway:" \
                       "  git clone https://github.com/$REPO && cd DaemonClient/selfhost && npm ci"

  if [ -d "$SRC_DIR/.git" ]; then
    step "Updating the existing checkout to $tag"
    git -C "$SRC_DIR" fetch --depth 1 origin "refs/tags/$tag:refs/tags/$tag" --force
    git -C "$SRC_DIR" checkout -q --force "$tag"
  else
    step "Fetching $tag"
    mkdir -p "$HOME_DIR"
    git clone --depth 1 --branch "$tag" "https://github.com/$REPO.git" "$SRC_DIR"
  fi
  ok "Source at $tag"
}

# ── P4 · hand over ───────────────────────────────────────────────────────────

hand_over() {
  step "Installing the installer's dependencies"
  ( cd "$SRC_DIR/selfhost" && npm ci --no-audit --no-fund --loglevel=error )
  ok "Ready"
  say ""
  exec node "$SRC_DIR/selfhost/bin/daemonclient.mjs" setup
}

main() {
  say ""
  say "${B}DaemonClient${Z} — setting up your own private cloud"
  say "${DIM}Nothing is installed system-wide. Everything lives in $HOME_DIR.${Z}"
  say "${DIM}To remove it all later: rm -rf $HOME_DIR${Z}"
  say ""

  local platform
  platform="$(detect_platform)"
  ok "Platform: $platform"

  require_cmd curl
  require_cmd tar
  require_cmd git "Install git with your package manager (apt install git, brew install git), then run this again."
  ok "Prerequisites present"

  ensure_node "$platform"
  fetch_source
  hand_over
}

# Only run when executed, not when sourced — so the test suite can exercise the
# functions above one at a time.
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  main "$@"
fi
