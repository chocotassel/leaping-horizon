#!/usr/bin/env python3
"""Compress one song and analyse its non-quantized musical events and structure."""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import subprocess
import tempfile
import warnings
from dataclasses import dataclass
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Iterable, Sequence

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("TORCH_HOME", str(ROOT / ".cache" / "torch"))
warnings.filterwarnings("ignore", message="pkg_resources is deprecated as an API", module="resampy.filters")

import librosa
import numpy as np
import soundfile as sf
from sklearn.cluster import AgglomerativeClustering
from sklearn.metrics.pairwise import cosine_similarity
from scipy.sparse import diags


SAMPLE_RATE = 22_050
GAME_AUDIO_SAMPLE_RATE = 32_000
GAME_AUDIO_BITRATE_KBPS = 96
HOP_LENGTH = 256
N_FFT = 1_024
MIN_OUTPUT_GAP_SECONDS = 0.12
MIN_PERFORMANCE_EVIDENCE_GAP_SECONDS = 0.065
COLORS = {
    "librosa-onset": "#35e4ed",
    "librosa-percussive": "#ff4058",
    "librosa-harmonic": "#58d68d",
    "librosa-band-bass": "#ff8b5c",
    "librosa-band-low-mid": "#ffd166",
    "librosa-band-mid": "#61dafb",
    "librosa-band-high-mid": "#8f7cff",
    "librosa-band-high": "#ff73c8",
    "basic-pitch": "#b879ff",
    "beat-this": "#ffc857",
}

STRUCTURE_MIN_PHRASE_BARS = 2
STRUCTURE_MAX_PHRASE_BARS = 12
STRUCTURE_MIN_RECURRENCE_BARS = 4
STRUCTURE_SAME_FAMILY_SIMILARITY = 0.84
STRUCTURE_RELATED_VARIANT_SIMILARITY = 0.78
STRUCTURE_OVERLAP_EXACT_SIMILARITY = 0.88
STRUCTURE_OVERLAP_RELATED_SIMILARITY = 0.82


@dataclass(frozen=True)
class DetectorEvent:
    time: float
    score: float
    source: str
    midi_pitch: float | None = None
    pitch_min: float | None = None
    pitch_max: float | None = None
    duration: float | None = None
    polyphony: int | None = None


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


