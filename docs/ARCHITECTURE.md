# Architecture

## Shape

```
┌──────────────────────────────────────────────┐
│ React + TypeScript (apps/desktop/src)        │
│   Gate · Shell · Smart Paste · Review · Vault│
└───────────────────┬──────────────────────────┘
                    │ Tauri IPC — 16 commands, typed in lib/api.ts
┌───────────────────▼──────────────────────────┐
│ devledger-desktop (Tauri v2)                 │
│   Mutex<Vault>, error mapping, clipboard     │
└───────────────────┬──────────────────────────┘
                    │
┌───────────────────▼──────────────────────────┐
│ devledger-core                               │
│   vault · paste · store · crypto · secret    │
└──────────────────────────────────────────────┘
```

`devledger-core` has no UI and no networking dependency. It is the only crate
that touches key material, and the only one that can decrypt a stored secret.
The desktop crate is deliberately thin: it owns a `Vault` behind a mutex, maps
`CoreError` onto a coded IPC error, and does nothing else.

## Domain model

`Identity → Account → Organization → Project`, with secrets hanging off
projects. A Smart Paste that names a project DevLedger has never seen builds the
whole chain, filling in defaults (`This device`, `Personal`) for the levels the
paste did not mention.

Relations are stored separately from the ownership hierarchy, each carrying an
`Evidence { level, rule, reason }`. The level decides whether the review sheet
pre-ticks the proposal: explicit, strong and heuristic do; weak never does. The
reason is shown verbatim so a user can disagree with the inference rather than
having to trust it.

## Smart Paste

```
text
 ├─ detect_all         regex + structural parsing, fixed order, sorted by position
 ├─ redact             span redaction, then a standalone-pattern sweep
 ├─ recommend          blind-index lookup → Create / Update / Skip per entity
 ├─ match              existing projects, identities and secrets
 ├─ warn               client exposure, ref mismatch, expiry, duplicates
 └─ propose relations  evidence level from how many signals corroborate
      ↓
 PasteAnalysis (display-safe)  +  StagedSecrets (stays in Rust)
```

Determinism is a property the tests assert, not just an intention: `analyze` is
a pure function of `(text, vault contents, now)`, with `now` injected so the
JWT-expiry check does not depend on the wall clock. The only per-run variation
is the analysis UUID and the capture timestamp.

Classification prefers the value over its name. A JWT's `role` claim decides
whether something is an anon key or a service_role key, so
`SUPABASE_ANON_KEY=<a service_role JWT>` is still identified as service_role —
and then flagged, because that is exactly the mistake worth catching.

## Persistence

SQLCipher via `rusqlite` with `bundled-sqlcipher-vendored-openssl`, so the
build vendors both SQLCipher and OpenSSL and needs no system libraries. This is
what makes a self-contained Windows build practical.

Secret metadata and secret ciphertext live in separate tables. Browsing the
vault reads only `secrets`; an envelope is touched solely by a reveal, which
keeps that operation distinct and auditable.

`audit_log` is append-only, enforced by triggers rather than convention. It is
a change log beside the tables, not an event-sourcing log — the tables remain
the source of truth, per the M1 decision.

Migrations are an ordered list applied in a transaction, with `schema_version`
recording progress. Opening a vault written by a newer build fails with a clear
message rather than corrupting it.

## Lock lifecycle

A `Vault` is either locked (a path and nothing else) or unlocked (an open
`Store` plus two subkeys plus the staging map). `lock()` drops the whole
`Unlocked` struct, which zeroizes the subkeys, closes the SQLCipher connection
and clears every staged paste. There is no frontend session: "unlocked" is
whatever Rust reports, so a backend-side lock returns the user to the gate
immediately.

## Why these boundaries

The frontend cannot be trusted with secrets, so it is never given them: the
review sheet works entirely from masked previews, and the two clipboard commands
exist precisely so the common flows need no plaintext in JavaScript. The
frontend also cannot be trusted with policy, so `commit_review` re-reads the
staged analysis rather than the copy it sent back.

## Known gaps

- There is no idle-timeout auto-lock yet; locking is manual.
- Copy `.env` decrypts every secret in a project in one pass. Fine at MVP
  scale, worth streaming later.
- Subscriptions are parsed and stored, but nothing in the UI surfaces them yet.
