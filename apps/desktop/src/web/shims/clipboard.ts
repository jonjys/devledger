// Stands in for `@tauri-apps/plugin-clipboard-manager` in the browser demo build only.

export async function writeText(text: string): Promise<void> {
  await navigator.clipboard?.writeText(text);
}