def curve_events(
    source: str,
    envelope: np.ndarray,
    duration: float,
    delta: float,
    wait: int,
) -> list[DetectorEvent]:
    normalized = normalize_curve(envelope)
    peak_frames = librosa.onset.onset_detect(
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
    # Spectral-flux maxima happen after the audible attack begins. Keep the
    # peak's confidence, but place the event at the preceding onset front so a
    # Target Cell sounds simultaneous with the instrument rather than late.
    attack_frames = librosa.onset.onset_backtrack(peak_frames, envelope)
    events: list[DetectorEvent] = []
    for peak_frame, attack_frame in zip(peak_frames, attack_frames):
        time = float(librosa.frames_to_time(attack_frame, sr=SAMPLE_RATE, hop_length=HOP_LENGTH))
        if 0.5 <= time <= duration - 0.5:
            events.append(DetectorEvent(time, float(normalized[int(peak_frame)]), source))
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


def cluster_basic_pitch_events(
    events: Sequence[DetectorEvent],
    gap: float = 0.05,
) -> list[DetectorEvent]:
    """Collapse near-simultaneous notes without changing the chosen onset time."""
    if not events:
        return []
    ordered = sorted(events, key=lambda event: event.time)
    clusters: list[list[DetectorEvent]] = [[ordered[0]]]
    for event in ordered[1:]:
        if event.time - clusters[-1][0].time <= gap:
            clusters[-1].append(event)
        else:
            clusters.append([event])

    aggregated: list[DetectorEvent] = []
    for cluster in clusters:
        representative = max(cluster, key=lambda event: event.score)
        pitched = [event for event in cluster if event.midi_pitch is not None]
        weights = np.asarray([max(event.score, 1e-9) for event in pitched], dtype=np.float64)
        pitches = np.asarray([float(event.midi_pitch) for event in pitched], dtype=np.float64)
        durations = np.asarray(
            [max(0.0, float(event.duration or 0.0)) for event in pitched],
            dtype=np.float64,
        )
        pitch_minimums = [
            float(event.pitch_min if event.pitch_min is not None else event.midi_pitch)
            for event in pitched
        ]
        pitch_maximums = [
            float(event.pitch_max if event.pitch_max is not None else event.midi_pitch)
            for event in pitched
        ]
        aggregated.append(DetectorEvent(
            time=representative.time,
            score=representative.score,
            source=representative.source,
            midi_pitch=float(np.average(pitches, weights=weights)) if pitched else None,
            pitch_min=min(pitch_minimums) if pitch_minimums else None,
            pitch_max=max(pitch_maximums) if pitch_maximums else None,
            duration=float(np.average(durations, weights=weights)) if pitched else None,
            polyphony=sum(max(1, event.polyphony or 1) for event in pitched) if pitched else None,
        ))
    return aggregated


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
        previous_logging_disable = logging.root.manager.disable
        logging.disable(logging.WARNING)
        try:
            from basic_pitch import ICASSP_2022_MODEL_PATH
            from basic_pitch.inference import Model, predict
        finally:
            logging.disable(previous_logging_disable)

        model = Model(ICASSP_2022_MODEL_PATH)
        _, _, notes = predict(
            wav_path,
            model_or_model_path=model,
            onset_threshold=0.5,
            frame_threshold=0.3,
            minimum_note_length=90,
        )
        raw = []
        for note in notes:
            start_time = float(note[0])
            if not 0.5 <= start_time <= duration - 0.5:
                continue
            end_time = max(start_time, float(note[1]))
            midi_pitch = float(note[2])
            raw.append(DetectorEvent(
                time=start_time,
                score=float(note[3]),
                source="basic_pitch",
                midi_pitch=midi_pitch,
                pitch_min=midi_pitch,
                pitch_max=midi_pitch,
                duration=end_time - start_time,
                polyphony=1,
            ))
        clustered = cluster_basic_pitch_events(raw, gap=0.05)
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
    phrase_bars = bars[start_bar : start_bar + bar_count]
    start_time = float(phrase_bars[0]["startSeconds"])
    end_time = float(phrase_bars[-1]["endSeconds"])
    # Every descriptor has a fixed dimension even when the musical sentence
    # spans a different number of bars. Time is normalized only inside the
    # descriptor; emitted beat/downbeat timestamps remain untouched.
    chroma_bins = _temporal_means(chroma_cens, frame_times, start_time, end_time, 32)
    timbre_bins = _temporal_means(mfcc_scaled, frame_times, start_time, end_time, 16)
    onset_bins = _temporal_means(onset_curve, frame_times, start_time, end_time, 64)
    return (
        _row_l2_normalize(np.maximum(chroma_bins, 0.0)).reshape(-1),
        timbre_bins.reshape(-1),
        _row_l2_normalize(np.maximum(onset_bins.T, 0.0)).reshape(-1),
    )


def _make_phrase_units(
    bars: list[dict],
    frame_times: np.ndarray,
    chroma_cens: np.ndarray,
    mfcc_scaled: np.ndarray,
    onset_curve: np.ndarray,
    ranges: Sequence[tuple[int, int]],
    prefix: str,
) -> tuple[list[dict], dict[str, np.ndarray]]:
    phrases: list[dict] = []
    harmony_vectors: list[np.ndarray] = []
    timbre_vectors: list[np.ndarray] = []
    rhythm_vectors: list[np.ndarray] = []
    for phrase_index, (start_bar, end_bar) in enumerate(ranges):
        bar_count = end_bar - start_bar
        if start_bar < 0 or end_bar > len(bars) or bar_count <= 0:
            continue
        harmony, timbre, rhythm = _phrase_features(
            bars,
            start_bar,
            bar_count,
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
            "barCount": bar_count,
            "intensity": round_number(float(np.mean(intensities)), 4),
        })
    return phrases, {
        "harmony": _safe_cosine_matrix(harmony_vectors),
        # Centered MFCC vectors may have negative cosine; map it to [0, 1].
        "timbre": (_safe_cosine_matrix(timbre_vectors) + 1.0) / 2.0,
        "rhythm": _safe_cosine_matrix(rhythm_vectors),
    }


