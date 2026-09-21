# Local speaker comparison

Opt-in developer benchmark. It downloads public AMI recordings, runs local models,
and scores their output against manual annotations. Audio and transcripts remain
in ignored `tmp/speaker-comparison/`. Nothing is uploaded. This is not part of the
application runtime or normal test suite.

## Reproduce

Use Python 3.13 and install `requirements.txt` in a separate virtual environment.
Install the app's npm dependencies and download its existing local Whisper base
and multilingual speaker models through the app. Run from the repository root:

```powershell
python scripts/speaker-benchmark/benchmark.py prepare
python scripts/speaker-benchmark/benchmark.py asr
python scripts/speaker-benchmark/benchmark.py baseline --label current
python scripts/speaker-benchmark/benchmark.py score --engines current
python tests/speaker-benchmark/test_scoring.py
```

`python` means the interpreter in that isolated environment. Preparation validates
the pinned public source hashes in `sources.json` and makes six fixed two-minute
excerpts from three AMI test meetings. Inference and scoring verify the excerpt
audio hashes. Do not edit prepared reference files between runs.

To compare another native version without changing the app, install that exact
version in an ignored directory and pass its absolute `sherpa-onnx-node` module
directory with `--sherpa-module`, plus a unique `--label`. `baseline` always means
the installed module unless explicitly overridden; it is not permanently 1.13.1.

The public WeSpeaker asset URL, revision and checksum are in `models.json`.
Download it to the ignored workspace and pass its path:

```powershell
python scripts/speaker-benchmark/benchmark.py wespeaker --embedding tmp/speaker-comparison/models/wespeaker_en_voxceleb_resnet34_LM.onnx --label wespeaker
python scripts/speaker-benchmark/benchmark.py score --engines current wespeaker
```

The runner rejects a WeSpeaker checkpoint with the wrong checksum. Both native
variants use the app defaults, including threshold 0.9 and Auto's six-speaker cap.
This evaluates a direct replacement. It is not a tuned comparison between model
families. Run inference sequentially on an otherwise idle machine.

## Metrics

- Diarization error rate (DER) counts missed speech, false speech and wrong
  speaker time. Score the pinned pyannote AMI `only_words` RTTM reference with
  zero boundary forgiveness and overlapping speech included. Lower is better.
- Word-speaker error assigns manual AMI NXT 1.6.2 words through the app's merger,
  with speaker names matched by the DER-optimal mapping. It isolates label
  assignment from recognition errors. Words cut by an excerpt edge are excluded.
- Concatenated minimum-permutation word error rate (cpWER) scores the app's final
  formatted transcript. Group words by speaker, find the cheapest global speaker
  pairing, and count word edits. It includes recognition and assignment errors;
  it can exceed 100%. All engines reuse exactly the same Whisper base CPU English
  output. Unicode word normalization and scorer sanity tests are included.
- Count agreement compares detected and reference speaker counts. A very brief
  voice still counts as a speaker, so low time error can coexist with a wrong count.
- Native time is cold subprocess wall time, including model loading and output
  serialization. Memory is sampled total process-tree RSS every 100 ms. Neither
  includes the separate Whisper run. Compare medians only on identical cases.

A failed process stays in the results as a failure. Quality totals contain only
completed cases, listed explicitly in `scoredCases`. **Never compare totals with
different case sets as evidence of accuracy improvement.** An error can represent
a crash, timeout or missing dependency; inspect the retained log.

## Optional Community-1 adapter

`community --model PATH` accepts a previously authorized local model checkout.
It needs separately installed pyannote.audio, torch, torchaudio and soundfile.
The model's access agreement must be accepted by an authorized person first.
Do not bypass the gate or upload recordings to a hosted service.

The adapter completed all six excerpts after approved access and manual model
downloads. See the [follow-up evaluation](../../docs/community-1-evaluation-2026-09-21.md)
for scores, hashes and exact dependency versions. `community-config.yaml` preserves
the official configuration values supplied by the user. Set `HF_HUB_OFFLINE=1` for
local inference. The adapter uses overlap-aware output for DER and exclusive output
for app text assignment. Its warm inference and separate pipeline-load times are
**not directly comparable** to native cold-process time. Runtime footprint and peak
memory still need measurement before any deployment recommendation. This verifies
Python inference only, not an Electron integration.

## Sources and limits

AMI audio and manual annotations are [CC BY 4.0](https://groups.inf.ed.ac.uk/ami/download/).
Credit the AMI Meeting Corpus, University of Edinburgh and partner institutions.
The pinned [pyannote AMI setup](https://github.com/pyannote/AMI-diarization-setup/tree/67c2d539286e89f68952d5dcf83912bd9f01dfae)
supplies the DER annotations; the original manual archive supplies transcript words.
The two reference representations are intentionally distinct.

Six excerpts from three scenario meetings are a small English sample, not six
independent meetings or a multilingual benchmark. No real Danish accuracy claim
is supported. Preserve a separate development set if tuning thresholds later.
