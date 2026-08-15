#!/usr/bin/env python3
"""Generate non-quantized rhythm candidates and a human-preference comparison file.

All precise event times come from mature detector outputs. The small classifier only
chooses between those candidates; it never creates, moves, or snaps an event.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Iterable, Sequence

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("TORCH_HOME", str(ROOT / ".cache" / "torch"))

import librosa
import numpy as np
import soundfile as sf
from sklearn.linear_model import LogisticRegression
from sklearn.cluster import AgglomerativeClustering
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from scipy.sparse import diags


SAMPLE_RATE = 22_050
HOP_LENGTH = 256
N_FFT = 1_024
MIN_OUTPUT_GAP_SECONDS = 0.12
TRAINING_MATCH_SECONDS = 0.12
SOURCE_MATCH_SECONDS = 0.09
REVIEW_MATCH_SECONDS = 0.18
COLORS = {
    "human-reference": "#f4f7ff",
    "legacy-grid": "#7c879c",
    "librosa-onset": "#35e4ed",
    "basic-pitch": "#b879ff",
    "beat-this": "#ffc857",
    "preference-fusion": "#ff4f9a",
}

STRUCTURE_BARS_PER_PHRASE = 8
STRUCTURE_OVERLAP_STRIDE_BARS = 4
STRUCTURE_SAME_FAMILY_SIMILARITY = 0.84
STRUCTURE_RELATED_VARIANT_SIMILARITY = 0.78
STRUCTURE_OVERLAP_EXACT_SIMILARITY = 0.88
STRUCTURE_OVERLAP_RELATED_SIMILARITY = 0.82


@dataclass(frozen=True)
class DetectorEvent:
    time: float
    score: float
    source: str


def package_version(name: str) -> str | None:
    try:
        return version(name)
    except PackageNotFoundError:
        return None


def round_number(value: float, digits: int = 5) -> float:
    return round(float(value), digits)


def normalize_curve(values: np.ndarray) -> np.ndarray:
    values = np.nan_to_num(np.asarray(values, dtype=np.float64), nan=0.0, posinf=0.0, neginf=0.0)
    if not values.size:
        return values
    low = float(np.percentile(values, 20))
    high = float(np.percentile(values, 97))
    return np.clip((values - low) / max(1e-9, high - low), 0, 1)


def load_labels(path: Path) -> list[float]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload.get("timeSeconds"), list):
        raw = payload["timeSeconds"]
    else:
        raw = [marker.get("timeSeconds") for marker in payload.get("markers", [])]
    return sorted(float(value) for value in raw if isinstance(value, (int, float)) and math.isfinite(value))


def load_review_feedback(path: Path) -> list[dict]:
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    feedback = payload.get("feedback", [])
    if not isinstance(feedback, list):
        raise ValueError(f"Feedback file must contain an array: {path}")
    return [
        item
        for item in feedback
        if isinstance(item, dict) and item.get("verdict") in {"keep", "reject", "missing"}
    ]


def load_legacy_times(path: Path) -> list[float]:
    if not path.exists():
        return []
    level = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(level.get("timeSeconds"), list):
        return sorted(float(value) for value in level["timeSeconds"])
    if level.get("version") == 3:
        return [
            float(event["timeSeconds"])
            for event in level.get("events", [])
            if 1 in event.get("obstacles", [])
        ]
    bpm = float(level["song"]["bpm"])
    offset = float(level["song"]["beatOffsetSeconds"])
    tick_duration = 60 / bpm / int(level["ticksPerBeat"])
    return [
        offset + tick * tick_duration
        for tick, row in enumerate(level.get("obstacles", []))
        if 1 in row
    ]


def curve_events(
    source: str,
    envelope: np.ndarray,
    duration: float,
    delta: float,
    wait: int,
) -> list[DetectorEvent]:
    normalized = normalize_curve(envelope)
    frames = librosa.onset.onset_detect(
        onset_envelope=envelope,
        sr=SAMPLE_RATE,
        hop_length=HOP_LENGTH,
        units="frames",
        backtrack=False,
        pre_max=3,
        post_max=3,
        pre_avg=10,
        post_avg=10,
        delta=delta,
        wait=wait,
    )
    events: list[DetectorEvent] = []
    for frame in frames:
        time = float(librosa.frames_to_time(frame, sr=SAMPLE_RATE, hop_length=HOP_LENGTH))
        if 0.5 <= time <= duration - 0.5:
            events.append(DetectorEvent(time, float(normalized[int(frame)]), source))
    return events


def build_librosa_detectors(y: np.ndarray, duration: float):
    harmonic, percussive = librosa.effects.hpss(y, margin=(1.35, 1.35))
    signals = {
        "mix": y,
        "percussive": percussive,
        "harmonic": harmonic,
    }
    curves: dict[str, np.ndarray] = {}
    events: dict[str, list[DetectorEvent]] = {}
    settings = {
        "mix": (0.11, 4),
        "percussive": (0.10, 4),
        "harmonic": (0.085, 3),
    }
    display_events: list[DetectorEvent] = []
    for source, signal in signals.items():
        curve = librosa.onset.onset_strength(
            y=signal,
            sr=SAMPLE_RATE,
            hop_length=HOP_LENGTH,
            n_fft=N_FFT,
            aggregate=np.median,
        )
        curves[source] = normalize_curve(curve)
        delta, wait = settings[source]
        events[source] = curve_events(source, curve, duration, delta, wait)
        if source == "mix":
            # A conservative, directly playable view of librosa's detector.
            # The lower-threshold events above stay available to the fusion model.
            display_events = curve_events(source, curve, duration, 0.30, 8)

    mel = librosa.feature.melspectrogram(
        y=y,
        sr=SAMPLE_RATE,
        n_fft=N_FFT,
        hop_length=HOP_LENGTH,
        n_mels=96,
        fmin=30,
        fmax=SAMPLE_RATE / 2,
    )
    mel_db = librosa.power_to_db(mel, ref=np.max)
    channel_edges = [0, 10, 24, 42, 66, 96]
    multi = librosa.onset.onset_strength_multi(
        S=mel_db,
        sr=SAMPLE_RATE,
        hop_length=HOP_LENGTH,
        channels=channel_edges,
        aggregate=np.mean,
    )
    band_names = ["bass", "low_mid", "mid", "high_mid", "high"]
    for index, band_name in enumerate(band_names):
        source = f"band_{band_name}"
        band_curve = np.asarray(multi[index])
        curves[source] = normalize_curve(band_curve)
        events[source] = curve_events(source, band_curve, duration, 0.09, 3)

    rms = librosa.feature.rms(y=y, frame_length=N_FFT, hop_length=HOP_LENGTH, center=True)[0]
    log_rms = np.log1p(rms * 100)
    curves["rms_rise"] = normalize_curve(np.maximum(0, np.diff(log_rms, prepend=log_rms[0])))

    chroma = librosa.feature.chroma_stft(
        y=harmonic,
        sr=SAMPLE_RATE,
        n_fft=2_048,
        hop_length=HOP_LENGTH,
    )
    chroma_diff = np.sum(np.abs(np.diff(chroma, axis=1, prepend=chroma[:, :1])), axis=0)
    curves["chroma_novelty"] = normalize_curve(chroma_diff)
    return harmonic, curves, events, display_events


def cluster_events(events: Sequence[DetectorEvent], gap: float = 0.055) -> list[DetectorEvent]:
    if not events:
        return []
    ordered = sorted(events, key=lambda event: event.time)
    clusters: list[list[DetectorEvent]] = [[ordered[0]]]
    for event in ordered[1:]:
        if event.time - clusters[-1][0].time <= gap:
            clusters[-1].append(event)
        else:
            clusters.append([event])
    return [max(cluster, key=lambda event: event.score) for cluster in clusters]


def nms_detector_events(events: Sequence[DetectorEvent], minimum_gap: float) -> list[DetectorEvent]:
    selected: list[DetectorEvent] = []
    for event in sorted(events, key=lambda item: item.score, reverse=True):
        if all(abs(event.time - existing.time) >= minimum_gap for existing in selected):
            selected.append(event)
    return sorted(selected, key=lambda item: item.time)


def run_basic_pitch(wav_path: Path, duration: float) -> tuple[list[DetectorEvent], dict]:
    metadata = {
        "id": "basic-pitch",
        "name": "Spotify Basic Pitch",
        "version": package_version("basic-pitch"),
        "available": False,
        "runtime": "ONNX",
    }
    try:
        from basic_pitch import ICASSP_2022_MODEL_PATH
        from basic_pitch.inference import Model, predict

        model = Model(ICASSP_2022_MODEL_PATH)
        _, _, notes = predict(
            wav_path,
            model_or_model_path=model,
            onset_threshold=0.5,
            frame_threshold=0.3,
            minimum_note_length=90,
        )
        raw = [
            DetectorEvent(float(note[0]), float(note[3]), "basic_pitch")
            for note in notes
            if 0.5 <= float(note[0]) <= duration - 0.5
        ]
        clustered = cluster_events(raw, gap=0.05)
        metadata.update({"available": True, "eventCount": len(clustered)})
        return clustered, metadata
    except Exception as error:  # optional model backend
        metadata["error"] = f"{type(error).__name__}: {error}"
        return [], metadata


def run_beat_this(wav_path: Path) -> tuple[list[DetectorEvent], list[DetectorEvent], dict]:
    metadata = {
        "id": "beat-this",
        "name": "Beat This!",
        "version": package_version("beat-this"),
        "checkpoint": "final0",
        "available": False,
    }
    try:
        from beat_this.inference import File2Beats

        tracker = File2Beats(checkpoint_path="final0", device="cpu", dbn=False)
        beats, downbeats = tracker(str(wav_path))
        downbeat_times = [float(value) for value in downbeats]
        downbeat_events = [DetectorEvent(time, 1.0, "downbeat") for time in downbeat_times]
        beat_events = [
            DetectorEvent(
                float(time),
                1.0 if any(abs(float(time) - downbeat) <= 0.03 for downbeat in downbeat_times) else 0.72,
                "beat_this",
            )
            for time in beats
        ]
        metadata.update({
            "available": True,
            "eventCount": len(beat_events),
            "downbeatCount": len(downbeat_events),
        })
        return beat_events, downbeat_events, metadata
    except Exception as error:  # optional model backend
        metadata["error"] = f"{type(error).__name__}: {error}"
        return [], [], metadata


def _safe_cosine_matrix(vectors: Sequence[np.ndarray]) -> np.ndarray:
    """Return a finite cosine matrix, including sensible zero-vector diagonals."""
    if not vectors:
        return np.empty((0, 0), dtype=np.float64)
    matrix = np.asarray(vectors, dtype=np.float64)
    matrix = np.nan_to_num(matrix, nan=0.0, posinf=0.0, neginf=0.0)
    similarities = cosine_similarity(matrix)
    similarities = np.clip(np.nan_to_num(similarities, nan=0.0), -1.0, 1.0)
    np.fill_diagonal(similarities, 1.0)
    return similarities


def _temporal_means(
    feature: np.ndarray,
    frame_times: np.ndarray,
    start_time: float,
    end_time: float,
    bin_count: int,
) -> np.ndarray:
    """Average frame features into time-relative bins without moving any event."""
    feature = np.asarray(feature, dtype=np.float64)
    if feature.ndim == 1:
        feature = feature[np.newaxis, :]
    boundaries = np.linspace(start_time, end_time, bin_count + 1)
    result = np.zeros((bin_count, feature.shape[0]), dtype=np.float64)
    for bin_index in range(bin_count):
        left = int(np.searchsorted(frame_times, boundaries[bin_index], side="left"))
        right = int(np.searchsorted(frame_times, boundaries[bin_index + 1], side="left"))
        left = min(max(left, 0), feature.shape[1] - 1)
        right = min(max(right, left + 1), feature.shape[1])
        result[bin_index] = np.mean(feature[:, left:right], axis=1)
    return np.nan_to_num(result, nan=0.0, posinf=0.0, neginf=0.0)


def _row_l2_normalize(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.float64)
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    return values / np.maximum(norms, 1e-9)


def _robust_feature_scale(values: np.ndarray) -> np.ndarray:
    """Feature-wise robust scaling used only for similarity, never for timing."""
    values = np.asarray(values, dtype=np.float64)
    median = np.median(values, axis=0, keepdims=True)
    lower = np.percentile(values, 25, axis=0, keepdims=True)
    upper = np.percentile(values, 75, axis=0, keepdims=True)
    return np.clip((values - median) / np.maximum(upper - lower, 1e-6), -4.0, 4.0)


def _timeline_from_beat_this(
    beat_events: Sequence[DetectorEvent],
    downbeat_events: Sequence[DetectorEvent],
    duration: float,
) -> tuple[list[dict], list[dict], int]:
    beat_times = sorted({float(event.time) for event in beat_events if 0 <= event.time <= duration})
    downbeat_times = sorted({float(event.time) for event in downbeat_events if 0 <= event.time <= duration})
    if len(downbeat_times) < 2:
        return [], [], 4

    downbeat_intervals = np.diff(downbeat_times)
    typical_bar_duration = float(np.median(downbeat_intervals))
    bar_ends = downbeat_times[1:] + [min(duration, downbeat_times[-1] + typical_bar_duration)]

    provisional_assignments: list[list[int]] = [[] for _ in downbeat_times]
    beat_records: list[dict] = []
    for beat_index, beat_time in enumerate(beat_times):
        # A detector peak a few milliseconds before its matching downbeat still
        # belongs to the following bar. This is an association tolerance only;
        # the original time is kept verbatim in the output.
        bar_index = int(np.searchsorted(downbeat_times, beat_time + 0.04, side="right") - 1)
        if bar_index < 0 or bar_index >= len(downbeat_times) or beat_time >= bar_ends[bar_index] + 0.04:
            bar_index_or_none: int | None = None
        else:
            bar_index_or_none = bar_index
            provisional_assignments[bar_index].append(beat_index)
        is_downbeat = any(abs(beat_time - downbeat) <= 0.04 for downbeat in downbeat_times)
        beat_records.append({
            "index": beat_index,
            "timeSeconds": round_number(beat_time),
            "isDownbeat": is_downbeat,
            "barIndex": bar_index_or_none,
            "beatInBar": None,
        })

    complete_counts = [
        len(indices)
        for indices, end_time in zip(provisional_assignments[:-1], bar_ends[:-1])
        if indices and end_time <= duration
    ]
    if complete_counts:
        counts, frequencies = np.unique(complete_counts, return_counts=True)
        beats_per_bar = int(counts[int(np.argmax(frequencies))])
        beats_per_bar = min(max(beats_per_bar, 2), 12)
    else:
        beats_per_bar = 4

    bars: list[dict] = []
    for bar_index, (start_time, end_time, beat_indices) in enumerate(
        zip(downbeat_times, bar_ends, provisional_assignments)
    ):
        ordered = sorted(beat_indices, key=lambda index: beat_times[index])
        for beat_in_bar, beat_index in enumerate(ordered, start=1):
            beat_records[beat_index]["beatInBar"] = beat_in_bar
        bars.append({
            "index": bar_index,
            "startSeconds": round_number(start_time),
            "endSeconds": round_number(end_time),
            "downbeatTimeSeconds": round_number(start_time),
            "beatIndices": ordered,
            "beatCount": len(ordered),
        })
    return beat_records, bars, beats_per_bar


def _agglomerative_labels(
    similarity: np.ndarray,
    threshold: float,
    linkage: str = "average",
) -> np.ndarray:
    count = similarity.shape[0]
    if count <= 1:
        return np.zeros(count, dtype=np.int32)
    distance = np.clip(1.0 - similarity, 0.0, 2.0)
    np.fill_diagonal(distance, 0.0)
    model = AgglomerativeClustering(
        n_clusters=None,
        metric="precomputed",
        linkage=linkage,
        distance_threshold=1.0 - threshold,
    )
    return model.fit_predict(distance)


def _family_name(index: int) -> str:
    # A..Z, AA..AZ is ample for song-scale structural units.
    name = ""
    value = index
    while True:
        name = chr(ord("A") + value % 26) + name
        value = value // 26 - 1
        if value < 0:
            return name


def _assign_phrase_families(
    phrases: list[dict],
    combined_similarity: np.ndarray,
    same_threshold: float,
    related_threshold: float,
    family_prefix: str = "F",
    linkage: str = "average",
) -> tuple[list[dict], list[dict]]:
    if not phrases:
        return [], []
    labels = _agglomerative_labels(combined_similarity, same_threshold, linkage)
    label_members: dict[int, list[int]] = {}
    for phrase_index, label in enumerate(labels):
        label_members.setdefault(int(label), []).append(phrase_index)

    recurring_groups = sorted(
        (members for members in label_members.values() if len(members) > 1),
        key=lambda members: members[0],
    )
    singleton_groups = sorted(
        (members for members in label_members.values() if len(members) == 1),
        key=lambda members: members[0],
    )
    ordered_groups = recurring_groups + singleton_groups

    families: list[dict] = []
    phrase_to_family: dict[int, str] = {}
    for family_index, members in enumerate(ordered_groups):
        recurring = len(members) > 1
        identifier = (
            f"{family_prefix}{_family_name(family_index)}"
            if recurring
            else f"{family_prefix}U{members[0] + 1:02d}"
        )
        if recurring:
            internal_means = [
                float(np.mean([combined_similarity[index, other] for other in members if other != index]))
                for index in members
            ]
            prototype = members[int(np.argmax(internal_means))]
            confidence = float(np.mean([
                combined_similarity[left, right]
                for offset, left in enumerate(members)
                for right in members[offset + 1 :]
            ]))
            kind = "repeated"
        else:
            prototype = members[0]
            best_other = max(
                (combined_similarity[prototype, other] for other in range(len(phrases)) if other != prototype),
                default=0.0,
            )
            confidence = float(max(0.0, 1.0 - best_other))
            kind = "unique-low-confidence"
        for member in members:
            phrase_to_family[member] = identifier
            phrases[member]["familyId"] = identifier
            phrases[member]["familyKind"] = kind
            phrases[member]["familyConfidence"] = round_number(confidence, 4)
            phrases[member]["similarityToPrototype"] = round_number(
                combined_similarity[member, prototype], 4
            )
        families.append({
            "id": identifier,
            "kind": kind,
            "prototypePhraseIndex": prototype,
            "phraseIndices": members,
            "phraseIds": [phrases[index]["id"] for index in members],
            "occurrenceCount": len(members),
            "confidence": round_number(confidence, 4),
            "relatedFamilyIds": [],
        })

    family_by_id = {family["id"]: family for family in families}
    links: list[dict] = []
    for left in range(len(phrases)):
        for right in range(left + 1, len(phrases)):
            similarity = float(combined_similarity[left, right])
            left_family = phrase_to_family[left]
            right_family = phrase_to_family[right]
            same_family = left_family == right_family and len(family_by_id[left_family]["phraseIndices"]) > 1
            if same_family:
                relationship = "same-family"
            elif similarity >= related_threshold:
                relationship = "related-variant"
                if right_family not in family_by_id[left_family]["relatedFamilyIds"]:
                    family_by_id[left_family]["relatedFamilyIds"].append(right_family)
                if left_family not in family_by_id[right_family]["relatedFamilyIds"]:
                    family_by_id[right_family]["relatedFamilyIds"].append(left_family)
            else:
                continue
            links.append({
                "sourcePhraseId": phrases[left]["id"],
                "targetPhraseId": phrases[right]["id"],
                "sourcePhraseIndex": left,
                "targetPhraseIndex": right,
                "relationship": relationship,
                "similarity": round_number(similarity, 4),
            })
    return families, links


def _phrase_features(
    bars: Sequence[dict],
    start_bar: int,
    bar_count: int,
    frame_times: np.ndarray,
    chroma_cens: np.ndarray,
    mfcc_scaled: np.ndarray,
    onset_curve: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    chroma_parts: list[np.ndarray] = []
    timbre_parts: list[np.ndarray] = []
    rhythm_parts: list[np.ndarray] = []
    for bar in bars[start_bar : start_bar + bar_count]:
        start_time = float(bar["startSeconds"])
        end_time = float(bar["endSeconds"])
        chroma_bins = _temporal_means(chroma_cens, frame_times, start_time, end_time, 4)
        chroma_parts.append(_row_l2_normalize(np.maximum(chroma_bins, 0.0)).reshape(-1))
        timbre_bins = _temporal_means(mfcc_scaled, frame_times, start_time, end_time, 2)
        timbre_parts.append(timbre_bins.reshape(-1))
        onset_bins = _temporal_means(onset_curve, frame_times, start_time, end_time, 16)
        rhythm_parts.append(_row_l2_normalize(np.maximum(onset_bins.T, 0.0)).reshape(-1))
    return (
        np.concatenate(chroma_parts),
        np.concatenate(timbre_parts),
        np.concatenate(rhythm_parts),
    )


def _make_phrase_units(
    bars: list[dict],
    frame_times: np.ndarray,
    chroma_cens: np.ndarray,
    mfcc_scaled: np.ndarray,
    onset_curve: np.ndarray,
    starts: Sequence[int],
    prefix: str,
) -> tuple[list[dict], dict[str, np.ndarray]]:
    phrases: list[dict] = []
    harmony_vectors: list[np.ndarray] = []
    timbre_vectors: list[np.ndarray] = []
    rhythm_vectors: list[np.ndarray] = []
    for phrase_index, start_bar in enumerate(starts):
        end_bar = start_bar + STRUCTURE_BARS_PER_PHRASE
        if end_bar > len(bars):
            continue
        harmony, timbre, rhythm = _phrase_features(
            bars,
            start_bar,
            STRUCTURE_BARS_PER_PHRASE,
            frame_times,
            chroma_cens,
            mfcc_scaled,
            onset_curve,
        )
        harmony_vectors.append(harmony)
        timbre_vectors.append(timbre)
        rhythm_vectors.append(rhythm)
        intensities = [float(bar.get("intensity", 0.0)) for bar in bars[start_bar:end_bar]]
        phrases.append({
            "index": phrase_index,
            "id": f"{prefix}-{phrase_index + 1:02d}",
            "startSeconds": bars[start_bar]["startSeconds"],
            "endSeconds": bars[end_bar - 1]["endSeconds"],
            "startBarIndex": start_bar,
            "endBarIndex": end_bar,
            "barCount": STRUCTURE_BARS_PER_PHRASE,
            "intensity": round_number(float(np.mean(intensities)), 4),
        })
    return phrases, {
        "harmony": _safe_cosine_matrix(harmony_vectors),
        # Centered MFCC vectors may have negative cosine; map it to [0, 1].
        "timbre": (_safe_cosine_matrix(timbre_vectors) + 1.0) / 2.0,
        "rhythm": _safe_cosine_matrix(rhythm_vectors),
    }


def _combined_phrase_similarity(components: dict[str, np.ndarray]) -> np.ndarray:
    if not components["harmony"].size:
        return np.empty((0, 0), dtype=np.float64)
    combined = (
        0.50 * components["harmony"]
        + 0.20 * components["timbre"]
        + 0.30 * components["rhythm"]
    )
    combined = np.clip(combined, 0.0, 1.0)
    np.fill_diagonal(combined, 1.0)
    return combined


def _multi_scale_sections(
    bars: list[dict],
    bar_feature_matrix: np.ndarray,
) -> tuple[list[dict], list[dict], dict[int, float]]:
    bar_count = len(bars)
    if bar_count < 4:
        return [], [], {}
    # Four-bar context suppresses one-bar fills and makes the clustering listen
    # for musical sentences. Boundaries remain the original downbeat timestamps.
    context_bars = 4 if bar_count >= 16 else 1
    unit_starts = list(range(0, bar_count, context_bars))
    context_features = []
    for start_bar in unit_starts:
        block = bar_feature_matrix[start_bar : min(start_bar + context_bars, bar_count)]
        if len(block) < context_bars:
            block = np.pad(block, ((0, context_bars - len(block)), (0, 0)), mode="edge")
        context_features.append(block.reshape(-1))
    scaled = _robust_feature_scale(np.asarray(context_features, dtype=np.float64))
    unit_count = len(unit_starts)
    connectivity = diags(
        [np.ones(unit_count - 1), np.ones(unit_count - 1)],
        offsets=[-1, 1],
        shape=(unit_count, unit_count),
        format="csr",
    )
    # Use phrase-scale resolutions. Very coarse 2/3-cluster cuts dominated the
    # vote with a single giant middle section on this song and obscured the
    # repeated 8/16-bar form that the chart generator needs to preserve.
    cluster_counts = sorted({count for count in (6, 8, 10, 12, 14, 16, 18) if count < unit_count})
    boundary_votes: dict[int, int] = {}
    scales: list[dict] = []
    for cluster_count in cluster_counts:
        labels = AgglomerativeClustering(
            n_clusters=cluster_count,
            linkage="ward",
            connectivity=connectivity,
        ).fit_predict(scaled)
        boundary_units = [index for index in range(1, unit_count) if labels[index] != labels[index - 1]]
        boundaries = [unit_starts[index] for index in boundary_units]
        for boundary in boundaries:
            boundary_votes[boundary] = boundary_votes.get(boundary, 0) + 1
        scales.append({
            "clusterCount": cluster_count,
            "contextBars": context_bars,
            "boundaryBarIndices": boundaries,
            "boundaryTimesSeconds": [bars[index]["startSeconds"] for index in boundaries],
        })

    support = {
        boundary: votes / len(cluster_counts)
        for boundary, votes in boundary_votes.items()
    }
    # Keep consensus boundaries, and suppress adjacent one-bar duplicates by
    # retaining the higher-supported downbeat. No boundary time is synthesized.
    minimum_support = 3 / max(1, len(cluster_counts))
    candidates = sorted(
        (boundary for boundary, value in support.items() if value >= minimum_support),
        key=lambda boundary: (boundary, -support[boundary]),
    )
    selected: list[int] = []
    for boundary in candidates:
        if selected and boundary - selected[-1] < 3:
            if support[boundary] > support[selected[-1]]:
                selected[-1] = boundary
            continue
        selected.append(boundary)
    # A low-confidence phrase boundary is preferable to a 20+ bar monolith:
    # long regions erase musical-stage identity. Fallbacks are still detector
    # downbeats and are marked with zero agglomerative support.
    fallback_stride = STRUCTURE_BARS_PER_PHRASE
    changed = True
    while changed:
        changed = False
        current_edges = [0] + sorted(selected) + [bar_count]
        for left, right in zip(current_edges, current_edges[1:]):
            if right - left <= 16:
                continue
            fallback = min(
                (
                    boundary
                    for boundary in range(fallback_stride, bar_count, fallback_stride)
                    if left + 4 <= boundary <= right - 4
                ),
                key=lambda boundary: abs(boundary - (left + right) / 2),
                default=None,
            )
            if fallback is not None and fallback not in selected:
                selected.append(fallback)
                selected.sort()
                support.setdefault(fallback, 0.0)
                changed = True
                break
    section_edges = [0] + selected + [bar_count]
    sections: list[dict] = []
    for section_index, (start_bar, end_bar) in enumerate(zip(section_edges, section_edges[1:])):
        if end_bar <= start_bar:
            continue
        sections.append({
            "index": section_index,
            "id": f"S{section_index + 1:02d}",
            "startSeconds": bars[start_bar]["startSeconds"],
            "endSeconds": bars[end_bar - 1]["endSeconds"],
            "startBarIndex": start_bar,
            "endBarIndex": end_bar,
            "barCount": end_bar - start_bar,
            "boundarySupport": round_number(support.get(start_bar, 1.0), 3),
            "intensity": round_number(
                float(np.mean([bar.get("intensity", 0.0) for bar in bars[start_bar:end_bar]])),
                4,
            ),
        })
    return sections, scales, support


def build_musical_structure(
    y: np.ndarray,
    harmonic: np.ndarray,
    curves: dict[str, np.ndarray],
    beat_events: Sequence[DetectorEvent],
    downbeat_events: Sequence[DetectorEvent],
    duration: float,
) -> dict:
    """Build bar/phrase identity on top of unmodified Beat This! timestamps."""
    beat_records, bars, beats_per_bar = _timeline_from_beat_this(
        beat_events,
        downbeat_events,
        duration,
    )
    base = {
        "algorithm": "beat-this-downbeats+librosa-cens-mfcc-onset+agglomerative-v1",
        "timingPolicy": (
            "Beat and downbeat times are copied from Beat This! detector peaks. "
            "All internal bar, phrase, and section boundaries reference those downbeats; "
            "only the final open bar may end at the decoded song duration. "
            "no BPM grid, snapping, interpolation, or event-time quantization is used."
        ),
        "beatsPerBar": beats_per_bar,
        "barsPerPhrase": STRUCTURE_BARS_PER_PHRASE,
        "beats": beat_records,
        "downbeats": [
            {
                "index": bar["index"],
                "timeSeconds": bar["downbeatTimeSeconds"],
                "barIndex": bar["index"],
            }
            for bar in bars
        ],
        "bars": bars,
        "sections": [],
        "phrases": [],
        "families": [],
        "similarityMatrix": [],
        "phraseLinks": [],
        "overlappingPhrases": [],
        "overlappingPhraseFamilies": [],
        "analysis": {
            "available": False,
            "reason": "Beat This! did not provide enough downbeats for structure analysis.",
        },
    }
    if len(bars) < STRUCTURE_BARS_PER_PHRASE or not beat_events:
        return base

    print("Analysing repeated musical structure on Beat This! downbeats...")
    chroma_cens = librosa.feature.chroma_cens(
        y=harmonic,
        sr=SAMPLE_RATE,
        hop_length=HOP_LENGTH,
    )
    mfcc = librosa.feature.mfcc(
        y=y,
        sr=SAMPLE_RATE,
        n_mfcc=13,
        n_fft=2_048,
        hop_length=HOP_LENGTH,
    )
    mfcc_scaled = _robust_feature_scale(mfcc.T).T
    onset_curve = np.asarray(curves.get("mix", np.zeros(mfcc.shape[1])), dtype=np.float64)
    rms = librosa.feature.rms(y=y, frame_length=N_FFT, hop_length=HOP_LENGTH, center=True)[0]
    frame_count = min(chroma_cens.shape[1], mfcc.shape[1], len(onset_curve), len(rms))
    chroma_cens = chroma_cens[:, :frame_count]
    mfcc_scaled = mfcc_scaled[:, :frame_count]
    onset_curve = onset_curve[:frame_count]
    rms = rms[:frame_count]
    frame_times = librosa.frames_to_time(
        np.arange(frame_count),
        sr=SAMPLE_RATE,
        hop_length=HOP_LENGTH,
    )

    raw_bar_features: list[np.ndarray] = []
    raw_intensities: list[float] = []
    for bar in bars:
        start_time = float(bar["startSeconds"])
        end_time = float(bar["endSeconds"])
        chroma_mean = _temporal_means(chroma_cens, frame_times, start_time, end_time, 1).reshape(-1)
        mfcc_bins = _temporal_means(mfcc_scaled, frame_times, start_time, end_time, 2)
        onset_bins = _temporal_means(onset_curve, frame_times, start_time, end_time, 16).reshape(-1)
        onset_bins = onset_bins / max(np.linalg.norm(onset_bins), 1e-9)
        intensity = float(_temporal_means(rms, frame_times, start_time, end_time, 1)[0, 0])
        raw_intensities.append(intensity)
        raw_bar_features.append(np.concatenate([
            chroma_mean / max(np.linalg.norm(chroma_mean), 1e-9),
            mfcc_bins.reshape(-1),
            onset_bins,
            np.asarray([intensity]),
        ]))
    normalized_intensities = normalize_curve(np.asarray(raw_intensities))
    for bar, intensity in zip(bars, normalized_intensities):
        bar["intensity"] = round_number(intensity, 4)

    sections, scales, boundary_support = _multi_scale_sections(
        bars,
        np.asarray(raw_bar_features, dtype=np.float64),
    )
    core_starts = list(range(0, len(bars) - STRUCTURE_BARS_PER_PHRASE + 1, STRUCTURE_BARS_PER_PHRASE))
    phrases, components = _make_phrase_units(
        bars,
        frame_times,
        chroma_cens,
        mfcc_scaled,
        onset_curve,
        core_starts,
        "phrase",
    )
    combined = _combined_phrase_similarity(components)
    families, core_links = _assign_phrase_families(
        phrases,
        combined,
        STRUCTURE_SAME_FAMILY_SIMILARITY,
        STRUCTURE_RELATED_VARIANT_SIMILARITY,
        "F",
    )

    section_by_bar: dict[int, int] = {}
    for section in sections:
        for bar_index in range(section["startBarIndex"], section["endBarIndex"]):
            section_by_bar[bar_index] = section["index"]
    for phrase in phrases:
        phrase["sectionIndex"] = section_by_bar.get(phrase["startBarIndex"])

    overlap_starts = list(range(
        0,
        len(bars) - STRUCTURE_BARS_PER_PHRASE + 1,
        STRUCTURE_OVERLAP_STRIDE_BARS,
    ))
    overlapping_phrases, overlap_components = _make_phrase_units(
        bars,
        frame_times,
        chroma_cens,
        mfcc_scaled,
        onset_curve,
        overlap_starts,
        "overlap",
    )
    overlap_combined = _combined_phrase_similarity(overlap_components)
    # Complete linkage makes an overlap family safe for exact obstacle reuse:
    # every pair in the family must clear the strict threshold. Softer matches
    # remain related-variant links and never inherit the same family/template.
    overlapping_families, overlap_links = _assign_phrase_families(
        overlapping_phrases,
        overlap_combined,
        STRUCTURE_OVERLAP_EXACT_SIMILARITY,
        STRUCTURE_OVERLAP_RELATED_SIMILARITY,
        "OF",
        "complete",
    )
    repeating_overlap_ids = {
        family["id"]
        for family in overlapping_families
        if family["occurrenceCount"] > 1
    }
    overlapping_families = [
        family for family in overlapping_families if family["id"] in repeating_overlap_ids
    ]

    def matrix_payload(matrix: np.ndarray) -> list[list[float]]:
        return [[round_number(value, 4) for value in row] for row in matrix]

    base.update({
        "bars": bars,
        "sections": sections,
        "phrases": phrases,
        "families": families,
        "similarityMatrix": matrix_payload(combined),
        "phraseLinks": [
            {**link, "scope": "non-overlapping-8-bar"} for link in core_links
        ] + [
            {**link, "scope": "overlapping-8-bar-stride-4"} for link in overlap_links
        ],
        "overlappingPhrases": overlapping_phrases,
        "overlappingPhraseFamilies": overlapping_families,
        "analysis": {
            "available": True,
            "features": {
                "harmony": "librosa chroma_cens, four local time bins per bar",
                "timbre": "13 librosa MFCCs, robust-scaled, two local time bins per bar",
                "microRhythm": "librosa onset strength, 16 locally normalized phase bins per bar",
                "similarityWeights": {"harmony": 0.5, "timbre": 0.2, "microRhythm": 0.3},
            },
            "recurrence": {
                "metric": "cosine affinity over locally normalized 8-bar descriptors",
                "matrixField": "similarityMatrix",
                "diagonalPolicy": "self-similarity is 1.0",
            },
            "familyThresholds": {
                "sameFamilyMinimumSimilarity": STRUCTURE_SAME_FAMILY_SIMILARITY,
                "relatedVariantMinimumSimilarity": STRUCTURE_RELATED_VARIANT_SIMILARITY,
                "uniquePolicy": "Singletons are retained as unique-low-confidence instead of forced into a repeated family.",
            },
            "multiScaleAgglomerative": {
                "method": "Ward agglomerative clustering with temporal-chain connectivity",
                "scales": scales,
                "boundarySupport": [
                    {
                        "barIndex": bar_index,
                        "timeSeconds": bars[bar_index]["startSeconds"],
                        "support": round_number(value, 3),
                    }
                    for bar_index, value in sorted(boundary_support.items())
                ],
                "sectionBoundaryMinimumSupport": round_number(3 / max(1, len(scales)), 3),
                "maximumSectionBarsBeforeDownbeatFallback": 16,
            },
            "overlappingWindow": {
                "barsPerWindow": STRUCTURE_BARS_PER_PHRASE,
                "strideBars": STRUCTURE_OVERLAP_STRIDE_BARS,
                "exactFamilyMinimumPairwiseSimilarity": STRUCTURE_OVERLAP_EXACT_SIMILARITY,
                "relatedVariantMinimumSimilarity": STRUCTURE_OVERLAP_RELATED_SIMILARITY,
                "familyLinkage": "complete",
                "purpose": "Detect repeated melody identities that begin midway through a non-overlapping phrase unit.",
            },
            "similarityComponents": {
                "harmony": matrix_payload(components["harmony"]),
                "timbre": matrix_payload(components["timbre"]),
                "microRhythm": matrix_payload(components["rhythm"]),
            },
        },
    })
    return base


def nearest_event_value(time: float, events: Sequence[DetectorEvent], radius: float) -> float:
    best = 0.0
    for event in events:
        distance = abs(event.time - time)
        if distance <= radius:
            best = max(best, event.score * math.exp(-0.5 * (distance / max(1e-6, radius / 2)) ** 2))
        elif event.time > time + radius:
            break
    return best


def curve_value(curve: np.ndarray, time: float) -> float:
    frame = int(round(time * SAMPLE_RATE / HOP_LENGTH))
    return float(curve[min(max(frame, 0), len(curve) - 1)]) if len(curve) else 0.0


def merge_candidates(detectors: dict[str, list[DetectorEvent]]) -> list[dict]:
    flattened = sorted(
        (event for events in detectors.values() for event in events),
        key=lambda event: event.time,
    )
    if not flattened:
        return []
    clusters: list[list[DetectorEvent]] = [[flattened[0]]]
    for event in flattened[1:]:
        if event.time - clusters[-1][0].time <= 0.045:
            clusters[-1].append(event)
        else:
            clusters.append([event])
    candidates = []
    for cluster in clusters:
        representative = max(cluster, key=lambda event: event.score)
        source_scores: dict[str, float] = {}
        for event in cluster:
            source_scores[event.source] = max(source_scores.get(event.source, 0), event.score)
        candidates.append({
            "time": representative.time,
            "baseScore": representative.score,
            "sourceScores": source_scores,
        })
    return candidates


def event_match_metrics(predicted: Sequence[float], reference: Sequence[float], tolerance: float) -> dict:
    pairs = sorted(
        (abs(prediction - target), prediction_index, target_index)
        for prediction_index, prediction in enumerate(predicted)
        for target_index, target in enumerate(reference)
        if abs(prediction - target) <= tolerance
    )
    used_predictions: set[int] = set()
    used_targets: set[int] = set()
    errors: list[float] = []
    for error, prediction_index, target_index in pairs:
        if prediction_index in used_predictions or target_index in used_targets:
            continue
        used_predictions.add(prediction_index)
        used_targets.add(target_index)
        errors.append(error)
    matched = len(errors)
    precision = matched / len(predicted) if predicted else 0.0
    recall = matched / len(reference) if reference else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "toleranceMs": round(tolerance * 1000),
        "matched": matched,
        "precision": round_number(precision, 4),
        "recall": round_number(recall, 4),
        "f1": round_number(f1, 4),
        "meanAbsoluteErrorMs": round_number(np.mean(errors) * 1000, 1) if errors else None,
        "p90AbsoluteErrorMs": round_number(np.percentile(errors, 90) * 1000, 1) if errors else None,
    }


def nms_candidates(candidates: Sequence[dict], score_key: str, minimum_gap: float) -> list[dict]:
    selected: list[dict] = []
    for candidate in sorted(candidates, key=lambda item: item[score_key], reverse=True):
        if all(abs(candidate["time"] - existing["time"]) >= minimum_gap for existing in selected):
            selected.append(candidate)
    return sorted(selected, key=lambda item: item["time"])


def train_preference_model(
    candidates: list[dict],
    detectors: dict[str, list[DetectorEvent]],
    curves: dict[str, np.ndarray],
    labels: Sequence[float],
    review_feedback: Sequence[dict],
) -> tuple[list[dict], dict]:
    detector_features = sorted(detectors)
    curve_features = ["rms_rise", "chroma_novelty"]
    feature_names = detector_features + curve_features
    matrix = []
    weights = []
    groups = []
    for candidate in candidates:
        time = candidate["time"]
        features = [nearest_event_value(time, detectors[source], SOURCE_MATCH_SECONDS) for source in detector_features]
        features.extend(curve_value(curves[source], time) for source in curve_features)
        matrix.append(features)
        groups.append(int(time // 30))

    # One tap can supervise at most one real audio candidate. This prevents a
    # dense cluster of nearby peaks from all becoming positive and also leaves
    # accidental double taps unmatched instead of duplicating an obstacle.
    possible_pairs = sorted(
        (abs(candidate["time"] - label), candidate_index, label_index)
        for candidate_index, candidate in enumerate(candidates)
        for label_index, label in enumerate(labels)
        if abs(candidate["time"] - label) <= TRAINING_MATCH_SECONDS
    )
    positive_candidates: set[int] = set()
    matched_labels: set[int] = set()
    for _, candidate_index, label_index in possible_pairs:
        if candidate_index in positive_candidates or label_index in matched_labels:
            continue
        positive_candidates.add(candidate_index)
        matched_labels.add(label_index)
    # Explicit listening-room feedback overrides the original one-pass tap label
    # for its nearest detector candidate. Later entries win, matching the UI's
    # ability to change a verdict without silently duplicating it.
    review_candidate_targets: dict[int, int] = {}
    matched_review_count = 0
    review_verdict_counts = {"keep": 0, "reject": 0, "missing": 0}
    for item in review_feedback:
        verdict = item.get("verdict")
        review_verdict_counts[verdict] += 1
        reference = item.get("eventTimeSeconds")
        if not isinstance(reference, (int, float)) or not math.isfinite(reference):
            reference = item.get("tapTimeSeconds")
        if not isinstance(reference, (int, float)) or not math.isfinite(reference) or not candidates:
            continue
        candidate_index = min(range(len(candidates)), key=lambda index: abs(candidates[index]["time"] - reference))
        if abs(candidates[candidate_index]["time"] - reference) <= REVIEW_MATCH_SECONDS:
            review_candidate_targets[candidate_index] = 0 if verdict == "reject" else 1
            matched_review_count += 1

    targets = [
        review_candidate_targets.get(index, 1 if index in positive_candidates else 0)
        for index in range(len(candidates))
    ]
    for index, candidate in enumerate(candidates):
        distance = min((abs(candidate["time"] - label) for label in labels), default=math.inf)
        is_positive = index in positive_candidates
        if index in review_candidate_targets:
            weights.append(4.0)
        else:
            weights.append(1.8 if is_positive else (1.25 if distance <= 0.75 else 0.7))

    x = np.asarray(matrix, dtype=np.float64)
    y = np.asarray(targets, dtype=np.int32)
    sample_weights = np.asarray(weights, dtype=np.float64)
    group_values = np.asarray(groups, dtype=np.int32)
    if not len(x) or len(np.unique(y)) < 2:
        for candidate in candidates:
            candidate["preferenceScore"] = candidate["baseScore"]
        return nms_candidates(candidates, "preferenceScore", MIN_OUTPUT_GAP_SECONDS), {
            "trained": False,
            "reason": "Candidate labels did not contain both classes.",
            "featureNames": feature_names,
        }

    unique_groups = np.unique(group_values)
    fold_count = min(5, len(unique_groups))
    oof = np.zeros(len(candidates), dtype=np.float64)
    if fold_count >= 2:
        splitter = GroupKFold(n_splits=fold_count)
        for train_indices, test_indices in splitter.split(x, y, group_values):
            if len(np.unique(y[train_indices])) < 2:
                oof[test_indices] = float(np.mean(y[train_indices]))
                continue
            model = make_pipeline(
                StandardScaler(),
                LogisticRegression(C=0.35, class_weight="balanced", max_iter=2_000, solver="liblinear"),
            )
            model.fit(x[train_indices], y[train_indices], logisticregression__sample_weight=sample_weights[train_indices])
            oof[test_indices] = model.predict_proba(x[test_indices])[:, 1]
    else:
        oof[:] = y

    best_threshold = 0.5
    best_score = -math.inf
    best_metrics = None
    best_count = len(labels)
    for threshold in np.linspace(0.15, 0.85, 71):
        trial = [
            {**candidate, "oofScore": float(score)}
            for candidate, score in zip(candidates, oof)
            if score >= threshold
        ]
        trial = nms_candidates(trial, "oofScore", MIN_OUTPUT_GAP_SECONDS)
        metrics = event_match_metrics([candidate["time"] for candidate in trial], labels, 0.12)
        density_penalty = 0.06 * abs(len(trial) - len(labels)) / max(1, len(labels))
        objective = metrics["f1"] - density_penalty
        if objective > best_score:
            best_score = objective
            best_threshold = float(threshold)
            best_metrics = metrics
            best_count = len(trial)

    final_model = make_pipeline(
        StandardScaler(),
        LogisticRegression(C=0.35, class_weight="balanced", max_iter=2_000, solver="liblinear"),
    )
    final_model.fit(x, y, logisticregression__sample_weight=sample_weights)
    probabilities = final_model.predict_proba(x)[:, 1]

    # Cross-validation probabilities and a refit model are calibrated differently.
    # Preserve the event density selected out-of-fold instead of blindly reusing
    # the numeric OOF threshold, which can make the final chart much too sparse.
    final_threshold = best_threshold
    closest_count_delta = math.inf
    for threshold in np.linspace(0.05, 0.95, 181):
        trial = [
            {**candidate, "refitScore": float(score)}
            for candidate, score in zip(candidates, probabilities)
            if score >= threshold
        ]
        trial = nms_candidates(trial, "refitScore", MIN_OUTPUT_GAP_SECONDS)
        count_delta = abs(len(trial) - best_count)
        if count_delta < closest_count_delta:
            closest_count_delta = count_delta
            final_threshold = float(threshold)

    scored = []
    for candidate, score in zip(candidates, probabilities):
        candidate = dict(candidate)
        candidate["preferenceScore"] = float(score)
        if score >= final_threshold:
            scored.append(candidate)
    selected = nms_candidates(scored, "preferenceScore", MIN_OUTPUT_GAP_SECONDS)

    logistic = final_model.named_steps["logisticregression"]
    coefficients = {
        name: round_number(weight, 4)
        for name, weight in sorted(
            zip(feature_names, logistic.coef_[0]),
            key=lambda pair: abs(pair[1]),
            reverse=True,
        )
    }
    return selected, {
        "trained": True,
        "model": "scikit-learn L2 logistic regression",
        "featureNames": feature_names,
        "candidateCount": len(candidates),
        "positiveCandidateCount": int(np.sum(y)),
        "matchedHumanLabelCount": len(matched_labels),
        "reviewFeedbackCount": len(review_feedback),
        "matchedReviewFeedbackCount": matched_review_count,
        "reviewVerdictCounts": review_verdict_counts,
        "blockedCrossValidationFolds": fold_count,
        "oofSelectedThreshold": round_number(best_threshold, 3),
        "refitCalibratedThreshold": round_number(final_threshold, 3),
        "oofSelectedEventCount": best_count,
        "minimumGapMs": round(MIN_OUTPUT_GAP_SECONDS * 1000),
        "oofMetricsAt120ms": best_metrics,
        "coefficientsAfterStandardization": coefficients,
        "timingPolicy": "Scores select mature detector candidates; timestamps are never moved or quantized.",
    }


def event_payload(time: float, confidence: float, sources: Iterable[str] = ()) -> dict:
    payload = {
        "timeSeconds": round_number(time),
        "confidence": round_number(confidence, 3),
    }
    source_list = sorted(set(sources))
    if source_list:
        payload["sources"] = source_list
    return payload


def create_track(
    track_id: str,
    name: str,
    description: str,
    events: Sequence[dict],
    labels: Sequence[float],
    kind: str = "algorithm",
) -> dict:
    times = [float(event["timeSeconds"]) for event in events]
    intervals = np.diff(times) if len(times) > 1 else np.array([], dtype=float)
    return {
        "id": track_id,
        "name": name,
        "description": description,
        "kind": kind,
        "color": COLORS[track_id],
        "eventCount": len(events),
        "eventsPerMinute": round_number(len(events) / max(times[-1] / 60, 1e-9), 2) if times else 0,
        "medianIntervalSeconds": round_number(np.median(intervals), 3) if intervals.size else None,
        "metrics": {
            "at50ms": event_match_metrics(times, labels, 0.05),
            "at80ms": event_match_metrics(times, labels, 0.08),
            "at120ms": event_match_metrics(times, labels, 0.12),
        },
        "events": events,
    }


def waveform_peaks(y: np.ndarray, bucket_count: int = 1_600) -> list[float]:
    boundaries = np.linspace(0, len(y), bucket_count + 1, dtype=int)
    peaks = [float(np.max(np.abs(y[boundaries[i] : boundaries[i + 1]]))) for i in range(bucket_count)]
    maximum = max(peaks, default=1)
    return [round_number(value / max(maximum, 1e-9), 4) for value in peaks]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", type=Path, default=ROOT / "public/audio/slice-at-two.mp3")
    parser.add_argument("--labels", type=Path, default=ROOT / "data/annotations/slice-at-two.human-beats.json")
    parser.add_argument(
        "--feedback",
        type=Path,
        default=ROOT / "data/annotations/slice-at-two.review-feedback.json",
        help="Optional feedback exported by the rhythm listening room.",
    )
    parser.add_argument(
        "--legacy-level",
        type=Path,
        default=ROOT / "data/baselines/slice-at-two.legacy-times.json",
        help="Immutable legacy baseline; never used to generate the new chart.",
    )
    parser.add_argument("--output", type=Path, default=ROOT / "public/analysis/slice-at-two.rhythm-analysis.json")
    parser.add_argument("--skip-beat-this", action="store_true")
    parser.add_argument("--skip-basic-pitch", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    labels = load_labels(args.labels)
    review_feedback = load_review_feedback(args.feedback)
    legacy_times = load_legacy_times(args.legacy_level)
    print(f"Loading {args.audio}...")
    y, sample_rate = librosa.load(args.audio, sr=SAMPLE_RATE, mono=True)
    if sample_rate != SAMPLE_RATE:
        raise RuntimeError(f"Unexpected sample rate {sample_rate}")
    duration = len(y) / SAMPLE_RATE
    harmonic, curves, detectors, librosa_display_events = build_librosa_detectors(y, duration)

    model_metadata = [{
        "id": "librosa",
        "name": "librosa",
        "version": package_version("librosa"),
        "available": True,
        "detectors": {source: len(events) for source, events in detectors.items()},
    }]

    with tempfile.TemporaryDirectory(prefix="neon-slice-rhythm-") as temp_directory:
        temp_path = Path(temp_directory)
        decoded_wav = temp_path / "decoded.wav"
        harmonic_wav = temp_path / "harmonic.wav"
        sf.write(decoded_wav, y, SAMPLE_RATE, subtype="PCM_16")
        sf.write(harmonic_wav, harmonic, SAMPLE_RATE, subtype="PCM_16")

        basic_pitch_events: list[DetectorEvent] = []
        if not args.skip_basic_pitch:
            print("Running Basic Pitch ONNX...")
            basic_pitch_events, metadata = run_basic_pitch(harmonic_wav, duration)
            model_metadata.append(metadata)
            if basic_pitch_events:
                detectors["basic_pitch"] = basic_pitch_events

        beat_events: list[DetectorEvent] = []
        downbeat_events: list[DetectorEvent] = []
        if not args.skip_beat_this:
            print("Running Beat This! final0...")
            beat_events, downbeat_events, metadata = run_beat_this(decoded_wav)
            model_metadata.append(metadata)
            if beat_events:
                detectors["beat_this"] = beat_events
            if downbeat_events:
                detectors["downbeat"] = downbeat_events

    musical_structure = build_musical_structure(
        y,
        harmonic,
        curves,
        beat_events,
        downbeat_events,
        duration,
    )

    candidates = merge_candidates(detectors)
    fusion, training = train_preference_model(candidates, detectors, curves, labels, review_feedback)

    librosa_selected = nms_detector_events(librosa_display_events, MIN_OUTPUT_GAP_SECONDS)
    basic_pitch_display_events = nms_detector_events(
        [event for event in basic_pitch_events if event.score >= 0.62],
        MIN_OUTPUT_GAP_SECONDS,
    )

    tracks = [
        create_track(
            "human-reference",
            "你的人工标注",
            "原始空格点击；保留可能的误触，只作为偏好参考。",
            [event_payload(time, 1.0) for time in labels],
            labels,
            kind="reference",
        ),
        create_track(
            "legacy-grid",
            "旧版网格算法",
            "原有 BPM/tick 生成结果，用来直观看出被替换前的问题。",
            [event_payload(time, 1.0, ["legacy-grid"]) for time in legacy_times],
            labels,
            kind="baseline",
        ),
        create_track(
            "librosa-onset",
            "librosa 多频段起音",
            "混音、打击、谐波和五个频带的成熟起音检测并集；不使用拍子网格。",
            [
                event_payload(event.time, event.score, [event.source])
                for event in librosa_selected
            ],
            labels,
        ),
    ]
    if basic_pitch_events:
        tracks.append(create_track(
            "basic-pitch",
            "Basic Pitch 旋律起音",
            "Spotify ONNX 模型在谐波声部上识别的音符起点，偏向旋律与主唱。",
            [
                event_payload(event.time, event.score, [event.source])
                for event in basic_pitch_display_events
            ],
            labels,
        ))
    if beat_events:
        structure_beats_by_time = {
            float(beat["timeSeconds"]): beat
            for beat in musical_structure.get("beats", [])
        }
        beat_track_payload = []
        for event in beat_events:
            payload = event_payload(event.time, event.score, [event.source])
            structure_beat = structure_beats_by_time.get(float(payload["timeSeconds"]))
            if structure_beat:
                payload.update({
                    "isDownbeat": structure_beat["isDownbeat"],
                    "barIndex": structure_beat["barIndex"],
                    "beatInBar": structure_beat["beatInBar"],
                })
            beat_track_payload.append(payload)
        tracks.append(create_track(
            "beat-this",
            "Beat This!（当前首选）",
            "你试听后选定的主方案；直接使用神经网络识别到的 beat/downbeat 峰值，不构造 BPM 网格。",
            beat_track_payload,
            labels,
            kind="recommended",
        ))
    tracks.append(create_track(
        "preference-fusion",
        "人工标注偏好融合",
        "正则化分类器从成熟检测器候选中选择更像第一遍手标的事件；保留作为对照方案。",
        [
            event_payload(
                candidate["time"],
                candidate["preferenceScore"],
                [source for source, score in candidate["sourceScores"].items() if score >= 0.2],
            )
            for candidate in fusion
        ],
        labels,
        kind="recommended" if not beat_events else "algorithm",
    ))

    all_candidate_times = [candidate["time"] for candidate in candidates]
    duplicate_indices = [
        index + 1
        for index in range(1, len(labels))
        if labels[index] - labels[index - 1] < 0.13
    ]
    unanchored_indices = [
        index + 1
        for index, label in enumerate(labels)
        if min((abs(label - candidate) for candidate in all_candidate_times), default=math.inf) > 0.15
    ]
    output = {
        "schemaVersion": 1,
        "kind": "rhythm-algorithm-comparison",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "timingPolicy": "All algorithm event times are detector peaks in seconds. No BPM grid, snapping, or gap filling is used.",
        "song": {
            "id": "slice-at-two",
            "title": "Slice at Two",
            "artist": "NEON SYSTEM",
            "audioUrl": "/audio/slice-at-two.mp3",
            "durationSeconds": round_number(duration, 3),
            "sampleRate": SAMPLE_RATE,
        },
        "primaryTrackId": "beat-this" if beat_events else "preference-fusion",
        "waveform": {
            "bucketCount": 1_600,
            "peaks": waveform_peaks(y),
        },
        "labels": {
            "count": len(labels),
            "source": str(args.labels.relative_to(ROOT)).replace("\\", "/") if args.labels.is_relative_to(ROOT) else str(args.labels),
            "possibleDuplicateMarkerIndices": duplicate_indices,
            "markersWithoutCandidateWithin150ms": unanchored_indices,
            "policy": "Possible mistakes are flagged but never silently deleted.",
            "reviewFeedbackCount": len(review_feedback),
            "reviewFeedbackSource": (
                str(args.feedback.relative_to(ROOT)).replace("\\", "/")
                if review_feedback and args.feedback.is_relative_to(ROOT)
                else (str(args.feedback) if review_feedback else None)
            ),
        },
        "models": model_metadata,
        "musicalStructure": musical_structure,
        "preferenceModel": training,
        "tracks": tracks,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {args.output}")
    for track in tracks:
        metrics = track["metrics"]["at120ms"]
        print(f"  {track['id']}: {track['eventCount']} events, F1@120ms={metrics['f1']:.3f}")


if __name__ == "__main__":
    main()