def _combined_phrase_similarity(
    components: dict[str, np.ndarray],
    phrases: Sequence[dict],
) -> np.ndarray:
    if not components["harmony"].size:
        return np.empty((0, 0), dtype=np.float64)
    combined = (
        0.50 * components["harmony"]
        + 0.20 * components["timbre"]
        + 0.30 * components["rhythm"]
    )
    combined = np.clip(combined, 0.0, 1.0)
    # Different sentence lengths may be related developments, but cannot be an
    # exact canonical repeat. Keep their affinity below the exact-family floor.
    for left in range(len(phrases)):
        for right in range(left + 1, len(phrases)):
            if phrases[left]["barCount"] != phrases[right]["barCount"]:
                combined[left, right] = min(combined[left, right], 0.839)
                combined[right, left] = combined[left, right]
    np.fill_diagonal(combined, 1.0)
    return combined


def _cosine_distance(left: np.ndarray, right: np.ndarray) -> float:
    left = np.asarray(left, dtype=np.float64).reshape(-1)
    right = np.asarray(right, dtype=np.float64).reshape(-1)
    left_norm = float(np.linalg.norm(left))
    right_norm = float(np.linalg.norm(right))
    if left_norm <= 1e-9 and right_norm <= 1e-9:
        return 0.0
    if left_norm <= 1e-9 or right_norm <= 1e-9:
        # Silence and audible content are maximally different evidence states.
        # Treating either zero vector as identical hid real section entrances.
        return 1.0
    denominator = left_norm * right_norm
    return float(np.clip(1.0 - np.dot(left, right) / denominator, 0.0, 2.0) / 2.0)


def _enforce_maximum_phrase_span(
    boundaries: Sequence[int],
    boundary_scores: np.ndarray,
    bars: Sequence[dict],
    threshold: float,
) -> tuple[list[int], list[dict]]:
    """Split only overlong regions at their strongest measured downbeat seam."""
    scores = np.asarray(boundary_scores, dtype=np.float64)
    forced: list[dict] = []

    def split_region(left: int, right: int) -> list[int]:
        if right - left <= STRUCTURE_MAX_PHRASE_BARS:
            return [left, right]
        candidates = range(
            left + STRUCTURE_MIN_PHRASE_BARS,
            right - STRUCTURE_MIN_PHRASE_BARS + 1,
        )
        midpoint = (left + right) / 2
        boundary = max(
            candidates,
            key=lambda candidate: (
                round(float(scores[candidate]), 12),
                -abs(candidate - midpoint),
                -candidate,
            ),
        )
        evidence_score = float(scores[boundary])
        forced.append({
            "barIndex": boundary,
            "timeSeconds": bars[boundary]["startSeconds"],
            "score": round_number(evidence_score, 5),
            "evidenceStrength": (
                "supported"
                if evidence_score > 0 and evidence_score >= threshold
                else "weak-fallback"
            ),
            "reason": "maximum-phrase-span",
        })
        left_boundaries = split_region(left, boundary)
        right_boundaries = split_region(boundary, right)
        return [*left_boundaries[:-1], *right_boundaries]

    result = [int(boundaries[0])] if boundaries else []
    for left, right in zip(boundaries, boundaries[1:]):
        result.extend(split_region(int(left), int(right))[1:])
    return sorted(set(result)), sorted(forced, key=lambda item: item["barIndex"])


