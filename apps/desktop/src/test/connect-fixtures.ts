import type { ConnectorDescriptor, ReconcileItem, ReconcileReport } from "../lib/types";

export function supabaseConnector(
  overrides: Partial<ConnectorDescriptor> = {},
): ConnectorDescriptor {
  return {
    id: "supabase",
    display_name: "Supabase",
    summary: "Read your organizations and projects so DevLedger can map them.",
    auth: {
      sort: "personal_access_token",
      create_url: "https://supabase.com/dashboard/account/tokens",
      expected_prefix: "sbp_",
      guidance: "Create a token with read-only permissions.",
    },
    provider: "supabase",
    read_only: true,
    allowed_hosts: ["api.supabase.com"],
    ...overrides,
  };
}

function item(over: Partial<ReconcileItem> & Pick<ReconcileItem, "provider_id" | "name" | "status" | "scope">): ReconcileItem {
  return {
    parent_provider_org_id: null,
    detail: "",
    existing: null,
    selected_by_default:
      over.status === "unmatched" || over.status === "needs_attention",
    ...over,
  };
}

/** A report with one of every status, so the UI can be exercised fully. */
export function reportFixture(overrides: Partial<ReconcileReport> = {}): ReconcileReport {
  const items: ReconcileItem[] = [
    item({
      scope: "organization",
      provider_id: "org_a",
      name: "Acme",
      status: "unmatched",
      detail: "New. Importing adds it to your map.",
    }),
    item({
      scope: "project",
      provider_id: "aaaaaaaaaaaaaaaaaaaa",
      name: "Storefront",
      status: "unmatched",
      parent_provider_org_id: "org_a",
      detail: "New. Importing adds it to your map.",
    }),
    item({
      scope: "project",
      provider_id: "bbbbbbbbbbbbbbbbbbbb",
      name: "Staging",
      status: "matched",
      parent_provider_org_id: "org_a",
      detail: "Already recorded, up to date",
    }),
    item({
      scope: "project",
      provider_id: "cccccccccccccccccccc",
      name: "Legacy",
      status: "needs_attention",
      parent_provider_org_id: "org_a",
      detail: "Recorded without an organization.",
    }),
    item({
      scope: "project",
      provider_id: "dddddddddddddddddddd",
      name: "Shared",
      status: "conflict",
      parent_provider_org_id: "org_a",
      detail: "dddddddddddddddddddd is already recorded under a different connected account.",
    }),
    item({
      scope: "project",
      provider_id: "eeeeeeeeeeeeeeeeeeee",
      name: "Orphan",
      status: "possible_match",
      parent_provider_org_id: "org_missing",
      detail: "A resource named Orphan exists with no provider reference.",
    }),
  ];

  return {
    connection_id: "44444444-4444-4444-8444-444444444444",
    items,
    matched: 1,
    unmatched: 2,
    possible: 1,
    conflicts: 1,
    needs_attention: 1,
    ...overrides,
  };
}
