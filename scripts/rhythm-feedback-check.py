#!/usr/bin/env python3
"""Small deterministic check for explicit listening-room feedback plumbing."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
MODULE_PATH = ROOT / "scripts/analyze-rhythm.py"
SPEC = importlib.util.spec_from_file_location("neon_slice_rhythm_analysis", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load {MODULE_PATH}")
analysis = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = analysis
SPEC.loader.exec_module(analysis)

candidates = [
    {
        "time": 0.5 + index * 0.5,
        "baseScore": 0.5 + (index % 5) * 0.08,
        "sourceScores": {"mix": 0.5 + (index % 5) * 0.08},
    }
    for index in range(40)
]
detectors = {
    "mix": [
        analysis.DetectorEvent(candidate["time"], candidate["baseScore"], "mix")
        for candidate in candidates
    ],
}
curves = {
    "rms_rise": analysis.np.zeros(2_000, dtype=float),
    "chroma_novelty": analysis.np.zeros(2_000, dtype=float),
}
labels = [candidates[index]["time"] for index in range(2, 40, 5)]
review = [
    {"verdict": "reject", "eventTimeSeconds": candidates[2]["time"]},
    {"verdict": "keep", "eventTimeSeconds": candidates[3]["time"]},
]

_, metadata = analysis.train_preference_model(candidates, detectors, curves, labels, review)
assert metadata["trained"] is True
assert metadata["reviewFeedbackCount"] == 2
assert metadata["matchedReviewFeedbackCount"] == 2
assert metadata["reviewVerdictCounts"] == {"keep": 1, "reject": 1, "missing": 0}
print("rhythm feedback check passed")
