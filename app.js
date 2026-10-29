/*
 * MathScope Lab — Sourdough Pore Analyzer
 * ทุกอย่างทำงานในเบราว์เซอร์ ไม่มีการส่งภาพออกนอกเครื่อง
 */
(() => {
  "use strict";

  // ------------------------------------------------------------------
  // ค่าคงที่และตัวช่วย
  // ------------------------------------------------------------------
  const LEGACY_STORAGE_KEY = "mathvision-pore-lab-complete-v1";
  const IDB_NAME = "mathscope-lab";
  const IDB_STORE = "kv";
  const MAX_PROCESSING_DIMENSION = 2000; // ด้านยาวสุดของ ROI ที่ใช้ประมวลผล (px)
  const AUTO_ANALYZE_DELAY = 220;
  const SERIES_COLORS = ["#0891b2", "#f97316", "#7c3aed", "#16a34a", "#db2777", "#ca8a04", "#2563eb", "#dc2626"];
  const METHOD_COLORS = {
    left: "#2563eb", right: "#7c3aed", midpoint: "#0891b2", lower: "#16a34a",
    upper: "#dc2626", trapezoid: "#ca8a04", simpson: "#db2777",
  };
  const METHOD_NAMES = {
    left: "ผลบวกซ้าย", right: "ผลบวกขวา", midpoint: "จุดกึ่งกลาง", lower: "ผลบวกล่าง",
    upper: "ผลบวกบน", trapezoid: "สี่เหลี่ยมคางหมู", simpson: "ซิมป์สัน",
  };
  const LENGTH_TO_MM = { mm: 1, cm: 10, in: 25.4 };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const DEBUG = /[?&]debug=1/.test(location.search);

  const state = {
    image: null,
    imageName: "",
    imageWidth: 0,
    imageHeight: 0,
    tool: "pan",
    viewMode: "original",
    calibration: { point1: null, point2: null, realLength: 10, unit: "mm" },
    measure: { point1: null, point2: null },
    roi: null,
    processing: {
      threshold: 115,
      thresholdTouched: false,
      poreMode: "dark",
      minAreaPx: 20,
      maxAreaPercent: 12,
      cleanMask: true,
      excludeBoundary: true,
    },
    analysis: null,
    groundTruth: null,
    selectedPoreId: null,
    geometry: { tool: "circle", shapes: [], polygonDraft: [], selectedPoreId: null },
    calculus: { poreId: null, n: 10, method: "left", axis: "x", hover: null, convView: "estimate", result: null, profile: null, playTimer: null },
    repository: [],
    storageMode: "idb",
    workspaceView: { scale: 1, x: 0, y: 0 },
    geometryView: { scale: 1, x: 0, y: 0 },
    interaction: null,
    geometryInteraction: null,
    sourceCache: null,
    analyzeTimer: null,
  };

  const dom = {
    imageInput: $("#imageInput"),
    dropZone: $("#dropZone"),
    imageName: $("#imageName"),
    workspaceCanvas: $("#workspaceCanvas"),
    workspaceWrap: $("#canvasWrap"),
    emptyCanvasState: $("#emptyCanvasState"),
    dropOverlay: $("#dropOverlay"),
    geometryCanvas: $("#geometryCanvas"),
    geometryWrap: $(".geometry-canvas-wrap"),
    geometryEmptyState: $("#geometryEmptyState"),
    thresholdInput: $("#thresholdInput"),
    thresholdValue: $("#thresholdValue"),
    realLengthInput: $("#realLengthInput"),
    unitSelect: $("#unitSelect"),
    pixelLengthReadout: $("#pixelLengthReadout"),
    calibrationReadout: $("#calibrationReadout"),
    measureReadout: $("#measureReadout"),
    scaleReadout: $("#scaleReadout"),
    toolHint: $("#toolHint"),
    analysisStatus: $("#analysisStatus"),
    poreTableBody: $("#poreTableBody"),
    selectedPoreCard: $("#selectedPoreCard"),
    geometryPoreSelect: $("#geometryPoreSelect"),
    calculusPoreSelect: $("#calculusPoreSelect"),
    shapeList: $("#shapeList"),
    repositoryCards: $("#repositoryCards"),
    repositoryCount: $("#repositoryCount"),
    dashboardSeriesSelect: $("#dashboardSeriesSelect"),
    dashboardMetricSelect: $("#dashboardMetricSelect"),
    growthTableBody: $("#growthTableBody"),
    stepper: $("#stepper"),
    nextHint: $("#nextHint"),
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatNumber(value, digits = 3) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    return new Intl.NumberFormat("th-TH", { maximumFractionDigits: digits }).format(Number(value));
  }

  /** แสดงตัวเลขให้อ่านง่าย: ค่ามากใช้ทศนิยมน้อย ค่าน้อยใช้ทศนิยมมาก */
  function fmt(value) {
    const v = Math.abs(Number(value));
    if (!Number.isFinite(v)) return "—";
    if (v >= 1000) return formatNumber(value, 0);
    if (v >= 100) return formatNumber(value, 1);
    if (v >= 1) return formatNumber(value, 3);
    if (v === 0) return "0";
    return formatNumber(value, 4);
  }

  function uid(prefix = "id") {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    }[char]));
  }

  function getPixelLength() {
    const { point1, point2 } = state.calibration;
    if (!point1 || !point2) return null;
    return Math.hypot(point2.x - point1.x, point2.y - point1.y);
  }

  function getUnitPerPixel() {
    const pixelLength = getPixelLength();
    const realLength = Number(state.calibration.realLength);
    if (!pixelLength || pixelLength < 1 || !Number.isFinite(realLength) || realLength <= 0) return null;
    return realLength / pixelLength;
  }

  const areaUnit = () => (getUnitPerPixel() ? `${state.calibration.unit}²` : "px²");
  const lengthUnit = () => (getUnitPerPixel() ? state.calibration.unit : "px");
  const toAreaUnits = (px2) => { const k = getUnitPerPixel(); return k ? px2 * k * k : px2; };
  const toLengthUnits = (px) => { const k = getUnitPerPixel(); return k ? px * k : px; };

  // ------------------------------------------------------------------
  // ที่เก็บข้อมูล (IndexedDB เก็บได้มากกว่า Local Storage หลายเท่า)
  // ------------------------------------------------------------------
  const storage = {
    dbPromise: null,
    open() {
      if (!("indexedDB" in window)) return Promise.reject(new Error("no indexedDB"));
      if (!this.dbPromise) {
        this.dbPromise = new Promise((resolve, reject) => {
          const request = indexedDB.open(IDB_NAME, 1);
          request.onupgradeneeded = () => request.result.createObjectStore(IDB_STORE);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      }
      return this.dbPromise;
    },
    async get(key) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const request = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    },
    async set(key, value) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };

  async function loadRepository() {
    try {
      const stored = await storage.get("repository");
      if (Array.isArray(stored)) {
        state.repository = stored;
      } else {
        // ย้ายข้อมูลจากเวอร์ชันเก่าที่เก็บใน Local Storage
        let legacy = [];
        try { legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "[]"); } catch { legacy = []; }
        state.repository = Array.isArray(legacy) ? legacy : [];
        if (state.repository.length) await storage.set("repository", state.repository);
      }
      state.storageMode = "idb";
    } catch (error) {
      console.warn("IndexedDB unavailable, using localStorage", error);
      state.storageMode = "local";
      try { state.repository = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "[]"); } catch { state.repository = []; }
    }
  }

  async function persistRepository() {
    try {
      if (state.storageMode === "idb") await storage.set("repository", state.repository);
      else localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(state.repository));
      return true;
    } catch (error) {
      console.error(error);
      toast("บันทึกไม่สำเร็จ: พื้นที่ในเบราว์เซอร์อาจเต็ม — ส่งออกไฟล์สำรองแล้วลบตัวอย่างเก่าบางส่วน", "error", 7000);
      return false;
    }
  }

  // ------------------------------------------------------------------
  // ข้อความแจ้งเตือน / สถานะ / ขั้นตอน
  // ------------------------------------------------------------------
  function toast(message, kind = "info", duration = 3800) {
    const host = $("#toastHost");
    const element = document.createElement("div");
    element.className = `toast ${kind}`;
    element.textContent = message;
    host.appendChild(element);
    while (host.children.length > 4) host.firstElementChild.remove();
    setTimeout(() => element.remove(), duration);
  }

  function setStatus(message, kind = "idle") {
    dom.analysisStatus.textContent = message;
    dom.analysisStatus.className = `status-message ${kind}`;
  }

  function flashSection(selector) {
    const element = $(selector);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "nearest" });
    element.classList.remove("flash");
    void element.offsetWidth;
    element.classList.add("flash");
  }

  function updateStepper() {
    const hasImage = Boolean(state.image);
    const hasScale = Boolean(getUnitPerPixel());
    const hasRoi = Boolean(state.roi);
    const hasAnalysis = Boolean(state.analysis);
    const done = { image: hasImage, scale: hasScale, roi: hasRoi, analyze: hasAnalysis };
    let current = null;
    if (!hasImage) current = "image";
    else if (!hasRoi && !hasScale) current = "scale";
    else if (!hasRoi) current = "roi";
    else if (!hasAnalysis) current = "analyze";
    $$("li", dom.stepper).forEach((item) => {
      item.classList.toggle("done", done[item.dataset.step]);
      item.classList.toggle("current", item.dataset.step === current);
    });

    let hint;
    let ok = false;
    if (!hasImage) hint = "เริ่มจากเลือกภาพหน้าตัดขนมปัง หรือกด “ใช้ภาพตัวอย่าง” เพื่อลองก่อน";
    else if (!hasRoi && !hasScale) hint = "ขั้นต่อไป: คลิก 2 จุดบนไม้บรรทัดเพื่อตั้งสเกล (ข้ามได้ ถ้ายอมให้ผลเป็นหน่วยพิกเซล) แล้วลาก ROI ครอบเนื้อขนมปัง";
    else if (!hasRoi) hint = "ขั้นต่อไป: ลากวงรีหรือสี่เหลี่ยมครอบเฉพาะเนื้อขนมปัง (ไม่รวมเปลือก)";
    else if (!hasAnalysis) hint = `พร้อมแล้ว — กด “วิเคราะห์รูพรุน”${hasScale ? "" : " (ยังไม่ได้ตั้งสเกล ผลจะเป็นหน่วยพิกเซล)"}`;
    else {
      ok = true;
      hint = `พบรูพรุน ${state.analysis.pores.length} รู — สลับไปโหมด “ขาว-ดำ” เพื่อตรวจว่ารูตรงกับภาพจริง จากนั้นไปต่อที่แท็บ 2–3 หรือบันทึกเข้าคลัง`;
    }
    dom.nextHint.textContent = hint;
    dom.nextHint.classList.toggle("ok", ok);

    $$(".tab-button").forEach((button) => {
      const tab = button.dataset.tab;
      const needsAnalysis = tab === "geometry" || tab === "calculus";
      button.classList.toggle("needs-data", needsAnalysis && !hasAnalysis);
      button.classList.toggle("has-data",
        (needsAnalysis && hasAnalysis) || ((tab === "repository" || tab === "dashboard") && state.repository.length > 0)
        || (tab === "analyze" && hasAnalysis));
    });
    updateSaveReadiness();
  }

  function setActiveTab(tabName) {
    stopPlay();
    $$(".tab-button").forEach((button) => button.classList.toggle("active", button.dataset.tab === tabName));
    $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${tabName}`));
    requestAnimationFrame(() => {
      resizeCanvases();
      if (tabName === "geometry") {
        if (getGeometryPore()) fitGeometryToSelectedPore();
        updateGeometryMetrics();
      }
      if (tabName === "calculus") updateCalculus();
      if (tabName === "repository") renderRepository();
      if (tabName === "dashboard") updateDashboard();
    });
  }

  // ------------------------------------------------------------------
  // เครื่องมือบนภาพ
  // ------------------------------------------------------------------
  const TOOL_COPY = {
    pan: ["โหมดเลื่อน", "ลากเพื่อเลื่อนภาพ · หมุนล้อเมาส์หรือใช้ปุ่ม + − เพื่อซูม"],
    scale: ["โหมดตั้งสเกล", "คลิกจุดแรกและจุดที่สองบนไม้บรรทัด · ลากจุดสีขาวเพื่อปรับตำแหน่ง"],
    "roi-ellipse": ["ROI วงรี", "กดค้างแล้วลากให้วงรีครอบเนื้อขนมปัง"],
    "roi-rect": ["ROI สี่เหลี่ยม", "กดค้างแล้วลากสี่เหลี่ยมครอบบริเวณที่ต้องการ"],
    select: ["โหมดเลือกรู", "คลิกที่รูพรุนเพื่อดูค่ารายรู"],
    measure: ["โหมดวัดระยะ", "คลิก 2 จุด เช่น จากฐานถึงยอดขนมปัง"],
  };

  function setTool(tool) {
    state.tool = tool;
    $$(".tool-button").forEach((button) => button.classList.toggle("active", button.dataset.tool === tool));
    $$(".roi-button").forEach((button) => button.classList.toggle("active", button.dataset.roiTool === tool));
    const [title, detail] = TOOL_COPY[tool] || TOOL_COPY.pan;
    dom.toolHint.textContent = `${title} — ${detail}`;
    dom.workspaceCanvas.style.cursor = tool === "pan" ? "grab" : tool === "select" ? "pointer" : "crosshair";
    drawWorkspace();
  }

  function resetAnalysis(reason = "") {
    clearTimeout(state.analyzeTimer);
    state.analysis = null;
    state.selectedPoreId = null;
    state.geometry.selectedPoreId = null;
    state.calculus.poreId = null;
    state.geometry.shapes = [];
    state.geometry.polygonDraft = [];
    state.calculus.result = null;
    state.viewMode = "original";
    $$(".view-button").forEach((button) => button.classList.toggle("active", button.dataset.view === "original"));
    updateSummary();
    renderPoreTable();
    refreshPoreSelects();
    renderValidation();
    drawWorkspace();
    drawGeometryCanvas();
    if (reason) setStatus(reason, "idle");
  }

  /** ถ้าเคยวิเคราะห์แล้ว ให้วิเคราะห์ใหม่อัตโนมัติเมื่อเปลี่ยนการตั้งค่า */
  function scheduleAnalyze() {
    if (!state.image || !state.roi) return;
    if (!state.analysis && !state.analyzePending) return;
    state.analyzePending = true;
    clearTimeout(state.analyzeTimer);
    setStatus("กำลังอัปเดตผล…", "working");
    state.analyzeTimer = setTimeout(() => {
      state.analyzePending = false;
      analyzeImage({ quiet: true });
    }, AUTO_ANALYZE_DELAY);
  }

  // ------------------------------------------------------------------
  // Canvas & มุมมอง
  // ------------------------------------------------------------------
  function resizeCanvasToWrap(canvas, wrap) {
    const rect = wrap.getBoundingClientRect();
    if (!rect.width) return;
    const cssWidth = Math.max(280, Math.floor(rect.width));
    const cssHeight = Math.max(300, Math.floor(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
    canvas._cssWidth = cssWidth;
    canvas._cssHeight = cssHeight;
  }

  function resizeCanvases() {
    resizeCanvasToWrap(dom.workspaceCanvas, dom.workspaceWrap);
    resizeCanvasToWrap(dom.geometryCanvas, dom.geometryWrap);
    drawWorkspace();
    drawGeometryCanvas();
  }

  function fitImage(viewKey = "workspaceView") {
    if (!state.image) return;
    const canvas = viewKey === "workspaceView" ? dom.workspaceCanvas : dom.geometryCanvas;
    const width = canvas._cssWidth || 900;
    const height = canvas._cssHeight || 640;
    const padding = 30;
    const scale = Math.min((width - padding * 2) / state.imageWidth, (height - padding * 2) / state.imageHeight);
    state[viewKey] = {
      scale,
      x: (width - state.imageWidth * scale) / 2,
      y: (height - state.imageHeight * scale) / 2,
    };
    if (viewKey === "workspaceView") drawWorkspace(); else drawGeometryCanvas();
  }

  function zoomView(viewKey, factor, drawFunction) {
    if (!state.image) return;
    const canvas = viewKey === "workspaceView" ? dom.workspaceCanvas : dom.geometryCanvas;
    const view = state[viewKey];
    const cx = (canvas._cssWidth || 900) / 2;
    const cy = (canvas._cssHeight || 640) / 2;
    const nextScale = clamp(view.scale * factor, 0.02, 40);
    const ix = (cx - view.x) / view.scale;
    const iy = (cy - view.y) / view.scale;
    state[viewKey] = { scale: nextScale, x: cx - ix * nextScale, y: cy - iy * nextScale };
    drawFunction();
  }

  function zoomToBox(viewKey, box, padding = 90) {
    const canvas = viewKey === "workspaceView" ? dom.workspaceCanvas : dom.geometryCanvas;
    const width = canvas._cssWidth || 900;
    const height = canvas._cssHeight || 640;
    const scale = clamp(Math.min((width - padding * 2) / Math.max(box.width, 1), (height - padding * 2) / Math.max(box.height, 1)), 0.05, 24);
    state[viewKey] = {
      scale,
      x: width / 2 - (box.x + box.width / 2) * scale,
      y: height / 2 - (box.y + box.height / 2) * scale,
    };
  }

  function screenToImage(canvas, view, clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return { x: (x - view.x) / view.scale, y: (y - view.y) / view.scale, sx: x, sy: y };
  }

  function imagePointInBounds(point) {
    return state.image && point.x >= 0 && point.y >= 0 && point.x <= state.imageWidth && point.y <= state.imageHeight;
  }

  function drawWorkspace() {
    const canvas = dom.workspaceCanvas;
    const ctx = canvas.getContext("2d");
    const width = canvas._cssWidth || 900;
    const height = canvas._cssHeight || 640;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, width, height);
    dom.emptyCanvasState.classList.toggle("hidden", Boolean(state.image));
    updateStepper();
    if (!state.image) return;

    const view = state.workspaceView;
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);
    ctx.imageSmoothingEnabled = view.scale < 2;
    ctx.drawImage(state.image, 0, 0, state.imageWidth, state.imageHeight);

    const analysis = state.analysis;
    if (analysis && state.viewMode === "binary") {
      ctx.drawImage(analysis.binaryCanvas, analysis.roi.x, analysis.roi.y, analysis.roi.width, analysis.roi.height);
    }
    if (analysis && state.viewMode === "detection") {
      ctx.globalAlpha = 0.8;
      ctx.drawImage(analysis.overlayCanvas, analysis.roi.x, analysis.roi.y, analysis.roi.width, analysis.roi.height);
      ctx.globalAlpha = 1;
    }

    drawSelectedPoreBox(ctx, view.scale);
    drawRoi(ctx, view.scale);
    drawLineTool(ctx, view.scale, state.calibration, "#f97316", getPixelLength() ? `${formatNumber(getPixelLength(), 1)} px` : "");
    drawLineTool(ctx, view.scale, state.measure, "#a78bfa", measureLabel());
    drawInteractionPreview(ctx, view.scale);
    ctx.restore();
  }

  function drawSelectedPoreBox(ctx, scale) {
    const pore = getSelectedPore();
    if (!pore) return;
    const box = pore.boundingBox;
    ctx.save();
    ctx.lineWidth = 3 / scale;
    ctx.strokeStyle = "#22d3ee";
    ctx.strokeRect(box.x - 2 / scale, box.y - 2 / scale, box.width + 4 / scale, box.height + 4 / scale);
    ctx.font = `bold ${14 / scale}px sans-serif`;
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "rgba(15,23,42,.9)";
    ctx.lineWidth = 3 / scale;
    ctx.strokeText(pore.id, box.x, box.y - 8 / scale);
    ctx.fillText(pore.id, box.x, box.y - 8 / scale);
    ctx.restore();
  }

  function drawRoi(ctx, scale) {
    if (!state.roi) return;
    const roi = state.roi;
    ctx.save();
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 2.5 / scale;
    ctx.setLineDash([10 / scale, 6 / scale]);
    ctx.beginPath();
    if (roi.type === "ellipse") ctx.ellipse(roi.x + roi.width / 2, roi.y + roi.height / 2, roi.width / 2, roi.height / 2, 0, 0, Math.PI * 2);
    else ctx.rect(roi.x, roi.y, roi.width, roi.height);
    ctx.stroke();
    ctx.restore();
  }

  function drawLineTool(ctx, scale, line, color, label) {
    const { point1, point2 } = line;
    if (!point1) return;
    ctx.save();
    ctx.lineWidth = 3 / scale;
    ctx.strokeStyle = color;
    if (point2) {
      ctx.beginPath();
      ctx.moveTo(point1.x, point1.y);
      ctx.lineTo(point2.x, point2.y);
      ctx.stroke();
      if (label) {
        ctx.font = `bold ${15 / scale}px sans-serif`;
        const tx = (point1.x + point2.x) / 2 + 10 / scale;
        const ty = (point1.y + point2.y) / 2 - 10 / scale;
        ctx.strokeStyle = "rgba(15,23,42,.9)";
        ctx.lineWidth = 4 / scale;
        ctx.strokeText(label, tx, ty);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(label, tx, ty);
      }
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5 / scale;
    for (const point of [point1, point2].filter(Boolean)) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 7 / scale, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawInteractionPreview(ctx, scale) {
    const interaction = state.interaction;
    if (!interaction || !interaction.start || !interaction.current || !interaction.type.startsWith("roi")) return;
    const x = Math.min(interaction.start.x, interaction.current.x);
    const y = Math.min(interaction.start.y, interaction.current.y);
    const width = Math.abs(interaction.current.x - interaction.start.x);
    const height = Math.abs(interaction.current.y - interaction.start.y);
    ctx.save();
    ctx.strokeStyle = "#22d3ee";
    ctx.fillStyle = "rgba(34,211,238,.1)";
    ctx.lineWidth = 2 / scale;
    ctx.setLineDash([8 / scale, 5 / scale]);
    ctx.beginPath();
    if (interaction.type === "roi-ellipse") ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    else ctx.rect(x, y, width, height);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function measureLengthPx() {
    const { point1, point2 } = state.measure;
    return point1 && point2 ? Math.hypot(point2.x - point1.x, point2.y - point1.y) : null;
  }

  function measureLabel() {
    const px = measureLengthPx();
    if (!px) return "";
    return `${fmt(toLengthUnits(px))} ${lengthUnit()}`;
  }

  function updateCalibrationReadout() {
    const pixelLength = getPixelLength();
    const unitPerPixel = getUnitPerPixel();
    dom.pixelLengthReadout.textContent = pixelLength ? `เส้นยาว ${formatNumber(pixelLength, 1)} px` : "— px";
    const text = unitPerPixel ? `1 mm ≈ ${formatNumber(1 / (unitPerPixel / LENGTH_TO_MM[state.calibration.unit]), 2)} px` : "ยังไม่ตั้งสเกล";
    dom.calibrationReadout.textContent = text;
    dom.scaleReadout.textContent = unitPerPixel ? `สเกล: ${text}` : "หน่วยพิกเซล";
    dom.measureReadout.textContent = measureLabel() || "—";
    const minArea = Number(state.processing.minAreaPx) || 0;
    $("#minAreaHint").textContent = unitPerPixel
      ? `${formatNumber(minArea, 0)} px² ≈ ${fmt(minArea * unitPerPixel ** 2)} ${state.calibration.unit}²`
      : "";
  }

  // ------------------------------------------------------------------
  // โหลดภาพ / ภาพตัวอย่าง / ภาพทดสอบ
  // ------------------------------------------------------------------
  function loadImageFromDataUrl(dataUrl, name = "image") {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        state.image = image;
        state.imageName = name;
        state.imageWidth = image.naturalWidth || image.width;
        state.imageHeight = image.naturalHeight || image.height;
        state.sourceCache = null;
        state.groundTruth = null;
        dom.imageName.textContent = `${name} · ${state.imageWidth} × ${state.imageHeight} px`;
        state.calibration.point1 = null;
        state.calibration.point2 = null;
        state.measure = { point1: null, point2: null };
        state.roi = null;
        state.processing.thresholdTouched = false;
        resetAnalysis();
        fitImage("workspaceView");
        fitImage("geometryView");
        updateCalibrationReadout();
        setStatus("โหลดภาพแล้ว", "done");
        resolve();
      };
      image.onerror = () => reject(new Error("ไม่สามารถอ่านไฟล์ภาพนี้ได้ (ไฟล์ HEIC ของ iPhone ให้แปลงเป็น JPG ก่อน)"));
      image.src = dataUrl;
    });
  }

  function handleImageFile(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      toast("รองรับเฉพาะไฟล์ PNG, JPG และ WEBP", "error");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast("ไฟล์ใหญ่เกิน 20 MB", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await loadImageFromDataUrl(reader.result, file.name);
        toast("โหลดภาพแล้ว — ต่อไปตั้งสเกลด้วยไม้บรรทัด", "success");
      } catch (error) {
        toast(error.message, "error", 6000);
      }
    };
    reader.readAsDataURL(file);
  }

  function mulberry32(seed) {
    return function random() {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function drawRuler(ctx, x, y, pxPerMm, lengthMm) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x - 10, y - 4, lengthMm * pxPerMm + 20, 46);
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 2;
    for (let mm = 0; mm <= lengthMm; mm += 1) {
      const tx = x + mm * pxPerMm;
      const long = mm % 10 === 0;
      if (!long && pxPerMm < 3) continue;
      ctx.beginPath();
      ctx.moveTo(tx, y);
      ctx.lineTo(tx, y + (long ? 22 : mm % 5 === 0 ? 15 : 9));
      ctx.stroke();
      if (long) {
        ctx.font = "bold 13px sans-serif";
        ctx.fillStyle = "#111827";
        ctx.textAlign = "center";
        ctx.fillText(String(mm / 10), tx, y + 38);
        ctx.textAlign = "left";
      }
    }
    ctx.font = "bold 12px sans-serif";
    ctx.fillText("cm", x + lengthMm * pxPerMm + 2, y + 38);
  }

  function createDemoImage() {
    const canvas = document.createElement("canvas");
    canvas.width = 1400;
    canvas.height = 900;
    const ctx = canvas.getContext("2d");
    const background = ctx.createLinearGradient(0, 0, 1400, 900);
    background.addColorStop(0, "#e5e7eb");
    background.addColorStop(1, "#cbd5e1");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(700, 430, 500, 335, -0.04, 0, Math.PI * 2);
    ctx.clip();
    const crumb = ctx.createRadialGradient(620, 340, 40, 700, 430, 620);
    crumb.addColorStop(0, "#f8e7bd");
    crumb.addColorStop(0.58, "#e8c989");
    crumb.addColorStop(1, "#a86b2c");
    ctx.fillStyle = crumb;
    ctx.fillRect(160, 70, 1080, 720);
    const random = mulberry32(1508);
    for (let i = 0; i < 115; i += 1) {
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random());
      const x = 700 + Math.cos(angle) * radius * 445;
      const y = 430 + Math.sin(angle) * radius * 280;
      const rx = 8 + random() * 34;
      const ry = 6 + random() * 25;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((random() - 0.5) * 1.2);
      ctx.fillStyle = `rgba(${28 + random() * 25},${19 + random() * 20},${12 + random() * 13},${0.78 + random() * 0.18})`;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
    ctx.strokeStyle = "#7c4a1d";
    ctx.lineWidth = 26;
    ctx.beginPath();
    ctx.ellipse(700, 430, 505, 340, -0.04, 0, Math.PI * 2);
    ctx.stroke();
    drawRuler(ctx, 140, 815, 5, 100);
    return canvas.toDataURL("image/png");
  }

  /** ภาพทดสอบ: รูปทรงที่รู้พื้นที่และเส้นรอบรูปแน่นอน + สัญญาณรบกวน */
  function createAccuracyTestImage() {
    const W = 1400;
    const H = 900;
    const pxPerMm = 5;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgb(226,200,152)";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgb(72,48,28)";
    const truth = [];
    const circleRadiiMm = [0.8, 1.2, 1.6, 2.4, 3.2, 4.8, 6.4, 9.6];
    let x = 90;
    circleRadiiMm.forEach((rMm, index) => {
      const r = rMm * pxPerMm;
      const cx = x + r;
      const cy = index % 2 ? 210 : 330;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      truth.push({ label: `วงกลม r = ${rMm} mm`, cx, cy, areaPx: Math.PI * r * r, perimeterPx: 2 * Math.PI * r });
      x = cx + r + 60;
    });
    // วงรี
    const ellipses = [[300, 560, 10, 4.5, 0.5], [620, 600, 6, 3, -0.3]];
    for (const [cx, cy, aMm, bMm, rot] of ellipses) {
      const a = aMm * pxPerMm;
      const b = bMm * pxPerMm;
      ctx.beginPath();
      ctx.ellipse(cx, cy, a, b, rot, 0, Math.PI * 2);
      ctx.fill();
      const h = ((a - b) / (a + b)) ** 2;
      truth.push({ label: `วงรี ${aMm * 2}×${bMm * 2} mm`, cx, cy, areaPx: Math.PI * a * b, perimeterPx: Math.PI * (a + b) * (1 + 3 * h / (10 + Math.sqrt(4 - 3 * h))) });
    }
    // สี่เหลี่ยม
    ctx.save();
    ctx.translate(900, 590);
    ctx.rotate(0.35);
    ctx.fillRect(-60, -25, 120, 50);
    ctx.restore();
    truth.push({ label: "สี่เหลี่ยม 24×10 mm", cx: 900, cy: 590, areaPx: 120 * 50, perimeterPx: 340 });
    // สามเหลี่ยม
    ctx.beginPath();
    ctx.moveTo(1120, 520); ctx.lineTo(1220, 660); ctx.lineTo(1040, 660); ctx.closePath();
    ctx.fill();
    const tri = [[1120, 520], [1220, 660], [1040, 660]];
    const triArea = Math.abs((tri[1][0] - tri[0][0]) * (tri[2][1] - tri[0][1]) - (tri[2][0] - tri[0][0]) * (tri[1][1] - tri[0][1])) / 2;
    const triPer = Math.hypot(100, 140) + 180 + Math.hypot(80, 140);
    truth.push({ label: "สามเหลี่ยม", cx: (1120 + 1220 + 1040) / 3, cy: (520 + 660 + 660) / 3, areaPx: triArea, perimeterPx: triPer });

    // สัญญาณรบกวนแบบสุ่ม (จำลองกล้อง)
    const imageData = ctx.getImageData(0, 0, W, H);
    const random = mulberry32(42);
    for (let i = 0; i < imageData.data.length; i += 4) {
      const noise = (random() + random() + random() - 1.5) * 18;
      imageData.data[i] = clamp(imageData.data[i] + noise, 0, 255);
      imageData.data[i + 1] = clamp(imageData.data[i + 1] + noise, 0, 255);
      imageData.data[i + 2] = clamp(imageData.data[i + 2] + noise, 0, 255);
    }
    ctx.putImageData(imageData, 0, 0);
    drawRuler(ctx, 100, 790, pxPerMm, 100);
    truth.forEach((item) => { item.circularity = Math.min(1, 4 * Math.PI * item.areaPx / item.perimeterPx ** 2); });
    return { dataUrl: canvas.toDataURL("image/png"), truth, pxPerMm };
  }

  // ------------------------------------------------------------------
  // ประมวลผลภาพ
  // ------------------------------------------------------------------
  function normaliseRoi(roi) {
    if (!roi) return null;
    const x1 = clamp(Math.floor(Math.min(roi.x, roi.x + roi.width)), 0, state.imageWidth);
    const y1 = clamp(Math.floor(Math.min(roi.y, roi.y + roi.height)), 0, state.imageHeight);
    const x2 = clamp(Math.ceil(Math.max(roi.x, roi.x + roi.width)), 0, state.imageWidth);
    const y2 = clamp(Math.ceil(Math.max(roi.y, roi.y + roi.height)), 0, state.imageHeight);
    return { type: roi.type === "ellipse" ? "ellipse" : "rect", x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) };
  }

  function isInsideRoiShape(x, y, width, height, type) {
    if (type !== "ellipse") return true;
    const rx = width / 2;
    const ry = height / 2;
    const dx = (x + 0.5 - rx) / rx;
    const dy = (y + 0.5 - ry) / ry;
    return dx * dx + dy * dy <= 1;
  }

  /** ตัดภาพตาม ROI → ภาพระดับเทา (ย่อเฉพาะเมื่อ ROI ใหญ่กว่า MAX_PROCESSING_DIMENSION) */
  function createProcessingSource(roi) {
    const key = `${state.imageName}|${state.imageWidth}|${roi.type}|${roi.x}|${roi.y}|${roi.width}|${roi.height}`;
    if (state.sourceCache?.key === key) return state.sourceCache.source;
    const longest = Math.max(roi.width, roi.height);
    const processScale = Math.min(1, MAX_PROCESSING_DIMENSION / longest);
    const width = Math.max(1, Math.round(roi.width * processScale));
    const height = Math.max(1, Math.round(roi.height * processScale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = processScale < 1;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(state.image, roi.x, roi.y, roi.width, roi.height, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    const gray = new Uint8Array(width * height);
    const insideMask = new Uint8Array(width * height);
    const histogram = new Uint32Array(256);
    let insideCount = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const offset = index * 4;
        const value = Math.round(0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2]);
        gray[index] = value;
        if (!isInsideRoiShape(x, y, width, height, roi.type)) continue;
        insideMask[index] = 1;
        histogram[value] += 1;
        insideCount += 1;
      }
    }
    const source = { gray, insideMask, histogram, insideCount, width, height, scaleX: roi.width / width, scaleY: roi.height / height };
    state.sourceCache = { key, source };
    return source;
  }

  /** Otsu: คืนค่า t ที่แบ่งเป็นกลุ่ม [0..t] และ [t+1..255] ให้ความแปรปรวนระหว่างกลุ่มมากที่สุด */
  function otsuThreshold(histogram, total) {
    let weightedTotal = 0;
    for (let i = 0; i < 256; i += 1) weightedTotal += i * histogram[i];
    let backgroundWeight = 0;
    let backgroundSum = 0;
    let best = 128;
    let bestVariance = -1;
    for (let threshold = 0; threshold < 256; threshold += 1) {
      backgroundWeight += histogram[threshold];
      if (!backgroundWeight) continue;
      const foregroundWeight = total - backgroundWeight;
      if (!foregroundWeight) break;
      backgroundSum += threshold * histogram[threshold];
      const meanBackground = backgroundSum / backgroundWeight;
      const meanForeground = (weightedTotal - backgroundSum) / foregroundWeight;
      const variance = backgroundWeight * foregroundWeight * (meanBackground - meanForeground) ** 2;
      if (variance > bestVariance) {
        bestVariance = variance;
        best = threshold;
      }
    }
    return best;
  }

  function createBinaryMask(source, threshold, mode) {
    const mask = new Uint8Array(source.width * source.height);
    for (let index = 0; index < mask.length; index += 1) {
      if (!source.insideMask[index]) continue;
      const gray = source.gray[index];
      // สอดคล้องกับ Otsu: กลุ่มมืดคือ ≤ t, กลุ่มสว่างคือ > t
      mask[index] = (mode === "light" ? gray > threshold : gray <= threshold) ? 1 : 0;
    }
    return mask;
  }

  /**
   * Erosion / Dilation 3×3 แบบแยกแถว-คอลัมน์
   * พิกเซลนอก ROI และนอกภาพถือเป็น "ไม่มีผล" จึงไม่กัดกร่อนรูที่อยู่ติดขอบ ROI
   */
  function morph(mask, insideMask, width, height, type) {
    const erode = type === "erode";
    const neutral = erode ? 1 : 0;
    const value = (index) => (insideMask[index] ? mask[index] : neutral);
    const rowPass = new Uint8Array(mask.length);
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const i = row + x;
        const a = x > 0 ? value(i - 1) : neutral;
        const b = value(i);
        const c = x < width - 1 ? value(i + 1) : neutral;
        rowPass[i] = erode ? (a & b & c) : (a | b | c);
      }
    }
    const result = new Uint8Array(mask.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        if (!insideMask[i]) continue;
        const a = y > 0 ? rowPass[i - width] : neutral;
        const b = rowPass[i];
        const c = y < height - 1 ? rowPass[i + width] : neutral;
        result[i] = erode ? (a & b & c) : (a | b | c);
      }
    }
    return result;
  }

  /** Opening (ลบจุดเล็ก) แล้ว Closing (เติมรอยแตกเล็ก) */
  function cleanMask(mask, insideMask, width, height) {
    const opened = morph(morph(mask, insideMask, width, height, "erode"), insideMask, width, height, "dilate");
    return morph(morph(opened, insideMask, width, height, "dilate"), insideMask, width, height, "erode");
  }

  function buildMaskCanvas(mask, insideMask, width, height, type) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const imageData = ctx.createImageData(width, height);
    const out = imageData.data;
    for (let index = 0; index < mask.length; index += 1) {
      const offset = index * 4;
      if (!insideMask[index]) continue;
      if (type === "binary") {
        const value = mask[index] ? 255 : 18;
        out[offset] = value; out[offset + 1] = value; out[offset + 2] = value; out[offset + 3] = 255;
      } else if (mask[index]) {
        out[offset] = 249; out[offset + 1] = 115; out[offset + 2] = 22; out[offset + 3] = 190;
      }
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  /**
   * เส้นรอบรูปด้วย Marching Squares แบบถ่วงน้ำหนัก
   * - นับส่วนของเส้นขอบที่ผ่านจุดกึ่งกลางระหว่างพิกเซลรูกับพิกเซลพื้น แยกเป็นส่วนแนวแกน และส่วนแนวทแยง
   * - ถ้าใช้ความยาวตรง ๆ (1 และ √2/2) จะได้ค่าเกินจริง ~5% เพราะเส้นหยักแบบขั้นบันได
   * - น้ำหนัก 0.9473 และ 0.6735 ได้จากการ fit กับวงกลม วงรี สี่เหลี่ยมที่หมุนแบบสุ่ม 600 รูป
   *   ทำให้คลาด < 1% สำหรับรูปทรงโค้งเรียบ (การนับขอบพิกเซลแบบเดิมเกินจริง ~27%)
   */
  const PERIMETER_AXIS_WEIGHT = 0.9473;
  const PERIMETER_DIAGONAL_WEIGHT = 0.6735;
  function componentPerimeter(labelMap, gridWidth, bounds, label, sx, sy) {
    const diagonal = PERIMETER_DIAGONAL_WEIGHT * Math.hypot(sx, sy) / Math.SQRT2;
    sx *= PERIMETER_AXIS_WEIGHT;
    sy *= PERIMETER_AXIS_WEIGHT;
    const x0 = bounds.x;
    const y0 = bounds.y;
    const x1 = bounds.x + bounds.width;
    const y1 = bounds.y + bounds.height;
    const at = (x, y) => (x >= x0 && x < x1 && y >= y0 && y < y1 && labelMap[y * gridWidth + x] === label ? 1 : 0);
    let perimeter = 0;
    for (let y = y0 - 1; y < y1; y += 1) {
      for (let x = x0 - 1; x < x1; x += 1) {
        const code = at(x, y) | (at(x + 1, y) << 1) | (at(x + 1, y + 1) << 2) | (at(x, y + 1) << 3);
        switch (code) {
          case 0: case 15: break;
          case 3: case 12: perimeter += sx; break;
          case 6: case 9: perimeter += sy; break;
          case 5: case 10: perimeter += 2 * diagonal; break;
          default: perimeter += diagonal;
        }
      }
    }
    return perimeter;
  }

  function detectComponents(source, mask, roi) {
    const { width, height, scaleX: sx, scaleY: sy } = source;
    const labelMap = new Int32Array(mask.length);
    const queue = new Int32Array(mask.length);
    const pores = [];
    const areaPerProcessPixel = sx * sy;
    const roiAreaPx = source.insideCount * areaPerProcessPixel;
    const maxAreaPx = roiAreaPx * (Number(state.processing.maxAreaPercent) / 100);
    const minAreaPx = Math.max(1, Number(state.processing.minAreaPx) || 1);
    const excluded = { small: 0, large: 0, boundary: 0 };
    let maskPixelCount = 0;
    let nextLabel = 1;

    for (let start = 0; start < mask.length; start += 1) {
      if (!mask[start] || labelMap[start]) continue;
      const label = nextLabel;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      labelMap[start] = label;
      let sumX = 0;
      let sumY = 0;
      let minX = width;
      let minY = height;
      let maxX = 0;
      let maxY = 0;
      let touchesBoundary = false;

      while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = (index - x) / width;
        sumX += x; sumY += y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (let dy = -1; dy <= 1; dy += 1) {
          const ny = y + dy;
          for (let dx = -1; dx <= 1; dx += 1) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) { touchesBoundary = true; continue; }
            const neighbor = ny * width + nx;
            if (!source.insideMask[neighbor]) { touchesBoundary = true; continue; }
            if (mask[neighbor] && !labelMap[neighbor]) {
              labelMap[neighbor] = label;
              queue[tail++] = neighbor;
            }
          }
        }
      }

      const count = tail;
      maskPixelCount += count;
      const areaPx = count * areaPerProcessPixel;
      let reason = null;
      if (areaPx < minAreaPx) reason = "small";
      else if (areaPx > maxAreaPx) reason = "large";
      else if (state.processing.excludeBoundary && touchesBoundary) reason = "boundary";
      if (reason) {
        excluded[reason] += 1;
        for (let i = 0; i < tail; i += 1) labelMap[queue[i]] = -1; // -1 = รูที่ไม่นับ
        continue;
      }
      nextLabel += 1;
      const processBounds = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
      const perimeterPx = componentPerimeter(labelMap, width, processBounds, label, sx, sy);
      const eqDiameterPx = 2 * Math.sqrt(areaPx / Math.PI);
      const circularity = perimeterPx ? Math.min(1, (4 * Math.PI * areaPx) / perimeterPx ** 2) : 0;
      pores.push({
        id: "",
        label,
        areaPx,
        perimeterPx,
        equivalentDiameterPx: eqDiameterPx,
        circularity,
        center: { x: roi.x + (sumX / count + 0.5) * sx, y: roi.y + (sumY / count + 0.5) * sy },
        boundingBox: { x: roi.x + minX * sx, y: roi.y + minY * sy, width: processBounds.width * sx, height: processBounds.height * sy },
        processBounds,
      });
    }

    const unitPerPixel = getUnitPerPixel();
    pores.sort((a, b) => b.areaPx - a.areaPx);
    pores.forEach((pore, index) => {
      pore.id = `P-${String(index + 1).padStart(3, "0")}`;
      pore.areaReal = unitPerPixel ? pore.areaPx * unitPerPixel ** 2 : null;
      pore.perimeterReal = unitPerPixel ? pore.perimeterPx * unitPerPixel : null;
      pore.equivalentDiameterReal = unitPerPixel ? pore.equivalentDiameterPx * unitPerPixel : null;
    });
    return { pores, labelMap, roiAreaPx, excluded, maskAreaPx: maskPixelCount * areaPerProcessPixel };
  }

  function buildAcceptedOverlay(labelMap, insideMask, width, height) {
    const accepted = new Uint8Array(labelMap.length);
    for (let i = 0; i < labelMap.length; i += 1) accepted[i] = labelMap[i] > 0 ? 1 : 0;
    return buildMaskCanvas(accepted, insideMask, width, height, "overlay");
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  /** S.D. ของกลุ่มตัวอย่าง (หารด้วย n − 1) */
  function standardDeviation(values) {
    if (values.length < 2) return 0;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
  }

  async function analyzeImage(options = {}) {
    if (!state.image) {
      toast("กรุณาเลือกภาพก่อน", "warn");
      flashSection("#section-image");
      return;
    }
    if (!state.roi || state.roi.width < 8 || state.roi.height < 8) {
      toast("ลาก ROI ครอบเนื้อขนมปังก่อน หรือกด “ใช้ทั้งภาพ”", "warn");
      flashSection("#section-roi");
      setTool("roi-ellipse");
      return;
    }
    try {
      setStatus("กำลังตรวจหารูพรุน…", "working");
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const roi = normaliseRoi(state.roi);
      const source = createProcessingSource(roi);
      if (!state.processing.thresholdTouched) {
        const threshold = otsuThreshold(source.histogram, source.insideCount);
        state.processing.threshold = threshold;
        state.processing.thresholdTouched = true;
        dom.thresholdInput.value = threshold;
        dom.thresholdValue.textContent = threshold;
        toast(`ใช้ Threshold อัตโนมัติ (Otsu) = ${threshold} — ปรับเองได้ด้วยแถบเลื่อน`, "info", 5000);
      }
      let binaryMask = createBinaryMask(source, Number(state.processing.threshold), state.processing.poreMode);
      if (state.processing.cleanMask) binaryMask = cleanMask(binaryMask, source.insideMask, source.width, source.height);
      const result = detectComponents(source, binaryMask, roi);
      const areasPx = result.pores.map((pore) => pore.areaPx);
      const totalAreaPx = areasPx.reduce((sum, area) => sum + area, 0);
      const k2 = getUnitPerPixel() ? getUnitPerPixel() ** 2 : null;
      const real = (value) => (k2 ? value * k2 : null);
      const meanAreaPx = areasPx.length ? totalAreaPx / areasPx.length : 0;
      const previousSelected = state.selectedPoreId;
      state.analysis = {
        roi,
        source,
        labelMap: result.labelMap,
        binaryCanvas: buildMaskCanvas(binaryMask, source.insideMask, source.width, source.height, "binary"),
        overlayCanvas: buildAcceptedOverlay(result.labelMap, source.insideMask, source.width, source.height),
        pores: result.pores,
        summary: {
          poreCount: result.pores.length,
          totalAreaPx,
          totalAreaReal: real(totalAreaPx),
          meanAreaPx,
          meanAreaReal: real(meanAreaPx),
          medianAreaPx: median(areasPx),
          medianAreaReal: real(median(areasPx)),
          sdAreaPx: standardDeviation(areasPx),
          sdAreaReal: k2 ? standardDeviation(areasPx) * k2 : null,
          roiAreaPx: result.roiAreaPx,
          roiAreaReal: real(result.roiAreaPx),
          porosityPercent: result.roiAreaPx ? (totalAreaPx / result.roiAreaPx) * 100 : 0,
          voidFractionPercent: result.roiAreaPx ? (result.maskAreaPx / result.roiAreaPx) * 100 : 0,
          excluded: result.excluded,
          threshold: state.processing.threshold,
        },
      };
      const keep = result.pores.find((pore) => pore.id === previousSelected);
      state.selectedPoreId = keep ? keep.id : result.pores[0]?.id || null;
      state.geometry.selectedPoreId = state.selectedPoreId;
      state.calculus.poreId = state.selectedPoreId;
      state.geometry.shapes = [];
      state.geometry.polygonDraft = [];
      if (!options.quiet) {
        if (window.innerWidth <= 1100) $(".workspace-panel").scrollIntoView({ behavior: "smooth", block: "start" });
        state.viewMode = "detection";
        $$(".view-button").forEach((button) => button.classList.toggle("active", button.dataset.view === "detection"));
      }
      updateSummary();
      renderPoreTable();
      refreshPoreSelects();
      renderValidation();
      drawWorkspace();
      drawGeometryCanvas();
      const count = result.pores.length;
      setStatus(
        count
          ? `พบรูพรุน ${count} รู (Threshold ${state.processing.threshold}) — ตรวจผลในโหมด “ขาว-ดำ” และ “รูที่พบ”`
          : "ไม่พบรูพรุนตามเกณฑ์ ลองเลื่อน Threshold หรือลดพื้นที่ต่ำสุด",
        count ? "done" : "error",
      );
    } catch (error) {
      console.error(error);
      setStatus(error.message || "วิเคราะห์ภาพไม่สำเร็จ", "error");
    }
  }

  // ------------------------------------------------------------------
  // สรุปผล / ตาราง / การเลือกรู
  // ------------------------------------------------------------------
  function updateSummary() {
    const summary = state.analysis?.summary;
    const area = (pxValue) => (summary ? `${fmt(toAreaUnits(pxValue))} ${areaUnit()}` : "—");
    $("#summaryCount").textContent = summary ? summary.poreCount : "—";
    $("#summaryTotalArea").textContent = area(summary?.totalAreaPx);
    $("#summaryMeanArea").textContent = area(summary?.meanAreaPx);
    $("#summaryMedianArea").textContent = area(summary?.medianAreaPx);
    $("#summarySdArea").textContent = area(summary?.sdAreaPx);
    $("#summaryPorosity").textContent = summary ? `${formatNumber(summary.porosityPercent, 2)}%` : "—";
    $("#summaryVoid").textContent = summary ? `${formatNumber(summary.voidFractionPercent, 2)}%` : "—";
    const ex = summary?.excluded;
    $("#summaryExcluded").textContent = ex && (ex.small || ex.large || ex.boundary)
      ? `ไม่นับ: เล็กเกิน ${ex.small} · ใหญ่เกิน ${ex.large} · ถูกขอบ ROI ตัด ${ex.boundary}`
      : "";
  }

  const getPore = (id) => state.analysis?.pores.find((pore) => pore.id === id) || null;
  const getSelectedPore = () => getPore(state.selectedPoreId);
  const getGeometryPore = () => getPore(state.geometry.selectedPoreId);
  const getCalculusPore = () => getPore(state.calculus.poreId);

  function selectPore(poreId, options = {}) {
    if (!getPore(poreId)) return;
    state.selectedPoreId = poreId;
    state.geometry.selectedPoreId = poreId;
    state.calculus.poreId = poreId;
    state.geometry.polygonDraft = [];
    dom.geometryPoreSelect.value = poreId;
    dom.calculusPoreSelect.value = poreId;
    renderPoreTable();
    if (options.zoom) {
      zoomToBox("workspaceView", getPore(poreId).boundingBox, 120);
    }
    drawWorkspace();
    drawGeometryCanvas();
  }

  function renderPoreTable() {
    const pores = state.analysis?.pores || [];
    if (!pores.length) {
      dom.poreTableBody.innerHTML = '<tr><td colspan="6" class="empty-table-cell">ยังไม่มีข้อมูล</td></tr>';
      dom.selectedPoreCard.classList.add("hidden");
      return;
    }
    const au = areaUnit();
    const lu = lengthUnit();
    dom.poreTableBody.innerHTML = pores.map((pore) => `
      <tr data-pore-id="${pore.id}" class="${pore.id === state.selectedPoreId ? "selected" : ""}">
        <td><strong>${pore.id}</strong></td>
        <td>${fmt(toAreaUnits(pore.areaPx))} ${au}</td>
        <td>${fmt(toLengthUnits(pore.perimeterPx))} ${lu}</td>
        <td>${fmt(toLengthUnits(pore.equivalentDiameterPx))} ${lu}</td>
        <td>${formatNumber(pore.circularity, 3)}</td>
        <td>(${formatNumber(pore.center.x, 0)}, ${formatNumber(pore.center.y, 0)})</td>
      </tr>`).join("");
    const selected = getSelectedPore();
    if (selected) {
      dom.selectedPoreCard.innerHTML = `
        <strong>${selected.id}</strong>
        <span>พื้นที่ ${fmt(toAreaUnits(selected.areaPx))} ${au}</span>
        <span>เส้นผ่านศูนย์กลางสมมูล ${fmt(toLengthUnits(selected.equivalentDiameterPx))} ${lu}</span>
        <span>Circularity ${formatNumber(selected.circularity, 3)}</span>`;
      dom.selectedPoreCard.classList.remove("hidden");
    }
  }

  function refreshPoreSelects() {
    const pores = state.analysis?.pores || [];
    const options = pores.length
      ? pores.map((pore) => `<option value="${pore.id}">${pore.id} · ${fmt(toAreaUnits(pore.areaPx))} ${areaUnit()}</option>`).join("")
      : '<option value="">ยังไม่มีข้อมูล</option>';
    dom.geometryPoreSelect.innerHTML = options;
    dom.calculusPoreSelect.innerHTML = options;
    if (pores.length) {
      dom.geometryPoreSelect.value = state.geometry.selectedPoreId || pores[0].id;
      dom.calculusPoreSelect.value = state.calculus.poreId || pores[0].id;
    }
  }

  function findPoreAtImagePoint(point) {
    const analysis = state.analysis;
    if (!analysis) return null;
    const { source, roi, labelMap } = analysis;
    const px = Math.floor((point.x - roi.x) / source.scaleX);
    const py = Math.floor((point.y - roi.y) / source.scaleY);
    if (px >= 0 && px < source.width && py >= 0 && py < source.height) {
      const label = labelMap[py * source.width + px];
      if (label > 0) return analysis.pores.find((pore) => pore.label === label) || null;
    }
    // ไม่โดนพิกเซลรูพอดี → เลือกรูที่จุดศูนย์กลางใกล้ที่สุดภายในระยะ 12 px บนจอ
    const tolerance = 12 / state.workspaceView.scale;
    let best = null;
    let bestDistance = Infinity;
    for (const pore of analysis.pores) {
      const box = pore.boundingBox;
      const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width));
      const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height));
      const distance = Math.hypot(dx, dy);
      if (distance <= tolerance && distance < bestDistance) { best = pore; bestDistance = distance; }
    }
    return best;
  }

  function renderValidation() {
    const card = $("#validationCard");
    const truth = state.groundTruth;
    if (!truth || !state.analysis) {
      card.classList.toggle("hidden", !truth);
      if (truth) {
        $("#validationBody").innerHTML = '<tr><td colspan="5" class="empty-table-cell">กด “วิเคราะห์รูพรุน” เพื่อดูผลเทียบ</td></tr>';
        $("#validationSummary").textContent = "";
      }
      return;
    }
    card.classList.remove("hidden");
    const errors = [];
    const rows = truth.map((item) => {
      const pore = findPoreAtImagePoint({ x: item.cx, y: item.cy });
      if (!pore) return `<tr><td>${item.label}</td><td>${fmt(toAreaUnits(item.areaPx))}</td><td colspan="3">ไม่พบ</td></tr>`;
      const error = (pore.areaPx - item.areaPx) / item.areaPx * 100;
      errors.push(Math.abs(error));
      const cls = Math.abs(error) < 2 ? "err-good" : Math.abs(error) < 5 ? "err-ok" : "err-bad";
      return `<tr><td>${item.label}</td><td>${fmt(toAreaUnits(item.areaPx))}</td><td>${fmt(toAreaUnits(pore.areaPx))}</td><td class="${cls}">${error >= 0 ? "+" : ""}${formatNumber(error, 2)}%</td><td>${formatNumber(pore.circularity, 2)} / ${formatNumber(item.circularity, 2)}</td></tr>`;
    });
    $("#validationBody").innerHTML = rows.join("");
    const mean = errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : 0;
    $("#validationSummary").innerHTML = `พื้นที่หน่วย ${areaUnit()} · คลาดเคลื่อนเฉลี่ย <strong>${formatNumber(mean, 2)}%</strong> · คอลัมน์ Circ. = วัดได้ / ค่าจริง<br>รูยิ่งเล็ก (มีพิกเซลน้อย) ยิ่งคลาดมาก เพราะขอบรูเป็นสัดส่วนที่ใหญ่ขึ้น`;
  }

  // ------------------------------------------------------------------
  // เมาส์บนภาพหลัก
  // ------------------------------------------------------------------
  function handleWorkspacePointerDown(event) {
    if (!state.image) return;
    const point = screenToImage(dom.workspaceCanvas, state.workspaceView, event.clientX, event.clientY);
    if (state.tool === "pan" || event.button === 1) {
      state.interaction = { type: "pan", startScreen: { x: point.sx, y: point.sy }, startView: { ...state.workspaceView } };
      dom.workspaceCanvas.style.cursor = "grabbing";
      dom.workspaceCanvas.setPointerCapture?.(event.pointerId);
      return;
    }
    if (!imagePointInBounds(point)) return;
    if (state.tool === "scale" || state.tool === "measure") {
      const line = state.tool === "scale" ? state.calibration : state.measure;
      const tolerance = 14 / state.workspaceView.scale;
      const hit1 = line.point1 && Math.hypot(point.x - line.point1.x, point.y - line.point1.y) <= tolerance;
      const hit2 = line.point2 && Math.hypot(point.x - line.point2.x, point.y - line.point2.y) <= tolerance;
      if (hit1 || hit2) {
        state.interaction = { type: "drag-point", line: state.tool, key: hit1 ? "point1" : "point2" };
        dom.workspaceCanvas.setPointerCapture?.(event.pointerId);
        return;
      }
      if (!line.point1 || line.point2) {
        line.point1 = { x: point.x, y: point.y };
        line.point2 = null;
        toast("คลิกจุดที่สอง", "info", 2000);
      } else {
        line.point2 = { x: point.x, y: point.y };
        if (state.tool === "scale") {
          dom.realLengthInput.focus();
          dom.realLengthInput.select();
          flashSection("#section-scale");
          toast("พิมพ์ระยะจริงระหว่าง 2 จุด (เช่น 10 mm) ในช่องทางซ้าย", "success", 5000);
          scheduleAnalyze();
        }
      }
      updateCalibrationReadout();
      drawWorkspace();
      return;
    }
    if (state.tool === "roi-ellipse" || state.tool === "roi-rect") {
      state.interaction = { type: state.tool, start: { x: point.x, y: point.y }, current: { x: point.x, y: point.y } };
      dom.workspaceCanvas.setPointerCapture?.(event.pointerId);
      return;
    }
    if (state.tool === "select") {
      const pore = findPoreAtImagePoint(point);
      if (pore) {
        selectPore(pore.id);
        dom.poreTableBody.querySelector(`[data-pore-id="${pore.id}"]`)?.scrollIntoView({ block: "nearest" });
      }
    }
  }

  function handleWorkspacePointerMove(event) {
    const interaction = state.interaction;
    if (!interaction) return;
    const point = screenToImage(dom.workspaceCanvas, state.workspaceView, event.clientX, event.clientY);
    if (interaction.type === "pan") {
      state.workspaceView.x = interaction.startView.x + (point.sx - interaction.startScreen.x);
      state.workspaceView.y = interaction.startView.y + (point.sy - interaction.startScreen.y);
    } else if (interaction.type === "drag-point") {
      const line = interaction.line === "scale" ? state.calibration : state.measure;
      line[interaction.key] = { x: clamp(point.x, 0, state.imageWidth), y: clamp(point.y, 0, state.imageHeight) };
      updateCalibrationReadout();
    } else if (interaction.type.startsWith("roi")) {
      interaction.current = { x: clamp(point.x, 0, state.imageWidth), y: clamp(point.y, 0, state.imageHeight) };
    }
    drawWorkspace();
  }

  function handleWorkspacePointerUp(event) {
    const interaction = state.interaction;
    if (!interaction) return;
    if (interaction.type === "pan") dom.workspaceCanvas.style.cursor = "grab";
    if (interaction.type === "drag-point" && interaction.line === "scale") scheduleAnalyze();
    if (interaction.type.startsWith("roi")) {
      const x = Math.min(interaction.start.x, interaction.current.x);
      const y = Math.min(interaction.start.y, interaction.current.y);
      const width = Math.abs(interaction.current.x - interaction.start.x);
      const height = Math.abs(interaction.current.y - interaction.start.y);
      if (width >= 8 && height >= 8) {
        state.roi = { type: interaction.type === "roi-ellipse" ? "ellipse" : "rect", x, y, width, height };
        if (state.analysis) scheduleAnalyze();
        else toast("กำหนด ROI แล้ว — กด “วิเคราะห์รูพรุน” ได้เลย", "success");
        state.interaction = null;
        setTool("pan");
      } else {
        toast("ROI เล็กเกินไป ลองกดค้างแล้วลากให้กว้างขึ้น", "warn");
      }
    }
    state.interaction = null;
    dom.workspaceCanvas.releasePointerCapture?.(event.pointerId);
    drawWorkspace();
  }

  function handleCanvasWheel(event, viewKey, drawFunction) {
    event.preventDefault();
    if (!state.image) return;
    const canvas = event.currentTarget;
    const view = state[viewKey];
    const rect = canvas.getBoundingClientRect();
    const pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const factor = Math.exp(-clamp(event.deltaY, -120, 120) * 0.0015);
    const nextScale = clamp(view.scale * factor, 0.02, 40);
    const imagePoint = { x: (pointer.x - view.x) / view.scale, y: (pointer.y - view.y) / view.scale };
    state[viewKey] = { scale: nextScale, x: pointer.x - imagePoint.x * nextScale, y: pointer.y - imagePoint.y * nextScale };
    drawFunction();
  }

  // ------------------------------------------------------------------
  // Geometry Lab
  // ------------------------------------------------------------------
  const GEOMETRY_HINTS = {
    circle: "วงกลม — กดค้างแล้วลาก ขนาดวงกลมเท่ากับด้านที่ยาวกว่าของกรอบที่ลาก",
    ellipse: "วงรี — กดค้างแล้วลาก",
    rect: "สี่เหลี่ยม — กดค้างแล้วลาก",
    polygon: "หลายเหลี่ยม — คลิกวางจุดทีละจุด แล้วดับเบิลคลิก กด Enter หรือปุ่ม “จบรูปหลายเหลี่ยม” · Esc = ยกเลิก",
    pan: "เลื่อนภาพ — ลากเพื่อเลื่อน หมุนล้อเพื่อซูม",
  };

  function setGeometryTool(tool) {
    state.geometry.tool = tool;
    $$(".geometry-tool").forEach((button) => button.classList.toggle("active", button.dataset.geometryTool === tool));
    if (tool !== "polygon") state.geometry.polygonDraft = [];
    $("#geometryHint").textContent = GEOMETRY_HINTS[tool];
    dom.geometryCanvas.style.cursor = tool === "pan" ? "grab" : "crosshair";
    drawGeometryCanvas();
  }

  function fitGeometryToSelectedPore() {
    const pore = getGeometryPore();
    if (!pore) return;
    zoomToBox("geometryView", pore.boundingBox, 90);
    drawGeometryCanvas();
  }

  function getPoreMaskCanvas(pore) {
    if (pore._maskCanvas) return pore._maskCanvas;
    const { source, labelMap } = state.analysis;
    const b = pore.processBounds;
    const canvas = document.createElement("canvas");
    canvas.width = b.width;
    canvas.height = b.height;
    const ctx = canvas.getContext("2d");
    const imageData = ctx.createImageData(b.width, b.height);
    for (let y = 0; y < b.height; y += 1) {
      for (let x = 0; x < b.width; x += 1) {
        if (labelMap[(b.y + y) * source.width + b.x + x] !== pore.label) continue;
        const o = (y * b.width + x) * 4;
        imageData.data[o] = 34; imageData.data[o + 1] = 211; imageData.data[o + 2] = 238; imageData.data[o + 3] = 150;
      }
    }
    ctx.putImageData(imageData, 0, 0);
    pore._maskCanvas = canvas;
    return canvas;
  }

  function drawGeometryCanvas() {
    const canvas = dom.geometryCanvas;
    const ctx = canvas.getContext("2d");
    const width = canvas._cssWidth || 900;
    const height = canvas._cssHeight || 660;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, width, height);
    const pore = getGeometryPore();
    dom.geometryEmptyState.classList.toggle("hidden", Boolean(state.image && pore));
    if (!state.image || !pore) return;
    const view = state.geometryView;
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);
    ctx.imageSmoothingEnabled = view.scale < 2;
    ctx.drawImage(state.image, 0, 0, state.imageWidth, state.imageHeight);
    const { roi, source } = state.analysis;
    ctx.drawImage(getPoreMaskCanvas(pore), roi.x + pore.processBounds.x * source.scaleX, roi.y + pore.processBounds.y * source.scaleY, pore.boundingBox.width, pore.boundingBox.height);
    ctx.font = `bold ${15 / view.scale}px sans-serif`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(pore.id, pore.boundingBox.x, pore.boundingBox.y - 8 / view.scale);

    for (const shape of state.geometry.shapes.filter((item) => item.poreId === pore.id)) drawGeometryShape(ctx, shape, view.scale, false);
    if (state.geometryInteraction?.preview) drawGeometryShape(ctx, state.geometryInteraction.preview, view.scale, true);
    const draft = state.geometry.polygonDraft;
    if (draft.length) {
      ctx.save();
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 2.5 / view.scale;
      ctx.setLineDash([7 / view.scale, 4 / view.scale]);
      ctx.beginPath();
      draft.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
      if (state.geometry.hoverPoint) ctx.lineTo(state.geometry.hoverPoint.x, state.geometry.hoverPoint.y);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const point of draft) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 5 / view.scale, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  function drawGeometryShape(ctx, shape, scale, preview) {
    ctx.save();
    ctx.strokeStyle = preview ? "#ffffff" : "#f59e0b";
    ctx.fillStyle = preview ? "rgba(255,255,255,.1)" : "rgba(245,158,11,.22)";
    ctx.lineWidth = (preview ? 2 : 2.6) / scale;
    if (preview) ctx.setLineDash([7 / scale, 4 / scale]);
    ctx.beginPath();
    if (shape.type === "rect") ctx.rect(shape.x, shape.y, shape.width, shape.height);
    else if (shape.type === "ellipse") ctx.ellipse(shape.x, shape.y, shape.radiusX, shape.radiusY, 0, 0, Math.PI * 2);
    else if (shape.type === "circle") ctx.arc(shape.x, shape.y, shape.radius, 0, Math.PI * 2);
    else if (shape.type === "polygon") {
      shape.points.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
      ctx.closePath();
    }
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function geometryShapeFromDrag(tool, start, current, poreId) {
    const x1 = Math.min(start.x, current.x);
    const y1 = Math.min(start.y, current.y);
    const width = Math.abs(current.x - start.x);
    const height = Math.abs(current.y - start.y);
    if (tool === "rect") return { id: uid("shape"), poreId, type: "rect", x: x1, y: y1, width, height };
    if (tool === "ellipse") return { id: uid("shape"), poreId, type: "ellipse", x: x1 + width / 2, y: y1 + height / 2, radiusX: width / 2, radiusY: height / 2 };
    return { id: uid("shape"), poreId, type: "circle", x: x1 + width / 2, y: y1 + height / 2, radius: Math.max(width, height) / 2 };
  }

  function pointInPolygon(points, x, y) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
      const xi = points[i].x; const yi = points[i].y;
      const xj = points[j].x; const yj = points[j].y;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi) inside = !inside;
    }
    return inside;
  }

  function pointInsideGeometry(shape, x, y) {
    if (shape.type === "rect") return x >= shape.x && x <= shape.x + shape.width && y >= shape.y && y <= shape.y + shape.height;
    if (shape.type === "ellipse") {
      const dx = (x - shape.x) / (shape.radiusX || 1e-9);
      const dy = (y - shape.y) / (shape.radiusY || 1e-9);
      return dx * dx + dy * dy <= 1;
    }
    if (shape.type === "circle") return (x - shape.x) ** 2 + (y - shape.y) ** 2 <= shape.radius ** 2;
    if (shape.type === "polygon") return pointInPolygon(shape.points, x, y);
    return false;
  }

  function shapeBounds(shape) {
    if (shape.type === "rect") return { x0: shape.x, y0: shape.y, x1: shape.x + shape.width, y1: shape.y + shape.height };
    if (shape.type === "ellipse") return { x0: shape.x - shape.radiusX, y0: shape.y - shape.radiusY, x1: shape.x + shape.radiusX, y1: shape.y + shape.radiusY };
    if (shape.type === "circle") return { x0: shape.x - shape.radius, y0: shape.y - shape.radius, x1: shape.x + shape.radius, y1: shape.y + shape.radius };
    const xs = shape.points.map((p) => p.x);
    const ys = shape.points.map((p) => p.y);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }

  function polygonArea(points) {
    let sum = 0;
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) / 2;
  }

  function shapeFormulaArea(shape) {
    if (shape.type === "rect") return shape.width * shape.height;
    if (shape.type === "ellipse") return Math.PI * shape.radiusX * shape.radiusY;
    if (shape.type === "circle") return Math.PI * shape.radius ** 2;
    if (shape.type === "polygon") return polygonArea(shape.points);
    return 0;
  }

  function geometryMetricsFor(pore) {
    if (!pore || !state.analysis) return null;
    const shapes = state.geometry.shapes.filter((shape) => shape.poreId === pore.id);
    if (!shapes.length) return { shapeCount: 0, actualAreaPx: pore.areaPx, unionAreaPx: 0, formulaAreaPx: 0, percentError: null, iou: null };
    const { source, roi, labelMap } = state.analysis;
    // ตรวจเฉพาะกรอบที่ครอบรูพรุนและรูปที่วาง
    let gx0 = pore.processBounds.x;
    let gy0 = pore.processBounds.y;
    let gx1 = pore.processBounds.x + pore.processBounds.width;
    let gy1 = pore.processBounds.y + pore.processBounds.height;
    for (const shape of shapes) {
      const b = shapeBounds(shape);
      gx0 = Math.min(gx0, Math.floor((b.x0 - roi.x) / source.scaleX));
      gy0 = Math.min(gy0, Math.floor((b.y0 - roi.y) / source.scaleY));
      gx1 = Math.max(gx1, Math.ceil((b.x1 - roi.x) / source.scaleX));
      gy1 = Math.max(gy1, Math.ceil((b.y1 - roi.y) / source.scaleY));
    }
    // ส่วนของรูปที่อยู่นอก ROI ก็นับเป็นพื้นที่ประมาณด้วย จึงขยายกริดออกไปนอก ROI ได้
    let estimatedCount = 0;
    let intersection = 0;
    let union = 0;
    for (let py = gy0; py < gy1; py += 1) {
      for (let px = gx0; px < gx1; px += 1) {
        const imageX = roi.x + (px + 0.5) * source.scaleX;
        const imageY = roi.y + (py + 0.5) * source.scaleY;
        const estimated = shapes.some((shape) => pointInsideGeometry(shape, imageX, imageY));
        const inGrid = px >= 0 && py >= 0 && px < source.width && py < source.height;
        const actual = inGrid && labelMap[py * source.width + px] === pore.label;
        if (estimated) estimatedCount += 1;
        if (estimated && actual) intersection += 1;
        if (estimated || actual) union += 1;
      }
    }
    const unionAreaPx = estimatedCount * source.scaleX * source.scaleY;
    return {
      shapeCount: shapes.length,
      actualAreaPx: pore.areaPx,
      unionAreaPx,
      formulaAreaPx: shapes.reduce((sum, shape) => sum + shapeFormulaArea(shape), 0),
      percentError: pore.areaPx ? Math.abs(unionAreaPx - pore.areaPx) / pore.areaPx * 100 : 0,
      iou: union ? intersection / union : 0,
    };
  }

  function updateGeometryMetrics() {
    const metrics = geometryMetricsFor(getGeometryPore());
    const area = (v) => (metrics && Number.isFinite(v) ? `${fmt(toAreaUnits(v))} ${areaUnit()}` : "—");
    $("#geoShapeCount").textContent = metrics?.shapeCount ?? 0;
    $("#geoActualArea").textContent = area(metrics?.actualAreaPx);
    $("#geoEstimateArea").textContent = metrics?.shapeCount ? area(metrics.unionAreaPx) : "—";
    $("#geoFormulaArea").textContent = metrics?.shapeCount ? area(metrics.formulaAreaPx) : "—";
    $("#geoPercentError").textContent = metrics?.shapeCount ? `${formatNumber(metrics.percentError, 2)}%` : "—";
    $("#geoIou").textContent = metrics?.shapeCount ? formatNumber(metrics.iou, 3) : "—";
    const success = metrics?.shapeCount > 0 && metrics.percentError < 5 && metrics.iou > 0.85;
    const challenge = $("#geometryChallenge");
    challenge.classList.toggle("success", success);
    challenge.textContent = success
      ? "🎉 ผ่านภารกิจ: Error ต่ำกว่า 5% และ IoU สูงกว่า 0.85"
      : "ภารกิจ: ให้ Error < 5% และ IoU > 0.85";
    renderShapeList();
  }

  function renderShapeList() {
    const pore = getGeometryPore();
    const shapes = pore ? state.geometry.shapes.filter((shape) => shape.poreId === pore.id) : [];
    if (!shapes.length) {
      dom.shapeList.innerHTML = '<span class="shape-chip muted">ยังไม่ได้วางรูป</span>';
      return;
    }
    const names = { circle: "วงกลม", ellipse: "วงรี", rect: "สี่เหลี่ยม", polygon: "หลายเหลี่ยม" };
    dom.shapeList.innerHTML = shapes.map((shape, index) => `
      <span class="shape-chip">${index + 1}. ${names[shape.type] || shape.type} · ${fmt(toAreaUnits(shapeFormulaArea(shape)))} ${areaUnit()}
        <button type="button" data-delete-shape="${shape.id}" aria-label="ลบรูปนี้">×</button>
      </span>`).join("");
  }

  function handleGeometryPointerDown(event) {
    const pore = getGeometryPore();
    if (!state.image || !pore) return;
    const point = screenToImage(dom.geometryCanvas, state.geometryView, event.clientX, event.clientY);
    if (event.shiftKey || event.button === 1 || state.geometry.tool === "pan") {
      state.geometryInteraction = { type: "pan", startScreen: { x: point.sx, y: point.sy }, startView: { ...state.geometryView } };
      dom.geometryCanvas.setPointerCapture?.(event.pointerId);
      return;
    }
    if (!imagePointInBounds(point)) return;
    if (state.geometry.tool === "polygon") {
      if (event.detail >= 2) return; // ดับเบิลคลิกจัดการใน dblclick
      state.geometry.polygonDraft.push({ x: point.x, y: point.y });
      drawGeometryCanvas();
      return;
    }
    state.geometryInteraction = {
      type: "draw",
      start: { x: point.x, y: point.y },
      preview: geometryShapeFromDrag(state.geometry.tool, point, point, pore.id),
    };
    dom.geometryCanvas.setPointerCapture?.(event.pointerId);
  }

  function handleGeometryPointerMove(event) {
    const point = screenToImage(dom.geometryCanvas, state.geometryView, event.clientX, event.clientY);
    const interaction = state.geometryInteraction;
    if (!interaction) {
      if (state.geometry.polygonDraft.length) {
        state.geometry.hoverPoint = { x: point.x, y: point.y };
        drawGeometryCanvas();
      }
      return;
    }
    if (interaction.type === "pan") {
      state.geometryView.x = interaction.startView.x + (point.sx - interaction.startScreen.x);
      state.geometryView.y = interaction.startView.y + (point.sy - interaction.startScreen.y);
    } else {
      const current = { x: clamp(point.x, 0, state.imageWidth), y: clamp(point.y, 0, state.imageHeight) };
      interaction.preview = geometryShapeFromDrag(state.geometry.tool, interaction.start, current, getGeometryPore().id);
    }
    drawGeometryCanvas();
  }

  function handleGeometryPointerUp(event) {
    const interaction = state.geometryInteraction;
    if (!interaction) return;
    if (interaction.type === "draw") {
      const b = shapeBounds(interaction.preview);
      const minSize = 4 / state.geometryView.scale;
      if (b.x1 - b.x0 >= minSize && b.y1 - b.y0 >= minSize) state.geometry.shapes.push(interaction.preview);
    }
    state.geometryInteraction = null;
    dom.geometryCanvas.releasePointerCapture?.(event.pointerId);
    drawGeometryCanvas();
    updateGeometryMetrics();
  }

  function finishPolygon() {
    const pore = getGeometryPore();
    if (!pore) return;
    if (state.geometry.polygonDraft.length < 3) {
      toast("รูปหลายเหลี่ยมต้องมีอย่างน้อย 3 จุด", "warn");
      return;
    }
    state.geometry.shapes.push({ id: uid("shape"), poreId: pore.id, type: "polygon", points: [...state.geometry.polygonDraft] });
    state.geometry.polygonDraft = [];
    state.geometry.hoverPoint = null;
    drawGeometryCanvas();
    updateGeometryMetrics();
  }

  // ------------------------------------------------------------------
  // Calculus Lab
  // ------------------------------------------------------------------
  /**
   * สร้างฟังก์ชันโปรไฟล์ f ของรูพรุน
   * axis = x : f(x) = ความยาวรวมของรูพรุนในแนวตั้ง ณ ตำแหน่ง x (หลักการของคาวาเลียรี)
   * axis = y : g(y) = ความยาวรวมในแนวนอน ณ ตำแหน่ง y
   * ค่าที่คอลัมน์พิกเซลแต่ละคอลัมน์ถูกวางไว้ที่จุดกึ่งกลางคอลัมน์ แล้วเชื่อมด้วยเส้นตรง
   * (ปลายสองข้างคงที่ครึ่งคอลัมน์) ทำให้ ∫ f = พื้นที่ที่นับจากพิกเซล “พอดี”
   */
  function buildProfile(pore, axis) {
    const { source, labelMap, roi } = state.analysis;
    const b = pore.processBounds;
    const k = getUnitPerPixel() || 1;
    const sx = source.scaleX;
    const sy = source.scaleY;
    const W = source.width;
    let values;
    let cell;
    let originImg;
    let imagePerCell;
    if (axis === "x") {
      values = new Float64Array(b.width);
      for (let x = 0; x < b.width; x += 1) {
        let count = 0;
        for (let y = 0; y < b.height; y += 1) if (labelMap[(b.y + y) * W + b.x + x] === pore.label) count += 1;
        values[x] = count * sy * k;
      }
      cell = sx * k;
      originImg = roi.x + b.x * sx;
      imagePerCell = sx;
    } else {
      values = new Float64Array(b.height);
      for (let y = 0; y < b.height; y += 1) {
        let count = 0;
        for (let x = 0; x < b.width; x += 1) if (labelMap[(b.y + y) * W + b.x + x] === pore.label) count += 1;
        values[y] = count * sx * k;
      }
      cell = sy * k;
      originImg = roi.y + b.y * sy;
      imagePerCell = sy;
    }
    let sum = 0;
    let max = 0;
    for (const v of values) { sum += v; if (v > max) max = v; }
    return { axis, values, cell, L: values.length * cell, exact: sum * cell, max, originImg, imagePerCell, poreId: pore.id };
  }

  function evalProfile(profile, u) {
    const { values, cell } = profile;
    const n = values.length;
    const t = u / cell - 0.5;
    if (t <= 0) return values[0];
    if (t >= n - 1) return values[n - 1];
    const i = Math.floor(t);
    return values[i] + (values[i + 1] - values[i]) * (t - i);
  }

  /** ค่าต่ำสุด/สูงสุดของ f บน [a, b] (f เป็นเส้นตรงเป็นช่วง ๆ จึงตรวจแค่ปลายช่วงกับจุดหักมุม) */
  function extremeOn(profile, a, b, kind) {
    let best = evalProfile(profile, a);
    const end = evalProfile(profile, b);
    best = kind === "min" ? Math.min(best, end) : Math.max(best, end);
    const i0 = Math.max(0, Math.ceil(a / profile.cell - 0.5));
    const i1 = Math.min(profile.values.length - 1, Math.floor(b / profile.cell - 0.5));
    for (let i = i0; i <= i1; i += 1) {
      const v = profile.values[i];
      best = kind === "min" ? Math.min(best, v) : Math.max(best, v);
    }
    return best;
  }

  function computeRiemann(profile, requestedN, method) {
    const L = profile.L;
    const n = method === "simpson" && requestedN % 2 ? requestedN + 1 : requestedN;
    const dx = L / n;
    const bars = [];
    let estimate = 0;
    if (method === "simpson") {
      for (let j = 0; j < n / 2; j += 1) {
        const a = 2 * j * dx;
        const m = a + dx;
        const b = a + 2 * dx;
        const h0 = evalProfile(profile, a);
        const hm = evalProfile(profile, m);
        const h1 = evalProfile(profile, b);
        const area = (dx / 3) * (h0 + 4 * hm + h1);
        estimate += area;
        bars.push({ type: "simpson", a, b, h0, hm, h1, area });
      }
    } else {
      for (let i = 0; i < n; i += 1) {
        const a = i * dx;
        const b = a + dx;
        if (method === "trapezoid") {
          const h0 = evalProfile(profile, a);
          const h1 = evalProfile(profile, b);
          const area = ((h0 + h1) / 2) * dx;
          estimate += area;
          bars.push({ type: "trap", a, b, h0, h1, area });
          continue;
        }
        let sample = null;
        let h;
        if (method === "lower") h = extremeOn(profile, a, b, "min");
        else if (method === "upper") h = extremeOn(profile, a, b, "max");
        else {
          sample = method === "left" ? a : method === "right" ? b : (a + b) / 2;
          h = evalProfile(profile, sample);
        }
        const area = h * dx;
        estimate += area;
        bars.push({ type: "rect", a, b, h, sample, area });
      }
    }
    const absoluteError = Math.abs(estimate - profile.exact);
    return {
      method, requestedN, n, dx, bars, estimate,
      exact: profile.exact,
      signedError: estimate - profile.exact,
      absoluteError,
      percentError: profile.exact ? (absoluteError / profile.exact) * 100 : 0,
    };
  }

  const AXIS_VAR = { x: "x", y: "y" };
  const AXIS_FN = { x: "f", y: "g" };

  function methodFormulaHtml(method, axis) {
    const v = AXIS_VAR[axis];
    const f = AXIS_FN[axis];
    const sum = '<span style="font-size:1.25em">Σ</span><sub>i=1</sub><sup>n</sup>';
    const map = {
      left: [`A ≈ ${sum} ${f}(${v}<sub>i−1</sub>) Δ${v}`, "ใช้ความสูงที่ปลายซ้ายของแต่ละแถบ"],
      right: [`A ≈ ${sum} ${f}(${v}<sub>i</sub>) Δ${v}`, "ใช้ความสูงที่ปลายขวาของแต่ละแถบ"],
      midpoint: [`A ≈ ${sum} ${f}(<span style="white-space:nowrap">(${v}<sub>i−1</sub>+${v}<sub>i</sub>)/2</span>) Δ${v}`, "ใช้ความสูงที่จุดกึ่งกลางของแต่ละแถบ — มักแม่นกว่าซ้ายและขวา"],
      lower: [`L<sub>n</sub> = ${sum} m<sub>i</sub> Δ${v}`, `m<sub>i</sub> คือค่าต่ำสุดของ ${f} บนแถบที่ i — สี่เหลี่ยมทุกอันอยู่ใต้กราฟ ผลจึงไม่เกินพื้นที่จริง`],
      upper: [`U<sub>n</sub> = ${sum} M<sub>i</sub> Δ${v}`, `M<sub>i</sub> คือค่าสูงสุดของ ${f} บนแถบที่ i — สี่เหลี่ยมคลุมกราฟ ผลจึงไม่น้อยกว่าพื้นที่จริง`],
      trapezoid: [`A ≈ ${sum} ½[${f}(${v}<sub>i−1</sub>) + ${f}(${v}<sub>i</sub>)] Δ${v}`, "ต่อยอดแถบด้วยเส้นตรง = ค่าเฉลี่ยของผลบวกซ้ายและขวา"],
      simpson: [`A ≈ (Δ${v}/3)[${f}<sub>0</sub> + 4${f}<sub>1</sub> + 2${f}<sub>2</sub> + 4${f}<sub>3</sub> + … + 4${f}<sub>n−1</sub> + ${f}<sub>n</sub>]`, "ต่อยอดทีละ 2 แถบด้วยพาราโบลา (n ต้องเป็นจำนวนคู่ ถ้าเลือกคี่ระบบจะใช้ n+1)"],
    };
    const [formula, note] = map[method];
    return `<strong>${METHOD_NAMES[method]}</strong><span class="formula">${formula}</span><span class="formula">Δ${v} = L / n &nbsp;&nbsp;และ&nbsp;&nbsp; lim<sub>n→∞</sub> = ∫<sub>0</sub><sup>L</sup> ${f}(${v}) d${v} = A</span><p>${note}</p>`;
  }

  function updateCalculus() {
    const pore = getCalculusPore();
    const calc = state.calculus;
    $("#methodFormula").innerHTML = methodFormulaHtml(calc.method, calc.axis);
    $("#profileExplain").textContent = calc.axis === "x"
      ? "f(x) คือความยาวรวมของรูพรุนในแนวตั้ง ณ ตำแหน่ง x — พื้นที่รูพรุนจึงเท่ากับพื้นที่ใต้กราฟ f (หลักของคาวาเลียรี)"
      : "g(y) คือความยาวรวมของรูพรุนในแนวนอน ณ ตำแหน่ง y — พื้นที่รูพรุนจึงเท่ากับพื้นที่ใต้กราฟ g";
    if (!pore) {
      calc.profile = null;
      calc.result = null;
      clearChart($("#riemannChart"), "วิเคราะห์ภาพในแท็บ 1 ก่อน");
      clearChart($("#poreStripCanvas"), "ยังไม่มีรูพรุนให้เลือก");
      clearChart($("#convergenceChart"), "ยังไม่มีข้อมูล");
      ["#calcLength", "#calcDx", "#riemannEstimate", "#riemannActual", "#riemannAbsoluteError", "#riemannPercentError",
        "#squeezeLower", "#squeezeActual", "#squeezeUpper", "#squeezeGap"].forEach((id) => { $(id).textContent = "—"; });
      $("#stepTableHead").innerHTML = "";
      $("#stepTableBody").innerHTML = '<tr><td class="empty-table-cell">ยังไม่มีข้อมูล</td></tr>';
      $("#stepTableFoot").innerHTML = "";
      return;
    }
    if (!calc.profile || calc.profile.poreId !== pore.id || calc.profile.axis !== calc.axis || calc.profile.k !== (getUnitPerPixel() || 1)) {
      calc.profile = buildProfile(pore, calc.axis);
      calc.profile.k = getUnitPerPixel() || 1;
    }
    const profile = calc.profile;
    const result = computeRiemann(profile, calc.n, calc.method);
    calc.result = result;
    const lower = computeRiemann(profile, calc.n, "lower").estimate;
    const upper = computeRiemann(profile, calc.n, "upper").estimate;
    const au = areaUnit();
    const lu = lengthUnit();
    const v = AXIS_VAR[calc.axis];
    $("#calcLength").textContent = `${fmt(profile.L)} ${lu}`;
    $("#calcDx").textContent = `${fmt(result.dx)} ${lu}${result.n !== result.requestedN ? ` (ใช้ n = ${result.n})` : ""}`;
    $("#calcDx").previousElementSibling.textContent = `ความกว้างแถบ Δ${v} = L/n`;
    $("#riemannEstimate").textContent = `${fmt(result.estimate)} ${au}`;
    $("#riemannActual").textContent = `${fmt(result.exact)} ${au}`;
    $("#riemannAbsoluteError").textContent = `${result.signedError >= 0 ? "+" : "−"}${fmt(Math.abs(result.signedError))} ${au}`;
    $("#riemannPercentError").textContent = `${formatNumber(result.percentError, 3)}%`;
    $("#squeezeLower").textContent = fmt(lower);
    $("#squeezeActual").textContent = fmt(result.exact);
    $("#squeezeUpper").textContent = fmt(upper);
    $("#squeezeGap").textContent = `${fmt(upper - lower)} ${au}`;
    drawPoreStrips();
    drawRiemannChart();
    drawConvergenceChart();
    renderStepTable();
    updateStripInfo();
  }

  function stripScreenGeometry(canvas) {
    const { width, height } = chartSize(canvas);
    return { width, height, pad: { left: 58, right: 18, top: 22, bottom: 44 } };
  }

  /** ภาพรูพรุนจริงพร้อมเส้นแบ่งแถบ */
  function drawPoreStrips() {
    const canvas = $("#poreStripCanvas");
    const { ctx, width, height } = prepareChartCanvas(canvas);
    const pore = getCalculusPore();
    const profile = state.calculus.profile;
    const result = state.calculus.result;
    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, width, height);
    if (!pore || !profile || !result) return;
    const box = pore.boundingBox;
    const margin = Math.max(box.width, box.height) * 0.12 + 2;
    const region = { x: box.x - margin, y: box.y - margin, width: box.width + margin * 2, height: box.height + margin * 2 };
    const scale = Math.min((width - 20) / region.width, (height - 20) / region.height);
    const ox = (width - region.width * scale) / 2 - region.x * scale;
    const oy = (height - region.height * scale) / 2 - region.y * scale;
    canvas._view = { scale, ox, oy };
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);
    ctx.imageSmoothingEnabled = scale < 2;
    ctx.drawImage(state.image, 0, 0, state.imageWidth, state.imageHeight);
    const { roi, source } = state.analysis;
    ctx.globalAlpha = 0.9;
    ctx.drawImage(getPoreMaskCanvas(pore), roi.x + pore.processBounds.x * source.scaleX, roi.y + pore.processBounds.y * source.scaleY, box.width, box.height);
    ctx.globalAlpha = 1;
    // แถบ
    const toImage = (u) => profile.originImg + (u / profile.cell) * profile.imagePerCell;
    const hover = state.calculus.hover;
    result.bars.forEach((bar, index) => {
      const p0 = toImage(bar.a);
      const p1 = toImage(bar.b);
      ctx.fillStyle = index === hover ? "rgba(249,115,22,.45)" : index % 2 ? "rgba(249,115,22,.10)" : "rgba(249,115,22,.0)";
      if (profile.axis === "x") ctx.fillRect(p0, region.y, p1 - p0, region.height);
      else ctx.fillRect(region.x, p0, region.width, p1 - p0);
    });
    ctx.strokeStyle = "rgba(255,255,255,.85)";
    ctx.lineWidth = 1 / scale;
    ctx.beginPath();
    const lines = result.method === "simpson" ? result.bars.length : result.n;
    for (let i = 0; i <= lines; i += 1) {
      const p = toImage(i * (profile.L / lines));
      if (profile.axis === "x") { ctx.moveTo(p, region.y); ctx.lineTo(p, region.y + region.height); }
      else { ctx.moveTo(region.x, p); ctx.lineTo(region.x + region.width, p); }
    }
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = "rgba(15,23,42,.75)";
    ctx.fillRect(8, 8, 150, 24);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 12px sans-serif";
    ctx.fillText(`${pore.id} · n = ${result.n}`, 16, 25);
  }

  function drawRiemannChart() {
    const canvas = $("#riemannChart");
    const { ctx, width, height } = prepareChartCanvas(canvas);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    const profile = state.calculus.profile;
    const result = state.calculus.result;
    if (!profile || !result) return;
    const v = AXIS_VAR[profile.axis];
    const fn = AXIS_FN[profile.axis];
    const frame = drawFrame(ctx, width, height, {
      xMin: 0, xMax: profile.L, yMin: 0, yMax: profile.max * 1.12 || 1,
      xLabel: `${v} (${lengthUnit()})`, yLabel: `${fn}(${v}) (${lengthUnit()})`,
    });
    canvas._frame = frame;
    const { sx, sy } = frame;
    const hover = state.calculus.hover;
    const color = METHOD_COLORS[result.method];
    ctx.lineWidth = 1;
    result.bars.forEach((bar, index) => {
      ctx.beginPath();
      if (bar.type === "rect") {
        ctx.rect(sx(bar.a), sy(bar.h), sx(bar.b) - sx(bar.a), sy(0) - sy(bar.h));
      } else if (bar.type === "trap") {
        ctx.moveTo(sx(bar.a), sy(0)); ctx.lineTo(sx(bar.a), sy(bar.h0)); ctx.lineTo(sx(bar.b), sy(bar.h1)); ctx.lineTo(sx(bar.b), sy(0)); ctx.closePath();
      } else {
        // พาราโบลาผ่าน 3 จุด (a,h0) (m,hm) (b,h1)
        const steps = 24;
        ctx.moveTo(sx(bar.a), sy(0));
        for (let s = 0; s <= steps; s += 1) {
          const t = s / steps; // 0..1
          const value = bar.h0 * (1 - t) * (1 - 2 * t) + bar.hm * 4 * t * (1 - t) + bar.h1 * t * (2 * t - 1);
          ctx.lineTo(sx(bar.a + (bar.b - bar.a) * t), sy(value));
        }
        ctx.lineTo(sx(bar.b), sy(0));
        ctx.closePath();
      }
      ctx.fillStyle = index === hover ? hexAlpha(color, 0.5) : hexAlpha(color, 0.2);
      ctx.fill();
      ctx.strokeStyle = hexAlpha(color, 0.9);
      ctx.stroke();
      if (bar.type === "rect" && bar.sample !== null && result.n <= 60) {
        ctx.beginPath();
        ctx.arc(sx(bar.sample), sy(bar.h), 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    });
    // กราฟ f
    ctx.beginPath();
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 2;
    const samples = Math.min(800, profile.values.length * 2 + 2);
    for (let s = 0; s <= samples; s += 1) {
      const u = (s / samples) * profile.L;
      const x = sx(u);
      const y = sy(evalProfile(profile, u));
      if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // คำอธิบาย
    ctx.font = "bold 13px sans-serif";
    ctx.fillStyle = "#0f172a";
    ctx.fillText(`${METHOD_NAMES[result.method]} · n = ${result.n} · ≈ ${fmt(result.estimate)} ${areaUnit()}`, frame.pad.left, 16);
  }

  function hexAlpha(hex, alpha) {
    const value = parseInt(hex.slice(1), 16);
    return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
  }

  const CONVERGENCE_NS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 125, 150, 200];

  function drawConvergenceChart() {
    const profile = state.calculus.profile;
    const canvas = $("#convergenceChart");
    if (!profile) return clearChart(canvas, "ยังไม่มีข้อมูล");
    const method = state.calculus.method;
    const au = areaUnit();
    if (state.calculus.convView === "estimate") {
      $("#convergenceExplain").textContent = "เส้นประคือพื้นที่จริง — ผลบวกล่างเข้ามาจากด้านล่าง ผลบวกบนเข้ามาจากด้านบน และวิธีที่เลือกถูกบีบอยู่ระหว่างกลาง";
      const series = [
        { name: METHOD_NAMES.upper, color: METHOD_COLORS.upper, points: CONVERGENCE_NS.map((n) => ({ x: n, y: computeRiemann(profile, n, "upper").estimate })) },
        { name: METHOD_NAMES.lower, color: METHOD_COLORS.lower, points: CONVERGENCE_NS.map((n) => ({ x: n, y: computeRiemann(profile, n, "lower").estimate })) },
      ];
      if (method !== "upper" && method !== "lower") {
        series.push({ name: METHOD_NAMES[method], color: METHOD_COLORS[method], width: 3, points: CONVERGENCE_NS.map((n) => ({ x: n, y: computeRiemann(profile, n, method).estimate })) });
      }
      drawChart(canvas, {
        series,
        xLabel: "จำนวนแถบ n", yLabel: `พื้นที่ (${au})`,
        refLines: [{ y: profile.exact, label: `พื้นที่จริง ${fmt(profile.exact)}`, color: "#0f172a" }],
        markerX: state.calculus.n,
      });
    } else {
      $("#convergenceExplain").textContent = "ทุกวิธีมี Error ลดลงเข้าใกล้ 0 เมื่อ n เพิ่มขึ้น แต่ลดเร็วไม่เท่ากัน (แสดงตั้งแต่ n = 4)";
      const methods = ["left", "right", "midpoint", "trapezoid", "simpson"];
      const series = methods.map((m) => ({
        name: METHOD_NAMES[m], color: METHOD_COLORS[m], width: m === method ? 3.5 : 2,
        points: CONVERGENCE_NS.filter((n) => n >= 4).map((n) => ({ x: n, y: computeRiemann(profile, n, m).percentError })),
      }));
      drawChart(canvas, { series, xLabel: "จำนวนแถบ n", yLabel: "Percent Error (%)", yMin: 0, markerX: state.calculus.n });
    }
  }

  function stepTableModel() {
    const result = state.calculus.result;
    const v = AXIS_VAR[state.calculus.axis];
    const f = AXIS_FN[state.calculus.axis];
    if (!result) return null;
    const range = (bar) => `[${fmt(bar.a)}, ${fmt(bar.b)}]`;
    let head;
    let rows;
    if (result.method === "simpson") {
      head = ["คู่แถบที่", `ช่วง ${v}`, `${f}(ซ้าย)`, `${f}(กลาง)`, `${f}(ขวา)`, `(Δ${v}/3)(${f}ซ้าย + 4${f}กลาง + ${f}ขวา)`];
      rows = result.bars.map((bar, i) => [i + 1, range(bar), fmt(bar.h0), fmt(bar.hm), fmt(bar.h1), fmt(bar.area)]);
    } else if (result.method === "trapezoid") {
      head = ["แถบที่", `ช่วง ${v}`, `${f}(${v}ᵢ₋₁)`, `${f}(${v}ᵢ)`, `½(${f}ᵢ₋₁ + ${f}ᵢ)·Δ${v}`];
      rows = result.bars.map((bar, i) => [i + 1, range(bar), fmt(bar.h0), fmt(bar.h1), fmt(bar.area)]);
    } else if (result.method === "lower" || result.method === "upper") {
      const label = result.method === "lower" ? "mᵢ (ค่าต่ำสุด)" : "Mᵢ (ค่าสูงสุด)";
      head = ["แถบที่", `ช่วง ${v}`, label, `${label.split(" ")[0]}·Δ${v}`];
      rows = result.bars.map((bar, i) => [i + 1, range(bar), fmt(bar.h), fmt(bar.area)]);
    } else {
      head = ["แถบที่", `ช่วง ${v}`, `จุดที่ใช้ ${v}*`, `${f}(${v}*)`, `${f}(${v}*)·Δ${v}`];
      rows = result.bars.map((bar, i) => [i + 1, range(bar), fmt(bar.sample), fmt(bar.h), fmt(bar.area)]);
    }
    return { head, rows, total: result.estimate };
  }

  function renderStepTable() {
    const model = stepTableModel();
    if (!model) return;
    $("#stepTableHead").innerHTML = `<tr>${model.head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
    $("#stepTableBody").innerHTML = model.rows.map((row, i) => `<tr data-strip="${i}" class="${i === state.calculus.hover ? "highlight" : ""}">${row.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
    $("#stepTableFoot").innerHTML = `<tr><td colspan="${model.head.length - 1}">ผลรวม (ค่าประมาณพื้นที่, ${areaUnit()})</td><td>${fmt(model.total)}</td></tr>`;
  }

  function updateStripInfo() {
    const result = state.calculus.result;
    const index = state.calculus.hover;
    const box = $("#stripTooltip");
    if (!result || index === null || !result.bars[index]) {
      box.textContent = "ชี้เมาส์หรือแตะที่แถบใดก็ได้ (บนภาพหรือบนกราฟ) เพื่อดูค่าของแถบนั้น";
      return;
    }
    const bar = result.bars[index];
    const v = AXIS_VAR[state.calculus.axis];
    const f = AXIS_FN[state.calculus.axis];
    const lu = lengthUnit();
    const au = areaUnit();
    let detail;
    if (bar.type === "rect") {
      const which = result.method === "lower" ? "ค่าต่ำสุดในแถบ" : result.method === "upper" ? "ค่าสูงสุดในแถบ" : `${f}(${fmt(bar.sample)})`;
      detail = `ความสูง ${which} = ${fmt(bar.h)} ${lu} → พื้นที่ = ${fmt(bar.h)} × ${fmt(result.dx)} = ${fmt(bar.area)} ${au}`;
    } else if (bar.type === "trap") {
      detail = `½(${fmt(bar.h0)} + ${fmt(bar.h1)}) × ${fmt(result.dx)} = ${fmt(bar.area)} ${au}`;
    } else {
      detail = `(${fmt(result.dx)}/3)(${fmt(bar.h0)} + 4×${fmt(bar.hm)} + ${fmt(bar.h1)}) = ${fmt(bar.area)} ${au}`;
    }
    const label = bar.type === "simpson" ? "คู่แถบที่" : "แถบที่";
    box.textContent = `${label} ${index + 1}: ${v} จาก ${fmt(bar.a)} ถึง ${fmt(bar.b)} ${lu} · ${detail}`;
  }

  function setCalcHover(index) {
    if (state.calculus.hover === index) return;
    state.calculus.hover = index;
    drawPoreStrips();
    drawRiemannChart();
    updateStripInfo();
    $$("#stepTableBody tr").forEach((row) => row.classList.toggle("highlight", Number(row.dataset.strip) === index));
  }

  function stripIndexAt(u) {
    const result = state.calculus.result;
    if (!result || u < 0 || u > state.calculus.profile.L) return null;
    const width = result.method === "simpson" ? 2 * result.dx : result.dx;
    return clamp(Math.floor(u / width), 0, result.bars.length - 1);
  }

  function handleRiemannHover(event) {
    const canvas = event.currentTarget;
    const frame = canvas._frame;
    if (!frame) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    setCalcHover(stripIndexAt(frame.invX(x)));
  }

  function handlePoreStripHover(event) {
    const canvas = event.currentTarget;
    const view = canvas._view;
    const profile = state.calculus.profile;
    if (!view || !profile) return;
    const rect = canvas.getBoundingClientRect();
    const ix = (event.clientX - rect.left - view.ox) / view.scale;
    const iy = (event.clientY - rect.top - view.oy) / view.scale;
    const imageCoord = profile.axis === "x" ? ix : iy;
    const u = ((imageCoord - profile.originImg) / profile.imagePerCell) * profile.cell;
    setCalcHover(stripIndexAt(u));
  }

  function setCalculusN(n) {
    state.calculus.n = clamp(Math.round(n), 1, 200);
    $("#riemannNInput").value = state.calculus.n;
    $("#riemannNValue").textContent = state.calculus.n;
    state.calculus.hover = null;
    updateCalculus();
  }

  function stopPlay() {
    if (state.calculus.playTimer) {
      clearInterval(state.calculus.playTimer);
      state.calculus.playTimer = null;
      $("#playNBtn").textContent = "▶ ดูภาพเคลื่อนไหวเมื่อ n เพิ่มขึ้น";
    }
  }

  function togglePlay() {
    if (state.calculus.playTimer) return stopPlay();
    if (!getCalculusPore()) return toast("วิเคราะห์ภาพก่อน", "warn");
    const sequence = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 50, 60, 80, 100, 130, 160, 200];
    let step = 0;
    $("#playNBtn").textContent = "⏸ หยุด";
    state.calculus.playTimer = setInterval(() => {
      setCalculusN(sequence[step]);
      step += 1;
      if (step >= sequence.length) stopPlay();
    }, 420);
  }

  function resetChallenge() {
    $("#challengeAnswer").textContent = "";
  }

  function revealChallenge() {
    const profile = state.calculus.profile;
    if (!profile) return;
    const method = state.calculus.method;
    let answer = null;
    for (let n = 1; n <= 200; n += 1) {
      if (computeRiemann(profile, n, method).percentError < 1) { answer = method === "simpson" && n % 2 ? n + 1 : n; break; }
    }
    $("#challengeAnswer").textContent = answer ? ` → n = ${answer}` : " → ไม่ถึง 1% ภายใน n ≤ 200 (รูนี้มีพิกเซลน้อยหรือรูปร่างซับซ้อน)";
  }

  function exportStepCsv() {
    const model = stepTableModel();
    if (!model) return toast("ยังไม่มีข้อมูล", "warn");
    const rows = [model.head, ...model.rows];
    const totalRow = new Array(model.head.length).fill("");
    totalRow[0] = "รวม";
    totalRow[totalRow.length - 1] = fmt(model.total);
    rows.push(totalRow);
    downloadText(`riemann-${state.calculus.method}-n${state.calculus.result.n}.csv`, `﻿${rows.map((r) => r.map(csvEscape).join(",")).join("\n")}`, "text/csv;charset=utf-8");
  }

  // ------------------------------------------------------------------
  // กราฟทั่วไป
  // ------------------------------------------------------------------
  function chartSize(canvas) {
    const rect = canvas.getBoundingClientRect();
    return { width: Math.max(300, rect.width || 900), height: Number(canvas.dataset.h) || 360 };
  }

  function prepareChartCanvas(canvas) {
    const { width, height } = chartSize(canvas);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width, height };
  }

  function clearChart(canvas, message = "ยังไม่มีข้อมูล") {
    const { ctx, width, height } = prepareChartCanvas(canvas);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#64748b";
    ctx.font = "15px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(message, width / 2, height / 2);
    ctx.textAlign = "left";
  }

  function niceStep(range, count) {
    const raw = range / Math.max(1, count);
    const power = 10 ** Math.floor(Math.log10(raw || 1));
    const fraction = raw / power;
    const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
    return nice * power;
  }

  /** วาดกรอบแกน + เส้นกริด คืนฟังก์ชันแปลงพิกัด */
  function drawFrame(ctx, width, height, o) {
    const pad = { left: 66, right: 20, top: 28, bottom: 48, ...(o.pad || {}) };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const sx = (value) => pad.left + ((value - o.xMin) / (o.xMax - o.xMin)) * plotW;
    const sy = (value) => pad.top + plotH - ((value - o.yMin) / (o.yMax - o.yMin)) * plotH;
    const invX = (px) => o.xMin + ((px - pad.left) / plotW) * (o.xMax - o.xMin);
    ctx.font = "12px sans-serif";
    ctx.lineWidth = 1;
    const yStep = niceStep(o.yMax - o.yMin, 5);
    for (let value = Math.ceil(o.yMin / yStep) * yStep; value <= o.yMax + 1e-9; value += yStep) {
      const y = sy(value);
      ctx.strokeStyle = "#eef2f7";
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
      ctx.fillStyle = "#64748b";
      ctx.textAlign = "right";
      ctx.fillText(fmt(value), pad.left - 8, y + 4);
    }
    const xStep = niceStep(o.xMax - o.xMin, Math.max(3, Math.floor(plotW / 90)));
    for (let value = Math.ceil(o.xMin / xStep) * xStep; value <= o.xMax + 1e-9; value += xStep) {
      const x = sx(value);
      ctx.strokeStyle = "#cbd5e1";
      ctx.beginPath(); ctx.moveTo(x, pad.top + plotH); ctx.lineTo(x, pad.top + plotH + 5); ctx.stroke();
      ctx.fillStyle = "#64748b";
      ctx.textAlign = "center";
      ctx.fillText(fmt(value), x, pad.top + plotH + 18);
    }
    ctx.strokeStyle = "#94a3b8";
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top);
    ctx.lineTo(pad.left, pad.top + plotH);
    ctx.lineTo(width - pad.right, pad.top + plotH);
    ctx.stroke();
    ctx.fillStyle = "#475569";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(o.xLabel || "", width - pad.right, height - 8);
    ctx.save();
    ctx.translate(14, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText(o.yLabel || "", 0, 0);
    ctx.restore();
    ctx.textAlign = "left";
    return { sx, sy, invX, pad, plotW, plotH };
  }

  function drawChart(canvas, o) {
    const { ctx, width, height } = prepareChartCanvas(canvas);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    const all = o.series.flatMap((s) => s.points).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!all.length) {
      clearChart(canvas, o.emptyMessage || "ยังไม่มีข้อมูล");
      return;
    }
    let xMin = Math.min(...all.map((p) => p.x));
    let xMax = Math.max(...all.map((p) => p.x));
    const refYs = (o.refLines || []).map((r) => r.y);
    let yMin = o.yMin ?? Math.min(...all.map((p) => p.y), ...refYs);
    let yMax = Math.max(...all.map((p) => p.y), ...refYs);
    if (xMin === xMax) { xMin -= 1; xMax += 1; }
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const yPad = (yMax - yMin) * 0.1;
    if (o.yMin === undefined) yMin -= yPad;
    yMax += yPad;
    const frame = drawFrame(ctx, width, height, { xMin, xMax, yMin, yMax, xLabel: o.xLabel, yLabel: o.yLabel, pad: { top: 34 } });
    const { sx, sy } = frame;
    if (Number.isFinite(o.markerX) && o.markerX >= xMin && o.markerX <= xMax) {
      ctx.strokeStyle = "rgba(15,23,42,.25)";
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(sx(o.markerX), frame.pad.top); ctx.lineTo(sx(o.markerX), frame.pad.top + frame.plotH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#475569";
      ctx.fillText(`n = ${o.markerX}`, sx(o.markerX) + 4, frame.pad.top + 12);
    }
    for (const ref of o.refLines || []) {
      ctx.strokeStyle = ref.color || "#0f172a";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([7, 5]);
      ctx.beginPath(); ctx.moveTo(frame.pad.left, sy(ref.y)); ctx.lineTo(width - frame.pad.right, sy(ref.y)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ref.color || "#0f172a";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(ref.label || "", width - frame.pad.right - 4, sy(ref.y) - 6);
      ctx.textAlign = "left";
    }
    for (const s of o.series) {
      const points = s.points.filter((p) => Number.isFinite(p.y));
      if (!points.length) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 2.5;
      ctx.beginPath();
      points.forEach((p, i) => (i ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y))));
      ctx.stroke();
      if (s.showPoints !== false) {
        ctx.fillStyle = s.color;
        for (const p of points) { ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), points.length > 30 ? 2 : 3.5, 0, Math.PI * 2); ctx.fill(); }
      }
    }
    // คำอธิบายสัญลักษณ์
    if (o.series.length > 1 || o.series[0]?.name) {
      ctx.font = "12px sans-serif";
      let x = frame.pad.left;
      const y = 16;
      for (const s of o.series) {
        if (!s.name) continue;
        ctx.fillStyle = s.color;
        ctx.fillRect(x, y - 8, 14, 4);
        ctx.fillStyle = "#334155";
        ctx.fillText(s.name, x + 18, y - 2);
        x += ctx.measureText(s.name).width + 34;
        if (x > width - 80) break;
      }
    }
  }

  // ------------------------------------------------------------------
  // คลังข้อมูล
  // ------------------------------------------------------------------
  function getMetadataFromForm() {
    const num = (selector) => { const v = $(selector).value; return v === "" ? null : Number(v); };
    return {
      groupName: $("#groupNameInput").value.trim(),
      sampleCode: $("#sampleCodeInput").value.trim() || `SD-${String(state.repository.length + 1).padStart(3, "0")}`,
      seriesCode: $("#seriesCodeInput").value.trim() || "SERIES-A",
      fermentationMinute: num("#fermentationInput") ?? 0,
      temperatureC: num("#temperatureInput"),
      hydrationPercent: num("#hydrationInput"),
      loafHeightCm: num("#loafHeightInput"),
      notes: $("#notesInput").value.trim(),
    };
  }

  function makeImageDataUrl(maxDimension, quality) {
    if (!state.image) return "";
    const scale = Math.min(1, maxDimension / Math.max(state.imageWidth, state.imageHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(state.imageWidth * scale);
    canvas.height = Math.round(state.imageHeight * scale);
    canvas.getContext("2d").drawImage(state.image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  }

  function serializablePores() {
    return (state.analysis?.pores || []).map((pore) => ({
      id: pore.id,
      areaPx: pore.areaPx,
      areaReal: pore.areaReal,
      perimeterPx: pore.perimeterPx,
      perimeterReal: pore.perimeterReal,
      equivalentDiameterPx: pore.equivalentDiameterPx,
      equivalentDiameterReal: pore.equivalentDiameterReal,
      circularity: pore.circularity,
      center: pore.center,
      boundingBox: pore.boundingBox,
    }));
  }

  function updateSaveReadiness() {
    const button = $("#saveRepositoryBtn");
    const note = $("#saveReadiness");
    if (!button) return;
    const ready = Boolean(state.image && state.analysis);
    button.disabled = !ready;
    note.textContent = ready
      ? `พร้อมบันทึก: ${state.imageName} · ${state.analysis.pores.length} รู`
      : "ต้องวิเคราะห์ภาพในแท็บ 1 ก่อน จึงจะบันทึกได้";
  }

  function goToSaveForm() {
    if (!state.analysis) {
      toast("วิเคราะห์ภาพก่อนจึงจะบันทึกได้", "warn");
      return;
    }
    setActiveTab("repository");
    setTimeout(() => {
      flashSection("#metadataSection");
      $("#groupNameInput").focus();
    }, 80);
    toast("กรอกข้อมูลตัวอย่าง แล้วกด “บันทึกตัวอย่างปัจจุบัน”", "info");
  }

  async function saveCurrentSample() {
    if (!state.image || !state.analysis) {
      toast("กรุณาวิเคราะห์ภาพก่อนบันทึก", "warn");
      return;
    }
    const metadata = getMetadataFromForm();
    const imageDataUrl = makeImageDataUrl(1600, 0.86);
    const record = {
      id: uid("sample"),
      version: 2,
      createdAt: new Date().toISOString(),
      metadata,
      imageName: state.imageName,
      imageDataUrl,
      thumbDataUrl: makeImageDataUrl(420, 0.72),
      imageWidth: state.imageWidth,
      imageHeight: state.imageHeight,
      calibration: JSON.parse(JSON.stringify(state.calibration)),
      roi: JSON.parse(JSON.stringify(state.roi)),
      processing: JSON.parse(JSON.stringify(state.processing)),
      unitPerPixel: getUnitPerPixel(),
      areaUnit: areaUnit(),
      lengthUnit: lengthUnit(),
      summary: JSON.parse(JSON.stringify(state.analysis.summary)),
      pores: serializablePores(),
      geometryAttempts: state.analysis.pores.map((pore) => {
        const shapes = state.geometry.shapes.filter((shape) => shape.poreId === pore.id);
        if (!shapes.length) return null;
        const metrics = geometryMetricsFor(pore);
        return { poreId: pore.id, shapes: JSON.parse(JSON.stringify(shapes)), unionAreaPx: metrics.unionAreaPx, percentError: metrics.percentError, iou: metrics.iou };
      }).filter(Boolean),
      calculusAttempt: state.calculus.result ? {
        poreId: state.calculus.poreId,
        axis: state.calculus.axis,
        n: state.calculus.result.n,
        method: state.calculus.method,
        estimate: state.calculus.result.estimate,
        exact: state.calculus.result.exact,
        percentError: state.calculus.result.percentError,
        unit: areaUnit(),
      } : null,
    };
    state.repository.push(record);
    if (await persistRepository()) {
      $("#sampleCodeInput").value = "";
      $("#notesInput").value = "";
      toast(`บันทึก ${metadata.sampleCode} แล้ว (${state.repository.length} ตัวอย่างในคลัง)`, "success");
    } else {
      state.repository.pop();
    }
    renderRepository();
    updateDashboardControls();
    updateStepper();
  }

  function renderRepository() {
    dom.repositoryCount.textContent = `${state.repository.length} ตัวอย่าง${state.storageMode === "local" ? " (โหมดพื้นที่จำกัด)" : ""}`;
    if (!state.repository.length) {
      dom.repositoryCards.innerHTML = '<div class="table-empty-state">ยังไม่มีข้อมูลในคลัง — วิเคราะห์ภาพแล้วกด “บันทึกเข้าคลัง”</div>';
      return;
    }
    const sorted = [...state.repository].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    dom.repositoryCards.innerHTML = sorted.map((record) => {
      const s = record.summary || {};
      const meta = record.metadata || {};
      const mean = recordAreaValue(record, "meanAreaPx");
      return `
        <article class="repository-card">
          <img class="repository-thumb" src="${record.thumbDataUrl || record.imageDataUrl}" alt="${escapeHtml(meta.sampleCode)}" loading="lazy" />
          <div class="repository-card-body">
            <h3>${escapeHtml(meta.sampleCode)}</h3>
            <div class="repository-meta">
              <span>กลุ่ม: ${escapeHtml(meta.groupName || "—")} · Series: ${escapeHtml(meta.seriesCode || "—")}</span>
              <span>เวลาหมัก ${formatNumber(meta.fermentationMinute, 0)} นาที${meta.loafHeightCm ? ` · สูง ${formatNumber(meta.loafHeightCm, 2)} cm` : ""}</span>
              <span>${new Date(record.createdAt).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })}</span>
            </div>
            <div class="repository-summary">
              <div><span>จำนวนรู</span><strong>${s.poreCount ?? "—"}</strong></div>
              <div><span>Porosity</span><strong>${formatNumber(s.porosityPercent, 2)}%</strong></div>
              <div><span>พื้นที่เฉลี่ย</span><strong>${fmt(mean.value)} ${mean.unit}</strong></div>
              <div><span>Threshold</span><strong>${s.threshold ?? record.processing?.threshold ?? "—"}</strong></div>
            </div>
            <div class="repository-card-actions">
              <button type="button" data-load-record="${record.id}">เปิดวิเคราะห์อีกครั้ง</button>
              <button type="button" class="delete" data-delete-record="${record.id}">ลบ</button>
            </div>
          </div>
        </article>`;
    }).join("");
  }

  async function loadRecordIntoWorkspace(recordId) {
    const record = state.repository.find((item) => item.id === recordId);
    if (!record) return;
    try {
      await loadImageFromDataUrl(record.imageDataUrl, record.imageName || record.metadata.sampleCode);
    } catch (error) {
      toast(error.message, "error");
      return;
    }
    // ภาพในคลังอาจถูกย่อ ต้องย่อพิกัด ROI/สเกล ตามไปด้วย
    const s = record.imageWidth ? state.imageWidth / record.imageWidth : 1;
    const scalePoint = (p) => (p ? { x: p.x * s, y: p.y * s } : null);
    const cal = record.calibration || {};
    state.calibration = { realLength: cal.realLength ?? 10, unit: cal.unit || "mm", point1: scalePoint(cal.point1), point2: scalePoint(cal.point2) };
    state.roi = record.roi ? { ...record.roi, x: record.roi.x * s, y: record.roi.y * s, width: record.roi.width * s, height: record.roi.height * s } : null;
    state.processing = { ...state.processing, ...record.processing, thresholdTouched: true };
    state.processing.minAreaPx = Math.max(1, Math.round((record.processing?.minAreaPx ?? 20) * s * s));
    syncProcessingInputs();
    syncMetadataForm(record.metadata);
    updateCalibrationReadout();
    setActiveTab("analyze");
    if (state.roi) await analyzeImage();
    if (s < 0.999) toast("ภาพในคลังถูกย่อเพื่อประหยัดพื้นที่ ค่าที่ได้อาจต่างจากครั้งแรกเล็กน้อย", "info", 6000);
  }

  function syncProcessingInputs() {
    dom.thresholdInput.value = state.processing.threshold;
    dom.thresholdValue.textContent = state.processing.threshold;
    $("#poreModeSelect").value = state.processing.poreMode;
    $("#minAreaInput").value = state.processing.minAreaPx;
    $("#maxAreaInput").value = state.processing.maxAreaPercent;
    $("#cleanMaskInput").checked = state.processing.cleanMask;
    $("#excludeBoundaryInput").checked = state.processing.excludeBoundary;
    dom.realLengthInput.value = state.calibration.realLength;
    dom.unitSelect.value = state.calibration.unit;
  }

  function syncMetadataForm(metadata = {}) {
    $("#groupNameInput").value = metadata.groupName || "";
    $("#sampleCodeInput").value = metadata.sampleCode || "";
    $("#seriesCodeInput").value = metadata.seriesCode || "";
    $("#fermentationInput").value = metadata.fermentationMinute ?? 0;
    $("#temperatureInput").value = metadata.temperatureC ?? "";
    $("#hydrationInput").value = metadata.hydrationPercent ?? "";
    $("#loafHeightInput").value = metadata.loafHeightCm ?? "";
    $("#notesInput").value = metadata.notes || "";
  }

  async function deleteRecord(recordId) {
    const record = state.repository.find((item) => item.id === recordId);
    if (!record || !confirm(`ลบ ${record.metadata.sampleCode} ออกจากคลังหรือไม่`)) return;
    state.repository = state.repository.filter((item) => item.id !== recordId);
    await persistRepository();
    renderRepository();
    updateDashboardControls();
    updateDashboard();
    updateStepper();
  }

  function downloadText(filename, text, type = "text/plain;charset=utf-8") {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function csvEscape(value) {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function exportPoreCsv() {
    if (!state.analysis?.pores.length) return toast("ยังไม่มีข้อมูลรูพรุน", "warn");
    const u = state.calibration.unit;
    const real = Boolean(getUnitPerPixel());
    const headers = ["pore_id", "area_px2", real ? `area_${u}2` : "", "perimeter_px", real ? `perimeter_${u}` : "", "equivalent_diameter_px", real ? `equivalent_diameter_${u}` : "", "circularity", "center_x_px", "center_y_px"].filter(Boolean);
    const rows = state.analysis.pores.map((p) => [
      p.id, p.areaPx, ...(real ? [p.areaReal] : []), p.perimeterPx, ...(real ? [p.perimeterReal] : []),
      p.equivalentDiameterPx, ...(real ? [p.equivalentDiameterReal] : []), p.circularity, p.center.x, p.center.y,
    ].map((v) => (typeof v === "number" ? Number(v.toFixed(6)) : v)));
    const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
    downloadText(`pore-data-${Date.now()}.csv`, `﻿${csv}`, "text/csv;charset=utf-8");
  }

  function exportRepositoryJson() {
    if (!state.repository.length) return toast("คลังยังว่าง", "warn");
    downloadText(`mathscope-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: "MathScope Lab", version: 2, exportedAt: new Date().toISOString(), records: state.repository }), "application/json");
  }

  function exportRepositoryCsv() {
    if (!state.repository.length) return toast("คลังยังว่าง", "warn");
    const headers = ["sample_code", "group_name", "series_code", "fermentation_minute", "temperature_c", "hydration_percent", "loaf_height_cm", "pore_count", "porosity_percent", "void_fraction_percent", "mean_area_mm2", "total_area_mm2", "mean_area_px2", "total_area_px2", "threshold", "created_at"];
    const rows = state.repository.map((r) => {
      const m = r.metadata || {};
      const s = r.summary || {};
      const mean = recordAreaValue(r, "meanAreaPx");
      const total = recordAreaValue(r, "totalAreaPx");
      return [m.sampleCode, m.groupName, m.seriesCode, m.fermentationMinute, m.temperatureC ?? "", m.hydrationPercent ?? "", m.loafHeightCm ?? "",
        s.poreCount, s.porosityPercent, s.voidFractionPercent ?? "", mean.unit === "mm²" ? mean.value : "", total.unit === "mm²" ? total.value : "",
        s.meanAreaPx, s.totalAreaPx, s.threshold ?? r.processing?.threshold ?? "", r.createdAt];
    });
    const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
    downloadText(`mathscope-summary-${new Date().toISOString().slice(0, 10)}.csv`, `﻿${csv}`, "text/csv;charset=utf-8");
  }

  async function importRepository(file) {
    try {
      const payload = JSON.parse(await file.text());
      const records = Array.isArray(payload) ? payload : payload.records;
      if (!Array.isArray(records)) throw new Error("ไฟล์นี้ไม่ใช่ไฟล์สำรองของ MathScope Lab");
      const existingIds = new Set(state.repository.map((record) => record.id));
      let added = 0;
      let skipped = 0;
      for (const record of records) {
        if (!record?.summary || !record?.metadata) { skipped += 1; continue; }
        if (existingIds.has(record.id)) { skipped += 1; continue; } // ซ้ำ ไม่ต้องนำเข้าอีก
        state.repository.push({ ...record, id: record.id || uid("sample") });
        added += 1;
      }
      await persistRepository();
      renderRepository();
      updateDashboardControls();
      updateStepper();
      toast(`นำเข้า ${added} ตัวอย่าง${skipped ? ` (ข้าม ${skipped} รายการที่ซ้ำหรือไม่สมบูรณ์)` : ""}`, "success");
    } catch (error) {
      toast(error.message || "นำเข้าไฟล์ไม่สำเร็จ", "error");
    }
  }

  async function clearAllRepository() {
    if (!state.repository.length || !confirm("ล้างข้อมูลทั้งหมดในคลังหรือไม่ — ควรส่งออกไฟล์สำรองก่อน การกระทำนี้ย้อนกลับไม่ได้")) return;
    state.repository = [];
    await persistRepository();
    renderRepository();
    updateDashboardControls();
    updateDashboard();
    updateStepper();
  }

  // ------------------------------------------------------------------
  // Dashboard
  // ------------------------------------------------------------------
  /** คืนพื้นที่ในหน่วย mm² ถ้าตัวอย่างนั้นตั้งสเกลไว้ ไม่เช่นนั้นคืน px² */
  function recordAreaValue(record, pxKey) {
    const px = record.summary?.[pxKey];
    const upp = record.unitPerPixel;
    const unit = record.calibration?.unit || "mm";
    if (upp && Number.isFinite(px)) {
      const mmPerPx = upp * (LENGTH_TO_MM[unit] || 1);
      return { value: px * mmPerPx * mmPerPx, unit: "mm²" };
    }
    return { value: px, unit: "px²" };
  }

  const METRICS = {
    meanArea: { label: "พื้นที่รูพรุนเฉลี่ย", get: (r) => recordAreaValue(r, "meanAreaPx") },
    totalArea: { label: "พื้นที่รูพรุนรวม", get: (r) => recordAreaValue(r, "totalAreaPx") },
    porosity: { label: "Porosity", get: (r) => ({ value: r.summary?.porosityPercent, unit: "%" }) },
    poreCount: { label: "จำนวนรูพรุน", get: (r) => ({ value: r.summary?.poreCount, unit: "รู" }) },
    loafHeight: { label: "ความสูงขนมปัง", get: (r) => ({ value: r.metadata?.loafHeightCm ?? NaN, unit: "cm" }) },
  };

  function updateDashboardControls() {
    const series = [...new Set(state.repository.map((record) => record.metadata?.seriesCode || "SERIES-A"))].sort();
    const current = dom.dashboardSeriesSelect.value;
    dom.dashboardSeriesSelect.innerHTML = '<option value="">ทั้งหมด</option>' + series.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
    if (series.includes(current)) dom.dashboardSeriesSelect.value = current;
  }

  function finiteDifferences(points) {
    return points.map((point, index) => {
      if (points.length < 2) return { ...point, derivative: null };
      const prev = points[index - 1];
      const next = points[index + 1];
      let derivative;
      if (!prev) derivative = (next.y - point.y) / (next.x - point.x);
      else if (!next) derivative = (point.y - prev.y) / (point.x - prev.x);
      else derivative = (next.y - prev.y) / (next.x - prev.x);
      return { ...point, derivative };
    });
  }

  function updateDashboard() {
    const seriesFilter = dom.dashboardSeriesSelect.value;
    const metric = METRICS[dom.dashboardMetricSelect.value] || METRICS.meanArea;
    $("#growthChartTitle").textContent = `${metric.label}ตามเวลาหมัก`;
    const raw = state.repository
      .filter((record) => !seriesFilter || (record.metadata?.seriesCode || "SERIES-A") === seriesFilter)
      .map((record) => ({ ...metric.get(record), x: Number(record.metadata?.fermentationMinute) || 0, series: record.metadata?.seriesCode || "SERIES-A" }))
      .filter((p) => Number.isFinite(Number(p.value)));

    // ถ้ามีทั้ง mm² และ px² ให้ใช้เฉพาะ mm² (เทียบกันได้)
    const units = new Set(raw.map((p) => p.unit));
    let note = "";
    let usable = raw;
    if (units.has("mm²") && units.has("px²")) {
      const dropped = raw.filter((p) => p.unit === "px²").length;
      usable = raw.filter((p) => p.unit === "mm²");
      note = ` (ไม่แสดง ${dropped} ตัวอย่างที่ไม่ได้ตั้งสเกล)`;
    }
    if (!usable.length) {
      const message = dom.dashboardMetricSelect.value === "loafHeight" ? "ยังไม่มีตัวอย่างที่กรอกความสูงขนมปัง" : "บันทึกตัวอย่างเข้าคลังก่อน";
      clearChart($("#growthChart"), message);
      clearChart($("#derivativeChart"), "ต้องมีข้อมูลอย่างน้อย 2 เวลาใน Series เดียวกัน");
      dom.growthTableBody.innerHTML = '<tr><td colspan="5" class="empty-table-cell">ยังไม่มีข้อมูลเพียงพอ</td></tr>';
      return;
    }
    const unit = usable[0].unit;
    const groups = new Map();
    for (const p of usable) {
      if (!groups.has(p.series)) groups.set(p.series, new Map());
      const byTime = groups.get(p.series);
      if (!byTime.has(p.x)) byTime.set(p.x, []);
      byTime.get(p.x).push(Number(p.value));
    }
    const seriesData = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, byTime], index) => {
      const points = [...byTime.entries()].map(([x, ys]) => ({ x, y: ys.reduce((a, b) => a + b, 0) / ys.length, n: ys.length })).sort((a, b) => a.x - b.x);
      return { name, color: SERIES_COLORS[index % SERIES_COLORS.length], points, diffs: finiteDifferences(points) };
    });

    drawChart($("#growthChart"), {
      series: seriesData.map((s) => ({ name: s.name, color: s.color, points: s.points })),
      xLabel: "เวลาหมัก (นาที)", yLabel: `${metric.label} (${unit})${note}`,
    });
    const derivSeries = seriesData.filter((s) => s.points.length >= 2);
    if (derivSeries.length) {
      drawChart($("#derivativeChart"), {
        series: derivSeries.map((s) => ({ name: s.name, color: s.color, points: s.diffs.map((d) => ({ x: d.x, y: d.derivative })) })),
        xLabel: "เวลาหมัก (นาที)", yLabel: `อัตราการเปลี่ยนแปลง (${unit}/นาที)`,
        refLines: [{ y: 0, label: "", color: "#cbd5e1" }],
      });
    } else {
      clearChart($("#derivativeChart"), "ต้องมีข้อมูลอย่างน้อย 2 เวลาใน Series เดียวกัน");
    }
    dom.growthTableBody.innerHTML = seriesData.flatMap((s) => s.diffs.map((d) => `
      <tr>
        <td><span style="color:${s.color};font-weight:700">●</span> ${escapeHtml(s.name)}</td>
        <td>${formatNumber(d.x, 1)}${d.n > 1 ? ` <span class="muted">(เฉลี่ย ${d.n} ตัวอย่าง)</span>` : ""}</td>
        <td>${fmt(d.y)} ${escapeHtml(unit)}</td>
        <td>${d.derivative === null ? "—" : fmt(d.derivative)}</td>
        <td>${escapeHtml(unit)} / นาที</td>
      </tr>`)).join("");
  }

  // ------------------------------------------------------------------
  // ผูกเหตุการณ์
  // ------------------------------------------------------------------
  function syncProcessingStateFromInputs() {
    state.processing.threshold = Number(dom.thresholdInput.value);
    state.processing.poreMode = $("#poreModeSelect").value;
    state.processing.minAreaPx = Number($("#minAreaInput").value) || 1;
    state.processing.maxAreaPercent = Number($("#maxAreaInput").value) || 100;
    state.processing.cleanMask = $("#cleanMaskInput").checked;
    state.processing.excludeBoundary = $("#excludeBoundaryInput").checked;
  }

  function bindEvents() {
    $$(".tab-button").forEach((button) => button.addEventListener("click", () => setActiveTab(button.dataset.tab)));
    $$(".go-analyze").forEach((button) => button.addEventListener("click", () => setActiveTab("analyze")));
    $$(".tool-button").forEach((button) => button.addEventListener("click", () => setTool(button.dataset.tool)));
    $$(".roi-button").forEach((button) => button.addEventListener("click", () => {
      if (!state.image) return toast("เลือกภาพก่อน", "warn");
      setTool(button.dataset.roiTool);
      toast("กดค้างแล้วลากบนภาพ", "info", 2200);
    }));
    $$(".geometry-tool").forEach((button) => button.addEventListener("click", () => setGeometryTool(button.dataset.geometryTool)));
    $$(".view-button").forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.view !== "original" && !state.analysis) toast("ต้องวิเคราะห์ภาพก่อนจึงจะดูมุมมองนี้ได้", "warn");
      state.viewMode = button.dataset.view;
      $$(".view-button").forEach((item) => item.classList.toggle("active", item === button));
      drawWorkspace();
    }));
    $$("li button", dom.stepper).forEach((button) => button.addEventListener("click", () => {
      const step = button.closest("li").dataset.step;
      if (step === "image") return dom.imageInput.click();
      if (!state.image) return toast("เลือกภาพก่อน", "warn");
      if (step === "scale") { setTool("scale"); flashSection("#section-scale"); }
      if (step === "roi") { setTool("roi-ellipse"); flashSection("#section-roi"); }
      if (step === "analyze") analyzeImage();
    }));
    $("#helpBtn").addEventListener("click", () => $("#helpDialog").showModal());

    // อัปโหลดภาพ + ลากวาง
    dom.imageInput.addEventListener("change", (event) => {
      handleImageFile(event.target.files?.[0]);
      event.target.value = "";
    });
    const dragTargets = [dom.dropZone, dom.workspaceWrap];
    for (const target of dragTargets) {
      target.addEventListener("dragover", (event) => {
        event.preventDefault();
        dom.dropZone.classList.add("dragging");
        dom.dropOverlay.classList.remove("hidden");
      });
      target.addEventListener("dragleave", () => {
        dom.dropZone.classList.remove("dragging");
        dom.dropOverlay.classList.add("hidden");
      });
      target.addEventListener("drop", (event) => {
        event.preventDefault();
        dom.dropZone.classList.remove("dragging");
        dom.dropOverlay.classList.add("hidden");
        handleImageFile(event.dataTransfer?.files?.[0]);
      });
    }
    window.addEventListener("dragover", (event) => event.preventDefault());
    window.addEventListener("drop", (event) => event.preventDefault());

    $("#demoImageBtn").addEventListener("click", async () => {
      await loadImageFromDataUrl(createDemoImage(), "ภาพตัวอย่าง.png");
      state.roi = { type: "ellipse", x: 215, y: 112, width: 970, height: 640 };
      state.calibration = { point1: { x: 140, y: 812 }, point2: { x: 640, y: 812 }, realLength: 100, unit: "mm" };
      syncProcessingInputs();
      updateCalibrationReadout();
      drawWorkspace();
      setStatus("ภาพตัวอย่างตั้งสเกลและ ROI ให้แล้ว — กด “วิเคราะห์รูพรุน” ได้เลย", "done");
      toast("ภาพตัวอย่างพร้อม: ตั้งสเกล (10 cm) และ ROI ไว้ให้แล้ว", "success");
    });

    $("#testImageBtn").addEventListener("click", async () => {
      const test = createAccuracyTestImage();
      await loadImageFromDataUrl(test.dataUrl, "ภาพทดสอบความแม่นยำ.png");
      state.groundTruth = test.truth;
      state.roi = { type: "rect", x: 40, y: 120, width: 1320, height: 600 };
      state.calibration = { point1: { x: 100, y: 786 }, point2: { x: 600, y: 786 }, realLength: 100, unit: "mm" };
      state.processing = { ...state.processing, minAreaPx: 20, maxAreaPercent: 12, cleanMask: true, excludeBoundary: true, thresholdTouched: false };
      syncProcessingInputs();
      updateCalibrationReadout();
      await analyzeImage();
      flashSection("#validationCard");
    });

    $("#fitImageBtn")?.addEventListener("click", () => fitImage("workspaceView"));
    $$(".zoom-controls button").forEach((button) => button.addEventListener("click", () => {
      const action = button.dataset.zoom;
      if (action === "fit") fitImage("workspaceView");
      else zoomView("workspaceView", action === "in" ? 1.3 : 1 / 1.3, drawWorkspace);
    }));
    $("#fitGeometryBtn").addEventListener("click", fitGeometryToSelectedPore);

    $("#startScaleBtn").addEventListener("click", () => {
      if (!state.image) return toast("เลือกภาพก่อน", "warn");
      setTool("scale");
      toast("คลิกจุดแรกบนไม้บรรทัด", "info", 2500);
    });
    $("#startMeasureBtn").addEventListener("click", () => {
      if (!state.image) return toast("เลือกภาพก่อน", "warn");
      setTool("measure");
      toast("คลิกจุดแรกที่ต้องการวัด", "info", 2500);
    });
    $("#useMeasureAsHeightBtn").addEventListener("click", () => {
      const px = measureLengthPx();
      const upp = getUnitPerPixel();
      if (!px) return toast("วัดระยะก่อน (คลิก 2 จุด)", "warn");
      if (!upp) return toast("ต้องตั้งสเกลก่อนจึงจะได้ค่าเป็นเซนติเมตร", "warn");
      const cm = (px * upp * LENGTH_TO_MM[state.calibration.unit]) / 10;
      $("#loafHeightInput").value = cm.toFixed(2);
      toast(`ใส่ความสูง ${cm.toFixed(2)} cm ในแบบฟอร์มคลังข้อมูลแล้ว`, "success");
    });
    $("#wholeImageRoiBtn").addEventListener("click", () => {
      if (!state.image) return toast("เลือกภาพก่อน", "warn");
      state.roi = { type: "rect", x: 0, y: 0, width: state.imageWidth, height: state.imageHeight };
      if (state.analysis) scheduleAnalyze();
      drawWorkspace();
      toast("ใช้ทั้งภาพเป็น ROI — ระวังพื้นหลังและเปลือกจะถูกนับด้วย", "warn", 5000);
    });
    $("#clearRoiBtn").addEventListener("click", () => {
      state.roi = null;
      resetAnalysis("ล้าง ROI แล้ว");
    });
    $("#clearScaleBtn").addEventListener("click", () => {
      state.calibration.point1 = null;
      state.calibration.point2 = null;
      updateCalibrationReadout();
      if (state.analysis) scheduleAnalyze();
      drawWorkspace();
    });
    dom.realLengthInput.addEventListener("input", () => {
      state.calibration.realLength = Number(dom.realLengthInput.value);
      updateCalibrationReadout();
      scheduleAnalyze();
      drawWorkspace();
    });
    dom.unitSelect.addEventListener("change", () => {
      state.calibration.unit = dom.unitSelect.value;
      updateCalibrationReadout();
      scheduleAnalyze();
      drawWorkspace();
    });

    dom.thresholdInput.addEventListener("input", () => {
      dom.thresholdValue.textContent = dom.thresholdInput.value;
      state.processing.threshold = Number(dom.thresholdInput.value);
      state.processing.thresholdTouched = true;
      if (state.analysis && state.viewMode === "original") {
        state.viewMode = "binary";
        $$(".view-button").forEach((b) => b.classList.toggle("active", b.dataset.view === "binary"));
      }
      scheduleAnalyze();
    });
    ["#poreModeSelect", "#minAreaInput", "#maxAreaInput", "#cleanMaskInput", "#excludeBoundaryInput"].forEach((selector) => {
      $(selector).addEventListener("change", () => {
        syncProcessingStateFromInputs();
        updateCalibrationReadout();
        if (selector === "#poreModeSelect") state.processing.thresholdTouched = false;
        scheduleAnalyze();
      });
    });
    $("#otsuBtn").addEventListener("click", () => {
      if (!state.image || !state.roi) return toast("เลือกภาพและกำหนด ROI ก่อน", "warn");
      const source = createProcessingSource(normaliseRoi(state.roi));
      const threshold = otsuThreshold(source.histogram, source.insideCount);
      state.processing.threshold = threshold;
      state.processing.thresholdTouched = true;
      dom.thresholdInput.value = threshold;
      dom.thresholdValue.textContent = threshold;
      if (state.analysis) scheduleAnalyze();
      else setStatus(`Otsu แนะนำ Threshold = ${threshold} — กด “วิเคราะห์รูพรุน”`, "done");
    });

    $("#analyzeBtn").addEventListener("click", () => analyzeImage());
    $("#exportPoreCsvBtn").addEventListener("click", exportPoreCsv);
    $("#saveSampleBtn").addEventListener("click", goToSaveForm);
    $("#saveRepositoryBtn").addEventListener("click", saveCurrentSample);
    $("#printReportBtn").addEventListener("click", () => window.print());

    dom.poreTableBody.addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-pore-id]");
      if (row) selectPore(row.dataset.poreId, { zoom: true });
    });

    const ws = dom.workspaceCanvas;
    ws.addEventListener("pointerdown", handleWorkspacePointerDown);
    ws.addEventListener("pointermove", handleWorkspacePointerMove);
    ws.addEventListener("pointerup", handleWorkspacePointerUp);
    ws.addEventListener("pointercancel", handleWorkspacePointerUp);
    ws.addEventListener("wheel", (event) => handleCanvasWheel(event, "workspaceView", drawWorkspace), { passive: false });

    const gc = dom.geometryCanvas;
    gc.addEventListener("pointerdown", handleGeometryPointerDown);
    gc.addEventListener("pointermove", handleGeometryPointerMove);
    gc.addEventListener("pointerup", handleGeometryPointerUp);
    gc.addEventListener("pointercancel", handleGeometryPointerUp);
    gc.addEventListener("dblclick", () => { if (state.geometry.tool === "polygon") finishPolygon(); });
    gc.addEventListener("wheel", (event) => handleCanvasWheel(event, "geometryView", drawGeometryCanvas), { passive: false });

    dom.geometryPoreSelect.addEventListener("change", () => {
      selectPore(dom.geometryPoreSelect.value);
      fitGeometryToSelectedPore();
      updateGeometryMetrics();
    });
    $("#finishPolygonBtn").addEventListener("click", finishPolygon);
    $("#undoGeometryBtn").addEventListener("click", () => {
      const pore = getGeometryPore();
      if (!pore) return;
      if (state.geometry.polygonDraft.length) {
        state.geometry.polygonDraft.pop();
      } else {
        for (let i = state.geometry.shapes.length - 1; i >= 0; i -= 1) {
          if (state.geometry.shapes[i].poreId === pore.id) { state.geometry.shapes.splice(i, 1); break; }
        }
      }
      drawGeometryCanvas();
      updateGeometryMetrics();
    });
    $("#clearGeometryBtn").addEventListener("click", () => {
      const pore = getGeometryPore();
      if (!pore) return;
      state.geometry.shapes = state.geometry.shapes.filter((shape) => shape.poreId !== pore.id);
      state.geometry.polygonDraft = [];
      drawGeometryCanvas();
      updateGeometryMetrics();
    });
    dom.shapeList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-delete-shape]");
      if (!button) return;
      state.geometry.shapes = state.geometry.shapes.filter((shape) => shape.id !== button.dataset.deleteShape);
      drawGeometryCanvas();
      updateGeometryMetrics();
    });
    document.addEventListener("keydown", (event) => {
      if (!$("#tab-geometry").classList.contains("active")) return;
      if (event.target.matches("input, textarea, select")) return;
      if (event.key === "Escape") { state.geometry.polygonDraft = []; drawGeometryCanvas(); }
      if (event.key === "Enter" && state.geometry.polygonDraft.length) finishPolygon();
    });

    // Calculus
    dom.calculusPoreSelect.addEventListener("change", () => {
      selectPore(dom.calculusPoreSelect.value);
      state.calculus.hover = null;
      resetChallenge();
      updateCalculus();
    });
    $("#calculusAxisSelect").addEventListener("change", (event) => {
      state.calculus.axis = event.target.value;
      state.calculus.hover = null;
      resetChallenge();
      updateCalculus();
    });
    $("#riemannNInput").addEventListener("input", (event) => { stopPlay(); setCalculusN(Number(event.target.value)); });
    $$(".n-presets button").forEach((button) => button.addEventListener("click", () => { stopPlay(); setCalculusN(Number(button.dataset.n)); }));
    $("#riemannMethodSelect").addEventListener("change", (event) => {
      state.calculus.method = event.target.value;
      state.calculus.hover = null;
      resetChallenge();
      updateCalculus();
    });
    $("#playNBtn").addEventListener("click", togglePlay);
    $("#revealChallengeBtn").addEventListener("click", revealChallenge);
    $("#exportStepCsvBtn").addEventListener("click", exportStepCsv);
    $$(".conv-view").forEach((button) => button.addEventListener("click", () => {
      state.calculus.convView = button.dataset.conv;
      $$(".conv-view").forEach((b) => b.classList.toggle("active", b === button));
      drawConvergenceChart();
    }));
    for (const [id, handler] of [["#riemannChart", handleRiemannHover], ["#poreStripCanvas", handlePoreStripHover]]) {
      const canvas = $(id);
      canvas.addEventListener("pointermove", handler);
      canvas.addEventListener("pointerdown", handler);
      canvas.addEventListener("pointerleave", (event) => { if (event.pointerType === "mouse") setCalcHover(null); });
    }
    $("#stepTableBody").addEventListener("pointerover", (event) => {
      const row = event.target.closest("tr[data-strip]");
      if (row) setCalcHover(Number(row.dataset.strip));
    });

    // Repository & dashboard
    dom.repositoryCards.addEventListener("click", (event) => {
      const load = event.target.closest("[data-load-record]");
      const del = event.target.closest("[data-delete-record]");
      if (load) loadRecordIntoWorkspace(load.dataset.loadRecord);
      if (del) deleteRecord(del.dataset.deleteRecord);
    });
    $("#exportRepositoryJsonBtn").addEventListener("click", exportRepositoryJson);
    $("#exportRepositoryCsvBtn").addEventListener("click", exportRepositoryCsv);
    $("#importRepositoryInput").addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      if (file) importRepository(file);
      event.target.value = "";
    });
    $("#clearRepositoryBtn").addEventListener("click", clearAllRepository);
    dom.dashboardSeriesSelect.addEventListener("change", updateDashboard);
    dom.dashboardMetricSelect.addEventListener("change", updateDashboard);

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeCanvases();
        const active = $(".tab-panel.active")?.id;
        if (active === "tab-calculus") updateCalculus();
        if (active === "tab-dashboard") updateDashboard();
      }, 120);
    });
    window.addEventListener("beforeprint", () => {
      const active = $(".tab-panel.active")?.id;
      if (active === "tab-calculus") updateCalculus();
    });
  }

  async function init() {
    bindEvents();
    resizeCanvases();
    setTool("pan");
    setGeometryTool("circle");
    updateCalibrationReadout();
    updateSummary();
    renderPoreTable();
    refreshPoreSelects();
    $("#riemannMethodSelect").value = state.calculus.method;
    updateCalculus();
    await loadRepository();
    renderRepository();
    updateDashboardControls();
    updateDashboard();
    updateStepper();
    if (DEBUG) {
      window.MathScope = { state, loadImageFromDataUrl, analyzeImage, createAccuracyTestImage, buildProfile, computeRiemann, getUnitPerPixel, setActiveTab, selectPore, saveCurrentSample, updateCalculus };
    }
  }

  init();
})();
