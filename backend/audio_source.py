import logging
import subprocess
import threading
import time
from typing import Callable, Optional

import numpy as np

logger = logging.getLogger(__name__)


class RtspAudioSource:
    """
    Pulls PCM audio from an RTSP URL via a bundled ffmpeg subprocess and
    delivers fixed-size chunks to a consumer callback.

    Output format: 16-bit signed little-endian, mono, 44100 Hz.
    """

    def __init__(
        self,
        rtsp_url: str,
        on_chunk: Callable[[np.ndarray], None],
        sample_rate: int = 44100,
        chunk_samples: int = 2205,  # 50 ms — more reactive updates
        reconnect_delay: float = 5.0,
    ):
        self.rtsp_url = rtsp_url
        self.on_chunk = on_chunk
        self.sample_rate = sample_rate
        self.chunk_samples = chunk_samples
        self.reconnect_delay = reconnect_delay

        self._proc: Optional[subprocess.Popen] = None
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._ffmpeg_exe: Optional[str] = None

    def _resolve_ffmpeg(self) -> str:
        try:
            import imageio_ffmpeg
            return imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            return "ffmpeg"

    def start(self):
        if self._running:
            return
        self._ffmpeg_exe = self._resolve_ffmpeg()
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        logger.info("RTSP audio source started (%s).", self._ffmpeg_exe)

    def stop(self):
        self._running = False
        if self._proc and self._proc.poll() is None:
            try:
                self._proc.kill()
            except Exception:
                pass
        self._proc = None

    def _spawn_ffmpeg(self) -> Optional[subprocess.Popen]:
        cmd = [
            self._ffmpeg_exe or "ffmpeg",
            "-loglevel", "error",
            "-rtsp_transport", "tcp",
            "-i", self.rtsp_url,
            "-vn",
            "-f", "s16le",
            "-acodec", "pcm_s16le",
            "-ac", "1",
            "-ar", str(self.sample_rate),
            "-",
        ]
        try:
            return subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0,
            )
        except Exception as e:
            logger.error("Failed to spawn ffmpeg: %s", e)
            return None

    def _loop(self):
        bytes_per_chunk = self.chunk_samples * 2  # int16 mono
        while self._running:
            self._proc = self._spawn_ffmpeg()
            if self._proc is None or self._proc.stdout is None:
                time.sleep(self.reconnect_delay)
                continue

            logger.info("ffmpeg audio capture connected.")
            try:
                while self._running:
                    raw = self._proc.stdout.read(bytes_per_chunk)
                    if not raw or len(raw) < bytes_per_chunk:
                        # stdout closed or short read — treat as disconnect
                        break
                    chunk = np.frombuffer(raw, dtype=np.int16)
                    try:
                        self.on_chunk(chunk)
                    except Exception as e:
                        logger.error("Audio callback error: %s", e)
            finally:
                if self._proc:
                    err = b""
                    try:
                        if self._proc.stderr is not None:
                            err = self._proc.stderr.read() or b""
                    except Exception:
                        pass
                    self._proc.kill()
                    self._proc = None
                    if err:
                        logger.warning("ffmpeg stderr: %s", err.decode("utf-8", errors="ignore").strip())

            if self._running:
                logger.warning("ffmpeg audio disconnected, reconnecting in %.1fs...", self.reconnect_delay)
                time.sleep(self.reconnect_delay)
