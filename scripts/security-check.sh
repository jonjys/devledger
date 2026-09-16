#!/usr/bin/env bash
# DevLedger security sanity check.
#
# These are the invariants the MVP's threat model rests on. They are cheap to
# check and expensive to notice by hand in review, so CI runs them on every push.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
note() { printf '  %s\n' "$1"; }
check() { printf '\n== %s\n' "$1"; }
bad() { printf '  FAIL: %s\n' "$1"; fail=1; }
ok() { printf '  ok: %s\n' "$1"; }

check "No HTTP or websocket client is linked into the desktop binary"
# `cargo tree -i` exits 0 even when it finds nothing, and `--target all` pulls in
# dependencies that only exist for mobile targets (tauri declares reqwest for
# Android/iOS only). What matters is the normal dependency graph for the target
# actually being built, so enumerate that and search it.
TARGET="${SECURITY_CHECK_TARGET:-}"
if [ -n "$TARGET" ]; then
  graph=$(cargo tree -p devledger-desktop -e normal --target "$TARGET" --prefix none 2>/dev/null | sed 's/ .*//' | sort -u)
else
  graph=$(cargo tree -p devledger-desktop -e normal --prefix none 2>/dev/null | sed 's/ .*//' | sort -u)
fi
if [ -z "$graph" ]; then
  bad "could not resolve the dependency graph"
fi
for crate in reqwest hyper ureq curl isahc surf tokio-tungstenite awc h2; do
  if printf '%s\n' "$graph" | grep -qx "$crate"; then
    bad "$crate is linked into the desktop build"
  else
    ok "$crate absent"
  fi
done

check "Secret containers cannot be serialized"
if grep -nE '^\s*#\[derive\(.*Serialize' crates/devledger-core/src/secret.rs >/dev/null 2>&1; then
  bad "a Serialize derive appears in secret.rs"
else
  ok "no Serialize derive on SecretString / SecretBytes"
fi

check "Exactly one IPC command returns plaintext"
reveal_count=$(grep -c 'IpcResult<String>' apps/desktop/src-tauri/src/lib.rs)
if [ "$reveal_count" -ne 1 ]; then
  bad "expected 1 command returning String, found $reveal_count"
else
  ok "reveal_secret is the only plaintext-returning command"
fi

check "The capability file grants no filesystem, shell, or network permission"
for forbidden in "fs:" "shell:" "http:" "updater:" "process:"; do
  if grep -q "\"$forbidden" apps/desktop/src-tauri/capabilities/default.json; then
    bad "capability '$forbidden' is granted"
  else
    ok "no '$forbidden' capability"
  fi
done

check "The CSP allows no remote origin"
csp=$(grep -o '"csp": "[^"]*"' apps/desktop/src-tauri/tauri.conf.json)
if printf '%s' "$csp" | grep -qE 'https?://(?!ipc\.localhost)' 2>/dev/null ||
   printf '%s' "$csp" | grep -qE '(\*|https://[a-z]+\.)' ; then
  # ipc.localhost is Tauri's own IPC origin on Windows, not a network endpoint.
  if printf '%s' "$csp" | grep -vq 'http://ipc.localhost'; then
    bad "CSP references a remote origin: $csp"
  else
    ok "CSP only references Tauri's local IPC origin"
  fi
else
  ok "CSP has no remote origins"
fi
if printf '%s' "$csp" | grep -q "unsafe-eval"; then
  bad "CSP allows unsafe-eval"
else
  ok "CSP forbids unsafe-eval"
fi

check "The core crate forbids unsafe code"
if grep -q '^#!\[forbid(unsafe_code)\]' crates/devledger-core/src/lib.rs; then
  ok "forbid(unsafe_code) is in place"
else
  bad "devledger-core does not forbid unsafe code"
fi

printf '\n'
if [ "$fail" -ne 0 ]; then
  printf 'Security check FAILED\n'
  exit 1
fi
printf 'Security check passed\n'
