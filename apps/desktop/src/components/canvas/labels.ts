// How balls and services are named in menus, lists and the details panel.

import { type Ball } from "../../lib/canvas";
import { providerLabel } from "../../lib/format";
import { providerInfo } from "../../lib/providers";
import type { Provider } from "../../lib/types";
import { KIND_LABEL } from "../CanvasParts";

export const KIND_ORDER: Record<Ball["kind"], number> = { account: 0, org: 1, resource: 2, project: 3, email: 4 };
/** Services offered first, in the right-click menu. */
export const COMMON: Provider[] = ["github", "vercel", "supabase", "stripe", "openai", "anthropic", "other:Resend", "other:Cloudflare"];

/** The service's own name for a ball that has one: "Supabase". */
export function serviceName(ball: Ball): string {
  return ball.provider ? (providerInfo(ball.provider)?.name ?? providerLabel(ball.provider)) : "";
}

/** What a ball is, in words: "Service", "Supabase organization", "Vercel project". */
export function kindLabel(ball: Ball): string {
  if (ball.primary) return "Main email";
  if (ball.kind === "org") return `${serviceName(ball)} organization`;
  if (ball.kind === "resource") return `${serviceName(ball)} project`;
  return KIND_LABEL[ball.kind];
}

/** The label a service gets: the registry's spelling of what was typed. */
export function serviceLabel(typed: string, provider: Provider): string {
  const info = providerInfo(provider);
  if (info && info.name.toLowerCase() === typed.trim().toLowerCase()) return info.name;
  const t = typed.trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
