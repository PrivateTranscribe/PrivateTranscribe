"""Score Danish multi-speaker fixture runs: speaker time, counts and words.

Raw runs (`<fixture>.<label>.json`) come straight from the native diarizer and
score speaker time and count only. App runs (`<fixture>-<label>.json`) come from
the opt-in Electron test and additionally score the final named transcript:
count of named speakers, cpWER per speaker and plain WER of all words.
"""
import argparse
import hashlib
import json
import os
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tmp/speaker-comparison/validation/multi/fixtures"
RESULTS = ROOT / "tmp/speaker-comparison/validation/multi/results"
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / "tmp/speaker-comparison/matplotlib"))
os.environ["PYANNOTE_METRICS_ENABLED"] = "0"


def tokens(text):
    return re.findall(r"\w+(?:['’]\w+)*", text.casefold().replace("’", "'"))


def read(path):
    return json.loads(path.read_text(encoding="utf8"))


def annotation(turns, key="speaker"):
    from pyannote.core import Annotation, Segment
    result = Annotation()
    for index, turn in enumerate(turns):
        if turn["end"] > turn["start"]:
            result[Segment(turn["start"], turn["end"]), index] = str(turn[key])
    return result


def der(reference, hypothesis, duration):
    from pyannote.core import Segment, Timeline
    from pyannote.metrics.diarization import DiarizationErrorRate
    metric = DiarizationErrorRate(collar=0.0, skip_overlap=False)
    details = metric(annotation(reference["turns"]), annotation(hypothesis),
                     uem=Timeline([Segment(0, duration)]), detailed=True)
    total = details["total"]
    error = sum(details[k] for k in ["confusion", "missed detection", "false alarm"])
    return dict(rate=error / total if total else None, **{k: float(v) for k, v in details.items()})


def cpwer(reference, hypothesis):
    from rapidfuzz.distance import Levenshtein
    from scipy.optimize import linear_sum_assignment
    import numpy as np
    ref, hyp = defaultdict(list), defaultdict(list)
    for turn in reference["turns"]:
        ref[turn["speaker"]].extend(tokens(turn["text"]))
    for segment in hypothesis:
        hyp[segment.get("speaker") or "Unknown speaker"].extend(tokens(segment.get("text", "")))
    size = max(len(ref), len(hyp))
    refs = list(ref.values()) + [[] for _ in range(size - len(ref))]
    hyps = list(hyp.values()) + [[] for _ in range(size - len(hyp))]
    costs = np.array([[Levenshtein.distance(r, h) for h in hyps] for r in refs], dtype=np.int64)
    rows, columns = linear_sum_assignment(costs)
    errors, length = int(costs[rows, columns].sum()), sum(map(len, refs))
    return dict(errors=errors, referenceWords=length, rate=errors / length if length else None)


def wer(reference, text):
    from rapidfuzz.distance import Levenshtein
    ref = [t for turn in reference["turns"] for t in tokens(turn["text"])]
    hyp = tokens(re.sub(r"^(?:Speaker \d+|Unknown speaker):\s*", "", text, flags=re.M))
    errors = Levenshtein.distance(ref, hyp)
    return dict(errors=errors, referenceWords=len(ref), rate=errors / len(ref) if ref else None)


def score(raw_labels, app_labels):
    manifest = {entry["name"]: entry for entry in read(FIXTURES / "manifest.json")}
    rows = []
    for name, entry in manifest.items():
        wav = FIXTURES / f"{name}.wav"
        if hashlib.sha256(wav.read_bytes()).hexdigest() != entry["wavSha256"]:
            raise ValueError(f"Fixture audio changed: {name}")
        reference = read(FIXTURES / f"{name}.reference.json")
        for label in raw_labels:
            path = FIXTURES / f"{name}.{label}.json"
            if not path.exists():
                continue
            result = read(path)
            rows.append(dict(fixture=name, kind="raw", label=label, referenceSpeakers=entry["speakers"],
                             detectedSpeakers=len({s["speaker"] for s in result["segments"]}),
                             der=der(reference, result["segments"], reference["durationSec"]),
                             config=result.get("config"), smallClusterMerges=result.get("smallClusterMerges"),
                             elapsedMs=result.get("elapsedMs")))
        for label in app_labels:
            path = RESULTS / f"{name}-{label}.json"
            if not path.exists():
                continue
            captured = read(path)
            result = captured["result"]
            if not result.get("success"):
                rows.append(dict(fixture=name, kind="app", label=label, failure=result.get("error") or result.get("message")))
                continue
            named = {s["speaker"] for s in result["segments"]
                     if s.get("speaker") and s["speaker"] != "Unknown speaker" and s.get("text", "").strip()}
            unknown = sum(len(tokens(s.get("text", ""))) for s in result["segments"]
                          if not s.get("speaker") or s["speaker"] == "Unknown speaker")
            rows.append(dict(fixture=name, kind="app", label=label, referenceSpeakers=entry["speakers"],
                             detectedSpeakers=result["diarization"]["speakerCount"],
                             transcriptSpeakers=len(named), unassignedTranscriptWords=unknown,
                             rawDer=der(reference, result["diarization"]["segments"], reference["durationSec"]),
                             transcriptDer=der(reference, result["segments"], reference["durationSec"]),
                             cpwer=cpwer(reference, result["segments"]), wer=wer(reference, result["text"]),
                             model=result.get("model"), detectedLanguage=(result.get("languageDetection") or {}).get("detected"),
                             config=result["diarization"].get("config"),
                             smallClusterMerges=result["diarization"].get("smallClusterMerges"),
                             elapsedMs=captured.get("elapsedMs")))
    return rows


def table(rows):
    lines = ["| Fixture | Kind | Label | Ref | Raw | Final | DER | cpWER | WER |", "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for r in rows:
        if "failure" in r:
            lines.append(f"| {r['fixture']} | {r['kind']} | {r['label']} | failed: {r['failure']} | | | | | |")
            continue
        d = r.get("rawDer") or r["der"]
        final = r.get("transcriptSpeakers", "")
        cp = f"{r['cpwer']['rate']:.1%}" if r.get("cpwer") else ""
        w = f"{r['wer']['rate']:.1%}" if r.get("wer") else ""
        lines.append(f"| {r['fixture']} | {r['kind']} | {r['label']} | {r['referenceSpeakers']} | {r['detectedSpeakers']} | {final} | {d['rate']:.1%} | {cp} | {w} |")
    return "\n".join(lines)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", nargs="*", default=[])
    parser.add_argument("--app", nargs="*", default=[])
    parser.add_argument("--output")
    args = parser.parse_args()
    rows = score(args.raw, args.app)
    print(table(rows))
    if args.output:
        Path(args.output).write_text(json.dumps(dict(protocol="Simulated Danish conversations from pinned FLEURS clips, zero collar", rows=rows), indent=2, ensure_ascii=False), encoding="utf8")
