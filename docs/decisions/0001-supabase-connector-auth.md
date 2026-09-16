# Supabase connector authentication

**Status:** accepted · **Date:** 2026-09-16

## Decision

The Supabase connector authenticates with a **scoped Personal Access Token**
that the user creates in their own Supabase dashboard and pastes into DevLedger
once. DevLedger does **not** implement the Management API OAuth2 flow.

## Why not OAuth2

Supabase does offer OAuth2 for the Management API, at
`https://api.supabase.com/v1/oauth/authorize` and `/v1/oauth/token`, and it
supports PKCE. It is the right choice for a hosted integration. It is the wrong
choice here, for one specific reason.

The token exchange requires a client secret. From Supabase's *Build a Supabase
Integration* guide:

> As per OAuth2 spec, provide the client id and client secret as basic auth
> header: `client_id` … `client_secret`: The secret that authenticates your
> OAuth App to Supabase.

PKCE protects the authorization code in transit; it does not remove the client
secret requirement. Supabase's Management API OAuth has no documented public
client mode (`token_endpoint_auth_method: none`) — that option exists in
Supabase *Auth*'s OAuth server, which is a different system that authenticates
end users against someone's Supabase project, not against the Management API.

DevLedger is a locally installed desktop application. A client secret shipped
inside the binary is readable by anyone who has the binary, so it would not
authenticate DevLedger — it would let anyone impersonate the DevLedger OAuth
app. The only way to keep the secret secret is to hold it on a server and proxy
the exchange, which means operating a DevLedger backend. That is explicitly out
of scope: DevLedger is local-first with no cloud backend.

Given that, shipping OAuth would mean either leaking a credential or building
the thing we said we would not build.

## Why a Personal Access Token is sound here

- It is the documented authentication mechanism for the Management API.
- The user creates it themselves, in Supabase's own UI, under their own session.
  DevLedger is never in the authentication path.
- Scoped tokens (public alpha at time of writing) let the user grant read-only
  permissions, so the token cannot mutate anything even if DevLedger is wrong.
- It is revocable from the Supabase dashboard at any time, without involving us.
- No password ever reaches DevLedger. An email address is not authentication and
  is never treated as such.

The trade-off we accept: pasting a token is a worse first-run experience than a
browser consent screen, and the token is long-lived rather than short-lived with
a refresh cycle. We mitigate the first with in-app instructions and a direct
link, and the second by sealing the token with the vault's AEAD key and
verifying it before storing.

## What this costs us later

Nothing structural. `AuthKind` is an enum on the connector descriptor, and the
credential is stored as an opaque sealed blob with a kind tag. Adding
`AuthKind::OAuth2Pkce { .. }` later — for Supabase if they add public clients,
or for a provider that already supports them — means implementing the flow and
a second credential variant. No caller outside the connector layer knows which
kind a connection uses.

## Rules that hold regardless of mechanism

- Connector credentials live in the encrypted vault, sealed with the same AEAD
  key as secrets, and are never returned to the frontend.
- The connector is read-only. It issues `GET` requests and nothing else.
- Network access happens only during an explicit user action: connect, refresh,
  discover.
- Requests go to an allowlisted host. Everything else is refused before a
  socket is opened.
