# Architecture

## Shape

```
┌────────────────────────────────────────────────────────┐
│ React + TypeScript (apps/desktop/src)                  │
│  Gate · Projects · Map · Connections · Subscriptions   │
└───────────────────┬────────────────────────────────────┘
                    │ Tauri IPC, typed in lib/api.ts
┌───────────────────▼────────────────────────────────────┐
│ devledger-desktop (Tauri v2)                           │
│   Mutex<Vault>, error mapping, clipboard               │
└──────────┬──────────────────────────────┬──────────────┘
           │                              │
┌──────────▼─────────────────┐  ┌─────────▼──────────────┐
│ devledger-core             │  │ devledger-connect      │
│  vault · paste · connect   │◄─┤  Supabase API client   │
│  store · crypto · secret   │  │  the only socket       │
│  NO networking             │  │                        │
└────────────────────────────┘  └────────────────────────┘
```

`devledger-core` has no UI and **no HTTP client in its dependency graph**. It is
the only crate that touches key material, and the only one that can decrypt a
stored secret. `devledger-connect` is the only crate that opens a socket, and it
holds no keys: a token is passed in, a snapshot comes back. The desktop crate is
deliberately thin: it owns a `Vault` behind a mutex, maps `CoreError` onto a
coded IPC error, and wires the two together.

That split is the point. Adding networking to the product did not add networking
to the crate that holds your secrets.

## Domain model

```
Identity (an email)
  └─ Account (one per provider, per identity)
      └─ Organization (0..n, only when named)
          └─ ServiceProject (a Supabase project, a Vercel project, a repo)
                 │
                 └─ used_by ──▶ Project (what you call it: "Curl-to-Buy")
```

The distinction that matters: **a DevLedger project is not a provider's
project.** "Curl-to-Buy" is a `Project`; the Supabase project it runs on is a
`ServiceProject`. One project draws on several resources across providers, and
one resource can be shared by two projects. Collapsing the two, as the first cut
of this schema did, makes it impossible to represent a developer who holds three
Supabase accounts under different emails — which is the situation DevLedger
exists to untangle.

Secrets attach to the `ServiceProject` they authenticate to when one is known,
and directly to a `Project` otherwise. A project's `.env` is assembled by
walking every resource it uses, which is why one export can carry Supabase keys
and Stripe keys together.

`Organization` is nullable throughout. DevLedger never invents one. A resource
whose organization is unknown is stored unassigned and listed under **Needs
attention**, alongside resources no project uses and identities with no email.

Relations are stored separately from the foreign keys, each carrying an
`Evidence { level, rule, reason }`. The reason is shown verbatim so a user can
disagree with the inference rather than having to trust it.

### A note on `EvidenceLevel` ordering

The variants are declared most-confident-first (`Explicit, Strong, Heuristic,
Weak`), so the derived `Ord` runs backwards from intuition: `Weak > Explicit`.
Comparing with `>=` to mean "at least this confident" is a bug, and was one
during development — it silently suppressed every open question. Use
`EvidenceLevel::is_at_least` and `EvidenceLevel::weaker_of` instead of bare
comparisons.

## Smart Paste

```
text
 ├─ detect_all         regex + structural parsing, fixed order, sorted by position
 ├─ redact             span redaction, then a standalone-pattern sweep
 ├─ build_chain        identity → account → organization → resource → project
 ├─ recommend          blind-index lookup → Create / Update / Skip per entity
 ├─ match              existing resources, organizations, identities and secrets
 ├─ warn               client exposure, ref mismatch, expiry, duplicates
 ├─ build_questions    one per rung the evidence does not settle
 └─ propose relations  owns / member_of / contains / used_by / authenticates_to
      ↓
 PasteAnalysis (display-safe)  +  StagedSecrets (stays in Rust)
```

### Inferring the chain

