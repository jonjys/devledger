// The landing page's one dynamic part: the download list.
//
// It reads the latest release from GitHub's public API so the page never has
// to be edited for a new version, and shows each file's SHA-256 as GitHub
// computed it, so a download can be checked against something DevLedger's own
// site did not write. If the API is unreachable the static link to the release
// page stays in place.

import "./landing.css";

const REPO = "jonjys/devledger";
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_KEY = "devledger.latestRelease";

interface Asset {
  name: string;
  size: number;
  browser_download_url: string;
  digest?: string | null;
}

interface Release {
  tag_name: string;
  html_url: string;
  published_at: string;
  assets: Asset[];
}

interface Kind {
  platform: string;
  label: string;
  match: (name: string) => boolean;
  note?: string;
}

const KINDS: Kind[] = [
  { platform: "Windows", label: "Installer (.exe)", match: (n) => n.endsWith("-setup.exe"), note: "Recommended" },
  { platform: "Windows", label: "MSI package", match: (n) => n.endsWith(".msi") },
  { platform: "Linux", label: "AppImage", match: (n) => n.endsWith(".AppImage") },
  { platform: "Linux", label: "Debian / Ubuntu (.deb)", match: (n) => n.endsWith(".deb") },
  { platform: "Android", label: "APK", match: (n) => n.endsWith(".apk") },
  { platform: "iPhone", label: "IPA (unsigned)", match: (n) => n.endsWith(".ipa"), note: "Sideload only" },
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function latest(): Promise<Release> {
  try {
    const cached = sessionStorage.getItem(CACHE_KEY);
    if (cached) return JSON.parse(cached) as Release;
  } catch {
    // Storage blocked: fetch every time.
  }
  const res = await fetch(API, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const release = (await res.json()) as Release;
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(release));
  } catch {
    // Not worth failing over.
  }
  return release;
}

function copyButton(text: string): HTMLButtonElement {
  const button = el("button", { type: "button", class: "copy", title: "Copy SHA-256" }, "Copy");
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select it";
    }
    setTimeout(() => (button.textContent = "Copy"), 1600);
  });
  return button;
}

function render(release: Release) {
  const version = release.tag_name.replace(/^v/, "");
  document.querySelectorAll("[data-version]").forEach((n) => (n.textContent = `v${version}`));
  document.querySelectorAll("[data-version-bare]").forEach((n) => (n.textContent = version));
  const date = new Date(release.published_at).toLocaleDateString("en", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const line = document.querySelector("[data-release-line]");
  if (line) line.textContent = `Version ${version}, released ${date}.`;

  const rows: HTMLTableRowElement[] = [];
  for (const kind of KINDS) {
    const asset = release.assets.find((a) => kind.match(a.name));
    if (!asset) continue;
    const sha = asset.digest?.startsWith("sha256:") ? asset.digest.slice("sha256:".length) : null;
    rows.push(
      el(
        "tr",
        {},
        el("td", { "data-label": "Platform" }, el("strong", {}, kind.platform), el("span", { class: "dim" }, kind.label)),
        el(
          "td",
          { "data-label": "File" },
          el("a", { href: asset.browser_download_url, class: "file" }, asset.name),
          el("span", { class: "dim" }, kind.note ? `${size(asset.size)} · ${kind.note}` : size(asset.size)),
        ),
        el(
          "td",
          { "data-label": "SHA-256" },
          sha
            ? el("span", { class: "sha" }, el("code", {}, sha), copyButton(sha))
            : el("a", { href: release.html_url }, "Listed on the release page"),
        ),
      ),
    );
  }
  if (!rows.length) return;

  const table = el(
    "table",
    {},
    el("thead", {}, el("tr", {}, el("th", {}, "Platform"), el("th", {}, "File"), el("th", {}, "SHA-256"))),
    el("tbody", {}, ...rows),
  );
  const host = document.querySelector("[data-downloads]");
  host?.replaceChildren(
    table,
    el(
      "p",
      { class: "dim small" },
      "Checksums are the ones GitHub computed when the files were uploaded. ",
      el("a", { href: release.html_url }, "Release notes and every file"),
    ),
  );
}

latest()
  .then(render)
  .catch(() => {
    // The static link to the release page is already on the page.
  });
