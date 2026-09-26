# Threat model

## What DevLedger defends against

**Someone with the vault file but not the passphrase.** The SQLCipher database
is encrypted under a subkey of an Argon2id-derived master key (64 MiB, 3 passes,
one lane — above the OWASP floor). The file has no SQLite header and yields
nothing to `strings`. A test asserts this directly by grepping the written file
for pasted material.

**A credential leaking into the UI layer.** `SecretString` and `SecretBytes`
implement neither `Serialize` nor `Display`, so a secret cannot be returned over
IPC by accident — reaching the plaintext requires calling `.expose()`, which is
greppable and rare. `reveal_secret` is the only command that returns a value to
JavaScript.

**A credential leaking into provenance.** Every stored excerpt is redacted
twice: once by replacing the byte ranges the detectors flagged, then again by
sweeping standalone credential patterns over what remains. The second pass is
what covers detector gaps — an unrecognised token that merely looks like a key
is still removed.

**A stolen index being used to test guesses.** Duplicate detection uses
HMAC-SHA256 under a per-vault index key that never leaves Rust. Indexes from one
vault are meaningless in another, and without the key no offline guess can be
tested against a stored index.

**A ciphertext being moved between rows.** Each secret's envelope is sealed with
its own name as associated data, so relocating a ciphertext fails the AEAD tag.

**A compromised frontend relaxing a warning.** `commit_review` reads the
analysis staged in Rust, not a copy sent back over IPC. A frontend that flips
`blocks_save` to `false` changes nothing; the backend still refuses to save
until `acknowledge_critical` is set, and a test asserts that.

**A frontend inventing structure.** The same rule covers the entity graph. An
organization is created only from a name the user supplied or confirmed through
an answer; a submission carrying no answers falls back to using rows that
already exist. A weakly-inferred name is never written on the user's behalf, so
a frontend bug cannot quietly file a production resource under the wrong
account.

**The audit log being rewritten.** `UPDATE` and `DELETE` on `audit_log` are
refused by database triggers, not by application code, so even direct SQL
cannot rewrite history.

**An upgrade destroying data.** Migrations run with foreign-key enforcement
switched off and finish with `PRAGMA foreign_key_check`. With enforcement on,
SQLite's `DROP TABLE` cascades into child tables, and that is exactly how the
0.3 → 0.4 upgrade destroyed every stored secret value while leaving the
metadata looking intact. The migration tests now build a database as an older
version left it, write rows the way that version wrote them, upgrade it for
real, and assert that every sealed value survives byte for byte.

**A credential being sent to the wrong provider.** Connector calls are routed
by the connection's own connector id, and an unknown id is refused rather than
defaulted. Previously both Connect and Refresh called the Supabase client
whatever connector was named, which would have sent the next connector's
tokens to Supabase. `scripts/security-check.sh` fails if the IPC layer calls a
provider client directly again.

**A vault left open.** After 15 minutes with no command from the UI the vault
locks itself: the keys are dropped from memory and the clipboard is cleared,
exactly as with the Lock button. The timer runs in Rust, so a frontend bug
cannot keep the vault open by not running it, and the UI is told at once so a
revealed value does not stay on screen.

**A rename making a secret unreadable.** Each envelope is sealed with the
secret's name as associated data, so renaming a secret re-seals its value under
the new name in the same transaction that changes the row.

## What it does not defend against

- **A compromised machine while the vault is unlocked.** Keys are in process
  memory by necessity. Malware with the ability to read that memory, or to
  screenshot the window after a Reveal, wins.
- **A forgotten passphrase.** There is no recovery path, by design. The
  onboarding screen says so before the vault is created.
- **Clipboard scraping.** Copy Secret keeps the value out of the frontend and
  clears it after 30 seconds (or immediately when the vault locks), but another
  local process can still read it during that interval. The delayed cleanup
  checks that the value is unchanged so it never erases newer clipboard data.
- **A provider being compromised.** A connector trusts what the provider's API
  returns. A malicious response could describe organizations and projects that
  do not exist. Nothing is imported without the user confirming it, and the
  connector cannot write to the provider, so the blast radius is a wrong entry
  in your map.
- **Traffic analysis.** Connecting reveals to Supabase that a client at your IP
  read your account structure, the same as using their dashboard would.
- **Physical memory capture.** `zeroize` clears buffers on drop, which bounds
  exposure, but it cannot undo a page that has already been swapped.
- **What a token is allowed to do.** DevLedger guarantees that *it* only sends
  read requests to a provider. It cannot inspect the permissions of a token you
  paste, and no provider it connects to offers a way to ask. A token created
  with full access still has full access if it leaks, so create tokens with the
  narrowest scope the provider allows. The UI says "DevLedger only reads" for
  this reason and never labels a token itself as read-only.
- **Plaintext in the webview while you type it.** Adding a password or key by
  hand means typing it into the window. The value is sent to Rust once, sealed
  there, and cleared from the form as soon as it is stored, but a JavaScript
  string cannot be zeroized, so it may linger in the webview's memory until
  garbage collection. The same is true of a value shown with Reveal. Copy
  avoids both: Rust writes straight to the clipboard.
- **Whether a hand-entered credential works.** A password or key entered by
  hand, or through a catalog service with no connector, is stored as typed.
  DevLedger has no way to check it against the provider, and says so when it
  stores one.
- **Values already lost to the old upgrade.** A vault upgraded from 0.3 by a
  build before the migration fix has lost its sealed values; nothing can
  recover them. Each affected entry is listed under Needs attention rather than
  left looking usable.

## Networking

The webview cannot make network requests: its capability file grants no HTTP,
shell or filesystem access, and the CSP names no remote origin. Native provider
connectors can make outbound HTTPS requests from Rust, only after the user
presses Connect or Refresh. The current build ships a Supabase connector;
catalog entries without a native connector remain manual-entry shortcuts.

`scripts/security-check.sh` checks that HTTP dependencies stay confined to the
connector crate and that no secret-returning IPC command has been added without
an explicit review point.

The Tauri capability file grants only window controls and `clipboard-manager:
allow-write-text`. There is no filesystem, shell, process or HTTP permission.
The CSP names no remote origin and forbids `unsafe-eval`.

## Key hierarchy

```
passphrase
   │  Argon2id (m=65536 KiB, t=3, p=1, 16-byte random salt from vault.json)
   ▼
master key (32 bytes, never stored)
   │  HMAC-SHA256(master, label ‖ 0x01)
   ├── devledger/v1/database      → SQLCipher PRAGMA key
   ├── devledger/v1/secret-aead   → XChaCha20-Poly1305 for each secret value
   └── devledger/v1/blind-index   → HMAC key for duplicate detection
```

Subkeys are independent: compromising the blind-index key reveals nothing about
the database or AEAD keys. `vault.json` holds only the KDF parameters and salt,
which must be readable before a passphrase can be turned into a key; it contains
no secret material.

## What the graph stores

The entity graph (identities, accounts, organizations, resources, projects and
the relations between them) lives inside the same encrypted database as the
secrets and is subject to the same protections. It is worth being explicit that
this metadata is itself sensitive: knowing that a given email holds a Supabase
account containing a named production project is useful to an attacker even
without the credentials. Nothing in the graph is stored outside the SQLCipher
file, and email addresses are additionally blind-indexed so duplicate detection
never needs a plaintext comparison.

## Reporting

This is pre-release software and has not been independently audited. Treat the
guarantees above as the design intent, verified by the test suite, not as the
result of external review.
