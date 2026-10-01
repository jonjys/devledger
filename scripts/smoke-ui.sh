#!/usr/bin/env bash
# Launch the built desktop app on a virtual display, drive it through
# onboarding, and screenshot each screen.
#
# This is the check that catches what unit tests cannot: that the *shipped*
# binary boots, loads its bundled frontend, and renders. It has already caught
# one real problem -- a binary built with plain `cargo build --release` embeds
# the dev server URL and shows "Could not connect to localhost", because only
# the Tauri CLI sets the release configuration.
#
# Requires: xvfb, xdotool, imagemagick. Linux only; on other platforms run the
# app by hand.
set -euo pipefail
cd "$(dirname "$0")/.."

BIN=target/release/devledger-desktop
OUT=${SMOKE_OUT:-target/smoke}
PASSPHRASE="smoke-test-passphrase-not-a-real-one"

for tool in xvfb-run xdotool import; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing $tool"; exit 127; }
done
[ -x "$BIN" ] || { echo "build it first: (cd apps/desktop && npx tauri build --no-bundle)"; exit 1; }

mkdir -p "$OUT"
DATA=$(mktemp -d)
trap 'rm -rf "$DATA"' EXIT

cat > "$DATA/drive.sh" <<'DRIVE'
#!/usr/bin/env bash
set -euo pipefail
"$BIN" & APP=$!
trap 'kill "$APP" 2>/dev/null || true' EXIT

# WebKit startup time varies considerably on a cold CI runner. Wait for an
# actual visible window instead of taking black desktop screenshots on a timer.
WINDOW=""
for _ in $(seq 1 60); do
  WINDOW=$(xdotool search --onlyvisible --name "DevLedger" 2>/dev/null | tail -1 || true)
  [ -n "$WINDOW" ] && break
  kill -0 "$APP" 2>/dev/null || { echo "DevLedger exited before opening a window"; exit 1; }
  sleep 1
done
[ -n "$WINDOW" ] || { echo "DevLedger did not open a visible window"; exit 1; }
xdotool windowactivate --sync "$WINDOW" 2>/dev/null || xdotool windowfocus "$WINDOW"

# A visible window is not a painted page. Under software rendering WebKit can
# show an all-black surface for several seconds, and typing into it then loses
# the first keystrokes -- which is how a 36-character passphrase arrived as 27.
# Wait until the window actually has content before touching it.
for _ in $(seq 1 60); do
  import -window "$WINDOW" -display "$DISPLAY" "$OUT/01-onboarding.png"
  painted=$(identify -format "%[fx:int(standard_deviation*255)]" "$OUT/01-onboarding.png")
  [ "$painted" -gt 5 ] && break
  sleep 1
done
sleep 1
import -window "$WINDOW" -display "$DISPLAY" "$OUT/01-onboarding.png"

