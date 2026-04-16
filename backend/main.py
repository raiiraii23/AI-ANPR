import os
import asyncio
import logging
import threading
import time
from contextlib import asynccontextmanager
from typing import Optional

import cv2
import numpy as np
from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, func
from dotenv import load_dotenv

from database import init_db, get_db, AsyncSessionLocal
from models import Violation, Detection
from rtsp_handler import RTSPStream
from audio_processor import AcousticTrigger
from audio_source import RtspAudioSource
from ai_engine import AIEngine

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

RTSP_URL = os.getenv("RTSP_URL", "rtsp://admin123:raiiraii23@192.168.8.103:554/stream1")
NOISE_THRESHOLD_DB = float(os.getenv("NOISE_THRESHOLD_DB", "99"))
TRIGGER_DURATION_MS = int(os.getenv("TRIGGER_DURATION_MS", "500"))
CAPTURE_DIR = os.getenv("CAPTURE_DIR", "./captures")

rtsp_stream = RTSPStream(RTSP_URL)
ai_engine = AIEngine()
acoustic_trigger: Optional[AcousticTrigger] = None
audio_source: Optional[RtspAudioSource] = None
_ws_clients: list[WebSocket] = []

# Shared state for the continuous detection worker
_latest_annotated: Optional[np.ndarray] = None
_annotated_lock = threading.Lock()
_seen_track_ids: set[int] = set()
_detection_stop = threading.Event()
_main_loop: Optional[asyncio.AbstractEventLoop] = None


async def broadcast_ws(message: dict):
    disconnected = []
    for ws in _ws_clients:
        try:
            await ws.send_json(message)
        except Exception:
            disconnected.append(ws)
    for ws in disconnected:
        if ws in _ws_clients:
            _ws_clients.remove(ws)


async def save_violation(record: dict):
    async with AsyncSessionLocal() as session:
        violation = Violation(**record)
        session.add(violation)
        await session.commit()
        await session.refresh(violation)
        logger.info("Violation saved: plate=%s dB=%.1f", violation.plate_number, violation.decibel_level)
        await broadcast_ws({
            "event": "new_violation",
            "data": {
                "id": violation.id,
                "plate_number": violation.plate_number,
                "decibel_level": violation.decibel_level,
                "timestamp": violation.timestamp.isoformat(),
                "image_path": violation.image_path,
                "status": violation.status,
                "location": violation.location,
            },
        })


async def save_detection(record: dict):
    async with AsyncSessionLocal() as session:
        detection = Detection(**record)
        session.add(detection)
        await session.commit()
        await session.refresh(detection)
        logger.info(
            "Detection saved: #%d %s track=%d conf=%.2f",
            detection.id, detection.class_name, detection.track_id, detection.confidence,
        )
        await broadcast_ws({
            "event": "new_detection",
            "data": {
                "id": detection.id,
                "track_id": detection.track_id,
                "class_name": detection.class_name,
                "confidence": detection.confidence,
                "timestamp": detection.timestamp.isoformat(),
                "image_path": detection.image_path,
            },
        })


def on_noise_trigger(db_level: float):
    """Called from audio thread when noise threshold is sustained."""
    logger.info("ACOUSTIC TRIGGER: %.1f dB", db_level)
    frame = rtsp_stream.get_frame()
    if frame is None:
        logger.warning("No frame available at trigger time.")
        return
    record = ai_engine.process_frame(frame, db_level)
    asyncio.run(save_violation(record))


def _detection_worker():
    """Continuously pulls frames, runs YOLO tracker, dedupes, persists new vehicles."""
    global _latest_annotated
    logger.info("Detection worker started.")
    while not _detection_stop.is_set():
        frame = rtsp_stream.get_frame()
        if frame is None:
            time.sleep(0.1)
            continue

        try:
            annotated, detections = ai_engine.detect_vehicles(frame)
        except Exception as e:
            logger.error("detect_vehicles failed: %s", e)
            time.sleep(0.1)
            continue

        with _annotated_lock:
            _latest_annotated = annotated

        for det in detections:
            tid = det["track_id"]
            if tid in _seen_track_ids:
                continue
            _seen_track_ids.add(tid)
            image_path = ai_engine.save_detection_crop(annotated, det["box"], tid)
            record = {
                "track_id": tid,
                "class_name": det["class_name"],
                "confidence": det["confidence"],
                "image_path": image_path,
            }
            if _main_loop is not None:
                asyncio.run_coroutine_threadsafe(save_detection(record), _main_loop)

        time.sleep(0.03)
    logger.info("Detection worker stopped.")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _main_loop
    _main_loop = asyncio.get_running_loop()
    await init_db()
    rtsp_stream.start()
    global acoustic_trigger, audio_source
    acoustic_trigger = AcousticTrigger(
        threshold_db=NOISE_THRESHOLD_DB,
        trigger_duration_ms=TRIGGER_DURATION_MS,
        on_trigger=on_noise_trigger,
    )
    audio_source = RtspAudioSource(
        rtsp_url=RTSP_URL,
        on_chunk=acoustic_trigger.process_chunk,
    )
    audio_source.start()
    worker = threading.Thread(target=_detection_worker, daemon=True)
    worker.start()
    logger.info("System ready. Threshold: %.0f dB | Duration: %dms", NOISE_THRESHOLD_DB, TRIGGER_DURATION_MS)
    yield
    _detection_stop.set()
    if audio_source:
        audio_source.stop()
    rtsp_stream.stop()


