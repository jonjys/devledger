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

check "The crate holding key material has no HTTP client"
# DevLedger is local-first but not permanently offline: a connector may reach a
# provider during an explicit Connect, Refresh or Discover. That networking is
# confined to devledger-connect. The crate that derives keys, seals secrets and
# owns the vault must still have no way to open a socket, which is what this
# checks.
core_graph=$(cargo tree -p devledger-core -e normal --prefix none 2>/dev/null | sed 's/ .*//' | sort -u)
if [ -z "$core_graph" ]; then
  bad "could not resolve the devledger-core dependency graph"
fi
for crate in reqwest hyper ureq curl isahc surf tokio-tungstenite awc h2; do
  if printf '%s\n' "$core_graph" | grep -qx "$crate"; then
    bad "$crate is linked into devledger-core"
  else
    ok "$crate absent from devledger-core"
  fi
done

check "Networking is confined to the connector crate"
connect_graph=$(cargo tree -p devledger-connect -e normal --prefix none 2>/dev/null | sed 's/ .*//' | sort -u)
if printf '%s\n' "$connect_graph" | grep -qx reqwest; then
  ok "devledger-connect is the crate that carries the HTTP client"
else
  bad "expected devledger-connect to carry the HTTP client"
fi

check "The connector is read-only and host-allowlisted"
if grep -qE '\.post\(|\.put\(|\.patch\(|\.delete\(' crates/devledger-connect/src/*.rs; then
  bad "the connector issues a non-GET request"
else
  ok "only GET requests are issued"
fi
# Matches check_host and check_host_inner: what matters is that the request
# path runs an allowlist check, not which spelling it uses.
if grep -qE 'check_host(_inner)?\(' crates/devledger-connect/src/supabase.rs; then
  ok "requests are checked against the host allowlist"
else
  bad "the Supabase connector does not check its host allowlist"
fi
# The relaxed-allowlist constructor must refuse anything that is not loopback,
# or it becomes a way to point a credential at an arbitrary host.
if grep -q 'is_loopback(host)' crates/devledger-connect/src/supabase.rs; then
  ok "the test-only client refuses non-loopback bases"
else
  bad "the test-only client does not verify its base is loopback"
fi
if grep -q 'redirect::Policy::none()' crates/devledger-connect/src/lib.rs; then
  ok "redirects are refused, so a bearer token cannot follow one off-host"
else
  bad "redirects are not disabled"
fi

check "No telemetry or analytics endpoint is referenced"
if grep -rniE '(telemetry|analytics|sentry|posthog|mixpanel|amplitude|segment\.io)' \
     --include=*.rs --include=*.ts --include=*.tsx --include=*.json \
     crates apps/desktop/src apps/desktop/src-tauri 2>/dev/null \
     | grep -v 'no telemetry' | grep -q .; then
  bad "something looks like telemetry"
else
  ok "no telemetry"
fi

check "Connector credentials are sealed, never returned to the frontend"
if grep -q 'aead::seal' crates/devledger-core/src/connect_vault.rs; then
  ok "credentials are sealed with the vault AEAD key"
else
  bad "connector credentials are not sealed"
fi
if grep -qE 'fn connection_token' apps/desktop/src-tauri/src/lib.rs; then
  bad "the stored credential is exposed over IPC"
else
  ok "no IPC command returns a stored credential"
fi

check "The app does not claim to be offline now that connectors exist"
# The top-bar label and the capability description are user-facing security
# claims. They said "no network" before Connect & Discover shipped; a stale
# claim is worse than none, so this fails if one comes back.
if grep -rn "no network" apps/desktop/src --include=*.tsx --include=*.ts | grep -q .; then
  bad "the UI still claims 'no network'"
else
  ok "the UI's network claim matches what the app does"
fi
if grep -q "fully offline" apps/desktop/src-tauri/capabilities/default.json; then
  bad "the capability file still claims the app is fully offline"
else
  ok "the capability description is accurate"
fi

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
