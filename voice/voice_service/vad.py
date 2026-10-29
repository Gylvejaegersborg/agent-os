"""Silero VAD v5 through onnxruntime directly (no torch). One 512-sample frame at 16 kHz → speech probability.

v5 carries a recurrent state between calls and expects the last 64 samples of the previous frame prepended
to each new one (what silero-vad's own OnnxWrapper does).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

CONTEXT = 64


class SileroVad:
    def __init__(self, model: Path, threads: int = 2, sample_rate: int = 16000) -> None:
        import onnxruntime as ort

        if sample_rate != 16000:
            raise ValueError("this wrapper is set up for 16 kHz (512-sample frames)")
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        self._session = ort.InferenceSession(str(model), sess_options=opts, providers=["CPUExecutionProvider"])
        self._sr = np.array(sample_rate, dtype=np.int64)
        self.reset()

    def reset(self) -> None:
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros((1, CONTEXT), dtype=np.float32)

    def __call__(self, frame: np.ndarray) -> float:
        x = np.asarray(frame, dtype=np.float32).reshape(1, -1)
        if x.shape[1] != 512:
            raise ValueError(f"expected 512 samples, got {x.shape[1]}")
        x = np.concatenate([self._context, x], axis=1)
        out, self._state = self._session.run(None, {"input": x, "state": self._state, "sr": self._sr})
        self._context = x[:, -CONTEXT:]
        return float(out.reshape(-1)[0])