app = FastAPI(title="Motorcycle Noise Enforcement API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

os.makedirs(CAPTURE_DIR, exist_ok=True)
app.mount("/captures", StaticFiles(directory=CAPTURE_DIR), name="captures")


@app.get("/api/violations")
async def list_violations(limit: int = 50, offset: int = 0, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Violation).order_by(desc(Violation.timestamp)).limit(limit).offset(offset)
    )
    violations = result.scalars().all()
    return [
        {
            "id": v.id,
            "plate_number": v.plate_number,
            "decibel_level": v.decibel_level,
            "timestamp": v.timestamp.isoformat() if v.timestamp else None,
            "image_path": v.image_path,
            "confidence": v.confidence,
            "location": v.location,
            "status": v.status,
            "notes": v.notes,
        }
        for v in violations
    ]


@app.get("/api/violations/{violation_id}")
async def get_violation(violation_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Violation).where(Violation.id == violation_id))
    v = result.scalar_one_or_none()
    if not v:
        raise HTTPException(status_code=404, detail="Violation not found")
    return {
        "id": v.id,
        "plate_number": v.plate_number,
        "decibel_level": v.decibel_level,
        "timestamp": v.timestamp.isoformat() if v.timestamp else None,
        "image_path": v.image_path,
        "confidence": v.confidence,
        "location": v.location,
        "status": v.status,
        "notes": v.notes,
    }


@app.patch("/api/violations/{violation_id}")
async def update_violation(
    violation_id: int,
    status: str,
    notes: str = None,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Violation).where(Violation.id == violation_id))
    v = result.scalar_one_or_none()
    if not v:
        raise HTTPException(status_code=404, detail="Violation not found")
    v.status = status
    if notes is not None:
        v.notes = notes
    await db.commit()
    return {"status": "updated"}


@app.get("/api/detections")
async def list_detections(limit: int = 50, offset: int = 0, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Detection).order_by(desc(Detection.timestamp)).limit(limit).offset(offset)
    )
    rows = result.scalars().all()
    return [
        {
            "id": d.id,
            "track_id": d.track_id,
            "class_name": d.class_name,
            "confidence": d.confidence,
            "timestamp": d.timestamp.isoformat() if d.timestamp else None,
            "image_path": d.image_path,
        }
        for d in rows
    ]


@app.post("/api/detections/reset")
async def reset_detections(db: AsyncSession = Depends(get_db)):
    _seen_track_ids.clear()
    await db.execute(Detection.__table__.delete())
    await db.commit()
    return {"status": "cleared"}


@app.get("/api/stats")
async def get_stats(db: AsyncSession = Depends(get_db)):
    total_r = await db.execute(select(func.count()).select_from(Violation))
    pending_r = await db.execute(select(func.count()).select_from(Violation).where(Violation.status == "pending"))
    cited_r = await db.execute(select(func.count()).select_from(Violation).where(Violation.status == "cited"))
    avg_db_r = await db.execute(select(func.avg(Violation.decibel_level)).select_from(Violation))
    det_count_r = await db.execute(select(func.count()).select_from(Detection))
    total = total_r.scalar() or 0
    pending = pending_r.scalar() or 0
    cited = cited_r.scalar() or 0
    return {
        "total": total,
        "pending": pending,
        "cited": cited,
        "dismissed": total - pending - cited,
        "avg_decibel": round(float(avg_db_r.scalar() or 0), 1),
        "detections": det_count_r.scalar() or 0,
    }


@app.get("/api/status")
async def system_status():
    return {
        "rtsp_connected": rtsp_stream.get_frame() is not None,
        "current_db": acoustic_trigger.current_db if acoustic_trigger else 0,
        "threshold_db": NOISE_THRESHOLD_DB,
        "trigger_duration_ms": TRIGGER_DURATION_MS,
        "unique_vehicles": len(_seen_track_ids),
    }


@app.get("/api/video_feed")
async def video_feed():
    boundary = b"--frame"

    async def gen():
        while True:
            with _annotated_lock:
                frame = None if _latest_annotated is None else _latest_annotated.copy()
            if frame is None:
                await asyncio.sleep(0.1)
                continue
            ok, jpeg = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
            if not ok:
                await asyncio.sleep(0.05)
                continue
            yield (
                boundary + b"\r\n"
                b"Content-Type: image/jpeg\r\n"
                b"Content-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n"
                + jpeg.tobytes() + b"\r\n"
            )
            await asyncio.sleep(0.05)

    return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=frame")


@app.websocket("/ws/live")
async def websocket_live(websocket: WebSocket):
    await websocket.accept()
    _ws_clients.append(websocket)
    try:
        while True:
            db_val = acoustic_trigger.current_db if acoustic_trigger else 0.0
            await websocket.send_json({"event": "db_update", "value": round(db_val, 1)})
            await asyncio.sleep(0.05)
    except WebSocketDisconnect:
        if websocket in _ws_clients:
            _ws_clients.remove(websocket)
