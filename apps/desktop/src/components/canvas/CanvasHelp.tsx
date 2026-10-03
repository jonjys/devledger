// The guide on an empty map, and the short "How it works" card.

export function Guide({ onEmail }: { onEmail: () => void }) {
  return (
    <div className="cv-guide" role="region" aria-label="Getting started">
      <h2>Draw your stack</h2>
      <ol>
        <li>
          <strong>Your email</strong> — the address you sign up to services with.
        </li>
        <li>
          <strong>Services</strong> — drag GitHub, Vercel, Supabase… in from the list on the right. Each one hangs off
          the email it is dropped next to.
        </li>
        <li>
          <strong>Inside a service</strong> — drag from Supabase&apos;s dot to an empty spot to add an organization or
          the projects you have there.
        </li>
        <li>
          <strong>Projects</strong> — e.g. <em>make-it-real</em>. Draw a line from the project to each service it runs on.
        </li>
      </ol>
      <button type="button" className="primary" onClick={onEmail}>
        Add your email
      </button>
    </div>
  );
}

export function HowItWorks({ onClose }: { onClose: () => void }) {
  return (
    <div className="cv-guide small" role="region" aria-label="How it works">
      <ul>
        <li>
          <strong>Connect</strong>: drag from the small dot on a ball to another ball.
        </li>
        <li>
          <strong>Service → email</strong>: who owns it. <strong>Project → service</strong>: what it runs on.
        </li>
        <li>
          <strong>Add something new</strong>: drag from a ball&apos;s dot to an empty spot. From a service you get an
          organization or a project in it; from an organization, a project in it.
        </li>
        <li>
          <strong>Add</strong>: drag from the list on the right, or right-click anywhere. Every ball takes fields with
          names of your own.
        </li>
        <li>
          <strong>Edit</strong>: right-click a ball or a line; double-click to rename.
        </li>
        <li>
          <strong>Several at once</strong>: Shift-drag a box around balls, or Ctrl/⌘-click them, then drag them together.
        </li>
        <li>
          <strong>Undo</strong>: ⌘Z / Ctrl+Z, redo with ⇧⌘Z / Ctrl+Y -- for moves, lines, renames and things you just added.
          Deleting is final, which is why it asks first.
        </li>
        <li>
          <strong>Done editing</strong> locks the layout again: nothing moves or gets deleted until you press Edit map.
        </li>
      </ul>
      <button type="button" onClick={onClose}>
        Got it
      </button>
    </div>
  );
}