def _adaptive_phrase_ranges(
    bars: Sequence[dict],
    bar_feature_matrix: np.ndarray,
    sections: Sequence[dict],
    boundary_support: dict[int, float],
) -> tuple[list[tuple[int, int]], dict]:
    """Infer variable-length musical sentences on real downbeat boundaries."""
    bar_count = len(bars)
    if bar_count < STRUCTURE_MIN_PHRASE_BARS:
        return ([(0, bar_count)] if bar_count else []), {
            "algorithm": "evidence-boundary-dp-v1",
            "minimumPhraseBars": STRUCTURE_MIN_PHRASE_BARS,
            "maximumPhraseBars": STRUCTURE_MAX_PHRASE_BARS,
            "threshold": None,
            "boundaries": [0, bar_count] if bar_count else [],
            "mandatorySectionBoundaries": [],
            "forcedLongRegionBoundaries": [],
            "scores": [],
        }
    features = np.asarray(bar_feature_matrix, dtype=np.float64)
    feature_similarity = _safe_cosine_matrix([row for row in features])
    checkerboard = np.zeros(bar_count + 1, dtype=np.float64)
    profile_discontinuity = np.zeros(bar_count + 1, dtype=np.float64)
    reset = np.zeros(bar_count + 1, dtype=np.float64)
    intensities = np.asarray([float(bar.get("intensity", 0.0)) for bar in bars], dtype=np.float64)
    for boundary in range(1, bar_count):
        scale_scores: list[float] = []
        for scale in (1, 2, 4):
            left_start = max(0, boundary - scale)
            right_end = min(bar_count, boundary + scale)
            if boundary - left_start < 1 or right_end - boundary < 1:
                continue
            left_mean = np.mean(features[left_start:boundary], axis=0)
            right_mean = np.mean(features[boundary:right_end], axis=0)
            scale_scores.append(_cosine_distance(left_mean, right_mean))
        checkerboard[boundary] = float(np.mean(scale_scores)) if scale_scores else 0.0
        profile_discontinuity[boundary] = _cosine_distance(
            feature_similarity[boundary - 1],
            feature_similarity[boundary],
        )
        local_left = float(np.mean(intensities[max(0, boundary - 2):boundary]))
        local_right = float(np.mean(intensities[boundary:min(bar_count, boundary + 2)]))
        reset[boundary] = abs(local_right - local_left)

    section_component = np.zeros(bar_count + 1, dtype=np.float64)
    for boundary, support in boundary_support.items():
        if 0 < boundary < bar_count:
            section_component[boundary] = max(section_component[boundary], float(support))
    score = (
        normalize_curve(checkerboard) * 0.40
        + normalize_curve(section_component) * 0.25
        + normalize_curve(profile_discontinuity) * 0.20
        + normalize_curve(reset) * 0.15
    )
    interior = score[1:bar_count]
    median = float(np.median(interior)) if interior.size else 0.0
    mad = float(np.median(np.abs(interior - median))) if interior.size else 0.0
    threshold = max(
        median + 0.5 * mad,
        float(np.percentile(interior, 70)) if interior.size else 0.0,
    )
    mandatory_candidates = sorted({
        int(section["startBarIndex"])
        for section in sections[1:]
        if 0 < int(section["startBarIndex"]) < bar_count
        and float(section.get("boundarySupport", 0.0)) >= 0.75
    })
    mandatory: list[int] = []
    for boundary in mandatory_candidates:
        if boundary < STRUCTURE_MIN_PHRASE_BARS or bar_count - boundary < STRUCTURE_MIN_PHRASE_BARS:
            continue
        if mandatory and boundary - mandatory[-1] < STRUCTURE_MIN_PHRASE_BARS:
            if score[boundary] > score[mandatory[-1]]:
                mandatory[-1] = boundary
            continue
        mandatory.append(boundary)

    def infer_region(left_edge: int, right_edge: int) -> list[int]:
        length = right_edge - left_edge
        if length < STRUCTURE_MIN_PHRASE_BARS * 2:
            return [left_edge, right_edge]
        best: dict[int, tuple[float, int, list[int]]] = {left_edge: (0.0, 0, [left_edge])}
        for end in range(left_edge + STRUCTURE_MIN_PHRASE_BARS, right_edge + 1):
            candidates: list[tuple[float, int, list[int]]] = []
            for start, (prior_score, phrase_count, path) in best.items():
                if end - start < STRUCTURE_MIN_PHRASE_BARS:
                    continue
                boundary_reward = 0.0 if end == right_edge else float(score[end] - threshold)
                if end != right_edge and boundary_reward <= 0:
                    continue
                candidates.append((prior_score + boundary_reward, phrase_count + 1, [*path, end]))
            if candidates:
                best[end] = max(
                    candidates,
                    key=lambda item: (round(item[0], 12), -item[1], tuple(-value for value in item[2])),
                )
        return best.get(right_edge, (0.0, 1, [left_edge, right_edge]))[2]

    boundaries = [0]
    mandatory_edges = [0, *mandatory, bar_count]
    for left_edge, right_edge in zip(mandatory_edges, mandatory_edges[1:]):
        region_edges = infer_region(left_edge, right_edge)
        boundaries.extend(region_edges[1:])
    boundaries = sorted(set(boundaries))
    while True:
        short_index = next((
            index
            for index, (left, right) in enumerate(zip(boundaries, boundaries[1:]))
            if right - left < STRUCTURE_MIN_PHRASE_BARS
        ), None)
        if short_index is None:
            break
        if short_index == 0:
            boundaries.pop(1)
        elif short_index == len(boundaries) - 2:
            boundaries.pop(-2)
        else:
            left_boundary = boundaries[short_index]
            right_boundary = boundaries[short_index + 1]
            if score[left_boundary] <= score[right_boundary]:
                boundaries.pop(short_index)
            else:
                boundaries.pop(short_index + 1)
    boundaries, forced_long_boundaries = _enforce_maximum_phrase_span(
        boundaries,
        score,
        bars,
        threshold,
    )
    score_components = {
        boundary: {
            "checkerboardNovelty": round_number(checkerboard[boundary], 5),
            "profileDiscontinuity": round_number(profile_discontinuity[boundary], 5),
            "energyReset": round_number(reset[boundary], 5),
            "sectionSupport": round_number(section_component[boundary], 5),
        }
        for boundary in range(1, bar_count)
    }
    forced_long_boundaries = [
        {**item, **score_components[item["barIndex"]]}
        for item in forced_long_boundaries
    ]
    ranges = [(left, right) for left, right in zip(boundaries, boundaries[1:]) if right > left]
    return ranges, {
        "algorithm": "evidence-boundary-dp-v1",
        "minimumPhraseBars": STRUCTURE_MIN_PHRASE_BARS,
        "maximumPhraseBars": STRUCTURE_MAX_PHRASE_BARS,
        "threshold": round_number(threshold, 5),
        "boundaries": boundaries,
        "mandatorySectionBoundaries": mandatory,
        "forcedLongRegionBoundaries": forced_long_boundaries,
        "scores": [
            {
                "barIndex": boundary,
                "timeSeconds": bars[boundary]["startSeconds"],
                "score": round_number(score[boundary], 5),
                "checkerboardNovelty": round_number(checkerboard[boundary], 5),
                "profileDiscontinuity": round_number(profile_discontinuity[boundary], 5),
                "energyReset": round_number(reset[boundary], 5),
                "sectionSupport": round_number(section_component[boundary], 5),
            }
            for boundary in range(1, bar_count)
        ],
    }


