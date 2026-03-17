import numpy as np
import time
import threading
import logging
from scipy.fft import fft
from scipy.signal import butter, filtfilt

logger = logging.getLogger(__name__)

MUFFLER_FREQ_LOW = 50
MUFFLER_FREQ_HIGH = 1000


def butter_bandpass(lowcut: float, highcut: float, fs: float, order: int = 5):
    nyq = 0.5 * fs
    low = lowcut / nyq
    high = highcut / nyq
    b, a = butter(order, [low, high], btype="band")
    return b, a


def compute_db_fft(audio_chunk: np.ndarray, sample_rate: int = 44100) -> float:
    """Compute dB level using FFT focused on muffler frequency range (50-1000Hz)."""
    if len(audio_chunk) == 0:
        return 0.0

    if audio_chunk.dtype != np.float32:
        audio_chunk = audio_chunk.astype(np.float32) / 32768.0

    try:
        b, a = butter_bandpass(MUFFLER_FREQ_LOW, MUFFLER_FREQ_HIGH, sample_rate)
        filtered = filtfilt(b, a, audio_chunk)
    except Exception:
        filtered = audio_chunk

    N = len(filtered)
    fft_vals = np.abs(fft(filtered))[:N // 2]
    freqs = np.fft.rfftfreq(N, d=1.0 / sample_rate)

    mask = (freqs >= MUFFLER_FREQ_LOW) & (freqs <= MUFFLER_FREQ_HIGH)
    band_energy = np.sum(fft_vals[mask] ** 2)

    if band_energy <= 0:
        return 0.0

    db = 10 * np.log10(band_energy + 1e-10)
    db_normalized = db + 60  # calibration offset - adjust during field testing
    return float(np.clip(db_normalized, 0, 140))


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
