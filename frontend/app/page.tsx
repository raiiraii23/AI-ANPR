"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Activity,
  Volume2,
  Camera,
  RefreshCw,
  Wifi,
  WifiOff,
  Bell,
} from "lucide-react";
import {
  getViolations,
  getStats,
  getSystemStatus,
  updateViolationStatus,
  createWebSocket,
  type Violation,
  type Stats,
  type SystemStatus,
} from "./lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const DB_HISTORY_SIZE = 80;

// ─── Sparkline ────────────────────────────────────────────────────────────────
function Sparkline({ data, threshold }: { data: number[]; threshold: number }) {
  const W = 600;
  const H = 56;
  const max = 140;
  if (data.length < 2) return null;

  const pts = data
    .map((v, i) => `${(i / (DB_HISTORY_SIZE - 1)) * W},${H - (v / max) * H}`)
    .join(" ");
  const area = `0,${H} ${pts} ${W},${H}`;
  const thY = H - (threshold / max) * H;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full mt-3"
      style={{ height: 56 }}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* threshold dashed line */}
      <line
        x1="0" y1={thY} x2={W} y2={thY}
        stroke="#ef4444" strokeWidth="1.5" strokeDasharray="6,4" opacity="0.7"
      />
      {/* area fill */}
      <polygon points={area} fill="url(#sparkGrad)" />
      {/* line */}
      <polyline points={pts} fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinejoin="round" />
      {/* live dot */}
      {(() => {
        const last = data[data.length - 1];
        const x = W;
        const y = H - (last / max) * H;
        return (
          <circle cx={x} cy={y} r="3" fill="#3b82f6">
            <animate attributeName="r" values="3;5;3" dur="1s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="1;0.4;1" dur="1s" repeatCount="indefinite" />
          </circle>
        );
      })()}
    </svg>
  );
}

// ─── DbMeter ──────────────────────────────────────────────────────────────────
function DbMeter({
  value,
  threshold = 99,
  history,
  peakDb,
}: {
  value: number;
  threshold?: number;
  history: number[];
  peakDb: number;
}) {
  const pct = Math.min(100, (value / 140) * 100);
  const peakPct = Math.min(100, (peakDb / 140) * 100);
  const isAlert = value >= threshold;
  const isWarn = value >= threshold * 0.85;

  const barColor = isAlert ? "bg-red-500" : isWarn ? "bg-yellow-400" : "bg-green-500";
  const textColor = isAlert ? "text-red-400" : isWarn ? "text-yellow-300" : "text-green-400";

  return (
    <div className="flex flex-col gap-3">
      {/* Large live value */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className={`text-6xl font-bold font-mono tabular-nums leading-none transition-colors duration-150 ${textColor}`}>
            {value.toFixed(1)}
            <span className="text-2xl ml-2 text-gray-400 font-normal">dB</span>
          </div>
          {isAlert ? (
            <div className="flex items-center gap-1.5 mt-2">
              <AlertTriangle className="w-4 h-4 text-red-400 animate-bounce" />
              <span className="text-red-400 text-sm font-bold tracking-wide animate-pulse">
                EXCEEDS LEGAL LIMIT
              </span>
            </div>
          ) : (
            <div className="mt-2 text-gray-500 text-sm">
              {isWarn ? "Approaching threshold" : "Within safe range"}
            </div>
          )}
        </div>
        <div className="text-right text-xs text-gray-500 space-y-1 flex-shrink-0">
          <div className="text-gray-400">
            Peak: <span className="text-white font-mono">{peakDb.toFixed(1)} dB</span>
          </div>
          <div>
            Limit: <span className="text-red-400 font-mono">{threshold} dB</span>
          </div>
          <div className="text-gray-600">LTO AO 2006-003</div>
        </div>
      </div>

      {/* Bar track */}
      <div className="relative h-6 bg-gray-700/80 rounded-full overflow-visible">
        {/* Fill */}
        <div
          className={`absolute top-0 left-0 h-full rounded-full transition-all duration-100 ${barColor} ${isAlert ? "shadow-[0_0_12px_rgba(239,68,68,0.6)]" : ""}`}
          style={{ width: `${pct}%` }}
        />
        {/* Peak hold tick */}
        {peakDb > 0 && (
          <div
            className="absolute top-0 h-full w-0.5 bg-white/80"
            style={{ left: `${peakPct}%` }}
          />
        )}
        {/* Threshold tick */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-red-400/80"
          style={{ left: `${(threshold / 140) * 100}%` }}
        />
      </div>

      {/* Scale */}
      <div className="flex justify-between text-xs text-gray-600 px-0.5">
        {[0, 20, 40, 60, 80, 100, 120, 140].map((v) => (
          <span key={v}>{v}</span>
        ))}
      </div>

      {/* Sparkline history */}
      <Sparkline data={history} threshold={threshold} />
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
  const [stats, setStats] = useState<Stats | null>(null);
  const [sysStatus, setSysStatus] = useState<SystemStatus | null>(null);
  const [liveDb, setLiveDb] = useState(0);
  const [dbHistory, setDbHistory] = useState<number[]>(Array(DB_HISTORY_SIZE).fill(0));
  const [peakDb, setPeakDb] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [newIds, setNewIds] = useState<Set<number>>(new Set());
  const [clock, setClock] = useState(new Date());
  const wsRef = useRef<WebSocket | null>(null);
  const toastIdRef = useRef(0);
  const peakDecayRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live clock
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [v, s, sys] = await Promise.all([getViolations(), getStats(), getSystemStatus()]);
      setViolations(v);
      setStats(s);
      setSysStatus(sys);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    loadData();

    let ws: WebSocket;
    const connect = () => {
      try {
        ws = createWebSocket((data: unknown) => {
          const msg = data as { event: string; value?: number; data?: Violation };
          if (msg.event === "db_update" && msg.value !== undefined) {
            const val = msg.value as number;
            setLiveDb(val);
            setDbHistory((prev) => [...prev.slice(1), val]);
            // Peak hold with 5 s decay
            setPeakDb((prev) => {
              if (val >= prev) {
                if (peakDecayRef.current) clearTimeout(peakDecayRef.current);
                peakDecayRef.current = setTimeout(() => setPeakDb(0), 5000);
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
            <div className="text-right hidden sm:block">
              <p className="text-white font-mono text-sm font-semibold tabular-nums">
                {clock.toLocaleTimeString("en-PH")}
              </p>
              <p className="text-gray-500 text-xs">
                {clock.toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" })}
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
          <DbMeter value={liveDb} threshold={threshold} history={dbHistory} peakDb={peakDb} />
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
                <Volume2 className="w-12 h-12 mx-auto mb-3 opacity-20" />
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
                            {new Date(v.timestamp).toLocaleString("en-PH")}
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