def _adaptive_overlap_ranges(
    phrase_ranges: Sequence[tuple[int, int]],
    segmentation: dict,
    bar_count: int,
) -> list[tuple[int, int]]:
    """Propose off-seam recurrence windows only at salient measured boundaries."""
    observed_phrase_lengths = sorted({
        right - left
        for left, right in phrase_ranges
        if right - left >= STRUCTURE_MIN_RECURRENCE_BARS
    })
    primary_ranges = set(phrase_ranges)
    boundary_score_by_bar = {
        int(item["barIndex"]): float(item["score"])
        for item in segmentation.get("scores", [])
    }
    section_supported = {
        int(item["barIndex"])
        for item in segmentation.get("scores", [])
        if float(item.get("sectionSupport", 0.0)) > 0
    }
    threshold = float(segmentation.get("threshold") or 0.0)
    salient_boundaries = sorted({
        0,
        bar_count,
        *segmentation.get("boundaries", []),
        *(
            boundary
            for boundary, score in boundary_score_by_bar.items()
            if (
                (
                    score >= threshold
                    and score >= boundary_score_by_bar.get(boundary - 1, -1.0)
                    and score >= boundary_score_by_bar.get(boundary + 1, -1.0)
                )
                or boundary in section_supported
            )
        ),
    })
    return [
        (start_bar, start_bar + phrase_length)
        for start_bar in salient_boundaries
        for phrase_length in observed_phrase_lengths
        if start_bar + phrase_length <= bar_count
        and (start_bar, start_bar + phrase_length) not in primary_ranges
    ]


