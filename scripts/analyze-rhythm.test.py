from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

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
