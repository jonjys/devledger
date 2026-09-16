import { useState, type FormEvent } from "react";

import { ApiError, vaultInitialize, vaultUnlock } from "../lib/api";
import type { VaultStatus } from "../lib/types";

const MIN_PASSPHRASE = 12;

interface Props {
  status: VaultStatus;
  onOpened: (status: VaultStatus) => void;
}

/**
 * Onboarding and unlock.
 *
 * A vault that does not exist yet gets the create flow (passphrase twice, with
 * the irrecoverability stated plainly, because there is no reset path by
 * design). An existing vault gets the unlock flow.
 */
export default function UnlockScreen({ status, onOpened }: Props) {
  const onboarding = !status.initialized;
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE;
  const mismatch = onboarding && confirmation.length > 0 && passphrase !== confirmation;
  const ready =
    passphrase.length >= MIN_PASSPHRASE && (!onboarding || passphrase === confirmation);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = onboarding
        ? await vaultInitialize(passphrase)
        : await vaultUnlock(passphrase);
      // Drop the passphrase from component state as soon as it has been used.
      setPassphrase("");
      setConfirmation("");
      onOpened(next);
    } catch (raw) {
      const message =
        raw instanceof ApiError && raw.code === "invalid_passphrase"
          ? "That passphrase does not open this vault."
          : raw instanceof Error
            ? raw.message
            : "Something went wrong.";
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <div className="gate-mark" />
        <h1>{onboarding ? "Create your vault" : "Unlock DevLedger"}</h1>
        <p className="sub">
          {onboarding
            ? "Everything stays on this machine, encrypted with this passphrase."
            : "Your ledger is encrypted at rest. Enter your passphrase to open it."}
        </p>

        {error && <div className="error" role="alert">{error}</div>}

        <div className="field">
          <label htmlFor="passphrase">Passphrase</label>
          <input
            id="passphrase"
            type="password"
            autoFocus
            autoComplete={onboarding ? "new-password" : "current-password"}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            aria-describedby={tooShort ? "passphrase-hint" : undefined}
          />
          {tooShort && (
            <p id="passphrase-hint" className="sub" style={{ marginTop: 6, fontSize: 12 }}>
              At least {MIN_PASSPHRASE} characters.
            </p>
          )}
        </div>

        {onboarding && (
          <div className="field">
            <label htmlFor="confirmation">Confirm passphrase</label>
            <input
              id="confirmation"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
            {mismatch && (
              <p className="sub" style={{ marginTop: 6, fontSize: 12, color: "var(--crit)" }}>
                The two passphrases do not match.
              </p>
            )}
          </div>
        )}

        <div className="actions">
          <button type="submit" className="primary" disabled={!ready || busy}>
            {busy
              ? onboarding
                ? "Creating…"
                : "Unlocking…"
              : onboarding
                ? "Create vault"
                : "Unlock"}
          </button>
        </div>

        {onboarding && (
          <div className="note">
            There is no recovery path. DevLedger never sends your passphrase anywhere,
            so if you lose it the vault cannot be opened by anyone, including us.
          </div>
        )}
      </form>
    </div>
  );
}
