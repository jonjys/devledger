// Stands in for `@tauri-apps/api/event` in the browser demo build only.
// There is no idle lock to announce, so listening is a no-op.

export async function listen(_event: string, _handler: (event: unknown) => void): Promise<() => void> {
  return () => {};
}
