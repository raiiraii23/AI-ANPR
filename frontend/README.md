# Frontend — Next.js 15 Dashboard

Admin dashboard for traffic enforcers. Displays live acoustic readings and a searchable, filterable log of all recorded violations. Connects to the Python backend via REST and WebSocket.

---

## Requirements

- Node.js 18+
- Backend running on `http://localhost:8000` (or set `NEXT_PUBLIC_API_URL`)

---

## Setup

```bash
npm install
npm run dev
# Open http://localhost:3000
```

### Other commands
```bash
npm run build    # production build — run this to verify no TypeScript errors
npm run lint     # ESLint check
```

---

## Environment

Create `frontend/.env.local`:
```env
NEXT_PUBLIC_API_URL=http://localhost:8000
```

For LAN deployment (e.g., tablet on the same network as the server):
```env
NEXT_PUBLIC_API_URL=http://192.168.1.50:8000
```

---

## Project Structure

```
frontend/
├── app/
│   ├── layout.tsx        ← root HTML shell, Geist font, page title
│   ├── page.tsx          ← Dashboard — the entire UI lives here
│   ├── globals.css       ← Tailwind base imports
│   └── lib/
│       └── api.ts        ← typed fetch wrappers + WebSocket helper
├── public/               ← static assets (empty by default)
├── .env.local            ← NEXT_PUBLIC_API_URL
├── next.config.ts
├── tailwind.config.ts
└── tsconfig.json         ← @/* alias = ./ (frontend root)
```

> **Path alias note:** `@/*` maps to `./` (the `frontend/` root), not `./src/`. All app code is in `app/`, not `src/app/`.

---

## Dashboard Features

### Live Acoustic Monitor
- Animated dB bar gauge updated every 100 ms via WebSocket
- Color: green (safe) → yellow (approaching limit) → red (≥ 99 dB)
- White marker line shows the legal threshold
- RTSP connection status indicator

### Stats Cards
Four summary cards updated on every data refresh:
- **Total Violations** — all-time count
- **Pending** — awaiting enforcer action
- **Cited** — citation issued
- **Avg Noise Level** — mean dB across all violations

### Violation Records Table
Columns: ID · Plate Number · dB Level · Timestamp · Location · Status · Evidence · Action

- **Filter tabs** — All / Pending / Cited / Dismissed
- **Plate number** displayed in monospace badge; shows "Unread" if OCR failed
- **dB Level** colored red if ≥ 99, yellow otherwise
- **Evidence** — "View Photo" opens a lightbox modal with the annotated JPEG
- **Action** — inline `<select>` to change status (pending → cited / dismissed)
- New violations appear instantly via WebSocket push without manual refresh

---

## API Client (`app/lib/api.ts`)

### TypeScript types
```typescript
Violation    { id, plate_number, decibel_level, timestamp, image_path,
               confidence, location, status, notes }
Stats        { total, pending, cited, dismissed, avg_decibel }
SystemStatus { rtsp_connected, current_db, threshold_db, trigger_duration_ms }
```

### Functions
| Function | Description |
|---|---|
| `getViolations(limit?, offset?)` | Fetch paginated violation list |
| `getStats()` | Fetch aggregate statistics |
| `getSystemStatus()` | Fetch RTSP status + live dB |
| `updateViolationStatus(id, status, notes?)` | PATCH a violation record |
| `createWebSocket(onMessage)` | Open WebSocket to `/ws/live`, returns the `WebSocket` instance |

### WebSocket message types
```typescript
{ event: "db_update",     value: number }      // fires every 100 ms
{ event: "new_violation", data: Violation }     // fires on each new record
```

---

## UI Conventions

- **Theme:** dark (`bg-gray-900` base, `bg-gray-800` cards)
- **Icons:** `lucide-react` only
- **No Shadcn** — raw Tailwind components throughout
- **Rounded cards:** `rounded-xl`
- **Status colors:** yellow = pending, red = cited, gray = dismissed
- **Transitions:** `transition` class (150 ms Tailwind default)

---

## WebSocket Reconnection

The dashboard auto-reconnects to the backend WebSocket after 3 seconds if the connection drops. The "Live / Offline" indicator in the header reflects the current connection state.
