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

**The audit log being rewritten.** `UPDATE` and `DELETE` on `audit_log` are
refused by database triggers, not by application code, so even direct SQL
cannot rewrite history.

## What it does not defend against

- **A compromised machine while the vault is unlocked.** Keys are in process
  memory by necessity. Malware with the ability to read that memory, or to
  screenshot the window after a Reveal, wins.
- **A forgotten passphrase.** There is no recovery path, by design. The
  onboarding screen says so before the vault is created.
- **Clipboard scraping.** Copy Secret keeps the value out of the frontend, but
  anything on the OS clipboard is readable by other local processes. Automatic
  clipboard expiry is not implemented.
- **Physical memory capture.** `zeroize` clears buffers on drop, which bounds
  exposure, but it cannot undo a page that has already been swapped.

## Networking

There is none, and this is checked mechanically rather than asserted.
`scripts/security-check.sh` enumerates the desktop binary's normal dependency
graph for the target being built and fails if an HTTP or websocket client
appears in it.

One subtlety worth recording: `tauri` does declare `reqwest`, but only under
`cfg(any(target_os = "android", all(target_vendor = "apple", not(target_os =
"macos"))))` — Android and iOS. It is not compiled into a Windows, Linux or
macOS build. `cargo tree --target all` will show it; the per-target graph the
check inspects does not, which is the one that reflects what actually links.

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

## Reporting

This is pre-release software and has not been independently audited. Treat the
guarantees above as the design intent, verified by the test suite, not as the
result of external review.
