#!/usr/bin/env bash
# Launch the built desktop app on a virtual display, drive it through
# onboarding, and screenshot each screen. This catches failures that unit
# tests cannot: shipped WebKit rendering, real clicks, and the workspace map.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${SMOKE_OUT:-$ROOT/artifacts/ui-smoke}"
mkdir -p "$OUT"
rm -f "$OUT"/*.png

export DISPLAY="${DISPLAY:-:99}"
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export LIBGL_ALWAYS_SOFTWARE=1
export GDK_BACKEND=x11

cleanup() {
  if [[ -n "${APP_PID:-}" ]]; then kill "$APP_PID" 2>/dev/null || true; fi
  if [[ -n "${XVFB_PID:-}" ]]; then kill "$XVFB_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  Xvfb "$DISPLAY" -screen 0 1280x900x24 -ac +extension GLX +render -noreset >/tmp/devledger-xvfb.log 2>&1 &
  XVFB_PID=$!
  for _ in $(seq 1 30); do xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break; sleep .2; done
fi

# Tauri needs a desktop D-Bus session for the Linux keyring plugin. CI has no
# login session, so start an isolated bus + Secret Service and unlock it.
if command -v dbus-daemon >/dev/null 2>&1 && command -v gnome-keyring-daemon >/dev/null 2>&1; then
  eval "$(dbus-launch --sh-syntax)"
  eval "$(printf '' | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null || true)"
fi

BIN="${DEVLEDGER_BIN:-$ROOT/target/debug/devledger}"
if [[ ! -x "$BIN" ]]; then echo "smoke: missing executable $BIN" >&2; exit 1; fi

rm -rf "$HOME/.local/share/com.nyttolabs.devledger"
"$BIN" >"$OUT/app.log" 2>&1 &
APP_PID=$!

WINDOW=""
for _ in $(seq 1 120); do
  WINDOW=$(xdotool search --onlyvisible --name 'DevLedger' 2>/dev/null | head -n1 || true)
  [[ -n "$WINDOW" ]] && break
  sleep .25
done
if [[ -z "$WINDOW" ]]; then echo "smoke: DevLedger window did not appear" >&2; cat "$OUT/app.log" >&2 || true; exit 1; fi
xdotool windowactivate --sync "$WINDOW"
xdotool windowsize "$WINDOW" 1280 900
xdotool windowmove "$WINDOW" 0 0
sleep 1

# Fresh vault setup.
xdotool mousemove 640 380 click 1
xdotool type --delay 20 'SmokePass-2026!'
xdotool key Tab
xdotool type --delay 20 'SmokePass-2026!'
xdotool key Tab Tab Return
sleep 3
import -window root "$OUT/01-home.png"

# Open Ledger. The frame must change materially.
xdotool mousemove 78 151 click 1
sleep 2
import -window root "$OUT/02-ledger-empty.png"
python3 - "$OUT/01-home.png" "$OUT/02-ledger-empty.png" <<'PY'
from PIL import Image, ImageChops, ImageStat
import sys
A=Image.open(sys.argv[1]).convert('RGB'); B=Image.open(sys.argv[2]).convert('RGB')
d=ImageChops.difference(A,B); mean=sum(ImageStat.Stat(d).mean)/3
if mean < 0.7: raise SystemExit(f'smoke: Ledger navigation produced almost no visual change ({mean:.3f})')
print(f'ledger navigation diff={mean:.2f}')
PY

# The new map has a fixed compact library on the right. Add an identity through
# that real UI. Email autofocuses; tab across optional name + Cancel to Save.
xdotool mousemove 1140 270 click 1
sleep .6
xdotool type --delay 25 'smoke@example.com'
xdotool key Tab Tab Tab Return
sleep 2
import -window root "$OUT/03-map-identity.png"
python3 - "$OUT/02-ledger-empty.png" "$OUT/03-map-identity.png" <<'PY'
from PIL import Image, ImageChops, ImageStat
import sys
A=Image.open(sys.argv[1]).convert('RGB'); B=Image.open(sys.argv[2]).convert('RGB')
d=ImageChops.difference(A,B); mean=sum(ImageStat.Stat(d).mean)/3
if mean < 0.45 or d.getbbox() is None: raise SystemExit(f'smoke: adding identity did not visibly update workspace map ({mean:.3f})')
print(f'map mutation diff={mean:.2f}, bbox={d.getbbox()}')
PY

# Lock is part of the safety model and must be visible/respond to a real click.
xdotool mousemove 1165 105 click 1
sleep .6
import -window root "$OUT/04-map-locked.png"
python3 - "$OUT/03-map-identity.png" "$OUT/04-map-locked.png" <<'PY'
from PIL import Image, ImageChops, ImageStat
import sys
A=Image.open(sys.argv[1]).convert('RGB'); B=Image.open(sys.argv[2]).convert('RGB')
d=ImageChops.difference(A,B); mean=sum(ImageStat.Stat(d).mean)/3
if mean < 0.03: raise SystemExit(f'smoke: map lock produced no visible change ({mean:.4f})')
print(f'lock diff={mean:.3f}')
PY

python3 - "$OUT/04-map-locked.png" <<'PY'
from PIL import Image, ImageStat
import sys
im=Image.open(sys.argv[1]).convert('RGB'); stat=ImageStat.Stat(im)
if max(stat.var) < 40: raise SystemExit(f'smoke: final screenshot appears blank/solid (variance={stat.var})')
print(f'final variance={stat.var}')
PY

echo "smoke: screenshots written to $OUT"
