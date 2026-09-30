#!/usr/bin/env bash
# Launch the built desktop app on a virtual display, drive it through
# onboarding, and screenshot each screen.
#
# This catches what unit tests cannot: that the shipped binary boots, loads its
# bundled frontend, renders, and accepts real clicks through the workspace map.
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

WINDOW=""
for _ in $(seq 1 60); do
  WINDOW=$(xdotool search --onlyvisible --name "DevLedger" 2>/dev/null | tail -1 || true)
  [ -n "$WINDOW" ] && break
  kill -0 "$APP" 2>/dev/null || { echo "DevLedger exited before opening a window"; exit 1; }
  sleep 1
done
[ -n "$WINDOW" ] || { echo "DevLedger did not open a visible window"; exit 1; }
xdotool windowactivate --sync "$WINDOW" 2>/dev/null || xdotool windowfocus "$WINDOW"

for _ in $(seq 1 60); do
  import -window "$WINDOW" -display "$DISPLAY" "$OUT/01-onboarding.png"
  painted=$(identify -format "%[fx:int(standard_deviation*255)]" "$OUT/01-onboarding.png")
  [ "$painted" -gt 5 ] && break
  sleep 1
done
sleep 1
import -window "$WINDOW" -display "$DISPLAY" "$OUT/01-onboarding.png"

xdotool mousemove --window "$WINDOW" 590 363 click 1; sleep 0.5
xdotool type --delay 35 "$PASSPHRASE"
xdotool key Tab; sleep 1
xdotool type --delay 35 "$PASSPHRASE"; sleep 1
xdotool key Return
sleep 6
import -window "$WINDOW" -display "$DISPLAY" "$OUT/02-shell.png"

xdotool mousemove --window "$WINDOW" 120 308 click 1; sleep 4
import -window "$WINDOW" -display "$DISPLAY" "$OUT/03-connections.png"
xdotool mousemove --window "$WINDOW" 498 348 click 1; sleep 3
import -window "$WINDOW" -display "$DISPLAY" "$OUT/04-connect-dialog.png"
xdotool key Escape; sleep 1

# Ledger now opens as the free workspace map, not the old email-rooted tree.
xdotool mousemove --window "$WINDOW" 120 148 click 1; sleep 4
import -window "$WINDOW" -display "$DISPLAY" "$OUT/06-ledger.png"

# Add an identity through the compact right-side library.
xdotool mousemove --window "$WINDOW" 1140 270 click 1; sleep 1
xdotool type --delay 35 "smoke@example.com"
xdotool key Tab Tab Tab Return; sleep 4
import -window "$WINDOW" -display "$DISPLAY" "$OUT/07-ledger-map.png"

# Map/List floats at the top edge of the canvas, clear of the map lock controls.
xdotool mousemove --window "$WINDOW" 980 150 click 1; sleep 3
import -window "$WINDOW" -display "$DISPLAY" "$OUT/08-ledger-list.png"
xdotool mousemove --window "$WINDOW" 1102 138 click 1; sleep 1
xdotool key Tab
xdotool type --delay 35 "second@example.com"
xdotool key Return; sleep 3
import -window "$WINDOW" -display "$DISPLAY" "$OUT/09-ledger-person.png"

xdotool windowsize "$WINDOW" 390 844
sleep 2
import -window "$WINDOW" -display "$DISPLAY" "$OUT/05-phone.png"
DRIVE
chmod +x "$DATA/drive.sh"

BIN="$PWD/$BIN" OUT="$PWD/$OUT" PASSPHRASE="$PASSPHRASE" XDG_DATA_HOME="$DATA/appdata" \
  timeout 120 xvfb-run -a --server-args="-screen 0 1280x900x24" "$DATA/drive.sh"

shots=$(ls "$OUT"/*.png 2>/dev/null | wc -l)
if [ "$shots" -lt 9 ]; then echo "UI smoke FAILED: expected 9 screenshots, got $shots"; exit 1; fi

for shot in "$OUT"/*.png; do
  mean=$(identify -format "%[fx:int(mean*255)]" "$shot")
  deviation=$(identify -format "%[fx:int(standard_deviation*255)]" "$shot")
  if [ "$mean" -gt 120 ] || [ "$deviation" -lt 8 ]; then echo "UI smoke FAILED: $(basename "$shot") is blank/error-like (mean $mean, deviation $deviation)"; exit 1; fi
done

for pair in "02-shell.png 03-connections.png" "03-connections.png 04-connect-dialog.png" \
            "06-ledger.png 07-ledger-map.png" "08-ledger-list.png 09-ledger-person.png"; do
  read -r before after <<<"$pair"
  changed=$(compare -metric AE "$OUT/$before" "$OUT/$after" null: 2>&1 || true)
  if [ "${changed:-0}" -lt 20000 ]; then echo "UI smoke FAILED: $after did not visibly change from $before"; exit 1; fi
done

phone_w=$(identify -format "%w" "$OUT/05-phone.png")
phone_h=$(identify -format "%h" "$OUT/05-phone.png")
if [ "$phone_h" -le "$phone_w" ]; then echo "UI smoke FAILED: phone window is not portrait (${phone_w}x${phone_h})"; exit 1; fi

echo "UI smoke passed: $shots screenshots in $OUT"
