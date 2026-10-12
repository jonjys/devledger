// Entry point of the web app: the real app, on an encrypted vault that lives in
// this browser. Same UI and command table as the demo; it starts empty, asks
// for a passphrase, and seals every change into the browser's storage.

import React from "react";
import ReactDOM from "react-dom/client";

import App from "../../App";
import "../../styles.css";
import "../demo/demo.css";
import { runOnPersistentVault } from "../demo/backend";
import { BrowserVault, localBacking } from "./store";

const REPO = "https://github.com/jonjys/devledger";

runOnPersistentVault(new BrowserVault(localBacking));

function AppBar() {
  return (
    <div className="demo-bar app-bar" role="note">
      <strong>Web app · beta</strong>
      <span>
        Encrypted with your passphrase and kept in this browser only · no account, no server · clearing site
        data deletes it
      </span>
      <span className="demo-bar-links">
        <a href="/">About</a>
        <a href="/demo">Demo</a>
        <a href="/#download">Desktop app</a>
        <a href={REPO} target="_blank" rel="noreferrer">
          Source
        </a>
      </span>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root element");
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <AppBar />
    <div className="demo-app">
      <App />
    </div>
  </React.StrictMode>,
);
