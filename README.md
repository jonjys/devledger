# DevLedger

A local-first ledger for the accounts, projects and credentials a developer
accumulates. Paste a `.env` block, a Supabase URL or a billing page into one
box; DevLedger works out what it is, shows you what it will do, and stores it
encrypted on your own machine.

No cloud. No account. No telemetry. No network calls at all.

## Where the milestones stand

| Milestone | Scope | State |
| --- | --- | --- |
| **M1** | Secure foundation: Argon2id, XChaCha20-Poly1305, zeroizing secret types, redaction and provenance, blind-index duplicate detection | Done — 19 tests |
| **M2** | Deterministic Smart Paste: detectors, JWT claim inspection, subscription parsing, account/project inference, evidence levels | Done — 18 tests |
| **M3** | Current stable Rust, Tauri v2 shell, SQLCipher persistence, unlock/onboarding, desktop shell, review sheet, Project Vault | Done — 22 Rust tests + 26 frontend tests |

85 tests in total: 59 Rust, 26 TypeScript.

## Running it

Prerequisites: a current stable Rust toolchain (`rustup` reads
`rust-toolchain.toml`), Node 20+, and the platform's Tauri prerequisites
(on Windows, the WebView2 runtime, which ships with Windows 11).

```bash
cd apps/desktop
npm install
npm run tauri dev          # development
npm run tauri build        # Windows installers land in src-tauri/target/release/bundle/
```

`npm run tauri build` on Windows produces both an NSIS `.exe` and an MSI in
`apps/desktop/src-tauri/target/release/bundle/`. The CI workflow builds the same
artifacts on every push and attaches them to the run.

## Layout

```
crates/devledger-core/     Security, parsing and persistence. No UI, no network.
apps/desktop/src-tauri/    Tauri v2 shell: IPC commands and capability config.
apps/desktop/src/          React + TypeScript frontend.
scripts/security-check.sh  The invariants CI enforces on every push.
docs/                      Architecture and threat model.
```

## How it behaves

**Smart Paste is deterministic.** The same text always produces the same
analysis. Classification comes from the value itself wherever it can: a JWT's
own `role` claim decides whether something is an anon key or a service_role
key, so a credential filed under a misleading variable name is still identified
correctly. There is no model and no guessing.

**Nothing is written until you say so.** A paste produces a review sheet listing
what was detected, what it matches in your vault, what relations are proposed
and with what evidence, and any warnings. Each row offers Save, Change, Create
new or Skip. Cancelling discards the staged plaintext.

**Secrets stay in Rust.** Secret values are not serializable, so they cannot
cross the IPC boundary by accident. `reveal_secret` is the only command that
returns plaintext to JavaScript and it needs a deliberate click. Copy Secret and
Copy `.env` are rendered in Rust and written straight to the OS clipboard, so
the common flows never put a credential in the frontend at all.

See [`docs/SECURITY.md`](docs/SECURITY.md) for the threat model and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the pieces fit.

## Development

```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
./scripts/security-check.sh

cd apps/desktop
npm run typecheck
npm test
```
