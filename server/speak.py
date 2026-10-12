# Kokoro TTS worker for Pulse. Loads the model once, then per stdin line
# {"text", "out", "voice", "speed"} writes a wav and prints "ok". Exits when stdin closes (server gone).
#
# People pause between sentences. Rendered in one go, Kokoro runs sentences together, which sounds rushed. So a line is
# rendered a sentence at a time and the pieces are joined with silences of a set length (each piece's own leading and
# trailing silence trimmed first, so the gaps are even). The form of address stays inside its sentence, where Kokoro
# gives it natural phrasing; rendering it as a piece of its own made an awkward gap.
import json
import os
import re
import sys

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

MODELS = os.path.join(os.environ.get("PULSE_HOME") or os.path.expanduser("~/.pulse"), "models")
# Full precision sounds noticeably less robotic; the int8 file is the lightweight fallback.
model = next(p for p in ("kokoro-v1.0.onnx", "kokoro-v1.0.int8.onnx") if os.path.exists(os.path.join(MODELS, p)))
kokoro = Kokoro(os.path.join(MODELS, model), os.path.join(MODELS, "voices-v1.0.bin"))
print("ready " + model, flush=True)

SENTENCE_GAP, EDGE = 0.34, 0.03  # seconds


def pieces(text):
    """(piece, gap after it) for a line: one piece per sentence, with a gap after each but the last."""
    out = [[s.strip(), SENTENCE_GAP] for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s.strip()]
    if out:
        out[-1][1] = 0
    return out


def trim(samples, rate):
    """Cut a piece's leading and trailing near-silence, keeping a few milliseconds so no sound is clipped."""
    loud = np.flatnonzero(np.abs(samples) > 0.02 * (np.max(np.abs(samples)) or 1))
    if not len(loud):
        return samples
    pad = int(EDGE * rate)
    return samples[max(0, loud[0] - pad): loud[-1] + pad]


for line in sys.stdin:
    try:
        job = json.loads(line)
        voice = job.get("voice") or "af_heart"
        lang = "en-gb" if voice.startswith("b") else "en-us"
        speed = float(job.get("speed") or 1.0)
        chunks, rate = [], 24000
        for piece, gap in pieces(job["text"]):
            samples, rate = kokoro.create(piece, voice=voice, speed=speed, lang=lang)
            chunks.append(trim(np.asarray(samples, dtype=np.float32), rate))
            if gap:
                chunks.append(np.zeros(int(gap * rate), dtype=np.float32))
        if not chunks:
            raise ValueError("nothing to say")
        sf.write(job["out"], np.concatenate(chunks), rate)
        print("ok " + job["out"], flush=True)
    except Exception as e:  # keep the worker alive; the page falls back to browser speech
        print("err " + str(e).replace("\n", " "), flush=True)
