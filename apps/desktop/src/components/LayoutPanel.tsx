import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useState } from "react";

import {
  ALL_VIEWS,
  BUILTIN_TEMPLATES,
  LIMITS,
  applyTemplate,
  move,
  parseTemplate,
  recommendedLayout,
  templateCode,
  templateFrom,
  type Layout,
  type Template,
  type ViewId,
} from "../lib/layout";

export const VIEW_LABEL: Record<ViewId, string> = {
  home: "Home",
  projects: "Projects",
  ledger: "Ledger",
  assistant: "Assistant",
  connections: "Connections",
  subscriptions: "Subscriptions",
  secrets: "Secrets",
  attention: "Needs attention",
};

interface Props {
  layout: Layout;
  onLayout: (next: Layout) => void;
  onClose: () => void;
  onNotify: (message: string, bad?: boolean) => void;
}

type Tab = "templates" | "menu";

/**
 * Templates and the menu: pick a ready-made layout, save your own, share one
 * as a code or import one, and choose which tabs show, in what order, and
 * where the app opens.
 */
export default function LayoutPanel({ layout, onLayout, onClose, onNotify }: Props) {
  const [tab, setTab] = useState<Tab>("templates");
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [importing, setImporting] = useState(false);
  const [code, setCode] = useState("");

  function use(t: Template) {
    const notes = layout.boxes.filter((b) => b.kind === "note" && (b.text ?? "").trim()).length;
    const warn = notes
      ? ` Your current boxes, including ${notes === 1 ? "a note" : `${notes} notes`}, will be replaced. Save them as a template first if you want to keep them.`
      : " Your current boxes will be replaced.";
    if (!window.confirm(`Use "${t.name}"?${warn}`)) return;
    onLayout(applyTemplate(layout, t));
    onNotify(`Using “${t.name}”`);
    onClose();
  }

  function save() {
    if (layout.templates.length >= LIMITS.templates) {
      onNotify(`You can keep up to ${LIMITS.templates} templates. Delete one first.`, true);
      return;
    }
    const t = templateFrom(layout, name, description);
    onLayout({ ...layout, templates: [...layout.templates, t] });
    setSaving(false);
    setName("");
    setDescription("");
    onNotify(`Saved “${t.name}”`);
  }

  async function share(t: Template) {
    const notes = t.boxes.filter((b) => b.kind === "note" && (b.text ?? "").trim()).length;
    if (
      !t.builtin &&
      notes > 0 &&
      !window.confirm(`The code includes the text of ${notes === 1 ? "your note" : `${notes} notes`}. Share it?`)
    ) {
      return;
    }
    try {
      await writeText(templateCode(t));
      onNotify(`Copied “${t.name}”. Paste it to someone; they use Import template.`);
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  function importCode() {
    const t = parseTemplate(code);
    if (!t) {
      onNotify("That is not a DevLedger template code. It starts with devledger-template:", true);
      return;
    }
    if (layout.templates.length >= LIMITS.templates) {
      onNotify(`You can keep up to ${LIMITS.templates} templates. Delete one first.`, true);
      return;
    }
    onLayout({ ...layout, templates: [...layout.templates, t] });
    setImporting(false);
    setCode("");
    onNotify(`Imported “${t.name}”. Press Use to try it.`);
  }

  function remove(t: Template) {
    if (!window.confirm(`Delete the template "${t.name}"? Your current layout stays as it is.`)) return;
    onLayout({ ...layout, templates: layout.templates.filter((x) => x.id !== t.id) });
  }

  // --- the menu ---
  const hidden = ALL_VIEWS.filter((v) => !layout.tabs.includes(v));
  const setTabs = (tabs: ViewId[]) =>
    onLayout({ ...layout, tabs, start: tabs.includes(layout.start) ? layout.start : tabs[0]! });

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet layout-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Templates and menu"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <header>
          <h2>Make it yours</h2>
          <p>Start from a template, save your own and share it, and choose what the menu shows.</p>
          <div className="seg layout-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "templates"} className={tab === "templates" ? "active" : ""} onClick={() => setTab("templates")}>
              Templates
            </button>
            <button type="button" role="tab" aria-selected={tab === "menu"} className={tab === "menu" ? "active" : ""} onClick={() => setTab("menu")}>
              Menu
            </button>
          </div>
        </header>

        <div className="scroll">
          {tab === "templates" ? (
            <>
              <h3 className="layout-h">Ready-made</h3>
              <div className="tpl-grid">
                {BUILTIN_TEMPLATES.map((t) => (
                  <TemplateCard key={t.id} t={t} onUse={() => use(t)} onShare={() => void share(t)} />
                ))}
              </div>

              <h3 className="layout-h">Yours</h3>
              {layout.templates.length === 0 && (
                <p className="muted-p">Arrange your home page, then save it here to come back to or share.</p>
              )}
              <div className="tpl-grid">
                {layout.templates.map((t) => (
                  <TemplateCard
                    key={t.id}
                    t={t}
                    onUse={() => use(t)}
                    onShare={() => void share(t)}
                    onDelete={() => remove(t)}
                  />
                ))}
              </div>

              {saving ? (
                <div className="tpl-form">
                  <label>
                    Name
                    <input value={name} maxLength={LIMITS.name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="My launch week" />
                  </label>
                  <label>
                    What it's for <span className="muted">(optional)</span>
                    <input
                      value={description}
                      maxLength={LIMITS.description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Costs and a checklist for shipping"
                    />
                  </label>
                  <p className="muted small">
                    Saves your boxes, their titles, note text, menu order and start page. Never ledger data or keys.
                  </p>
                  <div className="tpl-acts">
                    <button type="button" className="primary tiny" onClick={save}>
                      Save template
                    </button>
                    <button type="button" className="link-btn" onClick={() => setSaving(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : importing ? (
                <div className="tpl-form">
                  <label>
                    Template code
                    <textarea
                      value={code}
                      autoFocus
                      rows={3}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="devledger-template:…"
                    />
                  </label>
                  <p className="muted small">
                    A template only arranges boxes and notes. It cannot read your ledger or send anything.
                  </p>
                  <div className="tpl-acts">
                    <button type="button" className="primary tiny" onClick={importCode} disabled={!code.trim()}>
                      Import
                    </button>
                    <button type="button" className="link-btn" onClick={() => setImporting(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="tpl-acts">
                  <button type="button" className="outline tiny" onClick={() => setSaving(true)}>
                    Save current layout as a template
                  </button>
                  <button type="button" className="outline tiny" onClick={() => setImporting(true)}>
                    Import template
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <h3 className="layout-h">Shown, in this order</h3>
              <p className="muted small">On a phone the first four sit in the bottom bar; the rest are under More.</p>
              <ol className="menu-list">
                {layout.tabs.map((v, i) => (
                  <li key={v}>
                    <span className="menu-pos">{i + 1}</span>
                    <span className="menu-name">{VIEW_LABEL[v]}</span>
                    <button type="button" className="icon-btn" aria-label={`Move ${VIEW_LABEL[v]} up`} disabled={i === 0} onClick={() => setTabs(move(layout.tabs, i, -1))}>
                      ↑
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Move ${VIEW_LABEL[v]} down`}
                      disabled={i === layout.tabs.length - 1}
                      onClick={() => setTabs(move(layout.tabs, i, 1))}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Hide ${VIEW_LABEL[v]}`}
                      disabled={v === "home"}
                      title={v === "home" ? "Home stays, so your layout is always one tap away" : "Hide"}
                      onClick={() => setTabs(layout.tabs.filter((x) => x !== v))}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ol>

              {hidden.length > 0 && (
                <>
                  <h3 className="layout-h">Hidden</h3>
                  <div className="menu-hidden">
                    {hidden.map((v) => (
                      <button key={v} type="button" className="outline tiny" onClick={() => setTabs([...layout.tabs, v])}>
                        + {VIEW_LABEL[v]}
                      </button>
                    ))}
                  </div>
                </>
              )}

              <h3 className="layout-h">Open on</h3>
              <select
                aria-label="Start page"
                value={layout.start}
                onChange={(e) => onLayout({ ...layout, start: e.target.value as ViewId })}
              >
                {layout.tabs.map((v) => (
                  <option key={v} value={v}>
                    {VIEW_LABEL[v]}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>

        <footer>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              if (!window.confirm("Go back to the recommended layout and menu? Your saved templates stay.")) return;
              onLayout({ ...recommendedLayout(), templates: layout.templates });
              onNotify("Back to the recommended layout");
            }}
          >
            Reset to recommended
          </button>
          <span className="spacer" />
          <button type="button" className="primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

function TemplateCard({
  t,
  onUse,
  onShare,
  onDelete,
}: {
  t: Template;
  onUse: () => void;
  onShare: () => void;
  onDelete?: () => void;
}) {
  return (
    <article className="tpl-card">
      <strong>{t.name}</strong>
      {t.description && <p>{t.description}</p>}
      <p className="muted small">{t.boxes.length} boxes</p>
      <div className="tpl-acts">
        <button type="button" className="primary tiny" onClick={onUse} aria-label={`Use ${t.name}`}>
          Use
        </button>
        <button type="button" className="outline tiny" onClick={onShare} aria-label={`Share ${t.name}`}>
          Share
        </button>
        {onDelete && (
          <button type="button" className="link-btn" onClick={onDelete} aria-label={`Delete ${t.name}`}>
            Delete
          </button>
        )}
      </div>
    </article>
  );
}
