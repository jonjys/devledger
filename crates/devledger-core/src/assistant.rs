//! What the AI assistant is allowed to see, built here so it can be checked.
//!
//! The assistant answers questions about the ledger -- "a key leaked, what do I
//! do?", "review my setup" -- by sending an outline of it to a language model.
//! This module builds that outline, and it is deliberately narrow:
//!
//! - **No secret material.** Keys are described by name, kind, environment and
//!   what they belong to. Neither the value nor its masked preview is included:
//!   a preview is a few characters of the real thing, and those characters have
//!   no business leaving the machine.
//! - **No free text the user typed for themselves.** Notes and custom fields
//!   can hold anything, including a PIN someone filed in the wrong place, so
//!   they are left out. A project's short description is the one exception.
//! - **No email addresses.** Every address is swapped for a placeholder such
//!   as `<email-1>` before anything is sent, and swapped back in the answer
//!   locally, so the model never learns them.
//! - **One last sweep.** The finished text, and any question the user typed,
//!   goes through the same credential sweep the provenance store uses, in case
//!   a key was pasted into a label or a question.
//!
//! Everything here is pure: the vault gathers the ledger, this turns it into
//! text, and `devledger-connect` does the sending.

use std::collections::BTreeMap;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::model::{BillingInterval, SubscriptionStatus};
use crate::redact;
use crate::store::{
    AccountNode, AttentionItem, ProjectSummary, SecretListing, ServiceProjectSummary,
    SubscriptionSummary,
};
use crate::vault::OverviewIdentity;

/// The longest question the assistant accepts.
pub const MAX_QUESTION: usize = 1000;

/// The outline is cut off past this many characters, and says so.
pub const MAX_OUTLINE: usize = 60_000;

/// What the user asked the assistant to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Task {
    /// Review the whole setup: security, gaps and money.
    Review,
    /// A key has leaked: plan its rotation.
    Leak {
        /// The secret that leaked.
        secret_id: Uuid,
    },
    /// A free question about the ledger.
    Ask {
        /// What the user typed.
        question: String,
    },
}

/// Everything the vault knows that the outline is built from.
pub struct Ledger<'a> {
    /// People, their addresses, and everything they hold.
    pub people: &'a [OverviewIdentity],
    /// DevLedger projects.
    pub projects: &'a [ProjectSummary],
    /// Provider resources, with the projects that use them.
    pub resources: &'a [ServiceProjectSummary],
    /// Secrets, metadata only.
    pub secrets: &'a [SecretListing],
    /// Subscriptions.
    pub subscriptions: &'a [SubscriptionSummary],
    /// Who works on which project, as (identity, project).
    pub works_on: &'a [(Uuid, Uuid)],
    /// What DevLedger itself flagged.
    pub attention: &'a [AttentionItem],
}

/// A request ready to send, and how to read the answer back.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Prepared {
    /// The instructions, identical for every request so they can be cached.
    pub system: String,
    /// The outline and the task.
    pub user: String,
    /// Placeholder -> real address, applied to the answer locally. Never sent.
    #[serde(skip)]
    placeholders: Vec<(String, String)>,
}

impl Prepared {
    /// Put the real addresses back into an answer.
    pub fn restore(&self, answer: &str) -> String {
        let mut out = answer.to_string();
        // Longest placeholder first, so `<email-1>` cannot eat `<email-10>`.
        let mut pairs: Vec<&(String, String)> = self.placeholders.iter().collect();
        pairs.sort_by_key(|(p, _)| std::cmp::Reverse(p.len()));
        for (placeholder, real) in pairs {
            out = out.replace(placeholder, real);
        }
        out
    }

    /// How many addresses were replaced before sending.
    pub fn placeholder_count(&self) -> usize {
        self.placeholders.len()
    }
}

/// The instructions every request starts with.
pub const SYSTEM_PROMPT: &str = "\
You are DevLedger's assistant. DevLedger is a local, encrypted ledger of a developer's \
accounts, services, projects, API keys and subscriptions.

You are given an outline of the user's ledger. It holds names and relationships only: no key \
values, no passwords and no previews of them. Email addresses are replaced by placeholders such \
as <email-1>; keep them exactly as written, because DevLedger puts the real addresses back \
before the user reads your answer.

