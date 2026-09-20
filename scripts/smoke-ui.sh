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
sleep 2
import -window "$WINDOW" -display "$DISPLAY" "$OUT/01-onboarding.png"
xdotool type --delay 35 "$PASSPHRASE"
xdotool key Tab; sleep 1
xdotool type --delay 35 "$PASSPHRASE"; sleep 1
xdotool key Return
sleep 6
import -window "$WINDOW" -display "$DISPLAY" "$OUT/02-shell.png"
xdotool mousemove --window "$WINDOW" 500 30 click 1; sleep 4
import -window "$WINDOW" -display "$DISPLAY" "$OUT/03-connections.png"
xdotool mousemove --window "$WINDOW" 830 390 click 1; sleep 3
import -window "$WINDOW" -display "$DISPLAY" "$OUT/04-connect-dialog.png"
DRIVE
chmod +x "$DATA/drive.sh"

BIN="$PWD/$BIN" OUT="$PWD/$OUT" PASSPHRASE="$PASSPHRASE" XDG_DATA_HOME="$DATA/appdata" \
  timeout 120 xvfb-run -a --server-args="-screen 0 1280x900x24" "$DATA/drive.sh"

shots=$(ls "$OUT"/*.png 2>/dev/null | wc -l)
if [ "$shots" -lt 4 ]; then
  echo "UI smoke FAILED: expected 4 screenshots, got $shots"
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
# reached the shell, changed to Connections, and opened a service dialog.
for pair in "02-shell.png 03-connections.png" "03-connections.png 04-connect-dialog.png"; do
  read -r before after <<<"$pair"
  changed=$(compare -metric AE "$OUT/$before" "$OUT/$after" null: 2>&1 || true)
  if [ "${changed:-0}" -lt 1000 ]; then
    echo "UI smoke FAILED: $after did not visibly change from $before"
    exit 1
  fi
done

echo "UI smoke passed: $shots screenshots in $OUT"
