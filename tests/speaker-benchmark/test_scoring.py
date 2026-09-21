import importlib.util
from pathlib import Path
import unittest

source = Path(__file__).resolve().parents[2] / "scripts/speaker-benchmark/benchmark.py"
spec = importlib.util.spec_from_file_location("speaker_benchmark", source)
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class ScoringTests(unittest.TestCase):
    def test_transcript_count_excludes_unknown_and_empty_labels(self):
        segments = [dict(speaker="Speaker 1", text="Hello"),
                    dict(speaker="Speaker 1", text="Again"),
                    dict(speaker="Speaker 2", text="Hi"),
                    dict(speaker="Unknown speaker", text="Lost short reply"),
                    dict(speaker="Speaker 3", text=""),
                    dict(text="Unassigned")]
        self.assertEqual(benchmark.transcript_speaker_counts(segments),
                         dict(transcriptSpeakers=2, unassignedTranscriptWords=4))

    def test_empty_transcripts_have_no_errors_and_undefined_rate(self):
        self.assertEqual(benchmark.cpwer([], []), dict(errors=0, referenceWords=0, rate=None))

    def test_crop_keeps_overlaps_and_boundary_crossings(self):
        result = benchmark.crop_turns([
            dict(start=5, end=12, speaker="a"), dict(start=11, end=18, speaker="b"),
            dict(start=20, end=21, speaker="c"),
        ], 10, 15)
        self.assertEqual(result, [dict(start=0, end=2, speaker="a"), dict(start=1, end=5, speaker="b")])

    def test_permuted_names_are_not_errors(self):
        reference = [dict(referenceSpeaker="a", text="Hello friend"), dict(referenceSpeaker="b", text="Hi")]
        hypothesis = [dict(speaker="Speaker 2", text="Hello friend"), dict(speaker="Speaker 1", text="Hi")]
        self.assertEqual(benchmark.cpwer(reference, hypothesis), dict(errors=0, referenceWords=3, rate=0))

    def test_missing_and_extra_speakers_count(self):
        reference = [dict(referenceSpeaker="a", text="Hello friend"), dict(referenceSpeaker="b", text="Hi")]
        self.assertEqual(benchmark.cpwer(reference, [dict(speaker="x", text="Hello friend")])["errors"], 1)
        hypothesis = [dict(speaker="x", text="Hello friend"), dict(speaker="y", text="Hi"), dict(speaker="z", text="extra words")]
        self.assertEqual(benchmark.cpwer(reference, hypothesis)["errors"], 2)

    def test_split_voice_is_penalized(self):
        reference = [dict(referenceSpeaker="a", text="one two three four")]
        hypothesis = [dict(speaker="x", text="one two"), dict(speaker="y", text="three four")]
        self.assertEqual(benchmark.cpwer(reference, hypothesis)["errors"], 4)

    def test_der_uses_optimal_speaker_permutation_and_scores_overlap(self):
        from pyannote.core import Annotation, Segment, Timeline
        from pyannote.metrics.diarization import DiarizationErrorRate
        reference, hypothesis = Annotation(), Annotation()
        reference[Segment(0, 2), 0] = "a"
        reference[Segment(1, 3), 1] = "b"
        hypothesis[Segment(0, 2), 0] = "x"
        metric = DiarizationErrorRate(collar=0, skip_overlap=False)
        details = metric(reference, hypothesis, uem=Timeline([Segment(0, 3)]), detailed=True)
        self.assertEqual(details["total"], 4)
        self.assertEqual(details["missed detection"], 2)
        self.assertEqual(details["diarization error rate"], 0.5)
        self.assertEqual(metric.optimal_mapping(reference, hypothesis), {"x": "a"})


if __name__ == "__main__":
    unittest.main()
