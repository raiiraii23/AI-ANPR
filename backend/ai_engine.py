import cv2
import numpy as np
import os
import logging
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

CAPTURE_DIR = Path(os.getenv("CAPTURE_DIR", "./captures"))
CAPTURE_DIR.mkdir(parents=True, exist_ok=True)


class AIEngine:
    """YOLOv8 for plate region detection + PaddleOCR for text extraction."""

    def __init__(self):
        self._yolo = None
        self._ocr = None
        self._initialized = False

    def _lazy_init(self):
        if self._initialized:
            return
        try:
            from ultralytics import YOLO
            self._yolo = YOLO("yolov8n.pt")
            logger.info("YOLOv8 model loaded.")
        except Exception as e:
            logger.error("Failed to load YOLOv8: %s", e)

        try:
            from paddleocr import PaddleOCR
            self._ocr = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)
            logger.info("PaddleOCR loaded.")
        except Exception as e:
            logger.error("Failed to load PaddleOCR: %s", e)

        self._initialized = True

    def process_frame(self, frame: np.ndarray, decibel_level: float) -> dict:
        """Full pipeline: detect plate region -> OCR -> save image -> return record."""
        self._lazy_init()
        timestamp = datetime.utcnow()
        filename = f"violation_{timestamp.strftime('%Y%m%d_%H%M%S_%f')}.jpg"
        image_path = str(CAPTURE_DIR / filename)

        plate_text = None
        confidence = None
        plate_crop = None

        if self._yolo is not None:
            try:
                results = self._yolo(frame, verbose=False)
                best_conf = 0.0
                best_box = None
                for result in results:
                    for box in result.boxes:
                        conf = float(box.conf[0])
                        if conf > best_conf:
                            best_conf = conf
                            best_box = box.xyxy[0].cpu().numpy().astype(int)
                            confidence = best_conf

                if best_box is not None:
                    x1, y1, x2, y2 = best_box
                    h, w = frame.shape[:2]
                    x1 = max(0, x1 - 5)
                    y1 = max(0, y1 - 5)
                    x2 = min(w, x2 + 5)
                    y2 = min(h, y2 + 5)
                    plate_crop = frame[y1:y2, x1:x2]
            except Exception as e:
                logger.error("YOLOv8 inference error: %s", e)

        target = plate_crop if plate_crop is not None else frame
        if self._ocr is not None and target is not None and target.size > 0:
            try:
                ocr_result = self._ocr.ocr(target, cls=True)
                if ocr_result and ocr_result[0]:
                    texts = [line[1][0] for line in ocr_result[0] if line[1][1] > 0.5]
                    plate_text = " ".join(texts).strip().upper() if texts else None
            except Exception as e:
                logger.error("PaddleOCR error: %s", e)

        try:
            annotated = frame.copy()
            cv2.putText(annotated, f"{decibel_level:.1f} dB", (20, 40),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 255), 2)
            if plate_text:
                cv2.putText(annotated, plate_text, (20, 80),
                            cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 0), 2)
            cv2.imwrite(image_path, annotated)
        except Exception as e:
            logger.error("Image save error: %s", e)
            image_path = None

        return {
            "plate_number": plate_text,
            "decibel_level": decibel_level,
            "timestamp": timestamp,
            "image_path": image_path,
            "confidence": confidence,
        }
