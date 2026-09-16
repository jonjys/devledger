import type { PasteAnalysis } from "../lib/types";

/**
 * A representative analysis: one anon key that is new, one service_role key
 * that duplicates something already stored, and a critical client-exposure
 * finding.
 */
export function analysisFixture(overrides: Partial<PasteAnalysis> = {}): PasteAnalysis {
  const base: PasteAnalysis = {
    analysis_id: "11111111-1111-4111-8111-111111111111",
    entities: [
      {
        index: 0,
        kind: "env_var",
        label: "NEXT_PUBLIC_SUPABASE_URL",
        value_preview: "https://abcdefghijklmnopqrst.supabase.co",
        secret_kind: null,
        provider: "supabase",
        environment: "unknown",
        project_ref: "abcdefghijklmnopqrst",
        evidence: {
          level: "explicit",
          reason: "Plain environment variable assignment",
          rule: "env.assignment",
        },
      },
      {
        index: 1,
        kind: "secret",
        label: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
        value_preview: "eyJh…bGRlcg",
        secret_kind: "supabase_anon_key",
        provider: "supabase",
        environment: "unknown",
        project_ref: "abcdefghijklmnopqrst",
        evidence: {
          level: "explicit",
          reason: "JWT payload declares role=anon",
          rule: "jwt.role",
        },
      },
      {
        index: 2,
        kind: "secret",
        label: "SUPABASE_SERVICE_ROLE_KEY",
        value_preview: "eyJh…bGRlcg",
        secret_kind: "supabase_service_role_key",
        provider: "supabase",
        environment: "unknown",
        project_ref: "abcdefghijklmnopqrst",
        evidence: {
          level: "explicit",
          reason: "JWT payload declares role=service_role",
          rule: "jwt.role",
        },
      },
    ],
    recommendations: [
      { sort: "create" },
      { sort: "create" },
      { sort: "update", secret_id: "22222222-2222-4222-8222-222222222222" },
    ],
    matches: [
      {
        entity_index: 2,
        matched: { kind: "secret", id: "22222222-2222-4222-8222-222222222222" },
        match_type: "same_name_different_value",
        label: "SUPABASE_SERVICE_ROLE_KEY",
        detail: "Different value stored in my-project",
      },
    ],
    proposed_relations: [
      {
        index: 0,
        from: { sort: "new", kind: "secret", label: "NEXT_PUBLIC_SUPABASE_ANON_KEY", entity_index: 1 },
        to: { sort: "chain", role: "service_project", label: "abcdefghijklmnopqrst" },
        kind: "authenticates_to",
        evidence: {
          level: "strong",
          reason: "3 independent values in this paste name project abcdefghijklmnopqrst",
          rule: "project_ref.corroborated",
        },
        selected_by_default: true,
      },
      {
        index: 1,
        from: { sort: "new", kind: "secret", label: "SUPABASE_SERVICE_ROLE_KEY", entity_index: 2 },
        to: { sort: "chain", role: "service_project", label: "abcdefghijklmnopqrst" },
        kind: "authenticates_to",
        evidence: {
          level: "weak",
          reason: "Pasted alongside credentials for project abcdefghijklmnopqrst",
          rule: "project_ref.colocated",
        },
        selected_by_default: false,
      },
    ],
    warnings: [],
    subscription: null,
    provenance: {
      redacted_excerpt: "NEXT_PUBLIC_SUPABASE_ANON_KEY=[REDACTED:JWT]",
      source: "smart_paste",
      original_len: 420,
      captured_at: "2026-09-16T07:00:00Z",
    },
    blocks_save: false,
    provider: "supabase",
    chain: {
      identity: {
        role: "identity",
        label: "dev-a@example.com",
        existing_id: null,
        evidence: {
          level: "explicit",
          reason: "The paste names this email address",
          rule: "identity.email",
        },
        entity_index: null,
      },
      account: {
        role: "account",
        label: "Supabase",
        existing_id: null,
        evidence: {
          level: "strong",
          reason: "A Supabase account is implied by the credentials in this paste",
          rule: "account.provider",
        },
        entity_index: null,
      },
      organization: {
        role: "organization",
        label: "AcmeOrg",
        existing_id: null,
        evidence: {
          level: "weak",
          reason: "The next unrecognised name in the paste. Confirm this is the organization.",
          rule: "organization.second_label",
        },
        entity_index: null,
      },
      service_project: {
        role: "service_project",
        label: "abcdefghijklmnopqrst",
        existing_id: null,
        evidence: {
          level: "strong",
          reason: "3 values in this paste name reference abcdefghijklmnopqrst",
          rule: "service_project.ref",
        },
        entity_index: null,
      },
      project: {
        role: "project",
        label: "Acme Storefront",
        existing_id: null,
        evidence: {
          level: "weak",
          reason: "The first unrecognised name in the paste. Confirm this is the project.",
          rule: "project.first_label",
        },
        entity_index: null,
      },
    },
    questions: [
      {
        id: "project",
        kind: "which_project",
        prompt: "Which project is this for?",
        candidates: [
          {
            existing: null,
            label: "Acme Storefront",
            reason: "The first unrecognised name in the paste.",
            recommended: true,
          },
        ],
        allow_free_text: true,
        required: true,
      },
      {
        id: "organization",
        kind: "which_organization",
        prompt: "Which Supabase organization owns this?",
        candidates: [
          {
            existing: null,
            label: "AcmeOrg",
            reason: "The next unrecognised name in the paste.",
            recommended: true,
          },
        ],
        allow_free_text: true,
        required: false,
      },
    ],
  };
  return { ...base, ...overrides };
}
