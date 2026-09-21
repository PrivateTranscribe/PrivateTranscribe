"""Small, frozen AMI comparison. Audio and reference transcripts stay in ignored tmp/."""
import argparse
from collections import defaultdict
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request
import wave
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "tmp/speaker-comparison"
os.environ.setdefault("MPLCONFIGDIR", str(WORK / "matplotlib"))
os.environ["PYANNOTE_METRICS_ENABLED"] = "0"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
SESSIONS = ["ES2004a", "IS1009a", "TS3003a"]
WINDOWS = [(60, 180), (300, 420)]


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf8")


def read(path):
    return json.loads(path.read_text(encoding="utf8"))


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verified_cases():
    cases = read(WORK / "cases.json")
    for case in cases:
        if digest(WORK / "cases" / case["id"] / "audio.wav") != case["audioSha256"]:
            raise ValueError(f"Excerpt checksum mismatch: {case['id']}")
    return cases


def crop_turns(turns, start, end):
    return [dict(start=max(start, t["start"]) - start, end=min(end, t["end"]) - start,
                 speaker=t["speaker"])
            for t in turns if t["end"] > start and t["start"] < end]


def parse_rttm(text):
    turns = []
    for line in text.splitlines():
        fields = line.split()
        if not fields or fields[0] != "SPEAKER":
            continue
        start, duration = float(fields[3]), float(fields[4])
        turns.append(dict(start=start, end=start + duration, speaker=fields[7]))
    return sorted(turns, key=lambda t: (t["start"], t["end"]))


def prepare():
    sources = WORK / "sources"
    sources.mkdir(parents=True, exist_ok=True)
    for item in read(Path(__file__).with_name("sources.json"))["sources"]:
        dest = sources / item["file"]
        if not dest.exists():
            with urllib.request.urlopen(item["url"], timeout=60) as response, dest.with_suffix(".part").open("wb") as output:
                size = 0
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > item["bytes"]:
                        raise ValueError("Source exceeds pinned size")
                    output.write(chunk)
            dest.with_suffix(".part").replace(dest)
        if digest(dest) != item["sha256"]:
            raise ValueError(f"Source checksum mismatch: {dest.name}")
    cases = []
    with zipfile.ZipFile(sources / "ami_public_manual_1.6.2.zip") as archive:
        meetings = ET.fromstring(archive.read("corpusResources/meetings.xml"))
        for session in SESSIONS:
            meeting = next(m for m in meetings if m.attrib.get("observation") == session)
            all_words = []
            for speaker in meeting:
                agent = speaker.attrib["nxt_agent"]
                name = speaker.attrib["global_name"]
                document = ET.fromstring(archive.read(f"words/{session}.{agent}.words.xml"))
                for word in document:
                    if word.tag != "w" or word.attrib.get("punc") == "true":
                        continue
                    if "starttime" not in word.attrib or "endtime" not in word.attrib:
                        continue
                    start, end = float(word.attrib["starttime"]), float(word.attrib["endtime"])
                    if end > start and word.text:
                        all_words.append(dict(start=start, end=end, text=word.text, referenceSpeaker=name))
            all_words.sort(key=lambda w: (w["start"], w["end"], w["referenceSpeaker"]))
            turns = parse_rttm((sources / f"{session}.rttm").read_text())
            uem = (sources / f"{session}.uem").read_text().split()
            with wave.open(str(sources / f"{session}.wav"), "rb") as original:
                if (original.getframerate(), original.getnchannels(), original.getsampwidth()) != (16000, 1, 2):
                    raise ValueError("Expected original 16kHz mono PCM16 mix")
                for start, end in WINDOWS:
                    if start < float(uem[2]) or end > float(uem[3]):
                        raise ValueError("Window outside annotated region")
                    identifier = f"{session}-{start:04d}-{end:04d}"
                    directory = WORK / "cases" / identifier
                    directory.mkdir(parents=True, exist_ok=True)
                    original.setpos(start * 16000)
                    frames = original.readframes((end - start) * 16000)
                    if len(frames) != (end - start) * 32000:
                        raise ValueError("Incomplete audio window")
                    audio = directory / "audio.wav"
                    with wave.open(str(audio), "wb") as output:
                        output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                        output.writeframes(frames)
                    reference = crop_turns(turns, start, end)
                    # Exclude words cut by an excerpt boundary for transcript scoring.
                    words = [dict(w, start=w["start"] - start, end=w["end"] - start)
                             for w in all_words if w["start"] >= start and w["end"] <= end]
                    save(directory / "reference.json", reference)
                    save(directory / "words.json", words)
                    cases.append(dict(id=identifier, language="en", session=session,
                                      offset=start, duration=end-start, speakers=len({t["speaker"] for t in reference}),
                                      words=len(words), audioSha256=digest(audio)))
    save(WORK / "cases.json", cases)
    print(json.dumps(cases, indent=2))