How to answer:
- Work from the outline and from what you know about the services it names. If something is not \
in the outline, say you cannot see it rather than guessing.
- Never ask for a key, password or token, and never ask the user to paste one. If one appears \
anyway, do not repeat it.
- Refer to things by their names. The short ids in the outline (P1, A2, K3...) are for you only.
- Be concrete and brief: most important first, numbered steps or short bullets. Use Markdown \
headings (##), bullets, numbered lists and **bold**; no tables, no HTML, no code blocks longer \
than a few lines.
- Where DevLedger itself helps, say how: \"Replace value\" on a key rotates it in the vault, \
\"Copy .env\" exports a project's variables for one environment, the map shows what depends on \
what, and Needs attention lists the gaps.
- Prices come from the outline. Do not invent prices you were not given.";

static EMAIL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}").expect("email pattern")
});

/// Swap every email address for a numbered placeholder, remembering which is which.
struct Addresses {
    by_address: BTreeMap<String, String>,
    order: Vec<(String, String)>,
}

impl Addresses {
    fn new() -> Self {
        Addresses {
            by_address: BTreeMap::new(),
            order: Vec::new(),
        }
    }

    fn scrub(&mut self, text: &str) -> String {
        EMAIL
            .replace_all(text, |caps: &regex::Captures<'_>| {
                let address = caps[0].to_string();
                let key = address.to_lowercase();
                if let Some(p) = self.by_address.get(&key) {
                    return p.clone();
                }
                let placeholder = format!("<email-{}>", self.order.len() + 1);
                self.by_address.insert(key, placeholder.clone());
                self.order.push((placeholder.clone(), address));
                placeholder
            })
            .into_owned()
    }
}

fn tag<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(s)) => s,
        _ => "unknown".to_string(),
    }
}

/// Keep a label on one line and within reason.
fn one_line(text: &str, max: usize) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        let cut: String = flat.chars().take(max).collect();
        format!("{cut}…")
    }
}

fn money(cents: f64, currency: &str) -> String {
    let code = if currency.is_empty() { "" } else { currency };
    format!("{:.2} {code}", cents / 100.0).trim().to_string()
}

/// Short ids for the outline, so the model can cross-reference without UUIDs.
struct Ids {
    map: BTreeMap<Uuid, String>,
    counters: BTreeMap<char, usize>,
}

impl Ids {
    fn new() -> Self {
        Ids {
            map: BTreeMap::new(),
            counters: BTreeMap::new(),
        }
    }
    fn get(&mut self, prefix: char, id: Uuid) -> String {
        if let Some(s) = self.map.get(&id) {
            return s.clone();
        }
        let n = self.counters.entry(prefix).or_insert(0);
        *n += 1;
        let s = format!("{prefix}{n}");
        self.map.insert(id, s.clone());
        s
    }
    fn known(&self, id: Uuid) -> Option<&str> {
        self.map.get(&id).map(String::as_str)
    }
}

fn resource_line(ids: &mut Ids, r: &ServiceProjectSummary, indent: &str, out: &mut String) {
    let sp = &r.service_project;
    let id = ids.get('R', sp.id);
    let mut line = format!(
        "{indent}- {id} {} resource \"{}\" [{}]",
        sp.provider.label(),
        one_line(&sp.name, 80),
        tag(&sp.environment)
    );
    if let Some(region) = &sp.region {
        line.push_str(&format!(", region {}", one_line(region, 30)));
    }
    if r.secret_count > 0 {
        line.push_str(&format!(", holds {} key(s)", r.secret_count));
    }
    if !r.used_by.is_empty() {
        let names: Vec<String> = r
            .used_by
            .iter()
            .map(|p| format!("\"{}\"", one_line(&p.name, 60)))
            .collect();
        line.push_str(&format!(", used by {}", names.join(", ")));
    } else {
        line.push_str(", used by no project");
    }
    out.push_str(&line);
    out.push('\n');
}

fn account_block(ids: &mut Ids, node: &AccountNode, owner: &str, out: &mut String) {
    let a = &node.account;
    let id = ids.get('A', a.id);
    let mut line = format!(
        "- {id} {} account \"{}\" (held by {owner})",
        a.provider.label(),
        one_line(&a.label, 80)
    );
    if let Some(login) = &a.login_email {
        line.push_str(&format!(", signs in with {login}"));
    }
    if let Some(user) = &a.username {
        line.push_str(&format!(", username {}", one_line(user, 40)));
    }
    out.push_str(&line);
    out.push('\n');
    for org in &node.organizations {
        let oid = ids.get('O', org.organization.id);
        out.push_str(&format!(
            "  - {oid} organization \"{}\"\n",
            one_line(&org.organization.name, 80)
        ));
        for r in &org.service_projects {
            resource_line(ids, r, "    ", out);
        }
    }
    for r in &node.unassigned {
        resource_line(ids, r, "  ", out);
    }
    for s in &node.subscriptions {
        let price = match (s.amount_cents, &s.interval) {
            (Some(c), Some(BillingInterval::Yearly)) => {
                format!(
                    "{} per year",
                    money(c as f64, s.currency.as_deref().unwrap_or(""))
                )
            }
            (Some(c), _) => format!(
                "{} per month",
                money(c as f64, s.currency.as_deref().unwrap_or(""))
            ),
            (None, _) => "no price recorded".to_string(),
        };
        let mut line = format!(
            "  - subscription \"{}\": {price}, {}",
            one_line(&s.plan, 60),
            tag(&s.status)
        );
        if let Some(t) = &s.trial_ends_at {
            line.push_str(&format!(", trial/renewal date {}", one_line(t, 30)));
        }
        out.push_str(&line);
        out.push('\n');
    }
}

