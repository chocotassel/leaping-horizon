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
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


SAMPLE_RATE = 22_050
HOP_LENGTH = 256
N_FFT = 1_024
MIN_OUTPUT_GAP_SECONDS = 0.12
TRAINING_MATCH_SECONDS = 0.12
SOURCE_MATCH_SECONDS = 0.09
COLORS = {
    "human-reference": "#f4f7ff",
    "legacy-grid": "#7c879c",
    "librosa-onset": "#35e4ed",
    "basic-pitch": "#b879ff",
    "beat-this": "#ffc857",
    "preference-fusion": "#ff4f9a",
}


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
    targets = [1 if index in positive_candidates else 0 for index in range(len(candidates))]
    for index, candidate in enumerate(candidates):
        distance = min((abs(candidate["time"] - label) for label in labels), default=math.inf)
        is_positive = index in positive_candidates
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

    candidates = merge_candidates(detectors)
    fusion, training = train_preference_model(candidates, detectors, curves, labels)

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
        tracks.append(create_track(
            "beat-this",
            "Beat This! 拍点",
            "神经网络识别的 beat/downbeat，仅作为节拍基准，不代表全部障碍事件。",
            [event_payload(event.time, event.score, [event.source]) for event in beat_events],
            labels,
        ))
    tracks.append(create_track(
        "preference-fusion",
        "偏好融合（推荐）",
        "标准正则化分类器从成熟检测器候选中选择更像你标注的音乐事件；时间仍取原始音频峰。",
        [
            event_payload(
                candidate["time"],
                candidate["preferenceScore"],
                [source for source, score in candidate["sourceScores"].items() if score >= 0.2],
            )
            for candidate in fusion
        ],
        labels,
        kind="recommended",
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
        "primaryTrackId": "preference-fusion",
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
        },
        "models": model_metadata,
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
