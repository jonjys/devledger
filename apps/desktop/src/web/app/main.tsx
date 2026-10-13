// Entry point of the web app: the real app, on an encrypted vault that lives in
// this browser. Same UI and command table as the demo; it starts empty, asks
// for a passphrase, and seals every change into the browser's storage.

// First, before any other module is evaluated: start counting requests.
import "./watch";

import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import ReactDOM from "react-dom/client";

import App from "../../App";
import "../../styles.css";
import "../demo/demo.css";
import { runOnPersistentVault } from "../demo/backend";
import { onRequest, requests } from "./netwatch";
import { BrowserVault, exportBackup, localBacking, restoreBackup } from "./store";

const REPO = "https://github.com/jonjys/devledger";
const TIP_DISMISSED = "devledger.tip.no-keys";

runOnPersistentVault(new BrowserVault(localBacking));

const remember = (key: string) => {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Storage blocked: the tip just shows again next time.
  }
};
const remembered = (key: string) => {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};

/** Whether this browser holds a vault yet. Rechecked, since creating one happens inside the app. */
function useHasVault(): boolean {
  const [has, setHas] = useState(() => exportBackup(localBacking) !== null);
  useEffect(() => {
    const id = window.setInterval(() => setHas(exportBackup(localBacking) !== null), 1500);
    return () => window.clearInterval(id);
  }, []);
  return has;
}

/** The live count of requests that could carry data out of this page. */
function RequestCounter() {
  const list = useSyncExternalStore(onRequest, requests);
  const n = list.length;
  return (
    <details className={`net ${n ? "net-some" : "net-none"}`}>
      <summary title="Requests this page has sent since you opened it">
        <span className="net-dot" aria-hidden="true" />
        {n === 0 ? "0 requests sent" : `${n} request${n === 1 ? "" : "s"} sent`}
      </summary>
      <div className="net-pop">
        <p>
          Every request this page makes that could carry data out of it is counted here: fetch, XHR and beacons.
          Your vault never needs one. The only one DevLedger makes is when you press a button in{" "}
          <strong>Assistant</strong>, which sends the outline you can read first under “What is sent?”.
        </p>
        {n > 0 && (
          <ul>
            {list.map((r, i) => (
              <li key={i}>
                <code>
                  {r.method} {r.host}
                  {r.path}
                </code>
              </li>
            ))}
          </ul>
        )}
        <p>
          Don't take our word for it: open your browser's developer tools, go to the Network tab and use the app.{" "}
          <a href="/trust#verify">How to check</a>
        </p>
      </div>
    </details>
  );
}

function BackupControls({ hasVault }: { hasVault: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  function download() {
    const text = exportBackup(localBacking);
    if (!text) return;
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `devledger-backup-${new Date().toISOString().slice(0, 10)}.devledger`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function restore(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      restoreBackup(localBacking, await file.text());
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (hasVault) {
    return (
      <button
        type="button"
        className="bar-btn"
        onClick={download}
        title="Download your vault, still encrypted with your passphrase"
      >
        Backup
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        className="bar-btn"
        onClick={() => input.current?.click()}
        title="Open a backup file made with the Backup button"
      >
        Restore backup
      </button>
      <input
        ref={input}
        type="file"
        accept=".devledger,application/json"
        hidden
        onChange={(e) => void restore(e.target.files?.[0])}
      />
      {error && (
        <span className="bar-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

function AppBar() {
  const hasVault = useHasVault();
  return (
    <div className="demo-bar app-bar" role="note">
      <strong>Web app · beta</strong>
      <span>Encrypted with your passphrase, kept in this browser only · no account, no server</span>
      <span className="demo-bar-links">
        <RequestCounter />
        <BackupControls hasVault={hasVault} />
        <a href="/trust">Trust</a>
        <a href="/">About</a>
        <a href={REPO} target="_blank" rel="noreferrer">
          Source
        </a>
      </span>
    </div>
  );
}

/** First-visit advice: the map is worth having before a single key goes in. */
function StartTip() {
  const [hidden, setHidden] = useState(() => remembered(TIP_DISMISSED));
  if (hidden) return null;
  return (
    <div className="start-tip" role="note">
      <strong>Start without keys.</strong>
      <span>
        Add your emails, accounts, projects and what they cost first. The map, Costs and Needs attention work with names
        alone. Add keys when you trust it, or keep production keys in the{" "}
        <a href="/#download">desktop app</a>. Use <strong>Backup</strong> now and then: clearing this site's data
        deletes the vault.
      </span>
      <button
        type="button"
        aria-label="Hide this tip"
        onClick={() => {
          remember(TIP_DISMISSED);
          setHidden(true);
        }}
      >
        ×
      </button>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root element");
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <div className="web-shell">
      <AppBar />
      <StartTip />
      <div className="demo-app">
        <App />
      </div>
    </div>
  </React.StrictMode>,
);