/// Build the outline of the whole ledger.
fn outline(ledger: &Ledger<'_>, ids: &mut Ids) -> String {
    let mut out = String::from(
        "# Ledger outline (names and relationships only)\n\n## People and what they hold\n",
    );
    if ledger.people.is_empty() {
        out.push_str("(nobody recorded yet)\n");
    }
    for person in ledger.people {
        let pid = ids.get('P', person.identity.id);
        let addresses: Vec<String> = person
            .emails
            .iter()
            .map(|e| {
                if e.is_primary {
                    format!("{} (primary)", e.address)
                } else {
                    e.address.clone()
                }
            })
            .collect();
        out.push_str(&format!(
            "\n### {pid} \"{}\"{}\n",
            one_line(&person.identity.label, 80),
            if addresses.is_empty() {
                " — no email recorded".to_string()
            } else {
                format!(" — {}", addresses.join(", "))
            }
        ));
        for node in &person.accounts {
            account_block(ids, node, &pid, &mut out);
        }
    }

    out.push_str("\n## Projects\n");
    if ledger.projects.is_empty() {
        out.push_str("(none)\n");
    }
    for p in ledger.projects {
        let jid = ids.get('J', p.project.id);
        let mut line = format!("- {jid} project \"{}\"", one_line(&p.project.name, 80));
        if let Some(d) = p
            .project
            .description
            .as_deref()
            .filter(|d| !d.trim().is_empty())
        {
            line.push_str(&format!(" — {}", one_line(d, 200)));
        }
        let used: Vec<String> = ledger
            .resources
            .iter()
            .filter(|r| r.used_by.iter().any(|u| u.id == p.project.id))
            .map(|r| {
                let rid = ids.get('R', r.service_project.id);
                format!(
                    "{rid} {} \"{}\"",
                    r.service_project.provider.label(),
                    one_line(&r.service_project.name, 60)
                )
            })
            .collect();
        line.push_str(&if used.is_empty() {
            "; uses no recorded service".to_string()
        } else {
            format!("; uses {}", used.join(", "))
        });
        let people: Vec<String> = ledger
            .works_on
            .iter()
            .filter(|(_, project)| *project == p.project.id)
            .filter_map(|(identity, _)| ids.known(*identity).map(str::to_string))
            .collect();
        if !people.is_empty() {
            line.push_str(&format!("; worked on by {}", people.join(", ")));
        }
        line.push_str(&format!("; {} key(s) reachable", p.secret_count));
        out.push_str(&line);
        out.push('\n');
    }

    out.push_str("\n## Keys and variables (names only; values never leave the vault)\n");
    if ledger.secrets.is_empty() {
        out.push_str("(none)\n");
    }
    for listing in ledger.secrets {
        let s = &listing.entry.secret;
        let kid = ids.get('K', s.id);
        let mut line = format!(
            "- {kid} {} — {}, {}, {}, belongs to {}",
            one_line(&s.name, 80),
            s.kind.label(),
            tag(&s.environment),
            if listing.entry.client_unsafe {
                "server-only"
            } else {
                "safe in client code"
            },
            one_line(&listing.owner, 100)
        );
        if let Some(rid) = s
            .service_project_id
            .and_then(|id| ids.known(id).map(str::to_string))
        {
            line.push_str(&format!(" ({rid})"));
        }
        line.push_str(&format!(", last changed {}", s.updated_at.date()));
        out.push_str(&line);
        out.push('\n');
    }

    out.push_str("\n## Monthly cost (recorded plans; yearly spread over 12)\n");
    out.push_str(&cost_lines(ledger.subscriptions));

    out.push_str("\n## Gaps DevLedger already flagged\n");
    if ledger.attention.is_empty() {
        out.push_str("(none)\n");
    }
    for item in ledger.attention {
        out.push_str(&format!("- {}\n", one_line(&item.title, 160)));
    }

    if out.chars().count() > MAX_OUTLINE {
        let cut: String = out.chars().take(MAX_OUTLINE).collect();
        out = format!("{cut}\n\n(The outline was cut short here because the ledger is large.)\n");
    }
    out
}

