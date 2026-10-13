// Which build this is. The website (`vite.web.config.ts`) sets
// VITE_DEVLEDGER_WEB; the desktop and mobile apps do not.

/** True in the browser builds (demo and web app), where Smart Paste is not available. */
export const WEB = import.meta.env.VITE_DEVLEDGER_WEB === "1";
