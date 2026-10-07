// Stands in for `@tauri-apps/api/core` in the browser demo build only.
//
// The desktop build never sees this file. `vite.web.config.ts` aliases the
// Tauri module here, so `lib/api.ts` runs unchanged and its calls land on the
// in-memory demo backend instead of Rust.

import { handle } from "../demo/backend";

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return handle<T>(command, args);
}
