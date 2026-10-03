#!/usr/bin/env bash
# Prove that security-check.sh fails when it should.
#
# A guard that never goes red is indistinguishable from one that checks the
# wrong file. Each case below plants one violation in a throwaway copy of the
# repository and asserts that security-check.sh rejects it; the unmodified copy
# must pass. The working tree is never touched.
set -uo pipefail
cd "$(dirname "$0")/.."
root=$(pwd)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# Tracked files plus new, not yet committed ones -- what the next commit would hold.
git ls-files --cached --others --exclude-standard -z \
  | grep -zv '^apps/desktop/node_modules/' \
  | (cd "$root" && xargs -0 cp --parents -t "$work" 2>/dev/null)

pristine=$(mktemp -d)
trap 'rm -rf "$work" "$pristine"' EXIT
cp -a "$work/." "$pristine/"

failures=0
run() { (cd "$work" && bash scripts/security-check.sh >"$work/.out" 2>&1); }
reset() { rm -rf "$work" && mkdir -p "$work" && cp -a "$pristine/." "$work/"; }

expect_pass() {
  if run; then echo "  ok: $1 passes"; else echo "  FAIL: $1 should pass"; sed 's/^/    /' "$work/.out" | grep -E 'FAIL' ; failures=1; fi
}
expect_fail() {
  local name=$1 needle=$2
  if run; then
    echo "  FAIL: '$name' was not caught"; failures=1
  elif grep -q -- "$needle" "$work/.out"; then
    echo "  ok: '$name' is caught"
  else
    echo "  FAIL: '$name' failed, but not with \"$needle\""; sed 's/^/    /' "$work/.out" | grep FAIL; failures=1
  fi
  reset
}

ipc="$work/apps/desktop/src-tauri/src"
echo "== baseline"
expect_pass "the repository as it is"

echo "== the IPC layer"
cat >>"$ipc/ipc/manual.rs" <<'RS'
#[tauri::command]
pub fn leak_value(state: State<'_, AppState>, secret_id: Uuid) -> IpcResult<String> {
    unimplemented!("{state:?}{secret_id}")
}
RS
expect_fail "a second plaintext-returning command, in a module" "expected 1 command returning String, found 2"

cat >>"$ipc/ipc/vault.rs" <<'RS'
pub fn spelled_out() -> Result<String, IpcError> { unimplemented!() }
RS
expect_fail "a plaintext return spelled Result<String, IpcError>" "expected 1 command returning String, found 2"

sed -i 's/-> IpcResult<String> {/-> IpcResult<()> {/' "$ipc/ipc/secrets.rs"
cat >>"$ipc/ipc/manual.rs" <<'RS'
pub fn not_reveal() -> IpcResult<String> { unimplemented!() }
RS
expect_fail "the plaintext command is not reveal_secret" "is not reveal_secret"

mkdir -p "$ipc/ipc/extra"
echo 'pub fn connection_token() -> String { String::new() }' >"$ipc/ipc/extra/mod.rs"
expect_fail "connection_token in a nested IPC module" "the stored credential is exposed over IPC"

echo 'fn direct() { let _ = devledger_connect::supabase::verify("t"); }' >>"$ipc/ipc/connectors.rs"
expect_fail "a direct provider call from IPC" "calls a provider client directly"

echo 'use devledger_connect::supabase;' >>"$ipc/ipc/connectors.rs"
expect_fail "importing a provider module into IPC" "calls a provider client directly"

echo "== the connector crate"
mkdir -p "$work/crates/devledger-connect/src/github"
echo 'fn w(c: reqwest::Client) { let _ = c.post("https://x"); }' >"$work/crates/devledger-connect/src/github/mod.rs"
expect_fail "a non-GET request in a nested connector module" "the connector issues a non-GET request"

echo
if [ "$failures" -ne 0 ]; then echo "Self-test FAILED"; exit 1; fi
echo "Self-test passed: every planted violation was caught"
