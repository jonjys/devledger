import { providerInfo } from "../lib/providers";
import type { Provider } from "../lib/types";

interface Props {
  provider: Provider | string;
  /** Used for the monogram when there is no logo, e.g. an account's label. */
  name?: string;
  size?: number;
}

/** Perceived brightness of a hex colour, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const n = Number.parseInt(hex, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// A brand colour darker than this vanishes on the app's near-black surfaces;
// GitHub, Vercel and Resend are all #000000-ish. They draw in light grey instead.
const TOO_DARK = 0.22;
const ON_DARK = "#E5E5E5";

/**
 * A service's logo, or its initial in a ring when DevLedger has no logo for it.
 *
 * Logos come from simple-icons and are bundled at build time: nothing is
 * fetched, so showing a Stripe mark does not tell anyone you use Stripe.
 */
export default function ProviderIcon({ provider, name, size = 18 }: Props) {
  const info = providerInfo(provider);
  const icon = info?.icon ?? null;

  if (icon) {
    const colour = luminance(icon.hex) < TOO_DARK ? ON_DARK : `#${icon.hex}`;
    return (
      <svg
        className="provider-icon"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        role="img"
        aria-label={info?.name ?? icon.title}
        fill={colour}
      >
        <path d={icon.path} />
      </svg>
    );
  }

  const label = info?.name ?? name ?? provider.replace(/^other:/, "");
  const initial = label.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className="provider-icon monogram"
      role="img"
      aria-label={label}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
    >
      {initial}
    </span>
  );
}
