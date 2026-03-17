import cv2
import numpy as np
import threading
import logging
import time

logger = logging.getLogger(__name__)


class RTSPStream:
    """
    Manages a persistent RTSP connection with automatic reconnection.
    Provides the latest frame on demand for capture.
    """

    def __init__(self, rtsp_url: str, reconnect_delay: float = 5.0):
        self.rtsp_url = rtsp_url
        self.reconnect_delay = reconnect_delay

        self._cap: cv2.VideoCapture | None = None
        self._latest_frame: np.ndarray | None = None
        self._frame_lock = threading.Lock()
        self._running = False
        self._thread: threading.Thread | None = None

    def start(self):
        self._running = True
        self._thread = threading.Thread(target=self._stream_loop, daemon=True)
        self._thread.start()
        logger.info("RTSP stream thread started.")

    def stop(self):
        self._running = False
        if self._cap:
            self._cap.release()

    def get_frame(self) -> np.ndarray | None:
        with self._frame_lock:
            return self._latest_frame.copy() if self._latest_frame is not None else None

    def _stream_loop(self):
        while self._running:
            try:
                self._cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG)
                self._cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)

                if not self._cap.isOpened():
                    logger.warning("Cannot open RTSP stream. Retrying in %ss...", self.reconnect_delay)
                    time.sleep(self.reconnect_delay)
                    continue

                logger.info("RTSP stream connected.")
                while self._running:
                    ret, frame = self._cap.read()
                    if not ret:
                        logger.warning("Frame read failed. Reconnecting...")
                        break
                    with self._frame_lock:
                        self._latest_frame = frame

            except Exception as e:
                logger.error("RTSP error: %s", e)
            finally:
                if self._cap:
                    self._cap.release()
                time.sleep(self.reconnect_delay)