def run_process(command, log, timeout=600):
    import psutil
    started = time.perf_counter()
    peak = 0
    with log.open("w", encoding="utf8") as output:
        process = subprocess.Popen(command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT)
        monitor = psutil.Process(process.pid)
        try:
            while process.poll() is None:
                memory = 0
                try:
                    processes = [monitor, *monitor.children(recursive=True)]
                except psutil.NoSuchProcess:
                    processes = []
                for proc in processes:
                    try:
                        memory += proc.memory_info().rss
                    except psutil.NoSuchProcess:
                        pass
                peak = max(peak, memory)
                if time.perf_counter() - started > timeout:
                    raise TimeoutError("Evaluation exceeded per-clip time limit")
                time.sleep(0.1)
        finally:
            if process.poll() is None:
                for child in monitor.children(recursive=True):
                    try:
                        child.kill()
                    except psutil.NoSuchProcess:
                        pass
                process.kill()
            process.wait()
    if process.returncode:
        raise RuntimeError(f"Process failed ({process.returncode}); see {log}")
    return dict(wallSeconds=time.perf_counter()-started, peakRssBytes=peak)


def run_native(mode, embedding=None, sherpa_module=None, label=None, options=None):
    label = label or mode
    if options and label == mode:
        raise ValueError("Non-default diarization options need an explicit --label")
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", label):
        raise ValueError("Label must contain only letters, digits, underscores or hyphens")
    if mode == "wespeaker":
        pinned = read(Path(__file__).with_name("models.json"))["wespeaker"]
        if digest(Path(embedding)) != pinned["sha256"]:
            raise ValueError("WeSpeaker checkpoint does not match models.json")
    for case in verified_cases():
        directory = WORK / "cases" / case["id"]
        output = directory / f"{label}.json"
        if output.exists():
            output.unlink()
        job = dict(mode="asr" if mode == "asr" else "diarize", audio=str(directory / "audio.wav"), output=str(output))
        if embedding:
            job["embedding"] = str(Path(embedding).resolve())
        if sherpa_module:
            job["sherpaModule"] = str(Path(sherpa_module).resolve())
        if options:
            job["options"] = options
        job_path = directory / f"{label}.job.json"
        save(job_path, job)
        try:
            metrics = run_process(["node", str(Path(__file__).with_name("native.cjs")), str(job_path)], directory / f"{label}.log")
        except (RuntimeError, TimeoutError) as error:
            if mode == "asr":
                raise
            metrics = dict(failure=str(error))
            save(output, dict(failure=str(error)))
        save(directory / f"{label}.performance.json", metrics)
        print(json.dumps(dict(case=case["id"], engine=label, **metrics)), flush=True)


