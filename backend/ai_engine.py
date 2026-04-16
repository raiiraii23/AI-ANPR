import cv2
import numpy as np
import os
import logging
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

CAPTURE_DIR = Path(os.getenv("CAPTURE_DIR", "./captures"))
CAPTURE_DIR.mkdir(parents=True, exist_ok=True)

# COCO vehicle class ids: car, motorcycle, bus, truck
VEHICLE_CLASSES = {2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}


class AIEngine:
    """YOLOv8 for vehicle detection/tracking + optional PaddleOCR for plates."""

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
            logger.info("PaddleOCR unavailable (plate text will be skipped): %s", e)

        self._initialized = True

    def detect_vehicles(self, frame: np.ndarray):
        """
        Run YOLO tracker on a frame. Returns (annotated_frame, detections).
        Each detection: {"track_id", "class_name", "confidence", "box": (x1,y1,x2,y2)}.
        Boxes are drawn as green rectangles with a label.
        """
        self._lazy_init()
        annotated = frame.copy()
        detections: list[dict] = []

        if self._yolo is None:
            return annotated, detections

        try:
            results = self._yolo.track(
                frame,
                persist=True,
                verbose=False,
                classes=list(VEHICLE_CLASSES.keys()),
                tracker="bytetrack.yaml",
            )
        except Exception as e:
            logger.error("YOLO track error: %s", e)
            return annotated, detections

        if not results:
            return annotated, detections

        r = results[0]
        if r.boxes is None or len(r.boxes) == 0:
            return annotated, detections

        for box in r.boxes:
            cls_id = int(box.cls[0]) if box.cls is not None else -1
            cls_name = VEHICLE_CLASSES.get(cls_id, "vehicle")
            conf = float(box.conf[0]) if box.conf is not None else 0.0
            if box.id is None:
                continue
            track_id = int(box.id[0])
            x1, y1, x2, y2 = box.xyxy[0].cpu().numpy().astype(int).tolist()

            cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 255, 0), 2)
            label = f"{cls_name} #{track_id} {conf:.2f}"
            (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 1)
            cv2.rectangle(annotated, (x1, y1 - th - 6), (x1 + tw + 6, y1), (0, 255, 0), -1)
            cv2.putText(
                annotated, label, (x1 + 3, y1 - 4),
                cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 1, cv2.LINE_AA,
            )

            detections.append({
                "track_id": track_id,
                "class_name": cls_name,
                "confidence": conf,
                "box": (x1, y1, x2, y2),
            })

        return annotated, detections

    def save_detection_crop(self, frame: np.ndarray, box: tuple[int, int, int, int], track_id: int) -> str | None:
        try:
            x1, y1, x2, y2 = box
            h, w = frame.shape[:2]
            x1 = max(0, x1); y1 = max(0, y1); x2 = min(w, x2); y2 = min(h, y2)
            if x2 - x1 < 5 or y2 - y1 < 5:
                return None
            ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S_%f")
            filename = f"detection_{ts}_id{track_id}.jpg"
            path = CAPTURE_DIR / filename
            cv2.imwrite(str(path), frame[y1:y2, x1:x2])
            return str(path)
        except Exception as e:
            logger.error("Detection crop save error: %s", e)
            return None

    def process_frame(self, frame: np.ndarray, decibel_level: float) -> dict:
        """Noise-trigger pipeline: OCR the frame, annotate, and persist."""
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
