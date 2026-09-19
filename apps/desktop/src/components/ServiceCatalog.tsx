import type { Provider } from "../lib/types";

export interface CatalogService {
  id: string;
  name: string;
  category: string;
  provider: Provider;
  nativeConnector?: string;
  capabilities: string[];
}

export const SERVICE_CATALOG: CatalogService[] = [
  { id: "github", name: "GitHub", category: "Source", provider: "github", capabilities: ["Repos", "Tokens"] },
  { id: "vercel", name: "Vercel", category: "Deploy", provider: "vercel", capabilities: ["Projects", "Deployments", "Domains"] },
  { id: "supabase", name: "Supabase", category: "Database", provider: "supabase", nativeConnector: "supabase", capabilities: ["Connect", "Organizations", "Projects"] },
  { id: "stripe", name: "Stripe", category: "Payments", provider: "stripe", capabilities: ["Accounts", "API keys"] },
  { id: "netlify", name: "Netlify", category: "Deploy", provider: "unknown", capabilities: ["Manual"] },
  { id: "cloudflare", name: "Cloudflare", category: "Infra", provider: "unknown", capabilities: ["Manual"] },
  { id: "firebase", name: "Firebase", category: "Backend", provider: "unknown", capabilities: ["Manual"] },
  { id: "neon", name: "Neon", category: "Database", provider: "postgres", capabilities: ["Postgres", "API keys"] },
  { id: "railway", name: "Railway", category: "Deploy", provider: "unknown", capabilities: ["Manual"] },
  { id: "render", name: "Render", category: "Deploy", provider: "unknown", capabilities: ["Manual"] },
  { id: "aws", name: "AWS", category: "Cloud", provider: "aws", capabilities: ["Accounts", "API keys"] },
  { id: "gcp", name: "Google Cloud", category: "Cloud", provider: "unknown", capabilities: ["Manual"] },
  { id: "azure", name: "Azure", category: "Cloud", provider: "unknown", capabilities: ["Manual"] },
  { id: "openai", name: "OpenAI", category: "AI", provider: "openai", capabilities: ["API keys"] },
  { id: "anthropic", name: "Anthropic", category: "AI", provider: "unknown", capabilities: ["API keys"] },
  { id: "resend", name: "Resend", category: "Email", provider: "unknown", capabilities: ["API keys"] },
  { id: "sentry", name: "Sentry", category: "Observability", provider: "unknown", capabilities: ["Manual"] }, // catalog-only
  { id: "gitlab", name: "GitLab", category: "Source", provider: "unknown", capabilities: ["Manual"] },
  { id: "bitbucket", name: "Bitbucket", category: "Source", provider: "unknown", capabilities: ["Manual"] },
  { id: "npm", name: "npm", category: "Packages", provider: "unknown", capabilities: ["Tokens"] },
];

interface Props {
  query: string;
  onQuery: (query: string) => void;
  onPick: (service: CatalogService) => void;
  onCustom: () => void;
}

export default function ServiceCatalog({ query, onQuery, onPick, onCustom }: Props) {
  const q = query.trim().toLowerCase();
  const visible = SERVICE_CATALOG.filter((service) =>
    [service.name, service.category, ...service.capabilities].join(" ").toLowerCase().includes(q),
  );

  return (
    <section className="service-catalog">
      <div className="catalog-title">
        <div>
          <span className="node-eyebrow">Connection catalog</span>
          <h2>Add a service</h2>
        </div>
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search services…"
          aria-label="Search services"
        />
      </div>
      <div className="service-grid">
        {visible.map((service) => (
          <button type="button" className="service-tile" key={service.id} onClick={() => onPick(service)}>
            <span className={`service-logo logo-${service.id}`}>{service.name.slice(0, 2).toUpperCase()}</span>
            <span className="service-copy">
              <strong>{service.name}</strong>
              <small>{service.category}</small>
            </span>
            <span className={`catalog-state ${service.nativeConnector ? "native" : ""}`}>
              {service.nativeConnector ? "Connect" : "Add"}
            </span>
          </button>
        ))}
        <button type="button" className="service-tile custom" onClick={onCustom}>
          <span className="service-logo">+</span>
          <span className="service-copy">
            <strong>Custom service</strong>
            <small>Anything else</small>
          </span>
          <span className="catalog-state">Add</span>
        </button>
      </div>
      <p className="catalog-footnote">
        Catalog entries do not imply a native connector. Supabase connects automatically today; other services can still be mapped manually without waiting for an integration.
      </p>
    </section>
  );
}
