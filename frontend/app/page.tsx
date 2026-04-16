"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Activity,
  Camera,
  RefreshCw,
  WifiOff,
  Bell,
} from "lucide-react";
import {
  getViolations,
  getDetections,
  resetDetections,
  getStats,
  getSystemStatus,
  updateViolationStatus,
  createWebSocket,
  type Violation,
  type Detection,
  type Stats,
  type SystemStatus,
} from "./lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const PH_TZ = "Asia/Manila";
const MAX_DB_KEY = "anpr.maxDb";
const MONITOR_BARS = 96; // ~9.6s of history at 10 Hz

// Visualizer dB band — narrow window for high sensitivity to small changes.
// Anything below DB_FLOOR is silence; above DB_CEIL is clipped to full bar.
const DB_FLOOR = 40;
const DB_CEIL = 110;
const dbToPct = (v: number) =>
  Math.max(0, Math.min(100, ((v - DB_FLOOR) / (DB_CEIL - DB_FLOOR)) * 100));

// ─── LiveMonitor ──────────────────────────────────────────────────────────────
function LiveMonitor({ history, threshold }: { history: number[]; threshold: number }) {
  const thresholdTopPct = 100 - dbToPct(threshold);
  return (
    <div className="relative h-28 bg-black/40 border border-gray-800 rounded-lg overflow-hidden px-2 py-2">
      {/* Threshold guide line */}
      <div
        className="absolute left-0 right-0 border-t border-dashed border-red-500/50 pointer-events-none"
        style={{ top: `${thresholdTopPct}%` }}
      />
      <div
        className="absolute left-2 text-[10px] text-red-400/70 font-mono pointer-events-none"
        style={{ top: `calc(${thresholdTopPct}% - 12px)` }}
      >
        {threshold} dB
      </div>

      <div className="relative h-full w-full flex items-end justify-between gap-[2px]">
        {history.map((v, i) => {
          const h = Math.max(2, dbToPct(v));
          const isAlert = v >= threshold;
          const isWarn = v >= threshold * 0.85;
          const color = isAlert
            ? "bg-red-500"
            : isWarn
            ? "bg-yellow-400"
            : "bg-green-500";
          const isLatest = i === history.length - 1;
          return (
            <div
              key={i}
              className={`flex-1 rounded-[2px] ${color} transition-all duration-75 ease-out`}
              style={{
                height: `${h}%`,
                opacity: 0.35 + (i / history.length) * 0.65,
                boxShadow: isLatest
                  ? `0 0 10px ${
                      isAlert
                        ? "rgba(239,68,68,0.9)"
                        : isWarn
                        ? "rgba(250,204,21,0.8)"
                        : "rgba(34,197,94,0.7)"
                    }`
                  : undefined,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

// ─── DbMeter ──────────────────────────────────────────────────────────────────
function DbMeter({
  value,
  threshold = 99,
  maxRecorded,
  history,
}: {
  value: number;
  threshold?: number;
  maxRecorded: number;
  history: number[];
}) {
  const isAlert = value >= threshold;
  const isWarn = value >= threshold * 0.85;

  const textColor = isAlert ? "text-red-400" : isWarn ? "text-yellow-300" : "text-green-400";
  const ringColor = isAlert ? "bg-red-500/40" : isWarn ? "bg-yellow-400/30" : "bg-green-500/25";
  const dotColor = isAlert ? "bg-red-500" : isWarn ? "bg-yellow-400" : "bg-green-500";
  const glowColor = isAlert
    ? "rgba(239,68,68,0.9)"
    : isWarn
    ? "rgba(250,204,21,0.7)"
    : "rgba(34,197,94,0.8)";

  // Pulse intensity — scales across the visualizer band so quiet variations
  // still produce visible motion.
  const pulse = Math.max(0, Math.min(1, (value - DB_FLOOR) / (threshold - DB_FLOOR)));
  const ringScale = 1 + pulse * 0.5;
  const ringOpacity = 0.35 + pulse * 0.55;

  const maxIsAlert = maxRecorded >= threshold;
  const maxColor = maxIsAlert
    ? "text-red-400"
    : maxRecorded >= threshold * 0.85
    ? "text-yellow-300"
    : "text-green-400";

  const top = (
    <div className="flex flex-col md:flex-row items-stretch gap-6">
      {/* Live meter — big pulsing dB */}
      <div className="flex-1 flex items-center gap-6">
        <div className="relative w-28 h-28 flex items-center justify-center flex-shrink-0">
          <div
            className={`absolute inset-0 rounded-full ${ringColor} transition-all duration-100 ease-out`}
            style={{
              transform: `scale(${ringScale})`,
              opacity: ringOpacity,
              filter: `blur(${6 + pulse * 12}px)`,
            }}
          />
          <div
            className={`absolute inset-3 rounded-full ${ringColor} transition-all duration-100 ease-out`}
            style={{ transform: `scale(${1 + pulse * 0.2})`, opacity: 0.55 }}
          />
          <div
            className={`relative w-9 h-9 rounded-full ${dotColor} transition-colors duration-150`}
            style={{ boxShadow: `0 0 ${10 + pulse * 28}px ${glowColor}` }}
          />
        </div>
        <div>
          <div
            className={`text-7xl font-bold font-mono tabular-nums leading-none transition-colors duration-150 ${textColor}`}
            style={{ textShadow: `0 0 ${12 + pulse * 20}px ${glowColor}` }}
          >
            {value.toFixed(1)}
            <span className="text-2xl ml-2 text-gray-400 font-normal">dB</span>
          </div>
          {isAlert ? (
            <div className="flex items-center gap-1.5 mt-3">
              <AlertTriangle className="w-4 h-4 text-red-400 animate-bounce" />
              <span className="text-red-400 text-sm font-bold tracking-wide animate-pulse">
                EXCEEDS LEGAL LIMIT
              </span>
            </div>
          ) : (
            <div className="mt-3 text-sm">
              <span className={isWarn ? "text-yellow-300" : "text-green-400"}>
                {isWarn ? "Approaching threshold" : "Within safe range"}
              </span>
              <span className="text-gray-500 ml-2">
                · Limit <span className="text-red-400 font-mono">{threshold} dB</span>
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Highest recorded */}
      <div className="md:w-64 bg-gray-900/60 border border-gray-700 rounded-xl p-5 flex flex-col justify-center">
        <div className="flex items-center gap-2 text-xs text-gray-500 uppercase tracking-wider">
          <AlertTriangle className="w-3.5 h-3.5" />
          Highest dB Record
        </div>
        <div className={`text-5xl font-bold font-mono tabular-nums leading-none mt-2 ${maxColor}`}>
          {maxRecorded.toFixed(1)}
          <span className="text-xl ml-2 text-gray-500 font-normal">dB</span>
        </div>
        <div className="text-xs text-gray-500 mt-2">
          {maxIsAlert ? "Violation threshold breached" : "Session peak"}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      {top}
      <LiveMonitor history={history} threshold={threshold} />
    </div>
  );
}

// ─── StatusBadge ──────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: "bg-yellow-500/20 text-yellow-300 border border-yellow-500/30",
    cited: "bg-red-500/20 text-red-300 border border-red-500/30",
    dismissed: "bg-gray-500/20 text-gray-300 border border-gray-500/30",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] || styles.pending}`}>
      {status}
    </span>
  );
}

// ─── StatCard ─────────────────────────────────────────────────────────────────
function StatCard({
  label,
  value,
  icon: Icon,
  color,
  sub,
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  color: string;
  sub?: string;
}) {
  return (
    <div className="bg-gray-800 border border-gray-700 hover:border-gray-500 rounded-xl p-5 flex items-center gap-4 transition-colors duration-200">
      <div className={`p-3 rounded-lg ${color}`}>
        <Icon className="w-6 h-6" />
      </div>
      <div>
        <p className="text-gray-400 text-sm">{label}</p>
        <p className="text-white text-2xl font-bold tabular-nums">{value}</p>
        {sub && <p className="text-gray-500 text-xs mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────
interface ToastEntry {
  id: number;
  violation: Violation;
}

function ViolationToast({
  toast,
  onDismiss,
}: {
  toast: ToastEntry;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div className="animate-slide-in bg-red-950/95 border border-red-500/60 rounded-xl p-4 shadow-2xl backdrop-blur-sm flex items-start gap-3 w-80">
      <div className="bg-red-500/20 p-2 rounded-lg flex-shrink-0 mt-0.5">
        <AlertTriangle className="w-5 h-5 text-red-400 animate-bounce" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-red-300 text-sm">Violation Detected</p>
        <p className="text-white font-mono font-bold text-lg leading-none mt-1">
          {toast.violation.plate_number || "UNREAD"}
        </p>
        <p className="text-red-300/80 text-xs mt-1">
          {toast.violation.decibel_level.toFixed(1)} dB · {toast.violation.location}
        </p>
      </div>
      <button onClick={onDismiss} className="text-red-400/60 hover:text-white transition flex-shrink-0">
        <XCircle className="w-4 h-4" />
      </button>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [violations, setViolations] = useState<Violation[]>([]);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [sysStatus, setSysStatus] = useState<SystemStatus | null>(null);
  const [liveDb, setLiveDb] = useState(0);
  const [maxDb, setMaxDb] = useState(0);
  const [dbHistory, setDbHistory] = useState<number[]>(Array(MONITOR_BARS).fill(0));
  const [wsConnected, setWsConnected] = useState(false);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [newIds, setNewIds] = useState<Set<number>>(new Set());
  const [clock, setClock] = useState<Date | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const toastIdRef = useRef(0);

  // Live clock
  useEffect(() => {
    setClock(new Date());
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Restore persisted highest dB on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(MAX_DB_KEY);
      if (raw) {
        const n = parseFloat(raw);
        if (!Number.isNaN(n)) setMaxDb(n);
      }
    } catch {}
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [v, d, s, sys] = await Promise.all([
        getViolations(),
        getDetections(),
        getStats(),
        getSystemStatus(),
      ]);
      setViolations(v);
      setDetections(d);
      setStats(s);
      setSysStatus(sys);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleResetDetections = useCallback(async () => {
    try {
      await resetDetections();
      setDetections([]);
      loadData();
    } catch (e) {
      console.error(e);
    }
  }, [loadData]);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    loadData();

    let ws: WebSocket;
    const connect = () => {
      try {
        ws = createWebSocket((data: unknown) => {
          const msg = data as { event: string; value?: number; data?: Violation | Detection };
          if (msg.event === "db_update" && msg.value !== undefined) {
            const val = msg.value as number;
            setLiveDb(val);
            setDbHistory((prev) => [...prev.slice(1), val]);
            setMaxDb((prev) => {
              if (val > prev) {
                try {
                  localStorage.setItem(MAX_DB_KEY, String(val));
                } catch {}
                return val;
              }
              return prev;
            });
          } else if (msg.event === "new_violation" && msg.data) {
            const v = msg.data as Violation;
            setViolations((prev) => [v, ...prev]);
            setNewIds((prev) => new Set([...prev, v.id]));
            setTimeout(() => {
              setNewIds((prev) => {
                const next = new Set(prev);
                next.delete(v.id);
                return next;
              });
            }, 5000);
            const id = ++toastIdRef.current;
            setToasts((prev) => [...prev, { id, violation: v }]);
            loadData();
          } else if (msg.event === "new_detection" && msg.data) {
            const d = msg.data as unknown as Detection;
            setDetections((prev) => [d, ...prev].slice(0, 100));
          }
        });
        ws.onopen = () => setWsConnected(true);
        ws.onclose = () => {
          setWsConnected(false);
          setTimeout(connect, 3000);
        };
        ws.onerror = () => ws.close();
        wsRef.current = ws;
      } catch {}
    };
    connect();
    return () => wsRef.current?.close();
  }, [loadData]);

  const handleStatusChange = async (id: number, status: string) => {
    await updateViolationStatus(id, status);
    setViolations((prev) =>
      prev.map((v) => (v.id === id ? { ...v, status: status as Violation["status"] } : v))
    );
    loadData();
  };

  const threshold = sysStatus?.threshold_db || 99;
  const isAlert = liveDb >= threshold;
  const filtered = filterStatus === "all" ? violations : violations.filter((v) => v.status === filterStatus);

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* ── Header ── */}
      <header className="border-b border-gray-800 bg-gray-900/95 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2 rounded-lg">
              <Camera className="w-5 h-5" />
            </div>
            <div>
              <h1 className="font-bold text-lg leading-none">ANPR Noise Enforcement</h1>
              <p className="text-gray-400 text-xs mt-0.5">Motorcycle Traffic Monitoring System</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Live clock */}
            <div className="text-right hidden sm:block min-w-[120px]">
              <p className="text-white font-mono text-sm font-semibold tabular-nums">
                {clock ? clock.toLocaleTimeString("en-PH", { timeZone: PH_TZ, hour12: true }) : "--:--:-- --"}
              </p>
              <p className="text-gray-500 text-xs">
                {clock ? `${clock.toLocaleDateString("en-PH", { timeZone: PH_TZ, weekday: "short", month: "short", day: "numeric" })} · PHT` : "Loading..."}
              </p>
            </div>
            <div className="h-6 w-px bg-gray-700 hidden sm:block" />

            {/* WS indicator */}
            {wsConnected ? (
              <span className="flex items-center gap-2 text-green-400 text-sm font-medium">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
                </span>
                LIVE
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-red-400 text-sm">
                <WifiOff className="w-4 h-4" />
                Offline
              </span>
            )}

            <button
              onClick={loadData}
              className="flex items-center gap-1.5 bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded-lg text-sm transition"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8 space-y-8">
        {/* ── Live Feed + Detection Log ── */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 bg-black border border-gray-700 rounded-xl overflow-hidden relative">
            <div className="flex items-center justify-between px-4 py-2 bg-gray-900/80 border-b border-gray-700">
              <h2 className="font-semibold flex items-center gap-2 text-sm">
                <Camera className="w-4 h-4 text-green-400" />
                Live Detection Feed
              </h2>
              <span className="text-xs text-gray-400">
                Unique vehicles: <span className="text-white font-mono">{sysStatus?.unique_vehicles ?? 0}</span>
              </span>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`${API_URL}/api/video_feed`}
              alt="Live detection feed"
              className="w-full aspect-video object-contain bg-black"
            />
          </div>
          <div className="bg-gray-800 border border-gray-700 rounded-xl flex flex-col min-h-[320px]">
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700">
              <h2 className="font-semibold flex items-center gap-2 text-sm">
                <Activity className="w-4 h-4 text-green-400" />
                Detection Log
                <span className="bg-green-600/20 text-green-300 text-[10px] px-2 py-0.5 rounded-full tabular-nums">
                  {detections.length}
                </span>
              </h2>
              <button
                onClick={handleResetDetections}
                className="text-xs bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded transition"
                title="Clear the dedup cache so vehicles can be re-logged"
              >
                Reset
              </button>
            </div>
            <div className="flex-1 overflow-y-auto max-h-[420px]">
              {detections.length === 0 ? (
                <div className="text-center py-10 text-gray-500 text-sm">
                  Waiting for detections…
                </div>
              ) : (
                <ul className="divide-y divide-gray-700/50">
                  {detections.map((d) => (
                    <li
                      key={d.id}
                      className="px-4 py-2.5 flex items-center gap-3 hover:bg-gray-700/30 transition"
                    >
                      <div className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm text-white capitalize">
                            {d.class_name}
                          </span>
                          <span className="text-[10px] text-gray-500 font-mono">
                            #{d.track_id}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 tabular-nums">
                          {new Date(d.timestamp).toLocaleTimeString("en-PH", { timeZone: PH_TZ, hour12: true })}
                          <span className="ml-2 text-gray-600">
                            conf {(d.confidence * 100).toFixed(0)}%
                          </span>
                        </div>
                      </div>
                      {d.image_path && (
                        <button
                          onClick={() =>
                            setSelectedImage(
                              `${API_URL}/${d.image_path?.replace(/^\.\//, "")}`
                            )
                          }
                          className="text-blue-400 hover:text-blue-300 text-xs"
                        >
                          <Camera className="w-3 h-3" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>

        {/* ── Live Monitor ── */}
        <section
          className={`border rounded-xl p-6 transition-all duration-500 ${
            isAlert
              ? "bg-red-950/40 border-red-700/60 shadow-[0_0_40px_rgba(239,68,68,0.12)]"
              : "bg-gray-800 border-gray-700"
          }`}
        >
          <div className="flex items-center justify-between mb-6">
            <h2 className="font-semibold flex items-center gap-2 text-base">
              <Activity
                className={`w-4 h-4 ${isAlert ? "text-red-400 animate-pulse" : "text-blue-400"}`}
              />
              Live Acoustic Monitor
            </h2>
            <div className="flex items-center gap-2 text-sm">
              <span
                className={`w-2 h-2 rounded-full ${
                  sysStatus?.rtsp_connected ? "bg-green-400 animate-pulse" : "bg-red-400"
                }`}
              />
              <span className="text-gray-400">
                Camera: {sysStatus?.rtsp_connected ? "Connected" : "Disconnected"}
              </span>
            </div>
          </div>
          <DbMeter value={liveDb} threshold={threshold} maxRecorded={maxDb} history={dbHistory} />
        </section>

        {/* ── Stats ── */}
        {stats && (
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Total Violations"
              value={stats.total}
              icon={AlertTriangle}
              color="bg-blue-600/20 text-blue-400"
            />
            <StatCard
              label="Pending"
              value={stats.pending}
              icon={Bell}
              color="bg-yellow-600/20 text-yellow-400"
              sub="Awaiting action"
            />
            <StatCard
              label="Cited"
              value={stats.cited}
              icon={CheckCircle2}
              color="bg-red-600/20 text-red-400"
              sub="Citation issued"
            />
            <StatCard
              label="Avg Noise Level"
              value={`${(stats.avg_decibel ?? 0).toFixed(1)} dB`}
              icon={Activity}
              color="bg-purple-600/20 text-purple-400"
              sub="All violations"
            />
          </section>
        )}

        {/* ── Violations Table ── */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-lg flex items-center gap-2">
              Violation Records
              {stats && stats.total > 0 && (
                <span className="bg-blue-600 text-white text-xs px-2 py-0.5 rounded-full tabular-nums">
                  {stats.total}
                </span>
              )}
            </h2>
            <div className="flex gap-2">
              {["all", "pending", "cited", "dismissed"].map((s) => (
                <button
                  key={s}
                  onClick={() => setFilterStatus(s)}
                  className={`px-3 py-1 rounded-lg text-sm capitalize transition ${
                    filterStatus === s
                      ? "bg-blue-600 text-white"
                      : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
            {loading ? (
              <div className="text-center py-16 text-gray-400 flex flex-col items-center gap-3">
                <Activity className="w-8 h-8 animate-spin opacity-40" />
                <span>Loading violations…</span>
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-16 text-gray-500">
                <AlertTriangle className="w-12 h-12 mx-auto mb-3 opacity-20" />
                <p>No violations recorded yet.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-700 text-gray-400 text-left">
                      <th className="px-4 py-3 font-medium">ID</th>
                      <th className="px-4 py-3 font-medium">Plate</th>
                      <th className="px-4 py-3 font-medium">dB Level</th>
                      <th className="px-4 py-3 font-medium">Timestamp</th>
                      <th className="px-4 py-3 font-medium">Location</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium">Evidence</th>
                      <th className="px-4 py-3 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((v, i) => {
                      const isNew = newIds.has(v.id);
                      return (
                        <tr
                          key={v.id}
                          className={`border-b border-gray-700/50 transition-colors duration-300 ${
                            isNew
                              ? "animate-fade-new"
                              : i % 2 === 0
                              ? "hover:bg-gray-700/30"
                              : "bg-gray-800/50 hover:bg-gray-700/30"
                          }`}
                        >
                          <td className="px-4 py-3 text-gray-400">
                            <div className="flex items-center gap-2">
                              <span>#{v.id}</span>
                              {isNew && (
                                <span className="bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded font-bold animate-pulse leading-none">
                                  NEW
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            {v.plate_number ? (
                              <span className="font-mono font-bold text-white bg-gray-700 px-2 py-0.5 rounded tracking-widest">
                                {v.plate_number}
                              </span>
                            ) : (
                              <span className="text-gray-500 italic text-xs">Unread</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`font-semibold font-mono ${
                                v.decibel_level >= threshold ? "text-red-400" : "text-yellow-400"
                              }`}
                            >
                              {v.decibel_level.toFixed(1)} dB
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-400 tabular-nums text-xs">
                            {new Date(v.timestamp).toLocaleString("en-PH", { timeZone: PH_TZ })}
                          </td>
                          <td className="px-4 py-3 text-gray-300">{v.location}</td>
                          <td className="px-4 py-3">
                            <StatusBadge status={v.status} />
                          </td>
                          <td className="px-4 py-3">
                            {v.image_path ? (
                              <button
                                onClick={() =>
                                  setSelectedImage(
                                    `${API_URL}/${v.image_path?.replace(/^\.\//, "")}`
                                  )
                                }
                                className="flex items-center gap-1 text-blue-400 hover:text-blue-300 text-xs transition"
                              >
                                <Camera className="w-3 h-3" />
                                View
                              </button>
                            ) : (
                              <span className="text-gray-600 text-xs">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <select
                              value={v.status}
                              onChange={(e) => handleStatusChange(v.id, e.target.value)}
                              className="bg-gray-700 border border-gray-600 rounded text-xs text-white px-2 py-1 cursor-pointer hover:bg-gray-600 transition"
                            >
                              <option value="pending">Pending</option>
                              <option value="cited">Cited</option>
                              <option value="dismissed">Dismissed</option>
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </main>

      {/* ── Toast stack ── */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-3 items-end">
        {toasts.map((toast) => (
          <ViolationToast key={toast.id} toast={toast} onDismiss={() => dismissToast(toast.id)} />
        ))}
      </div>

      {/* ── Lightbox ── */}
      {selectedImage && (
        <div
          className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => setSelectedImage(null)}
        >
          <div
            className="relative max-w-3xl w-full bg-gray-800 rounded-xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
              <span className="font-medium text-sm flex items-center gap-2">
                <Camera className="w-4 h-4 text-blue-400" />
                Violation Evidence Photo
              </span>
              <button
                onClick={() => setSelectedImage(null)}
                className="text-gray-400 hover:text-white transition"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={selectedImage}
              alt="Violation evidence"
              className="w-full object-contain max-h-[70vh]"
            />
          </div>
        </div>
      )}
    </div>
  );
}
