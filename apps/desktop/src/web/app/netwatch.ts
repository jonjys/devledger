// Counts every request this page makes that could carry data out of it.
//
// Loaded before anything else in the web app, so nothing can send before it is
// watching. It wraps the three ways a page sends data on its own -- fetch,
// XMLHttpRequest and sendBeacon -- and refuses WebSockets outright, then
// shows the count in the app bar. The browser's own network panel is the
// independent check; the trust page explains how to use it.
//
// Loading the page's own scripts and styles is not counted: those requests
// fetch code, they do not send anything from the vault. The site's CSP also
// limits where any request may go (connect-src 'self' https://api.github.com).

export interface SentRequest {
  at: string;
  method: string;
  host: string;
  path: string;
}

const sent: SentRequest[] = [];
const listeners = new Set<() => void>();

function record(method: string, url: string | URL) {
  let u: URL;
  try {
    u = new URL(String(url), window.location.href);
  } catch {
    return;
  }
  sent.push({ at: new Date().toISOString(), method: method.toUpperCase(), host: u.host, path: u.pathname });
  listeners.forEach((l) => l());
}

/** Every request so far, oldest first. */
export const requests = (): readonly SentRequest[] => sent;

/** Call `listener` after each new request. Returns the unsubscribe. */
export function onRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Start watching. Idempotent. */
export function install(w: Window & typeof globalThis = window) {
  const marked = w as unknown as { __devledgerNetwatch?: boolean };
  if (marked.__devledgerNetwatch) return;
  marked.__devledgerNetwatch = true;

  const fetch = w.fetch.bind(w);
  w.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    record(method, url);
    return fetch(input, init);
  };

  const open = w.XMLHttpRequest.prototype.open;
  w.XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL) {
    record(method, url);
    // eslint-disable-next-line prefer-rest-params
    return open.apply(this, arguments as unknown as Parameters<typeof open>);
  } as typeof open;

  if (typeof w.navigator.sendBeacon === "function") {
    const beacon = w.navigator.sendBeacon.bind(w.navigator);
    Object.defineProperty(w.navigator, "sendBeacon", {
      configurable: true,
      value: (url: string | URL, data?: BodyInit | null) => {
        record("POST", url);
        return beacon(url, data);
      },
    });
  }

  // Nothing in DevLedger opens a socket; refuse rather than count.
  w.WebSocket = class {
    constructor() {
      throw new Error("DevLedger's web app does not open WebSockets");
    }
  } as unknown as typeof WebSocket;
}