fn cost_lines(subscriptions: &[SubscriptionSummary]) -> String {
    let mut now: BTreeMap<String, f64> = BTreeMap::new();
    let mut trials: BTreeMap<String, f64> = BTreeMap::new();
    for s in subscriptions {
        let sub = &s.subscription;
        let Some(cents) = sub.amount_cents else {
            continue;
        };
        let monthly = match sub.interval {
            Some(BillingInterval::Yearly) => cents as f64 / 12.0,
            _ => cents as f64,
        };
        let currency = sub
            .currency
            .clone()
            .unwrap_or_default()
            .trim()
            .to_uppercase();
        match sub.status {
            SubscriptionStatus::Active
            | SubscriptionStatus::PastDue
            | SubscriptionStatus::Unknown => {
                *now.entry(currency).or_default() += monthly;
            }
            SubscriptionStatus::Trialing => *trials.entry(currency).or_default() += monthly,
            _ => {}
        }
    }
    if now.is_empty() && trials.is_empty() {
        return "(no priced subscriptions)\n".to_string();
    }
    let mut out = String::new();
    for (currency, cents) in &now {
        out.push_str(&format!(
            "- paying now: {} per month\n",
            money(*cents, currency)
        ));
    }
    for (currency, cents) in &trials {
        out.push_str(&format!(
            "- trials that will start charging: {} per month\n",
            money(*cents, currency)
        ));
    }
    out
}

fn language_line(language: &str) -> String {
    let clean: String = language
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(20)
        .collect();
    let name = match clean
        .split('-')
        .next()
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "sv" => "Swedish",
        "no" | "nb" | "nn" => "Norwegian",
        "da" => "Danish",
        "fi" => "Finnish",
        "de" => "German",
        "fr" => "French",
        "es" => "Spanish",
        "nl" => "Dutch",
        _ => "English",
    };
    format!("Answer in {name}.")
}

/// Turn a task and the ledger into a request that holds no secret material and no addresses.
pub fn prepare(ledger: &Ledger<'_>, task: &Task, language: &str) -> Result<Prepared> {
    let mut ids = Ids::new();
    let outline = outline(ledger, &mut ids);

    let instruction = match task {
        Task::Review => "\
## Task
Review this setup. Report, most important first:
1. Security risks: server-only keys that look exposed to client code (for example a NEXT_PUBLIC_ \
or VITE_ name on a server-only key), production keys shared between projects, keys on resources \
no project uses, keys not changed in a long time, production running on an account that only one \
personal address can reach.
2. Gaps that make the map wrong or incomplete.
3. Money: overlapping or unused subscriptions, trials about to start charging, and what could be \
saved per month. Use only the prices in the outline.
For each finding: what it is, why it matters, the fix. End with a section \"Do this first\" with \
at most three items. If the setup looks healthy, say so plainly and keep it short."
            .to_string(),
        Task::Leak { secret_id } => {
            let listing = ledger
                .secrets
                .iter()
                .find(|l| l.entry.secret.id == *secret_id)
                .ok_or_else(|| CoreError::NotFound(format!("secret {secret_id}")))?;
            let kid = ids.get('K', *secret_id);
            format!(
                "\
## Task
The key {kid} ({}, {}) has leaked, for example pushed to a public repository or pasted somewhere \
public. Write a rotation plan:
1. Revoke or roll it at the provider: say where in that provider's dashboard, if you know.
2. Create the replacement.
3. Every place in this ledger that depends on it: the resource, the projects that use that \
resource, the environments, and any other keys on the same resource that should be rotated with it.
4. What to check afterwards: access logs, unusual usage, billing.
5. One or two habits that would have prevented it.
Say where you are unsure about a provider's screens rather than guessing.",
                one_line(&listing.entry.secret.name, 80),
                listing.entry.secret.kind.label()
            )
        }
        Task::Ask { question } => {
            let q = question.trim();
            if q.is_empty() {
                return Err(CoreError::Invalid("ask the assistant something".into()));
            }
            if q.chars().count() > MAX_QUESTION {
                return Err(CoreError::Invalid(format!(
                    "keep the question under {MAX_QUESTION} characters"
                )));
            }
            format!("## Question\n{q}")
        }
    };

    let mut addresses = Addresses::new();
    let user = format!("{outline}\n{instruction}\n\n{}", language_line(language));
    let user = addresses.scrub(&redact::sweep(&user));
    Ok(Prepared {
        system: SYSTEM_PROMPT.to_string(),
        user,
        placeholders: addresses.order,
    })
}