def community(model):
    import torch
    import soundfile as sf
    from pyannote.audio import Pipeline
    torch.set_num_threads(4)
    # A previously authorized download or an explicitly supplied local path.
    # Never accept remote custom code or use a hosted diarization service.
    started = time.perf_counter()
    pipeline = Pipeline.from_pretrained(model)
    load_seconds = time.perf_counter()-started
    for case in verified_cases():
        directory = WORK / "cases" / case["id"]
        waveform, sample_rate = sf.read(directory / "audio.wav", dtype="float32")
        started = time.perf_counter()
        result = pipeline({"waveform": torch.from_numpy(waveform).unsqueeze(0), "sample_rate": sample_rate}, max_speakers=6)
        elapsed = time.perf_counter()-started
        def segments(annotation):
            return [dict(start=t.start, end=t.end, speaker=s) for t, _, s in annotation.itertracks(yield_label=True)]
        save(directory / "community.json", dict(segments=segments(result.exclusive_speaker_diarization),
                                                 overlapSegments=segments(result.speaker_diarization)))
        save(directory / "community.performance.json", dict(inferenceSeconds=elapsed, pipelineLoadSeconds=load_seconds, torchThreads=4))
        print(json.dumps(dict(case=case["id"], engine="community", inferenceSeconds=elapsed)), flush=True)


def tokens(text):
    return re.findall(r"\w+(?:['’]\w+)*", text.casefold().replace("’", "'"))


def transcript_speaker_counts(segments):
    # Unknown assignments must never make a missing real voice look recovered.
    named = {s["speaker"] for s in segments
             if s.get("speaker") and s["speaker"] != "Unknown speaker" and s.get("text", "").strip()}
    unknown_words = sum(len(tokens(s.get("text", ""))) for s in segments
                        if not s.get("speaker") or s["speaker"] == "Unknown speaker")
    return dict(transcriptSpeakers=len(named), unassignedTranscriptWords=unknown_words)


def cpwer(reference, hypothesis):
    from rapidfuzz.distance import Levenshtein
    from scipy.optimize import linear_sum_assignment
    import numpy as np
    ref, hyp = defaultdict(list), defaultdict(list)
    for item in reference:
        ref[item["referenceSpeaker"]].extend(tokens(item["text"]))
    for item in hypothesis:
        hyp[item["speaker"]].extend(tokens(item["text"]))
    size = max(len(ref), len(hyp))
    if not size:
        return dict(errors=0, referenceWords=0, rate=None)
    refs = list(ref.values()) + [[] for _ in range(size-len(ref))]
    hyps = list(hyp.values()) + [[] for _ in range(size-len(hyp))]
    costs = np.array([[Levenshtein.distance(r, h) for h in hyps] for r in refs], dtype=np.int64)
    rows, columns = linear_sum_assignment(costs)
    errors, length = int(costs[rows, columns].sum()), sum(map(len, refs))
    return dict(errors=errors, referenceWords=length, rate=errors/length if length else None)


