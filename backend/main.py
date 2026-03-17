import os
import asyncio
import logging
import threading
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, func
from dotenv import load_dotenv

from database import init_db, get_db, AsyncSessionLocal
from models import Violation
from rtsp_handler import RTSPStream
from audio_processor import AcousticTrigger
from ai_engine import AIEngine

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

RTSP_URL = os.getenv("RTSP_URL", "rtsp://admin:password@192.168.1.100:554/Streaming/Channels/101")
NOISE_THRESHOLD_DB = float(os.getenv("NOISE_THRESHOLD_DB", "99"))
TRIGGER_DURATION_MS = int(os.getenv("TRIGGER_DURATION_MS", "500"))
CAPTURE_DIR = os.getenv("CAPTURE_DIR", "./captures")

rtsp_stream = RTSPStream(RTSP_URL)
ai_engine = AIEngine()
acoustic_trigger: Optional[AcousticTrigger] = None
_ws_clients: list[WebSocket] = []


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


def on_noise_trigger(db_level: float):
    """Called from audio thread when noise threshold is sustained."""
    logger.info("ACOUSTIC TRIGGER: %.1f dB", db_level)
    frame = rtsp_stream.get_frame()
    if frame is None:
        logger.warning("No frame available at trigger time.")
        return
    record = ai_engine.process_frame(frame, db_level)
    asyncio.run(save_violation(record))


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    rtsp_stream.start()
    global acoustic_trigger
    acoustic_trigger = AcousticTrigger(
        threshold_db=NOISE_THRESHOLD_DB,
        trigger_duration_ms=TRIGGER_DURATION_MS,
        on_trigger=on_noise_trigger,
    )
    logger.info("System ready. Threshold: %.0f dB | Duration: %dms", NOISE_THRESHOLD_DB, TRIGGER_DURATION_MS)
    yield
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


@app.get("/api/stats")
async def get_stats(db: AsyncSession = Depends(get_db)):
    total_r = await db.execute(select(func.count()).select_from(Violation))
    pending_r = await db.execute(select(func.count()).select_from(Violation).where(Violation.status == "pending"))
    cited_r = await db.execute(select(func.count()).select_from(Violation).where(Violation.status == "cited"))
    avg_db_r = await db.execute(select(func.avg(Violation.decibel_level)).select_from(Violation))
    total = total_r.scalar() or 0
    pending = pending_r.scalar() or 0
    cited = cited_r.scalar() or 0
    return {
        "total": total,
        "pending": pending,
        "cited": cited,
        "dismissed": total - pending - cited,
        "avg_decibel": round(float(avg_db_r.scalar() or 0), 1),
    }


@app.get("/api/status")
async def system_status():
    return {
        "rtsp_connected": rtsp_stream.get_frame() is not None,
        "current_db": acoustic_trigger.current_db if acoustic_trigger else 0,
        "threshold_db": NOISE_THRESHOLD_DB,
        "trigger_duration_ms": TRIGGER_DURATION_MS,
    }


@app.websocket("/ws/live")
async def websocket_live(websocket: WebSocket):
    await websocket.accept()
    _ws_clients.append(websocket)
    try:
        while True:
            db_val = acoustic_trigger.current_db if acoustic_trigger else 0.0
            await websocket.send_json({"event": "db_update", "value": round(db_val, 1)})
            await asyncio.sleep(0.1)
    except WebSocketDisconnect:
        if websocket in _ws_clients:
            _ws_clients.remove(websocket)
