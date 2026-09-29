"""Prepare six pinned Danish read-speech fixtures; keep audio/text in ignored tmp/."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "tmp/speaker-comparison/validation"
SOURCES = json.loads(Path(__file__).with_name("reliability-sources.json").read_text())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def verify_cached():
    manifest = WORK / "fleurs-manifest.json"
    if not manifest.exists():
        return False
    saved = json.loads(manifest.read_text(encoding="utf8"))
    for expected in SOURCES["rows"]:
        index = expected["index"]
        audio, wav = WORK / expected["audioFile"], WORK / f"da-{index}.wav"
        row = next((r for r in saved["rows"] if r["index"] == index), None)
        if (not audio.exists() or not wav.exists() or row is None
                or sha(audio.read_bytes()) != expected["sourceSha256"]
                or sha(wav.read_bytes()) != expected["wavSha256"]
                or sha(row["reference"].encode()) != expected["referenceSha256"]):
            return False
    return True


class RemoteFile(io.RawIOBase):
    """Read parquet byte ranges. Row-group reads may still transfer substantial audio."""
    def __init__(self, url, size):
        self.url, self.size, self.position = url, size, 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        position = offset if whence == 0 else self.position + offset if whence == 1 else self.size + offset
        if position < 0 or whence not in (0, 1, 2):
            raise ValueError("Invalid parquet seek")
        self.position = position
        return position

    def read(self, size=-1):
        end = self.size if size < 0 else min(self.size, self.position + size)
        if end <= self.position:
            return b""
        request = urllib.request.Request(self.url, headers={"Range": f"bytes={self.position}-{end-1}"})
        with urllib.request.urlopen(request, timeout=90) as response:
            expected = f"bytes {self.position}-{end-1}/{self.size}"
            if response.status != 206 or response.headers.get("Content-Range") != expected:
                raise ValueError("Server did not return the requested parquet range")
            content = response.read(end - self.position)
        if len(content) != end - self.position:
            raise ValueError("Truncated parquet range")
        self.position = end
        return content


def prepare(verify_only=False):
    if verify_cached():
        print("Verified all six Danish source, PCM WAV and reference checksums.")
        return
    if verify_only:
        raise ValueError("Danish fixtures are missing or differ from the pinned source")
    import pyarrow.parquet as pq
    WORK.mkdir(parents=True, exist_ok=True)
    source = SOURCES["source"]
    parquet = pq.ParquetFile(RemoteFile(source["url"], source["size"]))
    rows = parquet.read_row_group(0, columns=["id", "audio", "transcription", "language"]).slice(0, 6).to_pylist()
    ffmpeg = subprocess.check_output(["node", "-p", "require('ffmpeg-static')"], cwd=ROOT, text=True).strip()
    manifest = []
    for expected, row in zip(SOURCES["rows"], rows, strict=True):
        index = expected["index"]
        content = row["audio"]["bytes"]
        if (row["id"] != expected["id"] or sha(content) != expected["sourceSha256"]
                or sha(row["transcription"].encode()) != expected["referenceSha256"]):
            raise ValueError(f"Danish source identity mismatch at row {index}")
        audio, wav = WORK / expected["audioFile"], WORK / f"da-{index}.wav"
        audio.write_bytes(content)
        subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(audio),
                        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(wav)], check=True)
        if sha(wav.read_bytes()) != expected["wavSha256"]:
            raise ValueError("Converted WAV differs; check the locked FFmpeg dependency")
        manifest.append(dict(expected, reference=row["transcription"]))
    (WORK / "fleurs-manifest.json").write_text(json.dumps(dict(source=source, rows=manifest),
                                                        indent=2, ensure_ascii=False), encoding="utf8")
    if not verify_cached():
        raise ValueError("Prepared Danish fixtures failed verification")
    print("Prepared and verified six Danish fixtures. Audio and references remain in tmp/.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify-only", action="store_true")
    prepare(parser.parse_args().verify_only)
