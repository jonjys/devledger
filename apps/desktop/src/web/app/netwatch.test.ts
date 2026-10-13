// The web app's request counter must see every way a page sends data on its own.

import { install, onRequest, requests } from "./netwatch";

describe("request counter", () => {
  it("counts fetch, XHR and beacons, and refuses WebSockets", async () => {
    const calls: string[] = [];
    window.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("{}");
    }) as typeof fetch;
    Object.defineProperty(window.navigator, "sendBeacon", {
      configurable: true,
      value: () => true,
    });
    install(window);
    install(window); // twice is harmless

    let heard = 0;
    const stop = onRequest(() => (heard += 1));
    await window.fetch("/api/assistant", { method: "POST", body: "{}" });
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://api.github.com/repos/x/y");
    window.navigator.sendBeacon("/collect", "x");
    stop();

    expect(calls).toEqual(["/api/assistant"]);
    expect(requests().map((r) => `${r.method} ${r.host}${r.path}`)).toEqual([
      `POST ${window.location.host}/api/assistant`,
      "GET api.github.com/repos/x/y",
      `POST ${window.location.host}/collect`,
    ]);
    expect(heard).toBe(3);
    expect(() => new WebSocket("wss://example.com")).toThrow(/does not open WebSockets/);
  });
});
