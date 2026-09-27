import { useCallback, useEffect, useState } from "react";

import * as api from "../lib/api";
import type { CustomField, EntityRef, SecretOwner } from "../lib/types";

interface Props {
  /** What the fields are attached to. */
  entity: EntityRef;
  /** Where a hidden field is sealed. Omit where no secret can be filed. */
  secretOwner?: SecretOwner;
  onNotify: (message: string, bad?: boolean) => void;
  /** Called after a hidden field is stored, so its secret list can reload. */
  onSecretStored?: () => void;
}

/** Labels people reach for most, offered as suggestions. Anything else is fine too. */
export const FIELD_SUGGESTIONS = [
  "Username",
  "Customer number",
  "Support PIN",
  "Recovery email",
  "Phone",
  "Project",
  "Plan",
  "Renews",
  "Security question",
  "Note",
];

/**
 * Fields the user names themselves.
 *
 * For whatever no built-in field covers: a customer number, a support PIN, the
 * username on some forum, which project a plan is paid for. A field is shown in
 * the clear. Ticking "Hide value" stores it as a secret instead -- sealed, shown
 * masked, and only readable with Reveal -- which is the right home for anything
 * that would let someone into the account.
 */
export default function FieldsEditor({ entity, secretOwner, onNotify, onSecretStored }: Props) {
  const [fields, setFields] = useState<CustomField[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  // `entity` is usually a fresh object each render; what identifies it is
  // kind + id, so those are what the loader depends on.
  const { kind, id } = entity;
  const load = useCallback(async () => {
    try {
      setFields(await api.customFields({ kind, id }));
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }, [kind, id, onNotify]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(field: CustomField) {
    if (!window.confirm(`Remove the field "${field.label}"?`)) return;
    try {
      await api.deleteCustomField(field.id);
      onNotify(`Removed ${field.label}`);
      await load();
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  return (
    <div className="fields" aria-label="Fields">
      {fields && fields.length > 0 && (
        <dl className="field-list">
          {fields.map((field) =>
            editing === field.id ? (
              <FieldForm
                key={field.id}
                initialLabel={field.label}
                initialValue={field.value}
                submitLabel="Save"
                onCancel={() => setEditing(null)}
                onSubmit={async (label, value) => {
                  await api.updateCustomField(field.id, label, value);
                  onNotify(`Saved ${label}`);
                  setEditing(null);
                  await load();
                }}
                onNotify={onNotify}
              />
            ) : (
              <div key={field.id} className="field-row">
                <dt>{field.label}</dt>
                <dd>{field.value || <span className="muted">—</span>}</dd>
                <span className="row-acts">
                  <button
                    type="button"
                    className="ghost tiny"
                    aria-label={`Edit ${field.label}`}
                    onClick={() => setEditing(field.id)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="ghost tiny danger"
                    aria-label={`Remove ${field.label}`}
                    onClick={() => void remove(field)}
                  >
                    Remove
                  </button>
                </span>
              </div>
            ),
          )}
        </dl>
      )}

      {adding ? (
        <FieldForm
          submitLabel="Add field"
          canHide={Boolean(secretOwner)}
          onCancel={() => setAdding(false)}
          onNotify={onNotify}
          onSubmit={async (label, value, hidden) => {
            if (hidden && secretOwner) {
              await api.storeSecret(
                { owner: secretOwner, kind: "env_var", name: label, environment: "unknown", notes: null },
                value,
              );
              onNotify(`Stored ${label} encrypted`);
              onSecretStored?.();
            } else {
              await api.addCustomField(entity, label, value);
              onNotify(`Added ${label}`);
              await load();
            }
            setAdding(false);
          }}
        />
      ) : (
        <button type="button" className="ghost tiny" onClick={() => setAdding(true)}>
          + Field
        </button>
      )}
    </div>
  );
}

function FieldForm({
  initialLabel = "",
  initialValue = "",
  submitLabel,
  canHide = false,
  onCancel,
  onSubmit,
  onNotify,
}: {
  initialLabel?: string;
  initialValue?: string;
  submitLabel: string;
  canHide?: boolean;
  onCancel: () => void;
  onSubmit: (label: string, value: string, hidden: boolean) => Promise<void>;
  onNotify: (message: string, bad?: boolean) => void;
}) {
  const [label, setLabel] = useState(initialLabel);
  const [value, setValue] = useState(initialValue);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy || !label.trim()) return;
    if (hidden && !value) return;
    setBusy(true);
    try {
      await onSubmit(label.trim(), value, hidden);
      setValue("");
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="inline-form field-form"
      aria-label={submitLabel === "Save" ? "Edit field" : "New field"}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        autoFocus
        aria-label="Field name"
        list="field-suggestions"
        placeholder="Name, e.g. Customer number"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <datalist id="field-suggestions">
        {FIELD_SUGGESTIONS.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <input
        aria-label="Field value"
        type={hidden ? "password" : "text"}
        autoComplete="off"
        placeholder="Value"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {canHide && (
        <label className="check">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          Hide value (encrypt as a secret)
        </label>
      )}
      <button type="submit" className="primary" disabled={busy || !label.trim() || (hidden && !value)}>
        {submitLabel}
      </button>
      <button type="button" className="ghost" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
