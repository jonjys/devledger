# DevLedger

A local-first ledger for the accounts, projects and credentials a developer
accumulates. Paste a `.env` block, a Supabase URL or a billing page into one
box; DevLedger works out what it is, shows you what it will do, and stores it
encrypted on your own machine.

No cloud. No account. No telemetry. The only time DevLedger touches the network
is when you explicitly connect or refresh a provider account, and even then it
only ever reads.

## Where the milestones stand

| Milestone | Scope | State |
| --- | --- | --- |
| **M1** | Secure foundation: Argon2id, XChaCha20-Poly1305, zeroizing secret types, redaction and provenance, blind-index duplicate detection | Done — 19 tests |
| **M2** | Deterministic Smart Paste: detectors, JWT claim inspection, subscription parsing, account/project inference, evidence levels | Done — 18 tests |
| **M3** | Current stable Rust, Tauri v2 shell, SQLCipher persistence, unlock/onboarding, desktop shell, review sheet, Project Vault | Done — 22 Rust tests + 26 frontend tests |
| **M4** | Multi-account separation, shared resources, project links, subscriptions and attention queue | Done |
| **M5** | Read-only Supabase connector with explicit review before import | Done |
| **M6** | Visual stack, manual quick-add flow and 20-service catalog | Done |
| **Launch** | Overview dashboard, Indie/Dev display, skill-tree editing, secrets and attention views, installer release workflow | Done |

143 Rust tests and 89 TypeScript tests, plus a screenshot-based UI smoke test.

The launch build keeps the 0.6 ledger (encrypted vault, Smart Paste, Supabase connect, visual stack) and adds the shell it ships with: a sidebar, an Overview home screen, Indie versus Dev labels, and by-hand create, move and delete for accounts, resources and subscriptions.

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
crates/devledger-connect/  Connectors. The only crate that opens a socket.
apps/desktop/src-tauri/    Tauri v2 shell: IPC commands and capability config.
apps/desktop/src/          React + TypeScript frontend.
scripts/security-check.sh  The invariants CI enforces on every push.
docs/                      Architecture, threat model and decision records.
```

## How it behaves

**It maps what you have actually got.** A developer accumulates several provider
accounts under different emails, each with its own organizations and projects.
DevLedger models that properly: an identity holds accounts, accounts contain
organizations, organizations contain provider resources, and your *own* projects
sit alongside, linked to the resources they use. One project can draw on a
Supabase project, a Vercel project and a Stripe account at once; one Supabase
project can serve two of your projects.

**Smart Paste is deterministic.** The same text always produces the same
analysis. Classification comes from the value itself wherever it can: a JWT's
own `role` claim decides whether something is an anon key or a service_role
key, so a credential filed under a misleading variable name is still identified
correctly. There is no model and no guessing.

**Two ways in.** Paste something and DevLedger works out what it is, or connect
a provider account and DevLedger reads its structure directly. Connecting is
read-only, happens only when you press a button, and nothing reaches your map
until you review what was found. Several accounts with the same provider stay
separate — connecting a second Supabase account never overwrites the first.

**It asks rather than assuming.** Paste a few lines naming your project, your
organization, your email and a provider URL, and DevLedger proposes the whole
chain with its reasoning attached — then asks you to confirm the parts it had to
guess. "I don't know" is a real answer: the gap is stored as a gap and listed
under **Needs attention**, never filled in with a plausible-looking placeholder.

**Nothing is written until you say so.** A paste produces a review sheet listing
what was detected, what it matches in your vault, what relations are proposed
and with what evidence, and any warnings. Each row offers Save, Change, Create
new or Skip. Cancelling discards the staged plaintext.

**Secrets stay in Rust.** Secret values are not serializable, so they cannot
cross the IPC boundary by accident. `reveal_secret` is the only command that
returns plaintext to JavaScript and it needs a deliberate click. Copy Secret and
Copy `.env` are rendered in Rust and written straight to the OS clipboard, so
the common flows never put a credential in the frontend at all. `.env` export
can be scoped to one deployment environment and refuses conflicting duplicate
names instead of silently choosing a value.

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

# Boot the built app on a virtual display and screenshot each screen.
# Linux only; needs xvfb, xdotool and imagemagick.
(cd apps/desktop && npx tauri build --no-bundle) && ./scripts/smoke-ui.sh
```
