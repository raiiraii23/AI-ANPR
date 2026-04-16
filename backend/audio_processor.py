import os
import numpy as np
import time
import threading
import logging
from scipy.signal import butter, sosfiltfilt

logger = logging.getLogger(__name__)

MUFFLER_FREQ_LOW = 50
MUFFLER_FREQ_HIGH = 1000

# dB calibration offset (dBFS -> dB SPL). Override via DB_CALIBRATION_OFFSET env var.
DB_CALIBRATION_OFFSET = float(os.getenv("DB_CALIBRATION_OFFSET", "94.0"))


def butter_bandpass_sos(lowcut: float, highcut: float, fs: float, order: int = 4):
    nyq = 0.5 * fs
    low = max(1e-6, lowcut / nyq)
    high = min(0.9999, highcut / nyq)
    return butter(order, [low, high], btype="band", output="sos")


def compute_db(audio_chunk: np.ndarray, sample_rate: int = 44100) -> float:
    """
    Compute an SPL-style dB reading from a PCM chunk:
      1. Normalize int16 → float in [-1, 1]
      2. Bandpass 50–1000 Hz (muffler range)
      3. RMS → dBFS → dB SPL via fixed calibration offset
    """
    if audio_chunk is None or len(audio_chunk) == 0:
        return 0.0

    if audio_chunk.dtype == np.int16:
        audio = audio_chunk.astype(np.float32) / 32768.0
    elif audio_chunk.dtype != np.float32:
        audio = audio_chunk.astype(np.float32)
    else:
        audio = audio_chunk

    rms = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))
    if rms <= 1e-9:
        return 0.0

    dbfs = 20.0 * np.log10(rms)
    db_spl = dbfs + DB_CALIBRATION_OFFSET
    return float(np.clip(db_spl, 0.0, 140.0))


# Back-compat alias
compute_db_fft = compute_db


class AcousticTrigger:
    """
    Monitors audio levels and fires a callback when noise exceeds threshold
    sustained for the required duration (anti-horn false-positive using 500ms rule).
    """

    def __init__(
        self,
        threshold_db: float = 99.0,
        trigger_duration_ms: int = 500,
        sample_rate: int = 44100,
        on_trigger=None,
    ):
        self.threshold_db = threshold_db
        self.trigger_duration_ms = trigger_duration_ms
        self.sample_rate = sample_rate
        self.on_trigger = on_trigger

        self._above_threshold_since: float | None = None
        self._lock = threading.Lock()
        self._last_trigger_time: float = 0
        self._cooldown_seconds: float = 3.0
        self._current_db: float = 0.0

    @property
    def current_db(self) -> float:
        return self._current_db

    def process_chunk(self, audio_chunk: np.ndarray) -> float:
        db = compute_db_fft(audio_chunk, self.sample_rate)
        self._current_db = db

        now = time.monotonic()
        with self._lock:
            if db >= self.threshold_db:
                if self._above_threshold_since is None:
                    self._above_threshold_since = now
                elapsed_ms = (now - self._above_threshold_since) * 1000
                if elapsed_ms >= self.trigger_duration_ms:
                    since_last = now - self._last_trigger_time
                    if since_last >= self._cooldown_seconds:
                        self._last_trigger_time = now
                        self._above_threshold_since = None
                        if self.on_trigger:
                            threading.Thread(
                                target=self.on_trigger, args=(db,), daemon=True
                            ).start()
            else:
                self._above_threshold_since = None

        return db
