import { useEffect, type ReactNode } from "react";

interface Props {
  /** Accessible name for the dialog. */
  label: string;
  onClose: () => void;
  children: ReactNode;
  /** Max width of the sheet, in pixels. */
  maxWidth?: number;
}

/**
 * A modal sheet that closes when the backdrop is clicked or Escape is pressed.
 *
 * Clicks inside the sheet are stopped before they reach the backdrop, so only a
 * genuine click *outside* the panel dismisses it. This is the shared behaviour
 * every drawer and dialog in DevLedger uses.
 */
export default function Modal({ label, onClose, children, maxWidth }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={onClose}
    >
      <div
        className="sheet"
        style={maxWidth ? { maxWidth } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