def _retain_exact_overlap_recurrences(
    families: Sequence[dict],
    links: Sequence[dict],
    retained_phrase_ids: set[str],
) -> tuple[list[dict], list[dict]]:
    """Keep overlap windows as exact recurrence evidence, never development bridges."""
    exact_links = [
        link for link in links
        if link.get("relationship") == "same-family"
        and link.get("sourcePhraseId") in retained_phrase_ids
        and link.get("targetPhraseId") in retained_phrase_ids
    ]
    exact_families = [
        {
            **family,
            # Related overlap families are hypotheses around the same passage,
            # not separate developed Phrase Identity contracts.
            "relatedFamilyIds": [],
        }
        for family in families
        if all(phrase_id in retained_phrase_ids for phrase_id in family.get("phraseIds", []))
    ]
    return exact_families, exact_links


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
    # Express every resolution relative to this song's length. Each context
    # unit is four bars; these cuts inspect average section spans from roughly
    # five to sixteen bars without baking one reference song's section count
    # into the analyser.
    target_unit_spans = (1.25, 1.5, 2.0, 2.5, 3.0, 4.0)
    cluster_counts = sorted({
        max(2, min(unit_count - 1, round(unit_count / span)))
        for span in target_unit_spans
        if unit_count > 2
    })
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
    changed = True
    while changed:
        changed = False
        current_edges = [0] + sorted(selected) + [bar_count]
        for left, right in zip(current_edges, current_edges[1:]):
            if right - left <= 16:
                continue
            fallback_candidates = list(range(left + 4, right - 3))
            fallback = max(
                fallback_candidates,
                key=lambda boundary: (
                    _cosine_distance(bar_feature_matrix[boundary - 1], bar_feature_matrix[boundary]),
                    -abs(boundary - (left + right) / 2),
                    -boundary,
                ),
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
        "algorithm": "beat-this-downbeats+librosa-adaptive-evidence-phrases+agglomerative-v2",
        "timingPolicy": (
            "Beat and downbeat times are copied from Beat This! detector peaks. "
            "All internal bar, phrase, and section boundaries reference those downbeats; "
            "only the final open bar may end at the decoded song duration. "
            "no BPM grid, snapping, interpolation, or event-time quantization is used."
        ),
        "beatsPerBar": beats_per_bar,
        "barsPerPhrase": None,
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
    if len(bars) < STRUCTURE_MIN_PHRASE_BARS or not beat_events:
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
    phrase_ranges, segmentation = _adaptive_phrase_ranges(
        bars,
        np.asarray(raw_bar_features, dtype=np.float64),
        sections,
        boundary_support,
    )
    phrases, components = _make_phrase_units(
        bars,
        frame_times,
        chroma_cens,
        mfcc_scaled,
        onset_curve,
        phrase_ranges,
        "phrase",
    )
    combined = _combined_phrase_similarity(components, phrases)
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

    observed_phrase_lengths = sorted({right - left for left, right in phrase_ranges})
    overlap_ranges = _adaptive_overlap_ranges(phrase_ranges, segmentation, len(bars))
    overlapping_phrases, overlap_components = _make_phrase_units(
        bars,
        frame_times,
        chroma_cens,
        mfcc_scaled,
        onset_curve,
        overlap_ranges,
        "overlap",
    )
    overlap_combined = _combined_phrase_similarity(overlap_components, overlapping_phrases)
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
    non_overlapping_families: list[dict] = []
    for family in overlapping_families:
        candidates = sorted(
            family["phraseIndices"],
            key=lambda index: (
                overlapping_phrases[index]["endBarIndex"],
                overlapping_phrases[index]["startBarIndex"],
                index,
            ),
        )
        retained_indices: list[int] = []
        last_end = -1
        for index in candidates:
            phrase = overlapping_phrases[index]
            if phrase["startBarIndex"] < last_end:
                continue
            retained_indices.append(index)
            last_end = phrase["endBarIndex"]
        if len(retained_indices) < 2:
            continue
        non_overlapping_families.append({
            **family,
            "prototypePhraseIndex": retained_indices[0],
            "phraseIndices": retained_indices,
            "phraseIds": [overlapping_phrases[index]["id"] for index in retained_indices],
            "occurrenceCount": len(retained_indices),
        })
    overlapping_families = non_overlapping_families
    retained_overlap_phrase_ids = {
        phrase_id
        for family in overlapping_families
        for phrase_id in family["phraseIds"]
    }
    overlapping_phrases = [
        phrase for phrase in overlapping_phrases if phrase["id"] in retained_overlap_phrase_ids
    ]
    overlapping_families, overlap_links = _retain_exact_overlap_recurrences(
        overlapping_families,
        overlap_links,
        retained_overlap_phrase_ids,
    )

    def matrix_payload(matrix: np.ndarray) -> list[list[float]]:
        return [[round_number(value, 4) for value in row] for row in matrix]

    base.update({
        "bars": bars,
        "sections": sections,
        "phrases": phrases,
        "families": families,
        "similarityMatrix": matrix_payload(combined),
        "phraseLinks": [
            {**link, "scope": "adaptive-non-overlapping"} for link in core_links
        ] + [
            {**link, "scope": "adaptive-variable-window"} for link in overlap_links
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
                "metric": "cosine affinity over time-normalized variable-length phrase descriptors",
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
            "segmentation": segmentation,
            "overlappingWindow": {
                "candidateBarCounts": observed_phrase_lengths,
                "candidateCount": len(overlap_ranges),
                "exactFamilyMinimumPairwiseSimilarity": STRUCTURE_OVERLAP_EXACT_SIMILARITY,
                "relatedVariantMinimumSimilarity": STRUCTURE_OVERLAP_RELATED_SIMILARITY,
                "familyLinkage": "complete",
                "purpose": "Detect repeated identities beginning away from an inferred phrase seam without imposing a fixed span or stride.",
            },
            "similarityComponents": {
                "harmony": matrix_payload(components["harmony"]),
                "timbre": matrix_payload(components["timbre"]),
                "microRhythm": matrix_payload(components["rhythm"]),
            },
        },
    })
    return base


def event_payload(time: float, confidence: float, sources: Iterable[str] = ()) -> dict:
    payload = {
        "timeSeconds": round_number(time),
        "confidence": round_number(confidence, 3),
    }
    source_list = sorted(set(sources))
    if source_list:
        payload["sources"] = source_list
    return payload


def basic_pitch_event_payload(event: DetectorEvent) -> dict:
    payload = event_payload(event.time, event.score, [event.source])
    payload.update({
        "midiPitch": round_number(event.midi_pitch, 3) if event.midi_pitch is not None else None,
        "pitchMin": round_number(event.pitch_min, 3) if event.pitch_min is not None else None,
        "pitchMax": round_number(event.pitch_max, 3) if event.pitch_max is not None else None,
        "durationSeconds": round_number(event.duration, 4) if event.duration is not None else None,
        "polyphony": int(event.polyphony) if event.polyphony is not None else 1,
    })
    return payload


def create_event_source(source_id: str, events: Sequence[dict]) -> dict:
    times = [float(event["timeSeconds"]) for event in events]
    intervals = np.diff(times) if len(times) > 1 else np.array([], dtype=float)
    return {
        "id": source_id,
        "color": COLORS[source_id],
        "eventCount": len(events),
        "eventsPerMinute": round_number(len(events) / max(times[-1] / 60, 1e-9), 2) if times else 0,
        "medianIntervalSeconds": round_number(np.median(intervals), 3) if intervals.size else None,
        "events": events,
    }


def compress_game_audio(source: Path, destination: Path) -> dict:
    source_info = sf.info(source)
    if source.resolve() == destination.resolve():
        source_bytes = source.stat().st_size
        return {
            "sourceFormat": source_info.format,
            "sourceSampleRate": source_info.samplerate,
            "sourceChannels": source_info.channels,
            "sourceBytes": source_bytes,
            "format": "MP3",
            "codec": "MPEG Layer III",
            "bitrateMode": "existing",
            "compressionLevel": None,
            "sampleRate": source_info.samplerate,
            "channels": source_info.channels,
            "compressedBytes": source_bytes,
            "sizeRatio": 1.0,
        }
    destination.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source), "-vn", "-map_metadata", "-1",
        "-ar", str(GAME_AUDIO_SAMPLE_RATE),
        "-c:a", "libmp3lame", "-b:a", f"{GAME_AUDIO_BITRATE_KBPS}k",
        str(destination),
    ], check=True)
    output_info = sf.info(destination)
    source_bytes = source.stat().st_size
    output_bytes = destination.stat().st_size
    return {
        "sourceFormat": source_info.format,
        "sourceSampleRate": source_info.samplerate,
        "sourceChannels": source_info.channels,
        "sourceBytes": source_bytes,
        "format": "MP3",
        "codec": "MPEG Layer III",
        "bitrateMode": "constant",
        "bitrateKbps": GAME_AUDIO_BITRATE_KBPS,
        "compressionLevel": None,
        "sampleRate": output_info.samplerate,
        "channels": output_info.channels,
        "compressedBytes": output_bytes,
        "sizeRatio": round_number(output_bytes / max(1, source_bytes), 4),
    }


