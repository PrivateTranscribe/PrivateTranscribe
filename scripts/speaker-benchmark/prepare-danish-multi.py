"""Build Danish multi-speaker fixtures from pinned FLEURS read speech.

FLEURS has no speaker ids, so speakers were grouped by voice with the app's own
embedding model (see `danish-multi-sources.json`): three groups whose clips agree
with each other at cosine >= 0.72 and disagree with every other group at <= 0.49.
Clips of one group are treated as one speaker. Turns are laid out round-robin
with short seeded gaps, so the reference speaker timeline is exact by construction.
These are simulated conversations: clean read speech, no overlap, no crosstalk.
Audio and references stay in ignored tmp/.
"""
import argparse
import hashlib
import importlib.util
import json
import random
import struct
import subprocess
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "tmp/speaker-comparison/validation/multi"
PINNED = Path(__file__).with_name("danish-multi-sources.json")
SOURCES = json.loads(PINNED.read_text(encoding="utf8"))
FIXTURES = {
    "da-two-speakers": {"A": 4, "B": 4},
    "da-three-speakers": {"A": 3, "B": 3, "C": 3},
    "da-three-speakers-long": {"A": 6, "B": 6, "C": 5},
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def load_prepare_module():
    spec = importlib.util.spec_from_file_location(
        "prepare_reliability", Path(__file__).with_name("prepare-reliability.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def row_files(index):
    return WORK / f"row-{index}.audio", WORK / f"row-{index}.wav"


def rows_verified():
    for row in SOURCES["rows"]:
        audio, pcm = row_files(row["index"])
        if not audio.exists() or not pcm.exists():
            return False
        if sha(audio.read_bytes()) != row["sourceSha256"] or sha(pcm.read_bytes()) != row["wavSha256"]:
            return False
    return True


def fetch_rows():
    import pyarrow.parquet as pq
    prep = load_prepare_module()
    WORK.mkdir(parents=True, exist_ok=True)
    source = SOURCES["source"]
    parquet = pq.ParquetFile(prep.RemoteFile(source["url"], source["size"]))
    count = len(SOURCES["rows"])
    rows = parquet.read_row_group(0, columns=["id", "audio", "transcription"]).slice(0, count).to_pylist()
    ffmpeg = subprocess.check_output(["node", "-p", "require('ffmpeg-static')"], cwd=ROOT, text=True).strip()
    for expected, row in zip(SOURCES["rows"], rows, strict=True):
        content = row["audio"]["bytes"]
        if row["id"] != expected["id"] or sha(content) != expected["sourceSha256"]:
            raise ValueError(f"Danish source identity mismatch at row {expected['index']}")
        if sha(row["transcription"].encode()) != expected["referenceSha256"]:
            raise ValueError(f"Danish reference text mismatch at row {expected['index']}")
        audio, pcm = row_files(expected["index"])
        audio.write_bytes(content)
        subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(audio),
                        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(pcm)], check=True)
        if sha(pcm.read_bytes()) != expected["wavSha256"]:
            raise ValueError("Converted WAV differs; check the locked FFmpeg dependency")
    if not rows_verified():
        raise ValueError("Fetched Danish rows failed verification")


def read_pcm(path):
    with wave.open(str(path), "rb") as handle:
        if handle.getframerate() != 16000 or handle.getnchannels() != 1 or handle.getsampwidth() != 2:
            raise ValueError(f"{path} is not 16 kHz mono PCM16")
        frames = handle.readframes(handle.getnframes())
    return list(struct.unpack(f"<{len(frames)//2}h", frames))


def trim(samples, rate=16000, frame=320, threshold=150, margin=0.1):
    """Drop leading/trailing near-silence so reference turns cover speech only."""
    def loud(start):
        chunk = samples[start:start + frame]
        return chunk and (sum(x * x for x in chunk) / len(chunk)) ** 0.5 > threshold
    first = next((i for i in range(0, len(samples), frame) if loud(i)), 0)
    last = next((i + frame for i in range(len(samples) - frame, -1, -frame) if loud(i)), len(samples))
    pad = int(margin * rate)
    return samples[max(0, first - pad):min(len(samples), last + pad)]


def build(name, plan, rng):
    speakers = SOURCES["speakers"]
    queues = {label: list(speakers[label]["rows"][:count]) for label, count in plan.items()}
    references = {row["index"]: row for row in SOURCES["rows"]}
    rate = 16000
    cursor = int(0.5 * rate)
    output = [0] * cursor
    turns = []
    while any(queues.values()):
        for label in plan:
            if not queues[label]:
                continue
            index = queues[label].pop(0)
            samples = trim(read_pcm(row_files(index)[1]))
            start = len(output)
            output.extend(samples)
            turns.append(dict(start=round(start / rate, 3), end=round(len(output) / rate, 3), speaker=label,
                              rowIndex=index, text=references[index]["reference"]))
            output.extend([0] * int(rng.uniform(0.4, 1.2) * rate))
    output.extend([0] * int(0.5 * rate))
    target = WORK / "fixtures" / f"{name}.wav"
    target.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(target), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(struct.pack(f"<{len(output)}h", *output))
    (WORK / "fixtures" / f"{name}.reference.json").write_text(
        json.dumps(dict(name=name, speakers=len(plan), durationSec=round(len(output) / rate, 3), turns=turns),
                   indent=2, ensure_ascii=False), encoding="utf8")
    return dict(name=name, speakers=len(plan), turns=len(turns), durationSec=round(len(output) / rate, 3),
                wavSha256=sha(target.read_bytes()))


def main(verify_only=False):
    if not rows_verified():
        if verify_only:
            raise ValueError("Danish rows are missing or differ from the pinned source")
        fetch_rows()
    rng = random.Random(20260921)
    summary = [build(name, plan, rng) for name, plan in FIXTURES.items()]
    (WORK / "fixtures" / "manifest.json").write_text(json.dumps(summary, indent=2), encoding="utf8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify-only", action="store_true")
    main(parser.parse_args().verify_only)
