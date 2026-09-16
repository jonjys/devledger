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
set -uo pipefail
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
set -u
"$BIN" & APP=$!
sleep 18
xdotool search --name "DevLedger" windowactivate --sync 2>/dev/null || true
sleep 1
import -window root -display "$DISPLAY" "$OUT/01-onboarding.png"
xdotool type --delay 35 "$PASSPHRASE"
xdotool key Tab; sleep 1
xdotool type --delay 35 "$PASSPHRASE"; sleep 1
xdotool key Return
sleep 6
import -window root -display "$DISPLAY" "$OUT/02-shell.png"
xdotool mousemove 600 80 click 1; sleep 4
import -window root -display "$DISPLAY" "$OUT/03-connections.png"
xdotool mousemove 1141 398 click 1; sleep 3
import -window root -display "$DISPLAY" "$OUT/04-connect-dialog.png"
kill $APP 2>/dev/null
DRIVE
chmod +x "$DATA/drive.sh"

BIN="$PWD/$BIN" OUT="$PWD/$OUT" PASSPHRASE="$PASSPHRASE" XDG_DATA_HOME="$DATA/appdata" \
  timeout 120 xvfb-run -a --server-args="-screen 0 1280x900x24" "$DATA/drive.sh" >/dev/null 2>&1

shots=$(ls "$OUT"/*.png 2>/dev/null | wc -l)
if [ "$shots" -lt 4 ]; then
  echo "UI smoke FAILED: expected 4 screenshots, got $shots"
  exit 1
fi

# A window that failed to load its frontend shows the webview's own error page,
# which is almost entirely white. A rendered DevLedger screen is dark.
if command -v identify >/dev/null 2>&1; then
  mean=$(identify -format "%[fx:int(mean*255)]" "$OUT/02-shell.png" 2>/dev/null || echo 0)
  if [ "$mean" -gt 120 ]; then
    echo "UI smoke FAILED: the shell looks like an error page (mean brightness $mean)"
    exit 1
  fi
fi

echo "UI smoke passed: $shots screenshots in $OUT"
