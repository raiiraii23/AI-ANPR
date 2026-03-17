const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export interface Violation {
  id: number;
  plate_number: string | null;
  decibel_level: number;
  timestamp: string;
  image_path: string | null;
  confidence: number | null;
  location: string;
  status: "pending" | "cited" | "dismissed";
  notes: string | null;
}

export interface Stats {
  total: number;
  pending: number;
  cited: number;
  dismissed: number;
  avg_decibel: number;
}

export interface SystemStatus {
  rtsp_connected: boolean;
  current_db: number;
  threshold_db: number;
  trigger_duration_ms: number;
}

export async function getViolations(limit = 50, offset = 0): Promise<Violation[]> {
  const res = await fetch(`${API_URL}/api/violations?limit=${limit}&offset=${offset}`);
  if (!res.ok) throw new Error("Failed to fetch violations");
  return res.json();
}

export async function getStats(): Promise<Stats> {
  const res = await fetch(`${API_URL}/api/stats`);
  if (!res.ok) throw new Error("Failed to fetch stats");
  return res.json();
}

export async function getSystemStatus(): Promise<SystemStatus> {
  const res = await fetch(`${API_URL}/api/status`);
  if (!res.ok) throw new Error("Failed to fetch status");
  return res.json();
}

export async function updateViolationStatus(
  id: number,
  status: string,
  notes?: string
): Promise<void> {
  const params = new URLSearchParams({ status });
  if (notes) params.append("notes", notes);
  const res = await fetch(`${API_URL}/api/violations/${id}?${params}`, { method: "PATCH" });
  if (!res.ok) throw new Error("Failed to update violation");
}

export function createWebSocket(onMessage: (data: unknown) => void): WebSocket {
  const wsUrl = API_URL.replace("http", "ws");
  const ws = new WebSocket(`${wsUrl}/ws/live`);
  ws.onmessage = (event) => {
    try {
      onMessage(JSON.parse(event.data));
    } catch {}
  };
  return ws;
}
