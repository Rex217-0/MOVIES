#!/usr/bin/env bash
# Server-2 ComfyUI diagnostic + launcher (run INSIDE WSL2, Ubuntu-24.04).
#
# The sandbox that wrote this file cannot reach Server-2 (no Tailscale, no SSH,
# no route to 100.122.147.65). So this script must be run on the Windows host:
#
#   wsl -d Ubuntu-24.04 bash /path/to/server2-comfyui-up.sh
#
# It checks the install, starts ComfyUI, waits for a real 200 on /system_stats,
# and prints the exact error log if it never comes up. It exits non-zero on
# failure. It never writes a placeholder render.

set -u

COMFY_DIR="${COMFY_DIR:-$HOME/isa_movie/ComfyUI}"
START_SCRIPT="${START_SCRIPT:-$HOME/isa_movie/start_comfyui.sh}"
COMFY_URL="${COMFY_URL:-http://127.0.0.1:8188}"
LOG_FILE="${LOG_FILE:-$HOME/isa_movie/comfyui.log}"
WAIT_SECONDS="${WAIT_SECONDS:-180}"

fail() { echo "FAIL: $*" >&2; exit 1; }
say()  { echo "[server2] $*"; }

say "ComfyUI dir: $COMFY_DIR"
say "start script: $START_SCRIPT"

# --- 1. Is ComfyUI installed? ---
if [ ! -d "$COMFY_DIR" ]; then
  fail "wala ang folder $COMFY_DIR. Kailangan munang i-clone ang ComfyUI doon."
fi
if [ ! -f "$COMFY_DIR/main.py" ]; then
  fail "wala ang $COMFY_DIR/main.py. Hindi kumpleto ang install."
fi
say "OK: main.py exists"

# --- 2. Are the Wan 2.2 models present, at the exact byte sizes? ---
check_size() {
  local f="$1" want="$2" got
  if [ ! -f "$f" ]; then echo "MISSING: $f"; return 1; fi
  got=$(stat -c '%s' "$f")
  if [ "$got" != "$want" ]; then echo "WRONG SIZE: $f got=$got want=$want"; return 1; fi
  echo "OK: $(basename "$f") $got bytes"
}
model_ok=1
check_size "$COMFY_DIR/models/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors" 9999658848 || model_ok=0
check_size "$COMFY_DIR/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors" 6735906897 || model_ok=0
check_size "$COMFY_DIR/models/vae/wan2.2_vae.safetensors" 1409400960 || model_ok=0
[ "$model_ok" = 1 ] || say "WARNING: hindi kumpleto ang Wan 2.2 models (see above)"

# --- 3. Already live? ---
if curl -s -m 5 -o /dev/null -w '%{http_code}' "$COMFY_URL/system_stats" | grep -q 200; then
  say "OK: ComfyUI live na sa $COMFY_URL (hindi na kailangang mag-start)."
  curl -s -m 5 "$COMFY_URL/system_stats" | head -c 400; echo
  exit 0
fi

# --- 4. Start it ---
if [ -f "$START_SCRIPT" ]; then
  chmod +x "$START_SCRIPT"
  say "starting via $START_SCRIPT (log: $LOG_FILE)"
  nohup bash "$START_SCRIPT" >"$LOG_FILE" 2>&1 &
else
  say "WARNING: wala ang $START_SCRIPT; starting main.py directly (log: $LOG_FILE)"
  ( cd "$COMFY_DIR" && nohup python3 main.py --listen 0.0.0.0 --port 8188 >"$LOG_FILE" 2>&1 & )
fi

# --- 5. Wait for a real 200 ---
deadline=$(( $(date +%s) + WAIT_SECONDS ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if curl -s -m 5 -o /dev/null -w '%{http_code}' "$COMFY_URL/system_stats" | grep -q 200; then
    say "OK: ComfyUI live after start."
    curl -s -m 5 "$COMFY_URL/system_stats" | head -c 400; echo
    exit 0
  fi
  sleep 3
done

# --- 6. Honest failure with the exact log ---
echo "===== FAIL: ComfyUI did not answer 200 on $COMFY_URL/system_stats in ${WAIT_SECONDS}s =====" >&2
echo "----- last 60 lines of $LOG_FILE -----" >&2
tail -n 60 "$LOG_FILE" 2>/dev/null >&2 || echo "(no log file at $LOG_FILE)" >&2
exit 1