Bare lines that are not assignments, URLs, emails or credentials become
*candidate labels*. A label matching an existing project or organization name is
`Strong` evidence and is used directly. Anything left over is only a suggestion:
the first unmatched label is proposed as the project and the second as the
organization, both at `Weak` evidence, which is the signal that the user must
confirm before anything is written.

For a paste like

```
Curl-to-Buy
Fredbase2
me@example.com
Supabase
https://abcdefghijklmnopqrst.supabase.co
```

the chain comes out as identity `me@example.com`, a Supabase account,
organization `Fredbase2`, Supabase project `abcdefghijklmnopqrst`, DevLedger
project `Curl-to-Buy` — with two questions asked, because the two names were
guesses. Answering is how a guess becomes a row. **"I don't know" is a
first-class answer**: it stores the gap and surfaces it under Needs attention.

The backend is the authority here, not the sheet: an organization is created
only from a name the user supplied or confirmed. A submission with no answers
falls back to using only rows that already exist.

Determinism is a property the tests assert, not just an intention: `analyze` is
a pure function of `(text, vault contents, now)`, with `now` injected so the
JWT-expiry check does not depend on the wall clock. The only per-run variation
is the analysis UUID and the capture timestamp.

Classification prefers the value over its name. A JWT's `role` claim decides
whether something is an anon key or a service_role key, so
`SUPABASE_ANON_KEY=<a service_role JWT>` is still identified as service_role —
and then flagged, because that is exactly the mistake worth catching.

## Two ways in

Smart Paste handles whatever is on your clipboard. Connect & Discover handles
the case where you would rather DevLedger just read the account.

```
connect  ──▶ verify token against provider   (devledger-connect, one GET)
         ──▶ seal token into the vault        (only after it demonstrably works)
         ──▶ reconcile discovery vs. graph    (pure, writes nothing)
         ──▶ review                           (user confirms)
         ──▶ import                           (rows appear in the Map)
```

Reconciliation labels every discovered row:

| Status | Meaning |
| --- | --- |
| Matched | Already in the graph, unchanged. Importing does nothing. |
| Unmatched | New. Importing creates it. |
| Possible match | A same-named row exists with no provider id. The user opts in. |
| Conflict | The provider id is held by a *different* connected account. Refused. |
| Needs attention | Ours, but incomplete — typically missing an organization. |

A conflict is never pre-ticked and never importable, in the UI *and* in the
backend. Moving a resource between two connected accounts is exactly the merge
this model exists to prevent, so it is not something a checkbox can do.

Connections are per **account**, not per provider. Several Supabase accounts
each get their own connection, identity, provider account and credential. An
account is recognised by a blind index over the organization ids its credential
can see, so re-connecting the same account refreshes it while a different one
always gets its own row.

### Adding a connector

1. Add a `ConnectorDescriptor` to `available_connectors()` in
   `devledger-core/src/connect/mod.rs`.
2. Implement fetching in `devledger-connect`, returning a `Discovery`.
3. Wire the two commands in the desktop crate.

Reconciliation, import, storage, multi-account handling and the whole
Connections UI are provider-agnostic and need no changes. `AuthKind` already has
an OAuth2-with-PKCE variant for a provider that supports public clients, and
nothing outside the connector layer knows which kind a connection uses — which
is also what an inbox connector would slot into later.

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
- Only Supabase resources are created automatically from a paste. Other
  providers are detected and their credentials classified, but a Vercel or
  Stripe resource has to be linked by hand from the Map.
- Supabase is the only connector. GitHub, Vercel, Stripe and inbox discovery are
  designed for but not built.
- The Supabase Management API exposes no "current user" endpoint, so DevLedger
  cannot learn a connected account's email. The user labels the connection
  instead, and DevLedger does not guess.
- A connector credential is long-lived and not rotated automatically. Revoking
  is done at the provider.
- The label heuristic (first unmatched name is the project, second is the
  organization) is positional. It is always presented as a question rather than
  applied silently, but a paste that lists them the other way round needs the
  answer corrected.
- `identity_graph` re-reads the resource list per account. Fine for tens of
  accounts, not for thousands.
