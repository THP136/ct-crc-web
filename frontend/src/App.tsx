import { useEffect, useRef, useState } from "react";
import {
  fetchCurrentPrice,
  fetchLivePrices,
  fetchSettings,
  saveSettings,
  fetchSummary,
  fetchSections,
  createSection,
  fetchSectionInfo,
  deleteSection,
  priceBroadcast,
  deleteEngine,
  fetchPriceHistory,
  fetchValidX0,
  fetchWorkerStatus,
  deleteTask,
  deleteAllBuyTasks,
  type WorkerStatus,
  type TaskQueueItem,
  type PassedTaskItem,
  type ClosedTaskItem,
  type LivePrices,
  type SettingsItem,
  type SettingsPayload,
  type SummarySymbol,
  type SummaryRow,
  type Section,
  type PriceHistoryItem,
  type ValidX0Response,
  type ValidX0Item,
} from "./api";
import "./App.css";

function formatPrice(price: number): string {
  return price.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

type SettingsFieldKey = keyof SettingsPayload;
type SettingsEdit = Record<SettingsFieldKey, string>;

type SettingsField = {
  key: SettingsFieldKey;
  label: string;
  tip: string;
  group: string;
  kind: "qty" | "negative" | "positive";
};

const SETTINGS_GROUP_ORDER = [
  "Quantity %",
  "Spawn offsets %",
  "Section & buy rules",
];

const SETTINGS_FIELDS: SettingsField[] = [
  {
    key: "sell_down_pct",
    label: "SELL DOWN qty %",
    group: "Quantity %",
    kind: "qty",
    tip: "% khối lượng coin của section dùng để bán khi SELL DOWN fill. Không phải offset giá.",
  },
  {
    key: "sell_up_pct",
    label: "SELL UP qty %",
    group: "Quantity %",
    kind: "qty",
    tip: "% khối lượng coin dùng để bán khi SELL UP fill. Không phải offset giá.",
  },
  {
    key: "sell_down_offset_pct",
    label: "SELL DOWN offset %",
    group: "Spawn offsets %",
    kind: "negative",
    tip: "Offset target SELL DOWN. Phải âm. Ví dụ -2 → thấp hơn base 2%.",
  },
  {
    key: "sell_up_offset_pct",
    label: "SELL UP offset %",
    group: "Spawn offsets %",
    kind: "positive",
    tip: "Offset target SELL UP. Phải dương. Ví dụ +2 → cao hơn base 2%.",
  },
  {
    key: "buy_after_sell_down_offset_pct",
    label: "BUY after SELL DOWN %",
    group: "Spawn offsets %",
    kind: "negative",
    tip: "Offset BUY sau SELL DOWN fill. Phải âm. Ví dụ -2.",
  },
  {
    key: "buy_after_sell_up_offset_pct",
    label: "BUY after SELL UP %",
    group: "Spawn offsets %",
    kind: "negative",
    tip: "Offset BUY sau SELL UP fill. Phải âm. Ví dụ -2.",
  },
  {
    key: "supplement_sell_up_offset_pct",
    label: "Supplement SELL UP %",
    group: "Spawn offsets %",
    kind: "positive",
    tip: "Offset SELL UP bổ sung khi chưa có SELL UP. Phải dương.",
  },
  {
    key: "grid_step_pct",
    label: "Grid step %",
    group: "Section & buy rules",
    kind: "positive",
    tip: "Bước lưới x0: x0 = base × (1 + n×step%), n≠0. Chỉ ảnh hưởng section mới.",
  },
  {
    key: "buy_cancel_distance_pct",
    label: "BUY cancel distance %",
    group: "Section & buy rules",
    kind: "positive",
    tip: "Huỷ BUY nếu current > target × (1 + x%). Ví dụ 35.",
  },
];

function settingsToEdit(settings: SettingsItem): SettingsEdit {
  const edit = {} as SettingsEdit;
  for (const field of SETTINGS_FIELDS) {
    edit[field.key] = String(settings[field.key]);
  }
  return edit;
}

function validateSetting(field: SettingsField, raw: string): string | null {
  const value = Number(raw);
  if (!raw.trim() || Number.isNaN(value) || !Number.isFinite(value)) {
    return `${field.label} must be a number`;
  }
  if (field.kind === "qty" && !(value > 0 && value <= 100)) {
    return `${field.label} must be > 0 and <= 100`;
  }
  if (field.kind === "negative" && value >= 0) {
    return `${field.label} must be < 0`;
  }
  if (field.kind === "positive" && value <= 0) {
    return `${field.label} must be > 0`;
  }
  return null;
}

function InfoTip({ text }: { text: string }) {
  return (
    <span className="info-tip" tabIndex={0} aria-label={text}>
      ?
      <span className="info-tip-text">{text}</span>
    </span>
  );
}

function App() {
  const [page, setPage] = useState<
    "engine" | "price" | "settings" | "summary"
  >("engine");
  const [toast, setToast] = useState(false);

  // Current price
  const [priceSymbol, setPriceSymbol] = useState("");
  const [priceResult, setPriceResult] = useState<
    { symbol: string; price: number } | { error: string } | null
  >(null);
  const [priceLoading, setPriceLoading] = useState(false);

  // Sections
  const [allSections, setAllSections] = useState<Section[]>([]);
  const [engineSymbols, setEngineSymbols] = useState<string[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState("");
  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(
    null
  );
  const [sectionUpTasks, setSectionUpTasks] = useState<TaskQueueItem[]>([]);
  const [sectionDownTasks, setSectionDownTasks] = useState<TaskQueueItem[]>([]);
  const [sectionPassedTasks, setSectionPassedTasks] = useState<
    PassedTaskItem[]
  >([]);
  const [sectionClosedTasks, setSectionClosedTasks] = useState<
    ClosedTaskItem[]
  >([]);

  // Create section form
  const [newSectionSymbol, setNewSectionSymbol] = useState("");
  const [newSectionName, setNewSectionName] = useState("");
  const [newSectionX0, setNewSectionX0] = useState("");
  const [newSectionQty, setNewSectionQty] = useState("");

  // Valid x0 hint (for create section form)
  const [validX0, setValidX0] = useState<ValidX0Response | null>(null);
  const [createError, setCreateError] = useState<{
    msg: string;
    nearestPrices: ValidX0Item[];
    firstSectionName: string;
  } | null>(null);
  const validX0TimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Price broadcast
  const [broadcastPrice, setBroadcastPrice] = useState("");
  const [engineMessage, setEngineMessage] = useState("");

  const [loading, setLoading] = useState(true);

  // Live prices
  const [livePrices, setLivePrices] = useState<LivePrices>({});

  // Price history
  const [priceHistory, setPriceHistory] = useState<PriceHistoryItem[]>([]);

  // Settings
  const [settingsList, setSettingsList] = useState<SettingsItem[]>([]);
  const [settingsEdits, setSettingsEdits] = useState<
    Record<string, SettingsEdit>
  >({});
  const [settingsMessage, setSettingsMessage] = useState("");

  // Summary
  const [summaryData, setSummaryData] = useState<SummarySymbol[]>([]);
  const [summaryMessage, setSummaryMessage] = useState("");

  // Worker heartbeat
  const [workerStatus, setWorkerStatus] = useState<{
    online: boolean;
    workers: WorkerStatus[];
  } | null>(null);

  const loadAllSections = async () => {
    const secs = await fetchSections();
    setAllSections(secs);
    const syms = [...new Set(secs.map((s) => s.symbol))].sort();
    setEngineSymbols(syms);
    return { secs, syms };
  };

  const loadSectionInfo = (sectionId: number | null) => {
    if (!sectionId) {
      setSectionUpTasks([]);
      setSectionDownTasks([]);
      setSectionPassedTasks([]);
      setSectionClosedTasks([]);
      return;
    }
    fetchSectionInfo(sectionId).then((info) => {
      setSectionUpTasks(info.up_tasks ?? []);
      setSectionDownTasks(info.down_tasks ?? []);
      setSectionPassedTasks(info.passed_tasks ?? []);
      setSectionClosedTasks(info.closed_tasks ?? []);
    });
  };


  useEffect(() => {
    loadAllSections().then(({ secs, syms }) => {
      if (!selectedSymbol && syms.length > 0) {
        setSelectedSymbol(syms[0]);
        const first = secs.find((s) => s.symbol === syms[0]);
        if (first) setSelectedSectionId(first.id);
      }
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (page === "engine") loadAllSections();
  }, [page]);

  useEffect(() => {
    if (selectedSectionId) {
      loadSectionInfo(selectedSectionId);
      const sec = allSections.find((s) => s.id === selectedSectionId);
      if (sec) {
        fetchPriceHistory(sec.symbol, 15).then(setPriceHistory);
      }
    }
  }, [selectedSectionId]);

  // Poll worker heartbeat
  useEffect(() => {
    const poll = () =>
      fetchWorkerStatus()
        .then(setWorkerStatus)
        .catch(() => setWorkerStatus(null));
    poll();
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }, []);

  // Poll live prices
  useEffect(() => {
    if (page !== "engine") return;
    const poll = () =>
      fetchLivePrices()
        .then(setLivePrices)
        .catch(() => {});
    poll();
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }, [page]);

  // Settings
  useEffect(() => {
    if (page !== "settings") return;
    fetchSettings().then((items) => {
      setSettingsList(items);
      const edits: Record<string, SettingsEdit> = {};
      for (const s of items) {
        edits[s.symbol] = settingsToEdit(s);
      }
      setSettingsEdits(edits);
    });
  }, [page]);

  // Summary
  useEffect(() => {
    if (page !== "summary") return;
    setSummaryMessage("");
    fetchSummary().then(setSummaryData);
  }, [page]);

  // Debounced auto-fetch valid x0 when symbol input changes in Create Section form
  useEffect(() => {
    setValidX0(null);
    setCreateError(null);
    if (validX0TimerRef.current) clearTimeout(validX0TimerRef.current);
    const sym = newSectionSymbol.trim().toUpperCase();
    if (!sym) return;
    validX0TimerRef.current = setTimeout(() => {
      fetchValidX0(sym)
        .then(setValidX0)
        .catch(() => setValidX0(null));
    }, 500);
    return () => {
      if (validX0TimerRef.current) clearTimeout(validX0TimerRef.current);
    };
  }, [newSectionSymbol]);

  const selectedSection = allSections.find(
    (s) => s.id === selectedSectionId
  );
  const symbolSections = allSections.filter(
    (s) => s.symbol === selectedSymbol
  );

  // Handlers
  const handleCreateSection = async () => {
    const sym = newSectionSymbol.trim().toUpperCase();
    const name = newSectionName.trim();
    const x0 = parseFloat(newSectionX0.replace(/,/g, "").trim());
    if (!sym || !name || isNaN(x0) || x0 <= 0) return;
    const qty = parseFloat(newSectionQty.replace(/,/g, "").trim()) || 0;
    setCreateError(null);
    setEngineMessage(`Queued create_section for ${sym}…`);
    const result = await createSection(sym, name, x0, qty);
    if (result.error) {
      if (result.nearest_prices && result.nearest_prices.length > 0) {
        setCreateError({
          msg: result.error,
          nearestPrices: result.nearest_prices,
          firstSectionName: result.first_section_name ?? "",
        });
      } else {
        setEngineMessage(result.error);
      }
    } else {
      setCreateError(null);
      setEngineMessage(
        `Created section "${name}" for ${sym} with x0=${formatPrice(x0)}, qty=${qty}`
      );
      setNewSectionSymbol("");
      setNewSectionName("");
      setNewSectionX0("");
      setNewSectionQty("");
      setValidX0(null);
      await loadAllSections();
      setSelectedSymbol(sym);
      if (result.section) setSelectedSectionId(result.section.id);
      setToast(true);
      setTimeout(() => setToast(false), 2000);
    }
  };

  const handleDeleteSection = async (secId: number) => {
    if (!confirm("Delete this section and all its tasks?")) return;
    setEngineMessage("Queued delete_section…");
    const result = await deleteSection(secId);
    if (result.error) {
      setEngineMessage(result.error);
    } else {
      setEngineMessage("Section deleted.");
      const { secs: updatedSecs } = await loadAllSections();
      if (selectedSectionId === secId) {
        const next = updatedSecs.find((s) => s.symbol === selectedSymbol);
        setSelectedSectionId(next ? next.id : null);
      }
    }
  };

  const handleDeleteEngine = async (sym: string) => {
    if (
      !confirm(
        `Delete ALL data for ${sym}? (sections, tasks, settings, history)`
      )
    )
      return;
    setEngineMessage(`Queued delete_engine for ${sym}…`);
    const result = await deleteEngine(sym);
    if (result.error) {
      setEngineMessage(result.error);
      return;
    }
    setEngineMessage(`${sym} deleted.`);
    const { secs: remaining, syms: remainingSyms } = await loadAllSections();
    if (selectedSymbol === sym) {
      setSelectedSymbol(remainingSyms[0] || "");
      setSelectedSectionId(remaining[0]?.id ?? null);
    }
  };

  const handleDeleteTask = async (taskId: number) => {
    setEngineMessage("Queued delete_task…");
    const result = await deleteTask(taskId);
    if (result.error) {
      setEngineMessage(result.error);
    } else {
      setEngineMessage("Task deleted.");
      loadSectionInfo(selectedSectionId);
    }
  };

  const handlePriceBroadcast = async () => {
    if (!selectedSymbol) return;
    const price = parseFloat(broadcastPrice.replace(/,/g, "").trim());
    if (isNaN(price) || price <= 0) return;
    setEngineMessage(`Queued process_price for ${selectedSymbol}…`);
    const result = await priceBroadcast(selectedSymbol, price);
    if (result.error) {
      setEngineMessage(result.error);
    } else {
      const n = result.sections_updated ?? 0;
      const t = result.total_triggered ?? 0;
      setEngineMessage(
        `Updated ${n} section(s) for ${selectedSymbol} @ ${formatPrice(price)}. ${t} task(s) triggered.`
      );
      await loadAllSections();
      if (selectedSectionId) loadSectionInfo(selectedSectionId);
      fetchPriceHistory(selectedSymbol, 15).then(setPriceHistory);
    }
    setBroadcastPrice("");
  };

  const handleGetPrice = async () => {
    const sym = priceSymbol.trim().toUpperCase();
    if (!sym) return;
    setPriceLoading(true);
    setPriceResult(null);
    try {
      const result = await fetchCurrentPrice(sym);
      setPriceResult(result);
    } finally {
      setPriceLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="app">
        <p className="sub">Loading...</p>
      </div>
    );
  }

  const navItems = [
    { id: "engine" as const, label: "Task Engine", icon: "⚙" },
    { id: "summary" as const, label: "Summary", icon: "📊" },
    { id: "settings" as const, label: "Settings", icon: "🔧" },
    { id: "price" as const, label: "Current price", icon: "📈" },
  ];

  return (
    <div className="app">
      <aside className="sidebar">
        <h1 className="sidebar-title">CTC</h1>
        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`sidebar-item ${page === item.id ? "active" : ""}`}
              onClick={() => setPage(item.id)}
            >
              <span className="sidebar-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div
          className={`worker-badge ${
            workerStatus?.online ? "worker-online" : "worker-offline"
          }`}
        >
          Worker:{" "}
          {workerStatus === null
            ? "unknown"
            : workerStatus.online
              ? "online"
              : "offline"}
        </div>
      </aside>
      <main className="main-content">
        {page === "engine" && (
          <>
            <p className="sub">
              Task Engine: tạo section cho mỗi lần mua coin. Mỗi section có x0,
              coin_qty riêng. Cập nhật giá sẽ broadcast tới tất cả section
              cùng symbol.
            </p>
            {engineMessage && (
              <div className="engine-message">{engineMessage}</div>
            )}

            {/* Create section */}
            <section className="card">
              <h2>Create Section</h2>
              <p className="sub">
                Mỗi lần mua coin ở giá khác nhau = 1 section. Nhập symbol, tên,
                giá mua (x0), số lượng coin.
              </p>
              <div className="engine-init-form">
                <input
                  type="text"
                  placeholder="Symbol (e.g. ETHUSDT)"
                  value={newSectionSymbol}
                  onChange={(e) => {
                    setNewSectionSymbol(e.target.value);
                    setCreateError(null);
                  }}
                />
                <input
                  type="text"
                  placeholder="Tên section (e.g. S1)"
                  value={newSectionName}
                  onChange={(e) => setNewSectionName(e.target.value)}
                />
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <input
                    type="text"
                    placeholder="Giá mua x0"
                    value={newSectionX0}
                    onChange={(e) => {
                      setNewSectionX0(e.target.value);
                      setCreateError(null);
                    }}
                  />
                  {/* Valid x0 hint: show grid info when symbol has existing sections */}
                  {validX0?.requires_validation && validX0.sample_prices.length > 0 && (
                    <div className="valid-x0-hint">
                      <span className="valid-x0-hint-label">
                        Giá x0 hợp lệ — lưới&nbsp;
                        <strong>{validX0.grid_step_pct}%</strong>
                        &nbsp;từ base&nbsp;
                        <strong>{validX0.base_x0 != null ? formatPrice(validX0.base_x0) : ""}</strong>
                        &nbsp;(section&nbsp;<strong>{validX0.first_section?.name}</strong>):
                      </span>
                      <div className="valid-x0-chips">
                        {validX0.sample_prices.map((vp) => (
                          <button
                            key={`grid-${vp.n}`}
                            type="button"
                            className={`valid-x0-chip ${vp.n < 0 ? "chip-down" : "chip-up"}`}
                            onClick={() => {
                              setNewSectionX0(vp.target_x.toFixed(2));
                              setCreateError(null);
                            }}
                          >
                            n={vp.n > 0 ? "+" : ""}{vp.n}&nbsp;({vp.pct > 0 ? "+" : ""}{vp.pct.toFixed(1)}%)
                            &nbsp;→&nbsp;{formatPrice(vp.target_x)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* Error with nearest grid price chips */}
                  {createError && (
                    <div className="valid-x0-error">
                      <span>{createError.msg}</span>
                      {createError.nearestPrices.length > 0 && (
                        <div className="valid-x0-chips" style={{ marginTop: "6px" }}>
                          {createError.nearestPrices.map((vp) => (
                            <button
                              key={`err-${vp.n}`}
                              type="button"
                              className={`valid-x0-chip ${vp.n < 0 ? "chip-down" : "chip-up"}`}
                              onClick={() => {
                                setNewSectionX0(vp.target_x.toFixed(2));
                                setCreateError(null);
                              }}
                            >
                              n={vp.n > 0 ? "+" : ""}{vp.n}&nbsp;({vp.pct > 0 ? "+" : ""}{vp.pct.toFixed(1)}%)
                              &nbsp;→&nbsp;{formatPrice(vp.target_x)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <input
                  type="text"
                  placeholder="Số lượng coin"
                  value={newSectionQty}
                  onChange={(e) => setNewSectionQty(e.target.value)}
                  onKeyDown={(e) =>
                    e.key === "Enter" && handleCreateSection()
                  }
                />
                <button
                  type="button"
                  onClick={handleCreateSection}
                  disabled={
                    !newSectionSymbol.trim() ||
                    !newSectionName.trim() ||
                    !newSectionX0.trim()
                  }
                >
                  Create
                </button>
              </div>
            </section>

            {/* Live prices */}
            {engineSymbols.length > 0 && (
              <section className="card">
                <h2>Live Prices (auto-refresh 30s)</h2>
                <div className="live-prices-grid">
                  {engineSymbols.map((sym) => {
                    const lp = livePrices[sym];
                    return (
                      <div
                        key={sym}
                        className={`live-price-card ${selectedSymbol === sym ? "live-price-selected" : ""}`}
                        onClick={() => {
                          setSelectedSymbol(sym);
                          const first = allSections.find(
                            (s) => s.symbol === sym
                          );
                          setSelectedSectionId(first?.id ?? null);
                          setEngineMessage("");
                        }}
                      >
                        <span className="live-price-symbol">{sym}</span>
                        <span className="live-price-value">
                          {lp !== undefined ? formatPrice(lp) : "—"}
                        </span>
                        <span className="live-price-sections">
                          {allSections.filter((s) => s.symbol === sym).length}{" "}
                          section(s)
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Symbol & sections selector */}
            {selectedSymbol && (
              <section className="card">
                <div className="section-header-row">
                  <h2>
                    {selectedSymbol} — Sections ({symbolSections.length})
                  </h2>
                  <button
                    type="button"
                    className="btn-danger btn-sm"
                    onClick={() => handleDeleteEngine(selectedSymbol)}
                  >
                    Delete {selectedSymbol}
                  </button>
                </div>
                <div className="sections-grid">
                  {symbolSections.map((sec) => (
                    <div
                      key={sec.id}
                      className={`section-card ${selectedSectionId === sec.id ? "section-selected" : ""}`}
                      onClick={() => setSelectedSectionId(sec.id)}
                    >
                      <div className="section-card-header">
                        <strong>{sec.name}</strong>
                        <button
                          type="button"
                          className="btn-danger btn-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteSection(sec.id);
                          }}
                        >
                          ×
                        </button>
                      </div>
                      <div className="section-card-stats">
                        <span>x0: {formatPrice(sec.x0)}</span>
                        <span>
                          now: {formatPrice(sec.current_x)}
                        </span>
                        <span
                          className={
                            sec.current_pct >= 0 ? "pct-up" : "pct-down"
                          }
                        >
                          {sec.current_pct >= 0 ? "+" : ""}
                          {sec.current_pct.toFixed(4)}%
                        </span>
                        <span>qty: {sec.coin_qty}</span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Price broadcast */}
                <div className="engine-price-form" style={{ marginTop: "1rem" }}>
                  <input
                    type="text"
                    placeholder={`Giá mới cho ${selectedSymbol} (broadcast)`}
                    value={broadcastPrice}
                    onChange={(e) => setBroadcastPrice(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === "Enter" && handlePriceBroadcast()
                    }
                  />
                  <button
                    type="button"
                    onClick={handlePriceBroadcast}
                    disabled={!broadcastPrice.trim()}
                  >
                    Broadcast
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      loadAllSections();
                      if (selectedSectionId)
                        loadSectionInfo(selectedSectionId);
                    }}
                    style={{ background: "var(--accent-alt)" }}
                  >
                    Refresh
                  </button>
                </div>
              </section>
            )}

            {/* Price history */}
            {selectedSymbol && priceHistory.length > 0 && (
              <section className="card">
                <h2>Price History — {selectedSymbol} (last {priceHistory.length})</h2>
                <div className={priceHistory.length > 7 ? "scroll-table" : undefined}>
                  <table>
                    <thead>
                      <tr>
                        <th>Price</th>
                        <th>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {priceHistory.map((h, i) => (
                        <tr key={`ph-${i}`}>
                          <td>{formatPrice(h.price)}</td>
                          <td>{h.at}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* Selected section detail */}
            {selectedSection && (
              <>
                <section className="card">
                  <h2>
                    Section: {selectedSection.name} [{selectedSection.symbol}]
                  </h2>
                  <div className="engine-state-grid">
                    <div className="engine-stat">
                      <span className="engine-stat-label">Giá gốc (x0)</span>
                      <span className="engine-stat-value">
                        {formatPrice(selectedSection.x0)}
                      </span>
                    </div>
                    <div className="engine-stat">
                      <span className="engine-stat-label">Giá hiện tại</span>
                      <span className="engine-stat-value">
                        {formatPrice(selectedSection.current_x)}
                      </span>
                    </div>
                    <div className="engine-stat">
                      <span className="engine-stat-label">% so với x0</span>
                      <span
                        className={`engine-stat-value ${selectedSection.current_pct >= 0 ? "pct-up" : "pct-down"}`}
                      >
                        {selectedSection.current_pct >= 0 ? "+" : ""}
                        {selectedSection.current_pct.toFixed(4)}%
                      </span>
                    </div>
                    <div className="engine-stat">
                      <span className="engine-stat-label">Coin Qty</span>
                      <span className="engine-stat-value">
                        {selectedSection.coin_qty}
                      </span>
                    </div>
                    {livePrices[selectedSection.symbol] !== undefined && (
                      <div className="engine-stat engine-stat-live">
                        <span className="engine-stat-label">
                          Live (Binance)
                        </span>
                        <span className="engine-stat-value">
                          {formatPrice(livePrices[selectedSection.symbol])}
                        </span>
                      </div>
                    )}
                  </div>
                </section>

                {/* Queue UP */}
                <section className="card">
                  <h2>Queue UP (trigger khi pct &ge; target)</h2>
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Action</th>
                        <th>Target %</th>
                        <th>Target Price</th>
                        <th>Sibling</th>
                        <th>Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sectionUpTasks.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="empty">
                            No UP tasks
                          </td>
                        </tr>
                      ) : (
                        sectionUpTasks.map((t) => (
                          <tr key={t.id}>
                            <td>{t.id}</td>
                            <td>
                              <span
                                className={`action-badge action-${t.action.toLowerCase()}`}
                              >
                                {t.action}
                              </span>
                            </td>
                            <td className={t.action === "BUY" ? "pct-up" : "pct-down"}>
                              {t.target_pct >= 0 ? "+" : ""}
                              {t.target_pct.toFixed(4)}%
                            </td>
                            <td>
                              {formatPrice(
                                selectedSection.x0 *
                                  (1 + t.target_pct / 100)
                              )}
                            </td>
                            <td>
                              {t.sibling_id ? `#${t.sibling_id}` : "—"}
                            </td>
                            <td>{t.note}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </section>

                {/* Queue DOWN */}
                <section className="card">
                  <h2>Queue DOWN (trigger khi pct &le; target)</h2>
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Action</th>
                        <th>Target %</th>
                        <th>Target Price</th>
                        <th>Sibling</th>
                        <th>Origin</th>
                        <th>Note</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sectionDownTasks.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="empty">
                            No DOWN tasks
                          </td>
                        </tr>
                      ) : (
                        sectionDownTasks.map((t) => (
                          <tr key={t.id}>
                            <td>{t.id}</td>
                            <td>
                              <span
                                className={`action-badge action-${t.action.toLowerCase()}`}
                              >
                                {t.action}
                              </span>
                            </td>
                            <td className={t.action === "BUY" ? "pct-up" : "pct-down"}>
                              {t.target_pct >= 0 ? "+" : ""}
                              {t.target_pct.toFixed(4)}%
                            </td>
                            <td>
                              {formatPrice(
                                selectedSection.x0 *
                                  (1 + t.target_pct / 100)
                              )}
                            </td>
                            <td>
                              {t.sibling_id ? `#${t.sibling_id}` : "—"}
                            </td>
                            <td>{t.sell_origin || "—"}</td>
                            <td>{t.note}</td>
                            <td>
                              {t.action === "BUY" && (
                                <button
                                  className="btn-xs btn-danger"
                                  onClick={() => handleDeleteTask(t.id)}
                                  title="Delete BUY task"
                                >
                                  ×
                                </button>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </section>

                {/* Passed */}
                <section className="card">
                  <h2>Passed Tasks (Triggered)</h2>
                  <div className={sectionPassedTasks.length > 7 ? "scroll-table" : undefined}>
                    <table>
                    <thead>
                      <tr>
                        <th>Task #</th>
                        <th>Action</th>
                        <th>Direction</th>
                        <th>Target %</th>
                        <th>Hit %</th>
                        <th>Hit Price</th>
                        <th>Origin</th>
                        <th>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sectionPassedTasks.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="empty">
                            No passed tasks yet
                          </td>
                        </tr>
                      ) : (
                        sectionPassedTasks.map((t, i) => (
                          <tr key={`passed-${t.id}-${i}`}>
                            <td>#{t.task_id ?? "?"}</td>
                            <td>
                              <span
                                className={`action-badge action-${t.action.toLowerCase()}`}
                              >
                                {t.action}
                              </span>
                            </td>
                            <td>{t.direction}</td>
                            <td>
                              {t.target_pct >= 0 ? "+" : ""}
                              {t.target_pct.toFixed(4)}%
                            </td>
                            <td>
                              {t.hit_pct >= 0 ? "+" : ""}
                              {t.hit_pct.toFixed(4)}%
                            </td>
                            <td>{formatPrice(t.hit_price)}</td>
                            <td>{t.sell_origin || "—"}</td>
                            <td>{t.at}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                    </table>
                  </div>
                </section>

                {/* Closed */}
                <section className="card">
                  <h2>Closed Tasks (Cancelled)</h2>
                  <div className={sectionClosedTasks.length > 7 ? "scroll-table" : undefined}>
                    <table>
                    <thead>
                      <tr>
                        <th>Closed #</th>
                        <th>Action</th>
                        <th>Direction</th>
                        <th>Target %</th>
                        <th>Triggered By</th>
                        <th>At %</th>
                        <th>At Price</th>
                        <th>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sectionClosedTasks.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="empty">
                            No closed tasks yet
                          </td>
                        </tr>
                      ) : (
                        sectionClosedTasks.map((t, i) => (
                          <tr key={`closed-${t.id}-${i}`}>
                            <td>#{t.closed_task_id}</td>
                            <td>
                              <span
                                className={`action-badge action-${t.action.toLowerCase()}`}
                              >
                                {t.action}
                              </span>
                            </td>
                            <td>{t.direction}</td>
                            <td>
                              {t.target_pct >= 0 ? "+" : ""}
                              {t.target_pct.toFixed(4)}%
                            </td>
                            <td>{t.sibling_triggered_id != null ? `#${t.sibling_triggered_id}` : "—"}</td>
                            <td
                              className={
                                t.at_pct >= 0 ? "pct-up" : "pct-down"
                              }
                            >
                              {t.at_pct >= 0 ? "+" : ""}
                              {t.at_pct.toFixed(4)}%
                            </td>
                            <td>{formatPrice(t.at_price)}</td>
                            <td>{t.at}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                    </table>
                  </div>
                </section>
              </>
            )}

            {selectedSymbol && symbolSections.length === 0 && (
              <section className="card">
                <p className="sub">
                  No sections for {selectedSymbol}. Create one above.
                </p>
              </section>
            )}
          </>
        )}

        {page === "settings" && (
          <>
            <p className="sub">
              Quantity % quyết định khối lượng coin; offset % quyết định giá
              target khi spawn task. Thay đổi chỉ áp dụng cho task/section sinh
              sau khi lưu, riêng BUY cancel distance % áp dụng ngay cho BUY
              pending.
            </p>
            <section className="card settings-page-card">
              <h2>Settings (per-symbol)</h2>
              {settingsMessage && (
                <div className="engine-message">{settingsMessage}</div>
              )}
              {settingsList.length === 0 ? (
                <p className="sub">
                  Chưa có symbol nào. Tạo section trước để tạo settings.
                </p>
              ) : (
                <div className="settings-cards">
                  {settingsList.map((s) => {
                    const edit = settingsEdits[s.symbol] ?? settingsToEdit(s);
                    const save = async () => {
                      for (const field of SETTINGS_FIELDS) {
                        const error = validateSetting(field, edit[field.key]);
                        if (error) {
                          setSettingsMessage(error);
                          return;
                        }
                      }
                      const payload: SettingsPayload = {
                        sell_down_pct: Number(edit.sell_down_pct),
                        sell_up_pct: Number(edit.sell_up_pct),
                        sell_down_offset_pct: Number(edit.sell_down_offset_pct),
                        sell_up_offset_pct: Number(edit.sell_up_offset_pct),
                        buy_after_sell_down_offset_pct: Number(
                          edit.buy_after_sell_down_offset_pct
                        ),
                        buy_after_sell_up_offset_pct: Number(
                          edit.buy_after_sell_up_offset_pct
                        ),
                        supplement_sell_up_offset_pct: Number(
                          edit.supplement_sell_up_offset_pct
                        ),
                        grid_step_pct: Number(edit.grid_step_pct),
                        buy_cancel_distance_pct: Number(
                          edit.buy_cancel_distance_pct
                        ),
                      };
                      setSettingsMessage(`Saving ${s.symbol}…`);
                      const res = await saveSettings(s.symbol, payload);
                      if (res.error) {
                        setSettingsMessage(res.error);
                        return;
                      }
                      setSettingsMessage(`Saved ${s.symbol}.`);
                      const items = await fetchSettings();
                      setSettingsList(items);
                      const edits: Record<string, SettingsEdit> = {};
                      for (const item of items) {
                        edits[item.symbol] = settingsToEdit(item);
                      }
                      setSettingsEdits(edits);
                      setToast(true);
                      setTimeout(() => setToast(false), 2000);
                    };
                    return (
                      <div className="settings-card" key={s.symbol}>
                        <div className="settings-card-header">
                          <h3>{s.symbol}</h3>
                          <button type="button" onClick={save}>
                            Save
                          </button>
                        </div>
                        {SETTINGS_GROUP_ORDER.map((group) => (
                          <div className="settings-group" key={group}>
                            <h4>{group}</h4>
                            <div className="settings-fields">
                              {SETTINGS_FIELDS.filter(
                                (field) => field.group === group
                              ).map((field) => (
                                <label
                                  className="settings-field"
                                  key={field.key}
                                >
                                  <span className="settings-label">
                                    {field.label}
                                    <InfoTip text={field.tip} />
                                  </span>
                                  <input
                                    type="text"
                                    value={edit[field.key]}
                                    onChange={(e) =>
                                      setSettingsEdits((prev) => ({
                                        ...prev,
                                        [s.symbol]: {
                                          ...edit,
                                          [field.key]: e.target.value,
                                        },
                                      }))
                                    }
                                  />
                                </label>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}

        {page === "summary" && (
          <>
            <p className="sub">
              Tổng hợp action sắp tới (pending) cho tất cả symbol, chia theo
              SELL DOWN / BUY DOWN / SELL UP, kèm số lượng coin và tên
              section.
            </p>
            <div className="summary-actions">
              <button
                type="button"
                onClick={() => {
                  setSummaryMessage("");
                  fetchSummary().then(setSummaryData);
                }}
              >
                Refresh
              </button>
            </div>
            {summaryMessage && (
              <div className="engine-message">{summaryMessage}</div>
            )}
            {summaryData.length === 0 ? (
              <section className="card">
                <p className="sub">Chưa có section nào được tạo.</p>
              </section>
            ) : (
              summaryData.map((sym) => (
                <section
                  className="card summary-coin-card"
                  key={sym.symbol}
                >
                  <h2>
                    {sym.symbol} — SELL DOWN QTY:{" "}
                    {sym.settings.sell_down_pct}% | SELL UP QTY:{" "}
                    {sym.settings.sell_up_pct}%
                  </h2>

                  {/* SELL DOWN */}
                  <h3 className="summary-section-title">SELL DOWN</h3>
                  <table>
                    <thead>
                      <tr>
                        <th>Section</th>
                        <th>#</th>
                        <th>Target %</th>
                        <th>Target Price</th>
                        <th>Coins</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sym.sell_down.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="empty">
                            (none)
                          </td>
                        </tr>
                      ) : (
                        <>
                          {sym.sell_down.map((r: SummaryRow) => (
                            <tr key={r.id}>
                              <td>{r.section_name}</td>
                              <td>{r.id}</td>
                              <td className="pct-down">
                                {r.target_pct >= 0 ? "+" : ""}
                                {r.target_pct.toFixed(4)}%
                              </td>
                              <td>{formatPrice(r.target_price)}</td>
                              <td>{r.coins_to_trade.toFixed(4)}</td>
                            </tr>
                          ))}
                          <tr className="summary-total-row">
                            <td colSpan={4}>
                              <strong>Total coins to sell</strong>
                            </td>
                            <td>
                              <strong>
                                {sym.total_sell_down_coins.toFixed(4)}
                              </strong>
                            </td>
                          </tr>
                        </>
                      )}
                    </tbody>
                  </table>

                  {/* BUY DOWN */}
                  <div className="summary-section-title-row">
                    <h3 className="summary-section-title">BUY DOWN</h3>
                    {sym.buy_down.length > 0 && (
                      <button
                        type="button"
                        className="btn-danger btn-sm"
                        onClick={async () => {
                          if (!confirm(`Xoá tất cả ${sym.buy_down.length} BUY task của ${sym.symbol}?`)) return;
                          const result = await deleteAllBuyTasks(sym.symbol);
                          if (result.error) {
                            setSummaryMessage(result.error);
                          } else {
                            setSummaryMessage(`Đã xoá ${result.deleted_count ?? 0} BUY task của ${sym.symbol}.`);
                            fetchSummary().then(setSummaryData);
                          }
                        }}
                      >
                        Delete All BUY
                      </button>
                    )}
                  </div>
                  <table>
                    <thead>
                      <tr>
                        <th>Section</th>
                        <th>#</th>
                        <th>Target %</th>
                        <th>Target Price</th>
                        <th>Coins</th>
                        <th>Origin</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sym.buy_down.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="empty">
                            (none)
                          </td>
                        </tr>
                      ) : (
                        <>
                          {sym.buy_down.map((r: SummaryRow) => (
                            <tr key={r.id}>
                              <td>{r.section_name}</td>
                              <td>{r.id}</td>
                              <td className="pct-up">
                                {r.target_pct >= 0 ? "+" : ""}
                                {r.target_pct.toFixed(4)}%
                              </td>
                              <td>{formatPrice(r.target_price)}</td>
                              <td>{r.coins_to_trade.toFixed(4)}</td>
                              <td>{r.sell_origin || "—"}</td>
                              <td>
                                <button
                                  className="btn-xs btn-danger"
                                  title="Delete BUY task"
                                  onClick={async () => {
                                    const result = await deleteTask(r.id);
                                    if (result.error) {
                                      setSummaryMessage(result.error);
                                    } else {
                                      setSummaryMessage("");
                                      fetchSummary().then(setSummaryData);
                                    }
                                  }}
                                >
                                  ×
                                </button>
                              </td>
                            </tr>
                          ))}
                          <tr className="summary-total-row">
                            <td colSpan={4}>
                              <strong>Total coins to buy</strong>
                            </td>
                            <td>
                              <strong>
                                {sym.total_buy_down_coins.toFixed(4)}
                              </strong>
                            </td>
                            <td></td>
                            <td></td>
                          </tr>
                        </>
                      )}
                    </tbody>
                  </table>

                  {/* SELL UP */}
                  <h3 className="summary-section-title">SELL UP</h3>
                  <table>
                    <thead>
                      <tr>
                        <th>Section</th>
                        <th>#</th>
                        <th>Target %</th>
                        <th>Target Price</th>
                        <th>Coins</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sym.sell_up.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="empty">
                            (none)
                          </td>
                        </tr>
                      ) : (
                        <>
                          {sym.sell_up.map((r: SummaryRow) => (
                            <tr key={r.id}>
                              <td>{r.section_name}</td>
                              <td>{r.id}</td>
                              <td className="pct-down">
                                {r.target_pct >= 0 ? "+" : ""}
                                {r.target_pct.toFixed(4)}%
                              </td>
                              <td>{formatPrice(r.target_price)}</td>
                              <td>{r.coins_to_trade.toFixed(4)}</td>
                            </tr>
                          ))}
                          <tr className="summary-total-row">
                            <td colSpan={4}>
                              <strong>Total coins to sell</strong>
                            </td>
                            <td>
                              <strong>
                                {sym.total_sell_up_coins.toFixed(4)}
                              </strong>
                            </td>
                          </tr>
                        </>
                      )}
                    </tbody>
                  </table>
                </section>
              ))
            )}
          </>
        )}

        {page === "price" && (
          <section className="card page-card">
            <h2>Current crypto price</h2>
            <p className="sub">Get live price from Binance API.</p>
            <div className="price-lookup">
              <label htmlFor="price-symbol">Symbol</label>
              <div className="price-lookup-row">
                <input
                  id="price-symbol"
                  type="text"
                  placeholder="e.g. BTCUSDT, ETHUSDT"
                  value={priceSymbol}
                  onChange={(e) => setPriceSymbol(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleGetPrice()}
                  aria-label="Symbol to look up"
                />
                <button
                  type="button"
                  onClick={handleGetPrice}
                  disabled={!priceSymbol.trim() || priceLoading}
                >
                  {priceLoading ? "Loading..." : "Get price"}
                </button>
              </div>
              {priceResult && (
                <div
                  className={
                    "price-result " +
                    ("error" in priceResult ? "price-error" : "price-ok")
                  }
                >
                  {"error" in priceResult ? (
                    priceResult.error
                  ) : (
                    <>
                      <strong>{priceResult.symbol}</strong>:{" "}
                      {formatPrice(priceResult.price)}
                    </>
                  )}
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      {toast && <div className="toast">Saved.</div>}
    </div>
  );
}

export default App;
