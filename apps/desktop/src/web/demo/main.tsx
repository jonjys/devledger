// Entry point of the browser demo: the real app, on the in-memory sample vault.

import React from "react";
import ReactDOM from "react-dom/client";

import App from "../../App";
import "../../styles.css";
import "./demo.css";

const REPO = "https://github.com/jonjys/devledger";

function DemoBar() {
  return (
    <div className="demo-bar" role="note">
      <strong>Live demo</strong>
      <span>Sample data only · nothing is saved or sent anywhere · reload to start over · don't paste real keys here</span>
      <span className="demo-bar-links">
        <a href="/">About</a>
        <a href="/#download">Get the desktop app</a>
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
    <DemoBar />
    <div className="demo-app">
      <App />
    </div>
  </React.StrictMode>,
);
