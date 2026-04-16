# Synchronized ANPR & Acoustic Monitoring System
### Motorcycle Traffic Noise Enforcement — Undergraduate Thesis

A real-time traffic enforcement system for the Philippines that captures **license plates** and **noise levels** of passing motorcycles simultaneously. When a motorcycle exceeds the LTO-mandated 99 dB limit, the system saves a timestamped JPEG (annotated with plate number and dB reading) as verifiable evidence for citation.

---

## How It Works

```
Hikvision IP Camera (RTSP)
        │
        ├─── Video ──▶ RTSPStream thread (latest frame in memory)
        │
        └─── Audio ──▶ AcousticTrigger
                            │  FFT bandpass 50–1000 Hz
                            │  > 99 dB sustained for 500 ms?
                            ▼
                        AI Engine
                            ├─ YOLOv8  → detect plate region
                            ├─ PaddleOCR → read plate text
                            └─ Save annotated JPEG
                                    │
                              PostgreSQL DB
                                    │
                           Next.js Dashboard
                        (live dB meter + violation table)
```

The 500 ms sustained duration rule is key — it filters out short transients like car horns while still catching the continuous roar of a modified muffler.

---

## Project Structure

```
Thesis/
├── README.md
├── CLAUDE.md                  ← full technical reference for AI assistants
├── docker-compose.yml         ← PostgreSQL 16-alpine
├── backend/                   ← Python AI engine + REST API
│   ├── README.md
│   ├── CLAUDE.md
│   ├── main.py
│   ├── models.py
│   ├── database.py
│   ├── audio_processor.py
│   ├── rtsp_handler.py
│   ├── ai_engine.py
│   ├── requirements.txt
│   ├── .env.example
│   └── captures/              ← saved violation JPEGs (git-ignored)
└── frontend/                  ← Next.js 15 dashboard
    ├── README.md
    ├── CLAUDE.md
    └── app/
        ├── page.tsx           ← main dashboard
        ├── layout.tsx
        └── lib/api.ts         ← typed API client
```

---

## Prerequisites

| Requirement | Version |
|---|---|
| Python | 3.10+ |
| Node.js | 18+ |
| Docker | any recent |
| PostgreSQL | 16 (via Docker) |

---

## Quick Start

### 1. Start the database
```bash
docker compose up -d
```

### 2. Configure and run the backend
```bash
cd backend
cp .env.example .env
# Edit .env — set RTSP_URL to your camera's address
pip install -r requirements.txt
source venv/Scripts/activate
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### 3. Run the frontend
```bash
cd frontend
npm install
npm run dev
# Open http://localhost:3000
```

---

## Environment Variables

All backend config lives in `backend/.env`:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql+asyncpg://postgres:password@localhost:5432/thesis_db` | PostgreSQL connection string |
| `RTSP_URL` | `rtsp://admin:password@192.168.1.100:554/...` | Hikvision camera stream URL |
| `NOISE_THRESHOLD_DB` | `99` | Trigger level in dB (LTO AO 2006-003) |
| `TRIGGER_DURATION_MS` | `500` | Minimum sustained duration before trigger |
| `CAPTURE_DIR` | `./captures` | Where violation JPEGs are saved |

Frontend config in `frontend/.env.local`:

| Variable | Default | Description |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | Backend base URL |

---

## API Reference

Backend runs on `http://localhost:8000`.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/violations` | List violations (`limit`, `offset` params) |
| `GET` | `/api/violations/:id` | Single violation detail |
| `PATCH` | `/api/violations/:id` | Update `status` and/or `notes` |
| `GET` | `/api/stats` | Counts (total, pending, cited, dismissed) + avg dB |
| `GET` | `/api/status` | RTSP connection status + live dB reading |
| `WS` | `/ws/live` | Real-time stream: `db_update` (100ms) + `new_violation` events |
| `GET` | `/captures/*` | Static JPEG files for violation evidence |

---

## Hardware

| Component | Model | Price (PHP) |
|---|---|---|
| IP Camera | Hikvision DS-2CD2047G2-LU (4MP AcuSense, built-in mic) | ₱5,800 |
| Sound Meter | Digital Decibel Meter Class 2 (calibration reference) | ₱1,800 |
| Power/Data | PoE Injector + 20m Cat6 Cable | ₱1,500 |
| Mounting | Aluminum Tripod / Bracket | ₱1,200 |
| Storage | 128GB High-Endurance MicroSD | ₱1,100 |
| **TOTAL** | | **₱11,400** |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.10, FastAPI 0.115, Uvicorn |
| AI Detection | YOLOv8 (ultralytics) |
| AI Recognition | PaddleOCR 2.7 |
| Audio DSP | SciPy FFT + Butterworth bandpass filter |
| Video I/O | OpenCV (RTSP via CAP_FFMPEG) |
| Database | PostgreSQL 16, SQLAlchemy 2.0 (asyncpg) |
| Frontend | Next.js 15, TypeScript, Tailwind CSS |
| Real-time | WebSocket (FastAPI native) |

---

## Implementation Phases

- [ ] **Phase 1** — Hardware Procurement & Network Setup *(Month 1)*
- [ ] **Phase 2** — AI Engine Development *(Month 2–3)*
- [ ] **Phase 3** — Next.js Dashboard & Database Integration *(Month 4)*
- [ ] **Phase 4** — Field Testing & Calibration *(Month 5–6)*

---

## Legal Basis

This system is calibrated to the noise limits set by **LTO Administrative Order No. 2006-003**, which mandates a maximum of **99 dB(A)** for motorcycles. Measurements are validated against a Class 2 reference sound level meter during field setup.

---

## Thesis Details

- **Institution:** *(your university)*
- **Program:** *(your degree program)*
- **Adviser:** *(adviser name)*
- **Academic Year:** 2025–2026