def waveform_peaks(y: np.ndarray, bucket_count: int = 1_600) -> list[float]:
    boundaries = np.linspace(0, len(y), bucket_count + 1, dtype=int)
    peaks = [float(np.max(np.abs(y[boundaries[i] : boundaries[i + 1]]))) for i in range(bucket_count)]
    maximum = max(peaks, default=1)
    return [round_number(value / max(maximum, 1e-9), 4) for value in peaks]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", type=Path, required=True, help="Source audio accepted by libsndfile.")
    parser.add_argument("--audio-output", type=Path, required=True, help="Compressed MP3 used by the game.")
    parser.add_argument("--output", type=Path, required=True, help="Intermediate production analysis JSON.")
    parser.add_argument("--song-id", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--artist", default="Unknown Artist")
    parser.add_argument("--audio-url", required=True)
    parser.add_argument("--skip-beat-this", action="store_true")
    parser.add_argument("--skip-basic-pitch", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.audio.is_file():
        raise FileNotFoundError(f"Audio input does not exist: {args.audio}")
    print(f"Compressing {args.audio} -> {args.audio_output}...")
    audio_compression = compress_game_audio(args.audio, args.audio_output)
    print(
        f"Compressed {audio_compression['sourceBytes'] / 1_048_576:.2f} MiB -> "
        f"{audio_compression['compressedBytes'] / 1_048_576:.2f} MiB "
        f"({audio_compression['sizeRatio'] * 100:.1f}%)."
    )
    print(f"Loading compressed game audio {args.audio_output}...")
    y, sample_rate = librosa.load(args.audio_output, sr=SAMPLE_RATE, mono=True)
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

    librosa_selected = nms_detector_events(librosa_display_events, MIN_OUTPUT_GAP_SECONDS)
    percussive_selected = nms_detector_events(
        [event for event in detectors.get("percussive", []) if event.score >= 0.62],
        MIN_PERFORMANCE_EVIDENCE_GAP_SECONDS,
    )
    basic_pitch_display_events = nms_detector_events(
        [event for event in basic_pitch_events if event.score >= 0.62],
        MIN_PERFORMANCE_EVIDENCE_GAP_SECONDS,
    )

    event_sources = [
        create_event_source(
            "librosa-onset",
            [
                event_payload(event.time, event.score, [event.source])
                for event in librosa_selected
            ],
        ),
        create_event_source(
            "librosa-percussive",
            [
                event_payload(event.time, event.score, [event.source])
                for event in percussive_selected
            ],
        ),
        create_event_source(
            "librosa-harmonic",
            [
                event_payload(event.time, event.score, [event.source])
                for event in nms_detector_events(
                    [event for event in detectors.get("harmonic", []) if event.score >= 0.58],
                    MIN_PERFORMANCE_EVIDENCE_GAP_SECONDS,
                )
            ],
        ),
    ]
    for band_name in ("bass", "low_mid", "mid", "high_mid", "high"):
        detector_id = f"band_{band_name}"
        source_id = f"librosa-band-{band_name.replace('_', '-')}"
        event_sources.append(create_event_source(
            source_id,
            [
                event_payload(event.time, event.score, [event.source])
                for event in nms_detector_events(
                    [event for event in detectors.get(detector_id, []) if event.score >= 0.62],
                    MIN_PERFORMANCE_EVIDENCE_GAP_SECONDS,
                )
            ],
        ))
    if basic_pitch_events:
        event_sources.append(create_event_source(
            "basic-pitch",
            [
                basic_pitch_event_payload(event)
                for event in basic_pitch_display_events
            ],
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
        event_sources.append(create_event_source(
            "beat-this",
            beat_track_payload,
        ))

    if not beat_events:
        raise RuntimeError("Beat This! did not produce beat events; a complete production chart cannot be built.")
    beat_intervals = np.diff([event.time for event in beat_events])
    estimated_bpm = 60 / float(np.median(beat_intervals)) if beat_intervals.size else 120.0
    audio_fingerprint = hashlib.sha256(args.audio_output.read_bytes()).hexdigest()[:16]

    output = {
        "schemaVersion": 2,
        "kind": "rhythm-production-analysis",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "timingPolicy": "Attack evidence uses measured onset fronts in seconds; confidence remains sampled at the detector peak and no BPM grid or snapping is used.",
        "song": {
            "id": args.song_id,
            "title": args.title,
            "artist": args.artist,
            "audioUrl": args.audio_url,
            "audioFingerprint": audio_fingerprint,
            "bpm": round_number(estimated_bpm, 2),
            "durationSeconds": round_number(duration, 3),
            "sampleRate": SAMPLE_RATE,
            "audioCompression": audio_compression,
        },
        "primaryEventSourceId": "beat-this",
        "waveform": {
            "bucketCount": 1_600,
            "peaks": waveform_peaks(y),
        },
        "models": model_metadata,
        "musicalStructure": musical_structure,
        "eventSources": event_sources,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {args.output}")
    for source in event_sources:
        print(f"  {source['id']}: {source['eventCount']} events")


if __name__ == "__main__":
    main()
