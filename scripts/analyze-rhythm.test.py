from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np


MODULE_PATH = Path(__file__).with_name("analyze-rhythm.py")
SPEC = importlib.util.spec_from_file_location("analyze_rhythm", MODULE_PATH)
assert SPEC and SPEC.loader
ANALYZER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ANALYZER
SPEC.loader.exec_module(ANALYZER)


def bars(count: int) -> list[dict]:
    return [
        {
            "index": index,
            "startSeconds": float(index),
            "endSeconds": float(index + 1),
            "intensity": 0.25,
        }
        for index in range(count)
    ]


def pitched_signal(frequencies: np.ndarray, sample_rate: int) -> np.ndarray:
    phase = 2 * np.pi * np.cumsum(frequencies, dtype=np.float64) / sample_rate
    signal = 0.35 * np.sin(phase)
    edge_samples = min(sample_rate // 20, signal.size // 4)
    if edge_samples:
        envelope = np.ones_like(signal)
        envelope[:edge_samples] = np.linspace(0.0, 1.0, edge_samples, endpoint=False)
        envelope[-edge_samples:] = np.linspace(1.0, 0.0, edge_samples, endpoint=False)
        signal *= envelope
    return signal


class ContinuousPitchEvidenceTest(unittest.TestCase):
    def test_reusing_existing_game_audio_never_runs_an_in_place_transcode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            audio_path = Path(directory) / "existing.mp3"
            audio_path.write_bytes(b"already-compressed")
            audio_info = SimpleNamespace(format="MP3", samplerate=32_000, channels=2)
            with (
                patch.object(ANALYZER.sf, "info", return_value=audio_info),
                patch.object(ANALYZER.subprocess, "run") as run,
            ):
                result = ANALYZER.compress_game_audio(audio_path, audio_path)

        run.assert_not_called()
        self.assertTrue(result["reusedExistingAudio"])
        self.assertEqual(result["sourceBytes"], result["compressedBytes"])
        self.assertEqual(result["sizeRatio"], 1.0)

    def test_rising_tone_produces_measured_increasing_support_points(self) -> None:
        sample_rate = ANALYZER.SAMPLE_RATE
        duration = 2.4
        sample_count = round(duration * sample_rate)
        frequencies = np.linspace(220.0, 440.0, sample_count, dtype=np.float64)

        result = ANALYZER.build_continuous_pitch(
            pitched_signal(frequencies, sample_rate),
            sample_rate,
        )

        self.assertEqual(result["schemaVersion"], "1.0.0")
        self.assertEqual(result["algorithm"], "librosa-pyin-harmonic-v1")
        self.assertEqual(result["sourceRole"], "estimated-melody")
        self.assertEqual(result["diagnostics"]["status"], "ok")
        self.assertEqual(len(result["traces"]), 1)
        points = result["traces"][0]["points"]
        self.assertGreaterEqual(len(points), 5)
        self.assertGreater(points[-1]["pitchMidi"] - points[0]["pitchMidi"], 9.0)
        self.assertTrue(all(
            left["timeSeconds"] < right["timeSeconds"]
            for left, right in zip(points, points[1:])
        ))
        frame_seconds = ANALYZER.CONTINUOUS_PITCH_HOP_LENGTH / sample_rate
        self.assertTrue(all(
            abs(point["timeSeconds"] / frame_seconds - round(point["timeSeconds"] / frame_seconds)) < 1e-3
            for point in points
        ))

    def test_sine_contour_keeps_turns_instead_of_flattening_to_endpoints(self) -> None:
        sample_rate = ANALYZER.SAMPLE_RATE
        duration = 3.0
        sample_count = round(duration * sample_rate)
        phase = np.linspace(0.0, 1.0, sample_count, endpoint=False)
        frequencies = 220.0 * (2.0 ** ((12.0 * np.sin(np.pi * phase)) / 12.0))

        result = ANALYZER.build_continuous_pitch(
            pitched_signal(frequencies, sample_rate),
            sample_rate,
        )

        self.assertEqual(result["diagnostics"]["status"], "ok")
        points = result["traces"][0]["points"]
        highest = max(points, key=lambda point: point["pitchMidi"])
        self.assertGreater(highest["pitchMidi"], points[0]["pitchMidi"] + 9.0)
        self.assertGreater(highest["pitchMidi"], points[-1]["pitchMidi"] + 9.0)
        self.assertGreater(highest["timeSeconds"], 1.1)
        self.assertLess(highest["timeSeconds"], 1.9)

    def test_unvoiced_gap_separates_two_independent_traces(self) -> None:
        sample_rate = ANALYZER.SAMPLE_RATE
        tone_samples = sample_rate
        tone = pitched_signal(
            np.full(tone_samples, 330.0, dtype=np.float64),
            sample_rate,
        )
        signal = np.concatenate([
            tone,
            np.zeros(round(0.35 * sample_rate), dtype=np.float64),
            tone,
        ])

        result = ANALYZER.build_continuous_pitch(signal, sample_rate)

        self.assertEqual(result["diagnostics"]["status"], "ok")
        self.assertEqual(len(result["traces"]), 2)
        self.assertLess(
            result["traces"][0]["endSeconds"],
            result["traces"][1]["startSeconds"],
        )

    def test_silence_and_missing_audio_fail_closed_without_invented_points(self) -> None:
        silence = ANALYZER.build_continuous_pitch(
            np.zeros(ANALYZER.SAMPLE_RATE, dtype=np.float64),
            ANALYZER.SAMPLE_RATE,
        )
        missing = ANALYZER.build_continuous_pitch(
            np.asarray([], dtype=np.float64),
            ANALYZER.SAMPLE_RATE,
        )

        self.assertEqual(silence["traces"], [])
        self.assertEqual(silence["diagnostics"]["status"], "silent-input")
        self.assertEqual(silence["diagnostics"]["pointCount"], 0)
        self.assertEqual(missing["traces"], [])
        self.assertEqual(missing["diagnostics"]["status"], "missing-audio")
        self.assertEqual(missing["diagnostics"]["pointCount"], 0)


class Core4StemEvidenceTest(unittest.TestCase):
    def test_cli_accepts_a_precomputed_stem_manifest(self) -> None:
        with patch.object(sys, "argv", [
            "analyze-rhythm.py",
            "--audio", "game.mp3",
            "--audio-output", "game.mp3",
            "--output", "analysis.json",
            "--song-id", "fixture-song",
            "--title", "Fixture Song",
            "--audio-url", "./game.mp3",
            "--stems-manifest", "work/core4/manifest.json",
        ]):
            args = ANALYZER.parse_args()

        self.assertEqual(args.stems_manifest, Path("work/core4/manifest.json"))

    def test_loads_cached_manifest_stem_paths_relative_to_the_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manifest_path = Path(directory) / "manifest.json"
            stems = {}
            for role in ("vocals", "drums", "bass", "other"):
                stem_path = Path(directory) / f"{role}.wav"
                stem_path.write_bytes(f"fixture-{role}".encode("utf-8"))
                stems[role] = {
                    "status": "ready",
                    "file": stem_path.name,
                    "checksum": f"checksum-{role}",
                }
            manifest_path.write_text(json.dumps({
                "kind": "core4-separation-manifest",
                "schemaVersion": "1.0.0",
                "status": "ready",
                "audioFingerprint": "fixture-audio",
                "timeOriginSeconds": 0,
                "stems": stems,
            }), encoding="utf-8")

            loaded = ANALYZER.load_stem_separation_manifest(
                manifest_path,
                expected_audio_fingerprint="fixture-audio",
            )

        self.assertEqual(loaded["status"], "ready")
        for role in ("vocals", "drums", "bass", "other"):
            self.assertEqual(
                loaded["stems"][role]["path"],
                str((Path(directory) / f"{role}.wav").resolve()),
            )

    def test_manifest_for_different_game_audio_fails_closed_without_stem_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manifest_path = Path(directory) / "manifest.json"
            manifest_path.write_text(json.dumps({
                "kind": "core4-separation-manifest",
                "schemaVersion": "1.0.0",
                "status": "ready",
                "audioFingerprint": "wrong-audio",
                "timeOriginSeconds": 0,
                "stems": {
                    role: {"status": "ready", "file": f"{role}.wav"}
                    for role in ("vocals", "drums", "bass", "other")
                },
            }), encoding="utf-8")

            loaded = ANALYZER.load_stem_separation_manifest(
                manifest_path,
                expected_audio_fingerprint="current-audio",
            )

        self.assertEqual(loaded["status"], "unavailable")
        self.assertIn("audio fingerprint", loaded["diagnostics"]["error"].lower())
        self.assertTrue(all(
            stem["status"] == "unavailable" and "path" not in stem
            for stem in loaded["stems"].values()
        ))

    def test_missing_manifest_becomes_unavailable_evidence_without_invented_events(self) -> None:
        result = ANALYZER.build_stem_evidence_from_manifest(
            Path("missing-core4-manifest.json"),
            expected_audio_fingerprint="current-audio",
            duration=12.0,
        )

        self.assertEqual(result["status"], "unavailable")
        self.assertIn("manifest", result["diagnostics"]["separation"]["error"].lower())
        for stem in result["stems"].values():
            self.assertEqual(stem["status"], "unavailable")
            self.assertEqual(stem["timingEvents"], [])
            self.assertEqual(stem["pitchTraces"], [])
            self.assertEqual(stem["pitchLandmarks"], [])
            self.assertEqual(stem["accentEvents"], [])

    def test_extracts_role_specific_evidence_on_the_original_zero_based_timeline(self) -> None:
        sample_rate = ANALYZER.SAMPLE_RATE
        duration = 3.0
        sample_count = round(duration * sample_rate)
        times = np.arange(sample_count, dtype=np.float64) / sample_rate

        vocals = np.zeros(sample_count, dtype=np.float64)
        for start, end, frequency in [(0.55, 1.05, 220.0), (1.25, 1.75, 330.0), (1.95, 2.45, 440.0)]:
            active = (times >= start) & (times < end)
            vocals[active] = 0.35 * np.sin(2 * np.pi * frequency * times[active])

        drums = np.zeros(sample_count, dtype=np.float64)
        for hit_time in [0.6, 1.0, 1.4, 1.8, 2.2]:
            start = round(hit_time * sample_rate)
            length = round(0.05 * sample_rate)
            drums[start:start + length] += 0.8 * np.exp(-np.arange(length) / (sample_rate * 0.008))

        bass = np.zeros(sample_count, dtype=np.float64)
        for start, end, frequency in [(0.6, 1.0, 110.0), (1.2, 1.6, 146.83), (1.8, 2.2, 196.0)]:
            active = (times >= start) & (times < end)
            bass[active] = 0.4 * np.sin(2 * np.pi * frequency * times[active])

        other = 0.25 * np.sin(2 * np.pi * 523.25 * times)

        with tempfile.TemporaryDirectory() as directory:
            stem_paths = {}
            for role, signal in {
                "vocals": vocals,
                "drums": drums,
                "bass": bass,
                "other": other,
            }.items():
                path = Path(directory) / f"{role}.wav"
                ANALYZER.sf.write(path, signal, sample_rate, subtype="PCM_16")
                stem_paths[role] = path

            manifest = {
                "schemaVersion": "1.0.0",
                "status": "ready",
                "audioFingerprint": "fixture-audio",
                "separator": {
                    "id": "fixture-core4",
                    "model": "fixture-model",
                    "version": "1.0.0",
                    "checksum": "fixture-separator-checksum",
                },
                "timeOriginSeconds": 0,
                "cache": {"key": "fixture-cache", "hit": False, "manifestPath": "fixture"},
                "stems": {
                    role: {"status": "ready", "checksum": f"checksum-{role}", "path": str(path)}
                    for role, path in stem_paths.items()
                },
            }

            def fixture_notes(_wav_path: Path, _duration: float):
                return [
                    ANALYZER.DetectorEvent(
                        time=0.8,
                        score=0.91,
                        source="fixture-note",
                        midi_pitch=72,
                        pitch_min=72,
                        pitch_max=72,
                        duration=0.3,
                        polyphony=1,
                    ),
                ], {"available": True}

            with patch.object(ANALYZER, "run_beat_this", side_effect=AssertionError("stem Beat This is forbidden")):
                result = ANALYZER.build_stem_evidence(
                    manifest,
                    duration,
                    note_transcriber=fixture_notes,
                )

        self.assertEqual(result["kind"], "core4-stem-evidence")
        self.assertEqual(result["schemaVersion"], "1.0.0")
        self.assertEqual(result["status"], "ready", result["stems"])
        self.assertEqual(result["timeOriginSeconds"], 0)
        self.assertEqual(len(result["evidenceFingerprint"]), 64)
        self.assertEqual(set(result["stems"]), {"vocals", "drums", "bass", "other"})
        for role in ("vocals", "drums", "bass", "other"):
            stem = result["stems"][role]
            self.assertEqual(stem["status"], "ready")
            self.assertIn("timingEvents", stem)
            self.assertIn("pitchTraces", stem)
            self.assertIn("pitchLandmarks", stem)
            self.assertIn("accentEvents", stem)
            self.assertTrue(all(0 <= event["timeSeconds"] <= duration for event in stem["timingEvents"]))

        self.assertTrue(result["stems"]["vocals"]["timingEvents"])
        self.assertTrue(result["stems"]["vocals"]["pitchTraces"])
        self.assertTrue(result["stems"]["vocals"]["pitchLandmarks"])
        self.assertTrue(result["stems"]["drums"]["timingEvents"])
        self.assertTrue(all(
            event["kind"] == "drum-hit"
            for event in result["stems"]["drums"]["timingEvents"]
        ))
        self.assertTrue(result["stems"]["drums"]["accentEvents"])
        self.assertTrue(result["stems"]["bass"]["timingEvents"])
        self.assertTrue(all(
            "pitchMidi" in event
            for event in result["stems"]["bass"]["timingEvents"]
        ))
        self.assertEqual(result["stems"]["other"]["timingEvents"][0]["pitchMidi"], 72)


class AdaptivePhraseSegmentationTest(unittest.TestCase):
    def test_structure_provenance_names_timing_features_and_clustering(self) -> None:
        structure = ANALYZER.build_musical_structure(
            np.zeros(1, dtype=np.float64),
            np.zeros(1, dtype=np.float64),
            {},
            [],
            [],
            0.0,
        )

        self.assertEqual(
            structure["algorithm"],
            "beat-this-downbeats+librosa-adaptive-evidence-phrases+agglomerative-v2",
        )

    def test_uses_measured_variable_length_section_seams(self) -> None:
        song_bars = bars(12)
        features = np.vstack([
            np.tile([1.0, 0.0, 0.1], (3, 1)),
            np.tile([0.0, 1.0, 0.5], (5, 1)),
            np.tile([-1.0, 0.0, 0.9], (4, 1)),
        ])
        sections = [
            {"startBarIndex": 0, "boundarySupport": 1.0},
            {"startBarIndex": 3, "boundarySupport": 1.0},
            {"startBarIndex": 8, "boundarySupport": 1.0},
        ]
        ranges, diagnostics = ANALYZER._adaptive_phrase_ranges(
            song_bars,
            features,
            sections,
            {3: 1.0, 8: 1.0},
        )

        self.assertEqual(ranges, [(0, 3), (3, 8), (8, 12)])
        self.assertEqual([right - left for left, right in ranges], [3, 5, 4])
        self.assertEqual(diagnostics["algorithm"], "evidence-boundary-dp-v1")

    def test_flat_evidence_degrades_to_one_unique_sentence(self) -> None:
        song_bars = bars(11)
        features = np.ones((11, 5), dtype=np.float64)

        first, first_diagnostics = ANALYZER._adaptive_phrase_ranges(
            song_bars,
            features,
            [],
            {},
        )
        second, second_diagnostics = ANALYZER._adaptive_phrase_ranges(
            song_bars,
            features,
            [],
            {},
        )

        self.assertEqual(first, [(0, 11)])
        self.assertEqual(first, second)
        self.assertEqual(first_diagnostics, second_diagnostics)

    def test_long_smooth_region_splits_at_its_best_real_seam_not_a_fixed_span(self) -> None:
        song_bars = bars(17)
        scores = np.zeros(18, dtype=np.float64)
        scores[7] = 0.12

        boundaries, forced = ANALYZER._enforce_maximum_phrase_span(
            [0, 17],
            scores,
            song_bars,
            0.2,
        )

        self.assertEqual(boundaries, [0, 7, 17])
        self.assertEqual([item["barIndex"] for item in forced], [7])
        self.assertEqual(forced[0]["reason"], "maximum-phrase-span")
        self.assertEqual(forced[0]["evidenceStrength"], "weak-fallback")

    def test_flat_twenty_bar_region_has_a_deterministic_non_stride_fallback(self) -> None:
        song_bars = bars(20)
        features = np.ones((20, 5), dtype=np.float64)

        first, first_diagnostics = ANALYZER._adaptive_phrase_ranges(song_bars, features, [], {})
        second, second_diagnostics = ANALYZER._adaptive_phrase_ranges(song_bars, features, [], {})

        self.assertEqual(first, second)
        self.assertEqual(first_diagnostics, second_diagnostics)
        self.assertTrue(all(2 <= right - left <= 12 for left, right in first))
        self.assertNotEqual(
            first_diagnostics["boundaries"],
            [0, 4, 8, 12, 16, 20],
        )
        self.assertTrue(first_diagnostics["forcedLongRegionBoundaries"])
        self.assertTrue(all(
            item["evidenceStrength"] == "weak-fallback"
            for item in first_diagnostics["forcedLongRegionBoundaries"]
        ))

    def test_recursive_long_region_guard_keeps_every_phrase_between_two_and_twelve_bars(self) -> None:
        song_bars = bars(29)
        features = np.ones((29, 3), dtype=np.float64)

        ranges, diagnostics = ANALYZER._adaptive_phrase_ranges(song_bars, features, [], {})

        self.assertTrue(all(2 <= right - left <= 12 for left, right in ranges))
        self.assertGreaterEqual(len(diagnostics["forcedLongRegionBoundaries"]), 2)

    def test_every_boundary_is_a_real_downbeat_index(self) -> None:
        song_bars = bars(13)
        features = np.eye(13, 13, dtype=np.float64)
        ranges, diagnostics = ANALYZER._adaptive_phrase_ranges(
            song_bars,
            features,
            [],
            {},
        )

        self.assertEqual(ranges[0][0], 0)
        self.assertEqual(ranges[-1][1], len(song_bars))
        self.assertTrue(all(0 <= boundary <= len(song_bars) for boundary in diagnostics["boundaries"]))
        self.assertTrue(all(right - left >= 2 for left, right in ranges))

    def test_discards_a_mandatory_seam_that_would_leave_a_one_bar_tail(self) -> None:
        song_bars = bars(13)
        features = np.vstack([
            np.tile([1.0, 0.0], (12, 1)),
            np.asarray([[0.0, 1.0]]),
        ])
        ranges, diagnostics = ANALYZER._adaptive_phrase_ranges(
            song_bars,
            features,
            [
                {"startBarIndex": 0, "boundarySupport": 1.0},
                {"startBarIndex": 12, "boundarySupport": 1.0},
            ],
            {12: 1.0},
        )

        self.assertNotIn(12, diagnostics["boundaries"])
        self.assertTrue(all(right - left >= 2 for left, right in ranges))

    def test_overlap_candidates_use_salient_boundaries_not_every_bar(self) -> None:
        phrase_ranges = [(0, 3), (3, 8), (8, 12)]
        segmentation = {
            "threshold": 0.5,
            "boundaries": [0, 3, 8, 12],
            "scores": [
                {"barIndex": index, "score": 0.8 if index in {2, 3, 7, 8, 11} else 0.1}
                for index in range(1, 12)
            ],
        }

        candidates = ANALYZER._adaptive_overlap_ranges(phrase_ranges, segmentation, 12)

        self.assertLess(len(candidates), 12)
        self.assertTrue(all(start in {0, 2, 3, 7, 8, 11, 12} for start, _ in candidates))
        self.assertTrue(all(end - start in {4, 5} for start, end in candidates))

    def test_overlap_candidates_can_find_a_prefix_shift_without_sliding_every_bar(self) -> None:
        phrase_ranges = [(0, 4), (4, 9), (9, 13)]
        segmentation = {
            "threshold": 0.5,
            "boundaries": [0, 4, 9, 13],
            "scores": [
                {
                    "barIndex": index,
                    "score": 0.9 if index in {2, 7} else 0.1,
                    "sectionSupport": 0.0,
                }
                for index in range(1, 13)
            ],
        }

        candidates = ANALYZER._adaptive_overlap_ranges(phrase_ranges, segmentation, 13)

        self.assertIn((2, 7), candidates)
        self.assertIn((7, 12), candidates)
        self.assertNotIn((1, 6), candidates)
        self.assertLess(len({start for start, _ in candidates}), 13)

    def test_overlap_recurrence_output_drops_related_variants_and_family_bridges(self) -> None:
        families = [
            {"id": "OF01", "phraseIds": ["O01", "O03"], "relatedFamilyIds": ["OF02"]},
            {"id": "OF02", "phraseIds": ["O02", "O04"], "relatedFamilyIds": ["OF01"]},
        ]
        links = [
            {
                "sourcePhraseId": "O01",
                "targetPhraseId": "O03",
                "relationship": "same-family",
                "similarity": 0.91,
            },
            {
                "sourcePhraseId": "O01",
                "targetPhraseId": "O02",
                "relationship": "related-variant",
                "similarity": 0.84,
            },
        ]

        retained_families, retained_links = ANALYZER._retain_exact_overlap_recurrences(
            families,
            links,
            {"O01", "O02", "O03", "O04"},
        )

        self.assertEqual([link["relationship"] for link in retained_links], ["same-family"])
        self.assertTrue(all(family["relatedFamilyIds"] == [] for family in retained_families))

    def test_silence_to_music_is_a_strong_feature_boundary(self) -> None:
        self.assertEqual(
            ANALYZER._cosine_distance(np.zeros(4), np.asarray([1.0, 0.0, 0.0, 0.0])),
            1.0,
        )
        self.assertEqual(ANALYZER._cosine_distance(np.zeros(4), np.zeros(4)), 0.0)


if __name__ == "__main__":
    unittest.main()
