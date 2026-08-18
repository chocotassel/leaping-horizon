#!/usr/bin/env python3
"""Explicit CPU Demucs adapter used before rhythm analysis.

This process owns model execution. analyze-rhythm.py only consumes its cached
manifest and therefore never downloads or invokes a separation model itself.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torchaudio


CORE4_ROLES = ("vocals", "drums", "bass", "other")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--output-directory", type=Path, required=True)
    parser.add_argument("--result", type=Path, required=True)
    parser.add_argument("--model", default="htdemucs")
    parser.add_argument("--device", choices=("cpu",), default="cpu")
    return parser.parse_args()


def progress(message: str) -> None:
    print(message, flush=True)


def install_soundfile_backend() -> None:
    """Keep Demucs independent from optional TorchCodec/FFmpeg shared DLLs.

    The project already ships a command-line ffmpeg, but recent torchaudio
    releases require a separate shared-library distribution for decoding.
    Demucs only needs tensor load/save here, which libsndfile provides
    deterministically for the game MP3 and generated WAV stems.
    """

    def load(path: str) -> tuple[torch.Tensor, int]:
        samples, sample_rate = sf.read(path, dtype="float32", always_2d=True)
        tensor = torch.from_numpy(np.ascontiguousarray(samples.T))
        return tensor, int(sample_rate)

    def save(
        path: str,
        tensor: torch.Tensor,
        sample_rate: int,
        *,
        encoding: str | None = None,
        bits_per_sample: int | None = None,
        **_: object,
    ) -> None:
        subtype = "FLOAT" if encoding == "PCM_F" else {
            24: "PCM_24",
            32: "PCM_32",
        }.get(bits_per_sample, "PCM_16")
        samples = tensor.detach().cpu().numpy().T
        sf.write(path, samples, sample_rate, subtype=subtype)

    torchaudio.load = load
    torchaudio.save = save


def main() -> None:
    args = parse_args()
    audio_path = args.audio.resolve()
    output_directory = args.output_directory.resolve()
    result_path = args.result.resolve()
    if not audio_path.is_file():
        raise FileNotFoundError(f"Game audio does not exist: {audio_path}")

    output_directory.mkdir(parents=True, exist_ok=True)
    demucs_directory = output_directory / "demucs-output"
    progress(f"Separating {audio_path.name} with {args.model} on CPU...")
    install_soundfile_backend()
    from demucs.separate import main as demucs_main

    demucs_main([
        "--name",
        args.model,
        "--device",
        args.device,
        "--out",
        str(demucs_directory),
        str(audio_path),
    ])

    stems: dict[str, str] = {}
    reference_info = None
    for role in CORE4_ROLES:
        candidates = sorted((demucs_directory / args.model).rglob(f"{role}.wav"))
        if len(candidates) != 1:
            raise RuntimeError(
                f"Demucs produced {len(candidates)} candidates for {role}; expected exactly one."
            )
        destination = output_directory / f"{role}.wav"
        shutil.copy2(candidates[0], destination)
        info = sf.info(destination)
        if reference_info is None:
            reference_info = info
        elif info.samplerate != reference_info.samplerate or info.frames != reference_info.frames:
            raise RuntimeError("Core-4 stems do not share one zero-based sample timeline.")
        stems[role] = str(destination)
        progress(f"Prepared {role} stem ({info.frames / info.samplerate:.1f}s).")

    if reference_info is None:
        raise RuntimeError("Demucs did not produce core-4 stems.")
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps({
        "stems": stems,
        "sampleRate": reference_info.samplerate,
        "durationSeconds": reference_info.frames / reference_info.samplerate,
        "timeOriginSeconds": 0,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    progress(f"Core-4 separation complete: {result_path}")


if __name__ == "__main__":
    main()
