"""Røst v3 worker for the PrivateTranscribe narrator (opt-in).

Runs inside the user's own Python environment, never the app's installer.
Protocol, one JSON object per line:
  stdin   {"id": 1, "text": "...", "out": "<path>.f32"}
  stdout  {"ready": true, "device": "cuda", "sampleRate": 24000}
          {"id": 1, "sampleRate": 24000}      samples written to "out" as float32
          {"id": 1, "error": "..."}

The model's own built-in voice is used. Cloning a person's voice needs that
person's consent under the model's licence, so this worker takes no voice
prompt at all.
"""

import json
import sys


def main():
    model_dir = sys.argv[1]
    import numpy as np
    import torch
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = ChatterboxMultilingualTTS.from_local(model_dir, device=device)
    print(json.dumps({"ready": True, "device": device, "sampleRate": model.sr}), flush=True)

    for line in sys.stdin:
        try:
            request = json.loads(line)
        except ValueError:
            continue
        request_id = request.get("id")
        try:
            with torch.inference_mode():
                wav = model.generate(str(request.get("text", "")), language_id="da")
            samples = wav.squeeze(0).detach().cpu().numpy().astype(np.float32)
            samples.tofile(request["out"])
            print(json.dumps({"id": request_id, "sampleRate": model.sr}), flush=True)
        except Exception as error:  # noqa: BLE001 - every failure goes back to the app
            print(json.dumps({"id": request_id, "error": str(error)[:300]}), flush=True)


if __name__ == "__main__":
    main()