def score(engines):
    from pyannote.core import Annotation, Segment, Timeline
    from pyannote.metrics.diarization import DiarizationErrorRate
    def annotation(turns):
        result = Annotation()
        for index, turn in enumerate(turns):
            result[Segment(turn["start"], turn["end"]), index] = turn["speaker"]
        return result
    rows = []
    for case in verified_cases():
        directory = WORK / "cases" / case["id"]
        reference = annotation(read(directory / "reference.json"))
        words = read(directory / "words.json")
        for engine in engines:
            hypothesis = read(directory / f"{engine}.json")
            if "failure" in hypothesis:
                rows.append(dict(case=case["id"], engine=engine, failure=hypothesis["failure"]))
                continue
            # Score regular overlap-aware output; use exclusive output for text assignment.
            raw = annotation(hypothesis.get("overlapSegments", hypothesis["segments"]))
            metric = DiarizationErrorRate(collar=0.0, skip_overlap=False)
            details = metric(reference, raw, uem=Timeline([Segment(0, case["duration"])]), detailed=True)
            mapping = metric.optimal_mapping(reference, raw)
            # Convert sherpa's canonical ids to the display ids used by the app merge.
            mapping = {("Speaker " + str(int(k.split('_')[-1])+1) if re.fullmatch(r"SPEAKER_\d+", str(k)) else k): v for k, v in mapping.items()}
            job = dict(mode="merge", asr=str(directory / "asr.json"), diarization=str(directory / f"{engine}.json"),
                       referenceWords=str(directory / "words.json"), output=str(directory / f"{engine}.merged.json"))
            save(directory / f"{engine}.merge.job.json", job)
            subprocess.run(["node", str(Path(__file__).with_name("native.cjs")), str(directory / f"{engine}.merge.job.json")], cwd=ROOT, check=True)
            merged = read(directory / f"{engine}.merged.json")
            assigned = merged["referenceWordAssignments"]
            wrong = sum(mapping.get(w["speaker"]) != w["referenceSpeaker"] for w in assigned)
            row = dict(case=case["id"], engine=engine, language=case["language"],
                       der={k:float(v) for k,v in details.items()},
                       referenceWordSpeakerErrors=wrong, referenceWordCount=len(assigned),
                       cpwer=cpwer(words, merged["transcript"]["segments"]),
                       detectedSpeakers=len(raw.labels()), referenceSpeakers=case["speakers"],
                       assignmentOutputSpeakers=len({s["speaker"] for s in hypothesis["segments"]}),
                       **transcript_speaker_counts(merged["transcript"]["segments"]),
                       performance=read(directory / f"{engine}.performance.json"))
            rows.append(row)
            print(json.dumps(row), flush=True)
    totals = {}
    for engine in engines:
        selected = [r for r in rows if r["engine"] == engine and "failure" not in r]
        failures = sum(r["engine"] == engine and "failure" in r for r in rows)
        if not selected:
            totals[engine] = dict(completed=0, failures=failures)
            continue
        ref_words = sum(r["referenceWordCount"] for r in selected)
        wrong = sum(r["referenceWordSpeakerErrors"] for r in selected)
        cp_errors = sum(r["cpwer"]["errors"] for r in selected)
        cp_words = sum(r["cpwer"]["referenceWords"] for r in selected)
        ref_seconds = sum(r["der"]["total"] for r in selected)
        error_seconds = sum(sum(r["der"][k] for k in ["confusion", "missed detection", "false alarm"]) for r in selected)
        totals[engine] = dict(completed=len(selected), failures=failures, scoredCases=[r["case"] for r in selected], der=error_seconds/ref_seconds, wrongSpeakerWords=wrong,
                              referenceWords=ref_words, wordSpeakerErrorRate=wrong/ref_words,
                              cpwer=cp_errors/cp_words, cpErrors=cp_errors, cpReferenceWords=cp_words,
                              exactTranscriptSpeakerCountClips=sum(r["transcriptSpeakers"]==r["referenceSpeakers"] for r in selected),
                              unassignedTranscriptWords=sum(r["unassignedTranscriptWords"] for r in selected),
                              exactSpeakerCountClips=sum(r["detectedSpeakers"]==r["referenceSpeakers"] for r in selected))
    save(WORK / "results.json", dict(protocol="AMI Mix-Headset, six fixed 120s excerpts, zero collar, overlap included", rows=rows, totals=totals))
    print(json.dumps(totals, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["prepare", "asr", "baseline", "wespeaker", "community", "score"])
    parser.add_argument("--embedding")
    parser.add_argument("--sherpa-module")
    parser.add_argument("--label")
    parser.add_argument("--model", default="pyannote/speaker-diarization-community-1")
    parser.add_argument("--engines", nargs="+", default=["baseline", "community"])
    parser.add_argument("--threshold", type=float, help="Clustering distance cut; app default 0.9")
    parser.add_argument("--min-cluster-seconds", type=float)
    parser.add_argument("--min-cluster-share", type=float)
    args = parser.parse_args()
    options = {k: v for k, v in dict(threshold=args.threshold, minClusterSeconds=args.min_cluster_seconds,
                                     minClusterShare=args.min_cluster_share).items() if v is not None}
    if args.command == "wespeaker" and not args.embedding:
        parser.error("wespeaker requires --embedding; never label the baseline as another model")
    if args.command == "prepare": prepare()
    elif args.command == "community": community(args.model)
    elif args.command == "score": score(args.engines)
    else: run_native(args.command, args.embedding, args.sherpa_module, args.label, options)