# Click into the passphrase field rather than trusting autofocus to have landed.
xdotool mousemove --window "$WINDOW" 590 363 click 1; sleep 0.5
xdotool type --delay 35 "$PASSPHRASE"
xdotool key Tab; sleep 1
xdotool type --delay 35 "$PASSPHRASE"; sleep 1
xdotool key Return
sleep 6
import -window "$WINDOW" -display "$DISPLAY" "$OUT/02-shell.png"
# Sidebar: Workspace → Connections. Coordinates are inside the DevLedger window,
# so adding or reordering sidebar entries moves the targets. Look at the
# screenshots after any change to the sidebar or to these screens.
xdotool mousemove --window "$WINDOW" 120 308 click 1; sleep 4
import -window "$WINDOW" -display "$DISPLAY" "$OUT/03-connections.png"
# Supabase is the first card in the service grid; its Connect button sits at
# the card's bottom right.
xdotool mousemove --window "$WINDOW" 498 348 click 1; sleep 3
import -window "$WINDOW" -display "$DISPLAY" "$OUT/04-connect-dialog.png"
xdotool key Escape; sleep 1
# Ledger opens as the map. On a fresh vault a guide offers "Add your email".
xdotool mousemove --window "$WINDOW" 120 148 click 1; sleep 4
import -window "$WINDOW" -display "$DISPLAY" "$OUT/06-ledger.png"
# Add the first email from the guide: UI -> IPC -> SQLCipher -> back, and the
# map redraws with the address as a ball in the middle.
xdotool mousemove --window "$WINDOW" 427 518 click 1; sleep 1.5
xdotool type --delay 35 "smoke@example.com"
xdotool key Return; sleep 4
import -window "$WINDOW" -display "$DISPLAY" "$OUT/07-ledger-map.png"
# The List view, where a person is added by name and address.
xdotool mousemove --window "$WINDOW" 848 92 click 1; sleep 3
import -window "$WINDOW" -display "$DISPLAY" "$OUT/08-ledger-list.png"
xdotool mousemove --window "$WINDOW" 1102 138 click 1; sleep 1
xdotool key Tab
xdotool type --delay 35 "second@example.com"
xdotool key Return; sleep 3
import -window "$WINDOW" -display "$DISPLAY" "$OUT/09-ledger-person.png"
# Phone-sized window. The shell must collapse the sidebar into a bottom bar.
xdotool windowsize "$WINDOW" 390 844
sleep 2
import -window "$WINDOW" -display "$DISPLAY" "$OUT/05-phone.png"
DRIVE
chmod +x "$DATA/drive.sh"

BIN="$PWD/$BIN" OUT="$PWD/$OUT" PASSPHRASE="$PASSPHRASE" XDG_DATA_HOME="$DATA/appdata" \
  timeout 120 xvfb-run -a --server-args="-screen 0 1280x900x24" "$DATA/drive.sh"

shots=$(ls "$OUT"/*.png 2>/dev/null | wc -l)
if [ "$shots" -lt 9 ]; then
  echo "UI smoke FAILED: expected 9 screenshots, got $shots"
  exit 1
fi

# Reject both a white webview error page and the black screenshots that a slow
# startup used to produce. A real DevLedger screen has visible contrast.
for shot in "$OUT"/*.png; do
  mean=$(identify -format "%[fx:int(mean*255)]" "$shot")
  deviation=$(identify -format "%[fx:int(standard_deviation*255)]" "$shot")
  if [ "$mean" -gt 120 ] || [ "$deviation" -lt 8 ]; then
    echo "UI smoke FAILED: $(basename "$shot") is blank/error-like (mean $mean, deviation $deviation)"
    exit 1
  fi
done

# The screenshots must represent distinct states. This proves the automation
# reached the shell, changed to Connections, opened the Supabase dialog, added
# an address from the map, and added a person from the list. A click
# that lands on nothing changes almost no pixels -- a hover highlight at most --
# so each step must change a real share of the window.
for pair in "02-shell.png 03-connections.png" "03-connections.png 04-connect-dialog.png" \
            "06-ledger.png 07-ledger-map.png" "08-ledger-list.png 09-ledger-person.png"; do
  read -r before after <<<"$pair"
  changed=$(compare -metric AE "$OUT/$before" "$OUT/$after" null: 2>&1 || true)
  if [ "${changed:-0}" -lt 20000 ]; then
    echo "UI smoke FAILED: $after did not visibly change from $before"
    exit 1
  fi
done

# The map must actually draw the new ball. An empty canvas still has its dot
# grid and controls, so it passes the checks above; the main email is a large
# orange ball in the middle of the canvas, which lifts the brightness there.
centre=$(convert "$OUT/07-ledger-map.png" -crop 300x300+412+281 -format "%[fx:int(mean*255)]" info:)
if [ "$centre" -lt 20 ]; then
  echo "UI smoke FAILED: 07-ledger-map.png has no email ball in the middle (brightness $centre)"
  exit 1
fi

phone_w=$(identify -format "%w" "$OUT/05-phone.png")
phone_h=$(identify -format "%h" "$OUT/05-phone.png")
if [ "$phone_h" -le "$phone_w" ]; then
  echo "UI smoke FAILED: phone window is not portrait (${phone_w}x${phone_h})"
  exit 1
fi

echo "UI smoke passed: $shots screenshots in $OUT"
