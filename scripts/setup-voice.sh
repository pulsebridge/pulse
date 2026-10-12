#!/bin/sh
# One-time setup for Pulse's natural voice (Kokoro-82M, open source, runs locally, about 350 MB).
# Without it, Pulse still speaks using your browser's built-in voice.
set -e
PULSE_HOME="${PULSE_HOME:-$HOME/.pulse}"
MODELS="$PULSE_HOME/models"
URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
mkdir -p "$MODELS"
command -v python3 >/dev/null || { echo "Pulse voice needs python3 (3.10 or newer)."; exit 1; }
# Kokoro needs 3.10+; macOS's built-in python3 is older, so say so clearly instead of failing inside pip.
python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' || { echo "Pulse voice needs Python 3.10 or newer; this python3 is $(python3 -V 2>&1 | cut -d' ' -f2). Install a newer one (for example: brew install python), then run this again."; exit 1; }
if [ ! -x "$PULSE_HOME/venv/bin/python" ]; then
    echo "Creating Python environment in $PULSE_HOME/venv"
    python3 -m venv "$PULSE_HOME/venv"
fi
"$PULSE_HOME/venv/bin/pip" install -q kokoro-onnx soundfile
for f in kokoro-v1.0.onnx voices-v1.0.bin; do
    [ -f "$MODELS/$f" ] || { echo "Downloading $f"; curl -fL --progress-bar -o "$MODELS/$f.part" "$URL/$f" && mv "$MODELS/$f.part" "$MODELS/$f"; }
done
PORT="${PULSE_PORT:-4777}"
echo "Pulse voice is ready. Restart Pulse to use it: curl -s -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:$PORT/shutdown (it starts again with your next Claude session or when Pulse.app opens), or ask Claude to run /pulse."
