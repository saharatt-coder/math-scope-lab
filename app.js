(() => {
  "use strict";

  const STORAGE_KEY = "mathvision-pore-lab-complete-v1";
  const MAX_PROCESSING_DIMENSION = 900;
  const COLORS = {
    cyan: "#22d3ee",
    orange: "#f97316",
    amber: "#f59e0b",
    white: "#ffffff",
    navy: "#0f172a",
    grid: "#dbe3ee",
    muted: "#64748b",
    green: "#16a34a",
    red: "#dc2626",
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const state = {
    image: null,
    imageDataUrl: "",
    imageName: "",
    imageWidth: 0,
    imageHeight: 0,
    tool: "pan",
    viewMode: "original",
    calibration: { point1: null, point2: null, realLength: 10, unit: "mm" },
    roi: null,
    processing: {
      threshold: 115,
      poreMode: "dark",
      minAreaPx: 20,
      maxAreaPercent: 12,
      cleanMask: true,
      excludeBoundary: true,
    },
    analysis: null,
    selectedPoreId: null,
    geometry: {
      tool: "circle",
      shapes: [],
      polygonDraft: [],
      selectedPoreId: null,
    },
    calculus: {
      poreId: null,
      n: 20,
      method: "midpoint",
      result: null,
    },
    repository: [],
    workspaceView: { scale: 1, x: 0, y: 0 },
    geometryView: { scale: 1, x: 0, y: 0 },
    interaction: null,
    geometryInteraction: null,
  };

  const dom = {
    imageInput: $("#imageInput"),
    demoImageBtn: $("#demoImageBtn"),
    imageName: $("#imageName"),
    workspaceCanvas: $("#workspaceCanvas"),
    workspaceWrap: $("#canvasWrap"),
    emptyCanvasState: $("#emptyCanvasState"),
    geometryCanvas: $("#geometryCanvas"),
    geometryWrap: $(".geometry-canvas-wrap"),
    geometryEmptyState: $("#geometryEmptyState"),
    thresholdInput: $("#thresholdInput"),
    thresholdValue: $("#thresholdValue"),
    realLengthInput: $("#realLengthInput"),
    unitSelect: $("#unitSelect"),
    pixelLengthReadout: $("#pixelLengthReadout"),
    calibrationReadout: $("#calibrationReadout"),
    scaleReadout: $("#scaleReadout"),
    toolHint: $("#toolHint"),
    workspaceModeTitle: $("#workspaceModeTitle"),
    workspaceModeDetail: $("#workspaceModeDetail"),
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
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatNumber(value, digits = 3) {
    if (!Number.isFinite(Number(value))) return "—";
    return new Intl.NumberFormat("th-TH", { maximumFractionDigits: digits }).format(Number(value));
  }

  function uid(prefix = "id") {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function getPixelLength() {
    const { point1, point2 } = state.calibration;
    if (!point1 || !point2) return null;
    return Math.hypot(point2.x - point1.x, point2.y - point1.y);
  }

  function getUnitPerPixel() {
    const pixelLength = getPixelLength();
    const realLength = Number(state.calibration.realLength);
    if (!pixelLength || !Number.isFinite(realLength) || realLength <= 0) return null;
    return realLength / pixelLength;
  }

  function areaUnit() {
    return getUnitPerPixel() ? `${state.calibration.unit}²` : "px²";
  }

  function lengthUnit() {
    return getUnitPerPixel() ? state.calibration.unit : "px";
  }

  function setStatus(message, kind = "idle") {
    dom.analysisStatus.textContent = message;
    dom.analysisStatus.className = `status-message ${kind}`;
  }

  function setActiveTab(tabName) {
    $$(".tab-button").forEach((button) => button.classList.toggle("active", button.dataset.tab === tabName));
    $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${tabName}`));
    requestAnimationFrame(() => {
      resizeCanvases();
      if (tabName === "geometry") {
        drawGeometryCanvas();
        updateGeometryMetrics();
      }
      if (tabName === "calculus") updateCalculus();
      if (tabName === "repository") renderRepository();
      if (tabName === "dashboard") updateDashboard();
    });
  }

  function toolCopy(tool) {
    const copies = {
      pan: ["โหมด Pan", "ลากเพื่อเลื่อน · หมุนล้อหรือ Trackpad เพื่อซูม"],
      scale: ["โหมด Scale", "คลิกจุดเริ่มและจุดสิ้นสุดบนวัตถุอ้างอิง"],
      "roi-ellipse": ["โหมด ROI วงรี", "ลากวงรีครอบหน้าตัดขนมปัง"],
      "roi-rect": ["โหมด ROI สี่เหลี่ยม", "ลากสี่เหลี่ยมครอบบริเวณที่ต้องการวิเคราะห์"],
      select: ["โหมด Select Pore", "คลิกบนรูพรุนหรือกรอบเพื่อตรวจดูค่ารายรู"],
    };
    return copies[tool] || copies.pan;
  }

  function setTool(tool) {
    state.tool = tool;
    $$(".tool-button").forEach((button) => button.classList.toggle("active", button.dataset.tool === tool));
    const [title, detail] = toolCopy(tool);
    dom.workspaceModeTitle.textContent = title;
    dom.workspaceModeDetail.textContent = detail;
    dom.toolHint.textContent = `${title} — ${detail}`;
    drawWorkspace();
  }

  function setGeometryTool(tool) {
    state.geometry.tool = tool;
    $$(".geometry-tool").forEach((button) => button.classList.toggle("active", button.dataset.geometryTool === tool));
    if (tool !== "polygon") state.geometry.polygonDraft = [];
    drawGeometryCanvas();
  }

  function resetAnalysis(reason = "") {
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
    drawWorkspace();
    drawGeometryCanvas();
    if (reason) setStatus(reason, "idle");
  }

  function resizeCanvasToWrap(canvas, wrap, minimumHeight = 480) {
    const rect = wrap.getBoundingClientRect();
    const cssWidth = Math.max(320, Math.floor(rect.width));
    const cssHeight = Math.max(minimumHeight, Math.floor(rect.height || minimumHeight));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const context = canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    canvas._cssWidth = cssWidth;
    canvas._cssHeight = cssHeight;
    canvas._dpr = dpr;
  }

  function resizeCanvases() {
    resizeCanvasToWrap(dom.workspaceCanvas, dom.workspaceWrap, 660);
    resizeCanvasToWrap(dom.geometryCanvas, dom.geometryWrap, 720);
    drawWorkspace();
    drawGeometryCanvas();
  }

  function fitImage(viewKey = "workspaceView") {
    if (!state.image) return;
    const canvas = viewKey === "workspaceView" ? dom.workspaceCanvas : dom.geometryCanvas;
    const width = canvas._cssWidth || 900;
    const height = canvas._cssHeight || 650;
    const padding = 36;
    const scale = Math.min(
      (width - padding * 2) / state.imageWidth,
      (height - padding * 2) / state.imageHeight,
      1,
    );
    state[viewKey] = {
      scale,
      x: (width - state.imageWidth * scale) / 2,
      y: (height - state.imageHeight * scale) / 2,
    };
    if (viewKey === "workspaceView") drawWorkspace(); else drawGeometryCanvas();
  }

  function fitGeometryToSelectedPore() {
    const pore = getGeometryPore();
    if (!pore) return;
    const canvas = dom.geometryCanvas;
    const width = canvas._cssWidth || 900;
    const height = canvas._cssHeight || 720;
    const padding = 90;
    const box = pore.boundingBox;
    const scale = clamp(Math.min((width - padding * 2) / box.width, (height - padding * 2) / box.height), 0.05, 18);
    state.geometryView = {
      scale,
      x: width / 2 - (box.x + box.width / 2) * scale,
      y: height / 2 - (box.y + box.height / 2) * scale,
    };
    drawGeometryCanvas();
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

  function drawBaseImage(ctx, view) {
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);
    ctx.drawImage(state.image, 0, 0, state.imageWidth, state.imageHeight);
    ctx.restore();
  }

  function drawWorkspace() {
    const canvas = dom.workspaceCanvas;
    const ctx = canvas.getContext("2d");
    const width = canvas._cssWidth || 900;
    const height = canvas._cssHeight || 660;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, width, height);
    dom.emptyCanvasState.classList.toggle("hidden", Boolean(state.image));
    if (!state.image) return;

    const view = state.workspaceView;
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);
    ctx.drawImage(state.image, 0, 0, state.imageWidth, state.imageHeight);

    if (state.analysis && state.viewMode === "binary") {
      ctx.globalAlpha = 0.94;
      ctx.drawImage(
        state.analysis.binaryCanvas,
        state.analysis.roi.x,
        state.analysis.roi.y,
        state.analysis.roi.width,
        state.analysis.roi.height,
      );
      ctx.globalAlpha = 1;
    }

    if (state.analysis && state.viewMode === "detection") {
      ctx.globalAlpha = 0.76;
      ctx.drawImage(
        state.analysis.overlayCanvas,
        state.analysis.roi.x,
        state.analysis.roi.y,
        state.analysis.roi.width,
        state.analysis.roi.height,
      );
      ctx.globalAlpha = 1;
    }

    drawPoreBoxes(ctx, view.scale);
    drawRoi(ctx, view.scale);
    drawCalibration(ctx, view.scale);
    drawInteractionPreview(ctx, view.scale);
    ctx.restore();
  }

  function drawPoreBoxes(ctx, scale) {
    if (!state.analysis) return;
    for (const pore of state.analysis.pores) {
      const selected = pore.id === state.selectedPoreId;
      ctx.save();
      ctx.lineWidth = (selected ? 4 : 1.4) / scale;
      ctx.strokeStyle = selected ? COLORS.cyan : "rgba(255,255,255,.62)";
      if (!selected) ctx.setLineDash([5 / scale, 4 / scale]);
      ctx.strokeRect(pore.boundingBox.x, pore.boundingBox.y, pore.boundingBox.width, pore.boundingBox.height);
      if (selected) {
        ctx.fillStyle = "rgba(34,211,238,.12)";
        ctx.fillRect(pore.boundingBox.x, pore.boundingBox.y, pore.boundingBox.width, pore.boundingBox.height);
        ctx.font = `bold ${15 / scale}px sans-serif`;
        ctx.fillStyle = COLORS.white;
        ctx.fillText(pore.id, pore.boundingBox.x, pore.boundingBox.y - 8 / scale);
      }
      ctx.restore();
    }
  }

  function drawRoi(ctx, scale) {
    if (!state.roi) return;
    const roi = state.roi;
    ctx.save();
    ctx.strokeStyle = COLORS.cyan;
    ctx.fillStyle = "rgba(34,211,238,.06)";
    ctx.lineWidth = 3 / scale;
    ctx.setLineDash([10 / scale, 6 / scale]);
    ctx.beginPath();
    if (roi.type === "ellipse") {
      ctx.ellipse(roi.x + roi.width / 2, roi.y + roi.height / 2, roi.width / 2, roi.height / 2, 0, 0, Math.PI * 2);
    } else {
      ctx.rect(roi.x, roi.y, roi.width, roi.height);
    }
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `bold ${14 / scale}px sans-serif`;
    ctx.fillStyle = "#e6fbff";
    ctx.fillText(`ROI ${roi.width.toFixed(0)} × ${roi.height.toFixed(0)} px`, roi.x + 8 / scale, roi.y + 20 / scale);
    ctx.restore();
  }

  function drawCalibration(ctx, scale) {
    const { point1, point2 } = state.calibration;
    if (!point1) return;
    ctx.save();
    ctx.lineWidth = 3 / scale;
    ctx.strokeStyle = COLORS.orange;
    ctx.fillStyle = COLORS.white;
    if (point2) {
      ctx.beginPath();
      ctx.moveTo(point1.x, point1.y);
      ctx.lineTo(point2.x, point2.y);
      ctx.stroke();
      const px = getPixelLength();
      ctx.font = `bold ${16 / scale}px sans-serif`;
      ctx.fillStyle = COLORS.white;
      ctx.fillText(`${px.toFixed(2)} px`, (point1.x + point2.x) / 2 + 9 / scale, (point1.y + point2.y) / 2 - 10 / scale);
    }
    for (const point of [point1, point2].filter(Boolean)) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 7 / scale, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.white;
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawInteractionPreview(ctx, scale) {
    const interaction = state.interaction;
    if (!interaction || !interaction.start || !interaction.current) return;
    if (!interaction.type.startsWith("roi")) return;
    const x = Math.min(interaction.start.x, interaction.current.x);
    const y = Math.min(interaction.start.y, interaction.current.y);
    const width = Math.abs(interaction.current.x - interaction.start.x);
    const height = Math.abs(interaction.current.y - interaction.start.y);
    ctx.save();
    ctx.strokeStyle = COLORS.cyan;
    ctx.fillStyle = "rgba(34,211,238,.09)";
    ctx.lineWidth = 2 / scale;
    ctx.setLineDash([8 / scale, 5 / scale]);
    ctx.beginPath();
    if (interaction.type === "roi-ellipse") ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    else ctx.rect(x, y, width, height);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function updateCalibrationReadout() {
    const pixelLength = getPixelLength();
    const unitPerPixel = getUnitPerPixel();
    dom.pixelLengthReadout.textContent = pixelLength ? `${formatNumber(pixelLength, 2)} px` : "— px";
    dom.calibrationReadout.textContent = unitPerPixel
      ? `1 px = ${formatNumber(unitPerPixel, 6)} ${state.calibration.unit}`
      : "ยังไม่ Calibrate";
    dom.scaleReadout.textContent = unitPerPixel
      ? `1 px = ${formatNumber(unitPerPixel, 6)} ${state.calibration.unit}`
      : "หน่วยพิกเซล";
  }

  function loadImageFromDataUrl(dataUrl, name = "image") {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        state.image = image;
        state.imageDataUrl = dataUrl;
        state.imageName = name;
        state.imageWidth = image.naturalWidth || image.width;
        state.imageHeight = image.naturalHeight || image.height;
        dom.imageName.textContent = name;
        state.calibration.point1 = null;
        state.calibration.point2 = null;
        state.roi = null;
        resetAnalysis();
        fitImage("workspaceView");
        fitImage("geometryView");
        updateCalibrationReadout();
        setStatus("อัปโหลดภาพแล้ว — กำหนด ROI และสเกลก่อนวิเคราะห์", "done");
        resolve();
      };
      image.onerror = () => reject(new Error("ไม่สามารถอ่านไฟล์ภาพได้"));
      image.src = dataUrl;
    });
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
    ctx.ellipse(700, 450, 500, 335, -0.04, 0, Math.PI * 2);
    ctx.clip();
    const crumb = ctx.createRadialGradient(620, 360, 40, 700, 450, 620);
    crumb.addColorStop(0, "#f8e7bd");
    crumb.addColorStop(.58, "#e8c989");
    crumb.addColorStop(1, "#a86b2c");
    ctx.fillStyle = crumb;
    ctx.fillRect(160, 90, 1080, 720);

    const random = mulberry32(1508);
    for (let i = 0; i < 115; i += 1) {
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random());
      const x = 700 + Math.cos(angle) * radius * 445;
      const y = 450 + Math.sin(angle) * radius * 280;
      const rx = 8 + random() * 34;
      const ry = 6 + random() * 25;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((random() - .5) * 1.2);
      ctx.fillStyle = `rgba(${28 + random() * 25},${19 + random() * 20},${12 + random() * 13},${.78 + random() * .18})`;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    ctx.strokeStyle = "#7c4a1d";
    ctx.lineWidth = 26;
    ctx.beginPath();
    ctx.ellipse(700, 450, 505, 340, -0.04, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = "white";
    ctx.fillRect(140, 820, 500, 28);
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 3;
    for (let i = 0; i <= 20; i += 1) {
      const x = 140 + i * 25;
      ctx.beginPath();
      ctx.moveTo(x, 820);
      ctx.lineTo(x, i % 5 === 0 ? 852 : 842);
      ctx.stroke();
    }
    ctx.font = "bold 22px sans-serif";
    ctx.fillStyle = "#111827";
    ctx.fillText("0", 132, 884);
    ctx.fillText("100 mm", 572, 884);

    return canvas.toDataURL("image/jpeg", .92);
  }

  function mulberry32(seed) {
    return function random() {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function normaliseRoi(roi) {
    if (!roi) return null;
    const x1 = clamp(Math.min(roi.x, roi.x + roi.width), 0, state.imageWidth);
    const y1 = clamp(Math.min(roi.y, roi.y + roi.height), 0, state.imageHeight);
    const x2 = clamp(Math.max(roi.x, roi.x + roi.width), 0, state.imageWidth);
    const y2 = clamp(Math.max(roi.y, roi.y + roi.height), 0, state.imageHeight);
    return {
      type: roi.type === "ellipse" ? "ellipse" : "rect",
      x: x1,
      y: y1,
      width: Math.max(1, x2 - x1),
      height: Math.max(1, y2 - y1),
    };
  }

  function isInsideRoiShape(x, y, width, height, type) {
    if (type !== "ellipse") return true;
    const rx = width / 2;
    const ry = height / 2;
    const dx = (x + .5 - rx) / rx;
    const dy = (y + .5 - ry) / ry;
    return dx * dx + dy * dy <= 1;
  }

  function createProcessingSource(roi) {
    const longest = Math.max(roi.width, roi.height);
    const processScale = Math.min(1, MAX_PROCESSING_DIMENSION / longest);
    const width = Math.max(1, Math.round(roi.width * processScale));
    const height = Math.max(1, Math.round(roi.height * processScale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(state.image, roi.x, roi.y, roi.width, roi.height, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const insideMask = new Uint8Array(width * height);
    const histogram = new Uint32Array(256);
    let insideCount = 0;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (!isInsideRoiShape(x, y, width, height, roi.type)) continue;
        const offset = index * 4;
        const gray = Math.round(
          .299 * imageData.data[offset] + .587 * imageData.data[offset + 1] + .114 * imageData.data[offset + 2],
        );
        insideMask[index] = 1;
        histogram[gray] += 1;
        insideCount += 1;
      }
    }

    return {
      canvas,
      ctx,
      imageData,
      insideMask,
      histogram,
      insideCount,
      width,
      height,
      scaleX: roi.width / width,
      scaleY: roi.height / height,
    };
  }

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
    const data = source.imageData.data;
    for (let index = 0; index < mask.length; index += 1) {
      if (!source.insideMask[index]) continue;
      const offset = index * 4;
      const gray = Math.round(.299 * data[offset] + .587 * data[offset + 1] + .114 * data[offset + 2]);
      const isPore = mode === "light" ? gray >= threshold : gray <= threshold;
      mask[index] = isPore ? 1 : 0;
    }
    return mask;
  }

  function erode(mask, insideMask, width, height) {
    const result = new Uint8Array(mask.length);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        if (!insideMask[index] || !mask[index]) continue;
        let keep = 1;
        for (let dy = -1; dy <= 1 && keep; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const neighbor = index + dy * width + dx;
            if (!insideMask[neighbor] || !mask[neighbor]) {
              keep = 0;
              break;
            }
          }
        }
        result[index] = keep;
      }
    }
    return result;
  }

  function dilate(mask, insideMask, width, height) {
    const result = new Uint8Array(mask.length);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        if (!insideMask[index]) continue;
        let fill = 0;
        for (let dy = -1; dy <= 1 && !fill; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const neighbor = index + dy * width + dx;
            if (mask[neighbor]) {
              fill = 1;
              break;
            }
          }
        }
        result[index] = fill;
      }
    }
    return result;
  }

  function cleanMask(mask, insideMask, width, height) {
    const opened = dilate(erode(mask, insideMask, width, height), insideMask, width, height);
    return erode(dilate(opened, insideMask, width, height), insideMask, width, height);
  }

  function buildMaskCanvas(mask, insideMask, width, height, type = "binary") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const imageData = ctx.createImageData(width, height);
    for (let index = 0; index < mask.length; index += 1) {
      const offset = index * 4;
      if (!insideMask[index]) {
        imageData.data[offset + 3] = 0;
        continue;
      }
      if (type === "binary") {
        const value = mask[index] ? 255 : 22;
        imageData.data[offset] = value;
        imageData.data[offset + 1] = value;
        imageData.data[offset + 2] = value;
        imageData.data[offset + 3] = 255;
      } else if (mask[index]) {
        imageData.data[offset] = 249;
        imageData.data[offset + 1] = 115;
        imageData.data[offset + 2] = 22;
        imageData.data[offset + 3] = 180;
      }
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  function detectComponents(source, mask, roi) {
    const width = source.width;
    const height = source.height;
    const work = mask.slice();
    const queue = new Int32Array(mask.length);
    const acceptedOverlay = new Uint8Array(mask.length);
    const pores = [];
    const areaPerProcessPixel = source.scaleX * source.scaleY;
    const roiAreaPx = source.insideCount * areaPerProcessPixel;
    const maxAreaPx = roiAreaPx * (Number(state.processing.maxAreaPercent) / 100);
    const minAreaPx = Math.max(1, Number(state.processing.minAreaPx) || 1);
    const neighbors8 = [
      [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
    ];

    for (let start = 0; start < work.length; start += 1) {
      if (!work[start]) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      work[start] = 0;
      let count = 0;
      let sumX = 0;
      let sumY = 0;
      let minX = width;
      let minY = height;
      let maxX = 0;
      let maxY = 0;
      let perimeterPx = 0;
      let touchesBoundary = false;

      while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = Math.floor(index / width);
        count += 1;
        sumX += x;
        sumY += y;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);

        const left = x > 0 ? index - 1 : -1;
        const right = x < width - 1 ? index + 1 : -1;
        const top = y > 0 ? index - width : -1;
        const bottom = y < height - 1 ? index + width : -1;
        if (left < 0 || !source.insideMask[left] || !mask[left]) perimeterPx += source.scaleY;
        if (right < 0 || !source.insideMask[right] || !mask[right]) perimeterPx += source.scaleY;
        if (top < 0 || !source.insideMask[top] || !mask[top]) perimeterPx += source.scaleX;
        if (bottom < 0 || !source.insideMask[bottom] || !mask[bottom]) perimeterPx += source.scaleX;

        for (const [dx, dy] of neighbors8) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
            touchesBoundary = true;
            continue;
          }
          const neighbor = ny * width + nx;
          if (!source.insideMask[neighbor]) {
            touchesBoundary = true;
            continue;
          }
          if (work[neighbor]) {
            work[neighbor] = 0;
            queue[tail++] = neighbor;
          }
        }
      }

      const areaPx = count * areaPerProcessPixel;
      const accepted = areaPx >= minAreaPx && areaPx <= maxAreaPx && (!state.processing.excludeBoundary || !touchesBoundary);
      if (!accepted) continue;
      const processIndices = [];
      for (let i = 0; i < tail; i += 1) {
        const index = queue[i];
        acceptedOverlay[index] = 1;
        processIndices.push(index);
      }
      const centerProcessX = sumX / count + .5;
      const centerProcessY = sumY / count + .5;
      const eqDiameterPx = 2 * Math.sqrt(areaPx / Math.PI);
      const circularity = perimeterPx ? Math.min(1, (4 * Math.PI * areaPx) / perimeterPx ** 2) : 0;
      const unitPerPixel = getUnitPerPixel();
      pores.push({
        id: "",
        areaPx,
        areaReal: unitPerPixel ? areaPx * unitPerPixel ** 2 : null,
        perimeterPx,
        perimeterReal: unitPerPixel ? perimeterPx * unitPerPixel : null,
        equivalentDiameterPx: eqDiameterPx,
        equivalentDiameterReal: unitPerPixel ? eqDiameterPx * unitPerPixel : null,
        circularity,
        center: {
          x: roi.x + centerProcessX * source.scaleX,
          y: roi.y + centerProcessY * source.scaleY,
        },
        boundingBox: {
          x: roi.x + minX * source.scaleX,
          y: roi.y + minY * source.scaleY,
          width: (maxX - minX + 1) * source.scaleX,
          height: (maxY - minY + 1) * source.scaleY,
        },
        processBounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
        processIndices,
        indexSet: new Set(processIndices),
      });
    }

    pores.sort((a, b) => b.areaPx - a.areaPx);
    pores.forEach((pore, index) => { pore.id = `P-${String(index + 1).padStart(3, "0")}`; });
    return { pores, acceptedOverlay, roiAreaPx };
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function standardDeviation(values) {
    if (!values.length) return 0;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  }

  async function analyzeImage() {
    if (!state.image) {
      alert("กรุณาอัปโหลดภาพก่อน");
      return;
    }
    if (!state.roi || state.roi.width < 8 || state.roi.height < 8) {
      alert("กรุณาลาก ROI ครอบบริเวณขนมปังก่อน");
      return;
    }
    try {
      setStatus("กำลังประมวลผลภาพและตรวจหารูพรุน…", "working");
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const roi = normaliseRoi(state.roi);
      const source = createProcessingSource(roi);
      let binaryMask = createBinaryMask(source, Number(state.processing.threshold), state.processing.poreMode);
      if (state.processing.cleanMask) binaryMask = cleanMask(binaryMask, source.insideMask, source.width, source.height);
      const componentResult = detectComponents(source, binaryMask, roi);
      const binaryCanvas = buildMaskCanvas(binaryMask, source.insideMask, source.width, source.height, "binary");
      const overlayCanvas = buildMaskCanvas(componentResult.acceptedOverlay, source.insideMask, source.width, source.height, "overlay");
      const areasPx = componentResult.pores.map((pore) => pore.areaPx);
      const totalAreaPx = areasPx.reduce((sum, area) => sum + area, 0);
      const unitPerPixel = getUnitPerPixel();
      state.analysis = {
        roi,
        source,
        binaryMask,
        binaryCanvas,
        overlayCanvas,
        pores: componentResult.pores,
        summary: {
          poreCount: componentResult.pores.length,
          totalAreaPx,
          totalAreaReal: unitPerPixel ? totalAreaPx * unitPerPixel ** 2 : null,
          meanAreaPx: areasPx.length ? totalAreaPx / areasPx.length : 0,
          meanAreaReal: unitPerPixel && areasPx.length ? (totalAreaPx / areasPx.length) * unitPerPixel ** 2 : null,
          medianAreaPx: median(areasPx),
          medianAreaReal: unitPerPixel ? median(areasPx) * unitPerPixel ** 2 : null,
          sdAreaPx: standardDeviation(areasPx),
          sdAreaReal: unitPerPixel ? standardDeviation(areasPx) * unitPerPixel ** 2 : null,
          roiAreaPx: componentResult.roiAreaPx,
          roiAreaReal: unitPerPixel ? componentResult.roiAreaPx * unitPerPixel ** 2 : null,
          porosityPercent: componentResult.roiAreaPx ? (totalAreaPx / componentResult.roiAreaPx) * 100 : 0,
        },
      };
      state.selectedPoreId = componentResult.pores[0]?.id || null;
      state.geometry.selectedPoreId = state.selectedPoreId;
      state.calculus.poreId = state.selectedPoreId;
      state.geometry.shapes = [];
      state.geometry.polygonDraft = [];
      state.viewMode = "detection";
      $$(".view-button").forEach((button) => button.classList.toggle("active", button.dataset.view === "detection"));
      setTool("select");
      updateSummary();
      renderPoreTable();
      refreshPoreSelects();
      drawWorkspace();
      drawGeometryCanvas();
      setStatus(
        componentResult.pores.length
          ? `ตรวจพบรูพรุน ${componentResult.pores.length} รู — เลือกรูเพื่อเข้าสู่ Geometry และ Calculus Lab`
          : "ไม่พบรูพรุนตามเกณฑ์ปัจจุบัน ลองปรับ Threshold หรือพื้นที่ต่ำสุด",
        componentResult.pores.length ? "done" : "error",
      );
    } catch (error) {
      console.error(error);
      setStatus(error.message || "วิเคราะห์ภาพไม่สำเร็จ", "error");
    }
  }

  function currentArea(poreOrSummary, realKey, pxKey) {
    return getUnitPerPixel() ? poreOrSummary?.[realKey] : poreOrSummary?.[pxKey];
  }

  function updateSummary() {
    const summary = state.analysis?.summary;
    $("#summaryCount").textContent = summary?.poreCount ?? "—";
    $("#summaryTotalArea").textContent = summary ? `${formatNumber(currentArea(summary, "totalAreaReal", "totalAreaPx"), 3)} ${areaUnit()}` : "—";
    $("#summaryMeanArea").textContent = summary ? `${formatNumber(currentArea(summary, "meanAreaReal", "meanAreaPx"), 3)} ${areaUnit()}` : "—";
    $("#summaryMedianArea").textContent = summary ? `${formatNumber(currentArea(summary, "medianAreaReal", "medianAreaPx"), 3)} ${areaUnit()}` : "—";
    $("#summarySdArea").textContent = summary ? `${formatNumber(currentArea(summary, "sdAreaReal", "sdAreaPx"), 3)} ${areaUnit()}` : "—";
    $("#summaryPorosity").textContent = summary ? `${formatNumber(summary.porosityPercent, 2)}%` : "—";
  }

  function getSelectedPore() {
    return state.analysis?.pores.find((pore) => pore.id === state.selectedPoreId) || null;
  }

  function getGeometryPore() {
    return state.analysis?.pores.find((pore) => pore.id === state.geometry.selectedPoreId) || null;
  }

  function getCalculusPore() {
    return state.analysis?.pores.find((pore) => pore.id === state.calculus.poreId) || null;
  }

  function selectPore(poreId, options = {}) {
    if (!state.analysis?.pores.some((pore) => pore.id === poreId)) return;
    state.selectedPoreId = poreId;
    state.geometry.selectedPoreId = poreId;
    state.calculus.poreId = poreId;
    dom.geometryPoreSelect.value = poreId;
    dom.calculusPoreSelect.value = poreId;
    renderPoreTable();
    drawWorkspace();
    drawGeometryCanvas();
    updateGeometryMetrics();
    updateCalculus();
    if (options.zoom) zoomWorkspaceToPore(poreId);
  }

  function zoomWorkspaceToPore(poreId) {
    const pore = state.analysis?.pores.find((item) => item.id === poreId);
    if (!pore) return;
    const width = dom.workspaceCanvas._cssWidth || 900;
    const height = dom.workspaceCanvas._cssHeight || 660;
    const box = pore.boundingBox;
    const scale = clamp(Math.min((width - 180) / box.width, (height - 180) / box.height), .05, 16);
    state.workspaceView = {
      scale,
      x: width / 2 - (box.x + box.width / 2) * scale,
      y: height / 2 - (box.y + box.height / 2) * scale,
    };
    drawWorkspace();
  }

  function renderPoreTable() {
    const pores = state.analysis?.pores || [];
    if (!pores.length) {
      dom.poreTableBody.innerHTML = '<tr><td colspan="6" class="empty-table-cell">ยังไม่มีข้อมูล</td></tr>';
      dom.selectedPoreCard.classList.add("hidden");
      return;
    }
    dom.poreTableBody.innerHTML = pores.map((pore) => {
      const area = getUnitPerPixel() ? pore.areaReal : pore.areaPx;
      const perimeter = getUnitPerPixel() ? pore.perimeterReal : pore.perimeterPx;
      const diameter = getUnitPerPixel() ? pore.equivalentDiameterReal : pore.equivalentDiameterPx;
      return `
        <tr data-pore-id="${pore.id}" class="${pore.id === state.selectedPoreId ? "selected" : ""}">
          <td><strong>${pore.id}</strong></td>
          <td>${formatNumber(area, 3)} ${areaUnit()}</td>
          <td>${formatNumber(perimeter, 3)} ${lengthUnit()}</td>
          <td>${formatNumber(diameter, 3)} ${lengthUnit()}</td>
          <td>${formatNumber(pore.circularity, 3)}</td>
          <td>(${formatNumber(pore.center.x, 1)}, ${formatNumber(pore.center.y, 1)})</td>
        </tr>`;
    }).join("");
    $$('tr[data-pore-id]', dom.poreTableBody).forEach((row) => {
      row.addEventListener("click", () => selectPore(row.dataset.poreId, { zoom: true }));
    });
    const selected = getSelectedPore();
    if (selected) {
      const area = getUnitPerPixel() ? selected.areaReal : selected.areaPx;
      const diameter = getUnitPerPixel() ? selected.equivalentDiameterReal : selected.equivalentDiameterPx;
      dom.selectedPoreCard.innerHTML = `
        <strong>${selected.id}</strong>
        <span>พื้นที่ ${formatNumber(area, 3)} ${areaUnit()}</span>
        <span>เส้นผ่านศูนย์กลางสมมูล ${formatNumber(diameter, 3)} ${lengthUnit()}</span>
        <span>Circularity ${formatNumber(selected.circularity, 3)}</span>`;
      dom.selectedPoreCard.classList.remove("hidden");
    }
  }

  function refreshPoreSelects() {
    const pores = state.analysis?.pores || [];
    const options = pores.length
      ? pores.map((pore) => `<option value="${pore.id}">${pore.id} · ${formatNumber(getUnitPerPixel() ? pore.areaReal : pore.areaPx, 2)} ${areaUnit()}</option>`).join("")
      : '<option value="">ยังไม่มีข้อมูล</option>';
    dom.geometryPoreSelect.innerHTML = options;
    dom.calculusPoreSelect.innerHTML = options;
    if (pores.length) {
      state.geometry.selectedPoreId = state.geometry.selectedPoreId || pores[0].id;
      state.calculus.poreId = state.calculus.poreId || pores[0].id;
      dom.geometryPoreSelect.value = state.geometry.selectedPoreId;
      dom.calculusPoreSelect.value = state.calculus.poreId;
    }
  }

  function findPoreAtImagePoint(point) {
    if (!state.analysis) return null;
    const { source, roi } = state.analysis;
    const px = Math.floor((point.x - roi.x) / source.scaleX);
    const py = Math.floor((point.y - roi.y) / source.scaleY);
    if (px >= 0 && px < source.width && py >= 0 && py < source.height) {
      const index = py * source.width + px;
      const exact = state.analysis.pores.find((pore) => pore.indexSet.has(index));
      if (exact) return exact;
    }
    return state.analysis.pores.find((pore) => {
      const box = pore.boundingBox;
      return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
    }) || null;
  }

  function handleWorkspacePointerDown(event) {
    if (!state.image) return;
    const point = screenToImage(dom.workspaceCanvas, state.workspaceView, event.clientX, event.clientY);
    if (state.tool === "pan") {
      state.interaction = {
        type: "pan",
        startScreen: { x: point.sx, y: point.sy },
        startView: { ...state.workspaceView },
      };
      dom.workspaceCanvas.setPointerCapture?.(event.pointerId);
      return;
    }
    if (!imagePointInBounds(point)) return;
    if (state.tool === "scale") {
      const handleTolerance = 14 / state.workspaceView.scale;
      const hitPoint1 = state.calibration.point1 && Math.hypot(point.x - state.calibration.point1.x, point.y - state.calibration.point1.y) <= handleTolerance;
      const hitPoint2 = state.calibration.point2 && Math.hypot(point.x - state.calibration.point2.x, point.y - state.calibration.point2.y) <= handleTolerance;
      if (hitPoint1 || hitPoint2) {
        state.interaction = { type: "drag-scale", key: hitPoint1 ? "point1" : "point2" };
        dom.workspaceCanvas.setPointerCapture?.(event.pointerId);
        return;
      }
      if (!state.calibration.point1 || state.calibration.point2) {
        state.calibration.point1 = { x: point.x, y: point.y };
        state.calibration.point2 = null;
      } else {
        state.calibration.point2 = { x: point.x, y: point.y };
      }
      resetAnalysis("แก้เส้นสเกลแล้ว กรุณาวิเคราะห์ใหม่");
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
      if (pore) selectPore(pore.id);
    }
  }

  function handleWorkspacePointerMove(event) {
    const interaction = state.interaction;
    if (!interaction) return;
    const point = screenToImage(dom.workspaceCanvas, state.workspaceView, event.clientX, event.clientY);
    if (interaction.type === "pan") {
      state.workspaceView.x = interaction.startView.x + (point.sx - interaction.startScreen.x);
      state.workspaceView.y = interaction.startView.y + (point.sy - interaction.startScreen.y);
    } else if (interaction.type === "drag-scale") {
      state.calibration[interaction.key] = {
        x: clamp(point.x, 0, state.imageWidth),
        y: clamp(point.y, 0, state.imageHeight),
      };
      updateCalibrationReadout();
    } else if (interaction.type.startsWith("roi")) {
      interaction.current = {
        x: clamp(point.x, 0, state.imageWidth),
        y: clamp(point.y, 0, state.imageHeight),
      };
    }
    drawWorkspace();
  }

  function handleWorkspacePointerUp(event) {
    const interaction = state.interaction;
    if (!interaction) return;
    if (interaction.type === "drag-scale") {
      if (state.analysis) resetAnalysis("ปรับเส้นสเกลแล้ว กรุณาวิเคราะห์ใหม่");
      updateCalibrationReadout();
    }
    if (interaction.type.startsWith("roi")) {
      const x = Math.min(interaction.start.x, interaction.current.x);
      const y = Math.min(interaction.start.y, interaction.current.y);
      const width = Math.abs(interaction.current.x - interaction.start.x);
      const height = Math.abs(interaction.current.y - interaction.start.y);
      if (width >= 8 && height >= 8) {
        state.roi = { type: interaction.type === "roi-ellipse" ? "ellipse" : "rect", x, y, width, height };
        resetAnalysis("ROI เปลี่ยนแล้ว กรุณาวิเคราะห์ใหม่");
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
    const oldScale = view.scale;
    const nextScale = clamp(event.deltaY < 0 ? oldScale * 1.09 : oldScale / 1.09, .025, 20);
    const imagePoint = { x: (pointer.x - view.x) / oldScale, y: (pointer.y - view.y) / oldScale };
    state[viewKey] = {
      scale: nextScale,
      x: pointer.x - imagePoint.x * nextScale,
      y: pointer.y - imagePoint.y * nextScale,
    };
    drawFunction();
  }

  function drawGeometryCanvas() {
    const canvas = dom.geometryCanvas;
    const ctx = canvas.getContext("2d");
    const width = canvas._cssWidth || 900;
    const height = canvas._cssHeight || 720;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, width, height);
    dom.geometryEmptyState.classList.toggle("hidden", Boolean(state.image && getGeometryPore()));
    if (!state.image || !getGeometryPore()) return;
    const view = state.geometryView;
    const pore = getGeometryPore();
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);
    ctx.drawImage(state.image, 0, 0, state.imageWidth, state.imageHeight);

    if (state.analysis?.overlayCanvas) {
      ctx.globalAlpha = .45;
      ctx.drawImage(state.analysis.overlayCanvas, state.analysis.roi.x, state.analysis.roi.y, state.analysis.roi.width, state.analysis.roi.height);
      ctx.globalAlpha = 1;
    }

    ctx.save();
    ctx.strokeStyle = COLORS.cyan;
    ctx.lineWidth = 4 / view.scale;
    ctx.strokeRect(pore.boundingBox.x, pore.boundingBox.y, pore.boundingBox.width, pore.boundingBox.height);
    ctx.fillStyle = "rgba(34,211,238,.08)";
    ctx.fillRect(pore.boundingBox.x, pore.boundingBox.y, pore.boundingBox.width, pore.boundingBox.height);
    ctx.font = `bold ${16 / view.scale}px sans-serif`;
    ctx.fillStyle = COLORS.white;
    ctx.fillText(pore.id, pore.boundingBox.x, pore.boundingBox.y - 8 / view.scale);
    ctx.restore();

    for (const shape of state.geometry.shapes.filter((item) => item.poreId === pore.id)) drawGeometryShape(ctx, shape, view.scale, false);
    if (state.geometryInteraction?.preview) drawGeometryShape(ctx, state.geometryInteraction.preview, view.scale, true);
    if (state.geometry.polygonDraft.length) {
      ctx.save();
      ctx.strokeStyle = COLORS.amber;
      ctx.fillStyle = "rgba(245,158,11,.12)";
      ctx.lineWidth = 2.5 / view.scale;
      ctx.setLineDash([7 / view.scale, 4 / view.scale]);
      ctx.beginPath();
      state.geometry.polygonDraft.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y); else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
      for (const point of state.geometry.polygonDraft) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 5 / view.scale, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.white;
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  function drawGeometryShape(ctx, shape, scale, preview = false) {
    ctx.save();
    ctx.strokeStyle = preview ? COLORS.white : COLORS.amber;
    ctx.fillStyle = preview ? "rgba(255,255,255,.08)" : "rgba(245,158,11,.16)";
    ctx.lineWidth = (preview ? 2 : 2.8) / scale;
    if (preview) ctx.setLineDash([7 / scale, 4 / scale]);
    ctx.beginPath();
    if (shape.type === "rect") {
      ctx.rect(shape.x, shape.y, shape.width, shape.height);
    } else if (shape.type === "ellipse") {
      ctx.ellipse(shape.x, shape.y, shape.radiusX, shape.radiusY, 0, 0, Math.PI * 2);
    } else if (shape.type === "circle") {
      ctx.arc(shape.x, shape.y, shape.radius, 0, Math.PI * 2);
    } else if (shape.type === "polygon") {
      shape.points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y); else ctx.lineTo(point.x, point.y);
      });
      ctx.closePath();
    }
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function geometryShapeFromDrag(tool, start, current, poreId) {
    const x1 = Math.min(start.x, current.x);
    const y1 = Math.min(start.y, current.y);
    const x2 = Math.max(start.x, current.x);
    const y2 = Math.max(start.y, current.y);
    const width = x2 - x1;
    const height = y2 - y1;
    if (tool === "rect") return { id: uid("shape"), poreId, type: "rect", x: x1, y: y1, width, height };
    if (tool === "ellipse") return { id: uid("shape"), poreId, type: "ellipse", x: x1 + width / 2, y: y1 + height / 2, radiusX: width / 2, radiusY: height / 2 };
    const radius = Math.max(width, height) / 2;
    return { id: uid("shape"), poreId, type: "circle", x: x1 + width / 2, y: y1 + height / 2, radius };
  }

  function pointInPolygon(points, x, y) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
      const xi = points[i].x;
      const yi = points[i].y;
      const xj = points[j].x;
      const yj = points[j].y;
      const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi;
      if (intersect) inside = !inside;
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

  function polygonArea(points) {
    let sum = 0;
    for (let i = 0; i < points.length; i += 1) {
      const current = points[i];
      const next = points[(i + 1) % points.length];
      sum += current.x * next.y - next.x * current.y;
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

  function geometryMetrics() {
    const pore = getGeometryPore();
    if (!pore || !state.analysis) return null;
    const shapes = state.geometry.shapes.filter((shape) => shape.poreId === pore.id);
    if (!shapes.length) return { shapeCount: 0, actualAreaPx: pore.areaPx, unionAreaPx: 0, percentError: 100, iou: 0, formulaAreaPx: 0 };
    const { source, roi } = state.analysis;
    const actualSet = pore.indexSet;
    let estimatedCount = 0;
    let intersection = 0;
    let union = 0;
    for (let py = 0; py < source.height; py += 1) {
      for (let px = 0; px < source.width; px += 1) {
        const imageX = roi.x + (px + .5) * source.scaleX;
        const imageY = roi.y + (py + .5) * source.scaleY;
        const estimated = shapes.some((shape) => pointInsideGeometry(shape, imageX, imageY));
        const actual = actualSet.has(py * source.width + px);
        if (estimated) estimatedCount += 1;
        if (estimated && actual) intersection += 1;
        if (estimated || actual) union += 1;
      }
    }
    const unionAreaPx = estimatedCount * source.scaleX * source.scaleY;
    const formulaAreaPx = shapes.reduce((sum, shape) => sum + shapeFormulaArea(shape), 0);
    const percentError = pore.areaPx ? Math.abs(unionAreaPx - pore.areaPx) / pore.areaPx * 100 : 0;
    return {
      shapeCount: shapes.length,
      actualAreaPx: pore.areaPx,
      unionAreaPx,
      formulaAreaPx,
      percentError,
      iou: union ? intersection / union : 0,
    };
  }

  function updateGeometryMetrics() {
    const metrics = geometryMetrics();
    const unitPerPixel = getUnitPerPixel();
    $("#geoShapeCount").textContent = metrics?.shapeCount ?? 0;
    $("#geoActualArea").textContent = metrics ? `${formatNumber(unitPerPixel ? metrics.actualAreaPx * unitPerPixel ** 2 : metrics.actualAreaPx, 3)} ${areaUnit()}` : "—";
    $("#geoEstimateArea").textContent = metrics ? `${formatNumber(unitPerPixel ? metrics.unionAreaPx * unitPerPixel ** 2 : metrics.unionAreaPx, 3)} ${areaUnit()}` : "—";
    $("#geoPercentError").textContent = metrics ? `${formatNumber(metrics.percentError, 2)}%` : "—";
    $("#geoIou").textContent = metrics ? formatNumber(metrics.iou, 3) : "—";
    const challenge = $("#geometryChallenge");
    const success = metrics && metrics.shapeCount > 0 && metrics.percentError < 5 && metrics.iou > .85;
    challenge.classList.toggle("success", success);
    challenge.textContent = success
      ? "ผ่านภารกิจ: Error ต่ำกว่า 5% และ IoU สูงกว่า 0.85"
      : "เป้าหมาย: Error < 5% และ IoU > 0.85";
    renderShapeList();
  }

  function renderShapeList() {
    const pore = getGeometryPore();
    const shapes = pore ? state.geometry.shapes.filter((shape) => shape.poreId === pore.id) : [];
    if (!shapes.length) {
      dom.shapeList.innerHTML = '<span class="shape-chip muted">ยังไม่ได้วางรูป</span>';
      return;
    }
    const names = { circle: "วงกลม", ellipse: "วงรี", rect: "สี่เหลี่ยม", polygon: "รูปหลายเหลี่ยม" };
    dom.shapeList.innerHTML = shapes.map((shape, index) => `
      <span class="shape-chip">${index + 1}. ${names[shape.type] || shape.type}
        <button type="button" data-delete-shape="${shape.id}" aria-label="ลบ">×</button>
      </span>`).join("");
    $$('[data-delete-shape]', dom.shapeList).forEach((button) => {
      button.addEventListener("click", () => {
        state.geometry.shapes = state.geometry.shapes.filter((shape) => shape.id !== button.dataset.deleteShape);
        drawGeometryCanvas();
        updateGeometryMetrics();
      });
    });
  }

  function handleGeometryPointerDown(event) {
    const pore = getGeometryPore();
    if (!state.image || !pore) return;
    const point = screenToImage(dom.geometryCanvas, state.geometryView, event.clientX, event.clientY);
    if (event.shiftKey || event.button === 1) {
      state.geometryInteraction = {
        type: "pan",
        startScreen: { x: point.sx, y: point.sy },
        startView: { ...state.geometryView },
      };
      dom.geometryCanvas.setPointerCapture?.(event.pointerId);
      return;
    }
    if (!imagePointInBounds(point)) return;
    if (state.geometry.tool === "polygon") {
      state.geometry.polygonDraft.push({ x: point.x, y: point.y });
      drawGeometryCanvas();
      return;
    }
    state.geometryInteraction = {
      type: "draw",
      start: { x: point.x, y: point.y },
      current: { x: point.x, y: point.y },
      preview: geometryShapeFromDrag(state.geometry.tool, point, point, pore.id),
    };
    dom.geometryCanvas.setPointerCapture?.(event.pointerId);
  }

  function handleGeometryPointerMove(event) {
    const interaction = state.geometryInteraction;
    if (!interaction) return;
    const point = screenToImage(dom.geometryCanvas, state.geometryView, event.clientX, event.clientY);
    if (interaction.type === "pan") {
      state.geometryView.x = interaction.startView.x + (point.sx - interaction.startScreen.x);
      state.geometryView.y = interaction.startView.y + (point.sy - interaction.startScreen.y);
    } else if (interaction.type === "draw") {
      interaction.current = { x: clamp(point.x, 0, state.imageWidth), y: clamp(point.y, 0, state.imageHeight) };
      interaction.preview = geometryShapeFromDrag(state.geometry.tool, interaction.start, interaction.current, getGeometryPore().id);
    }
    drawGeometryCanvas();
  }

  function handleGeometryPointerUp(event) {
    const interaction = state.geometryInteraction;
    if (!interaction) return;
    if (interaction.type === "draw") {
      const shape = interaction.preview;
      const width = shape.type === "rect" ? shape.width : shape.type === "ellipse" ? shape.radiusX * 2 : shape.radius * 2;
      const height = shape.type === "rect" ? shape.height : shape.type === "ellipse" ? shape.radiusY * 2 : shape.radius * 2;
      if (width >= 5 && height >= 5) state.geometry.shapes.push(shape);
    }
    state.geometryInteraction = null;
    dom.geometryCanvas.releasePointerCapture?.(event.pointerId);
    drawGeometryCanvas();
    updateGeometryMetrics();
  }

  function finishPolygon() {
    const pore = getGeometryPore();
    if (!pore || state.geometry.polygonDraft.length < 3) {
      alert("Polygon ต้องมีอย่างน้อย 3 จุด");
      return;
    }
    state.geometry.shapes.push({
      id: uid("shape"),
      poreId: pore.id,
      type: "polygon",
      points: [...state.geometry.polygonDraft],
    });
    state.geometry.polygonDraft = [];
    drawGeometryCanvas();
    updateGeometryMetrics();
  }

  function getColumnHeights(pore) {
    if (!pore || !state.analysis) return [];
    const { source } = state.analysis;
    const bounds = pore.processBounds;
    const heights = [];
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      let count = 0;
      for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
        if (pore.indexSet.has(y * source.width + x)) count += 1;
      }
      heights.push(count);
    }
    return heights;
  }

  function sampleHeight(heights, continuousIndex) {
    if (!heights.length) return 0;
    const index = clamp(Math.round(continuousIndex), 0, heights.length - 1);
    return heights[index];
  }

  function calculateRiemann(pore, n, method) {
    if (!pore || !state.analysis) return null;
    const heights = getColumnHeights(pore);
    if (!heights.length) return null;
    const widthColumns = heights.length;
    const dxColumns = widthColumns / n;
    let areaProcessPixels = 0;
    const bars = [];

    if (method === "trapezoid") {
      for (let i = 0; i < n; i += 1) {
        const leftX = i * dxColumns;
        const rightX = (i + 1) * dxColumns;
        const leftHeight = sampleHeight(heights, leftX);
        const rightHeight = sampleHeight(heights, rightX);
        const averageHeight = (leftHeight + rightHeight) / 2;
        areaProcessPixels += averageHeight * dxColumns;
        bars.push({ x0: leftX, x1: rightX, height: averageHeight });
      }
    } else {
      const offset = method === "left" ? 0 : method === "right" ? 1 : .5;
      for (let i = 0; i < n; i += 1) {
        const sampleX = (i + offset) * dxColumns;
        const height = sampleHeight(heights, sampleX);
        areaProcessPixels += height * dxColumns;
        bars.push({ x0: i * dxColumns, x1: (i + 1) * dxColumns, height });
      }
    }

    const areaScale = state.analysis.source.scaleX * state.analysis.source.scaleY;
    const estimatePx = areaProcessPixels * areaScale;
    const actualPx = pore.areaPx;
    const absoluteErrorPx = Math.abs(estimatePx - actualPx);
    const percentError = actualPx ? absoluteErrorPx / actualPx * 100 : 0;
    return { heights, bars, n, method, estimatePx, actualPx, absoluteErrorPx, percentError };
  }

  function updateCalculus() {
    const pore = getCalculusPore();
    if (!pore) {
      clearChart($("#riemannChart"), "วิเคราะห์ภาพและเลือกรูพรุนก่อน");
      clearChart($("#convergenceChart"), "ยังไม่มีข้อมูล");
      $("#riemannActual").textContent = "—";
      $("#riemannEstimate").textContent = "—";
      $("#riemannAbsoluteError").textContent = "—";
      $("#riemannPercentError").textContent = "—";
      return;
    }
    const n = Number(state.calculus.n);
    const method = state.calculus.method;
    const result = calculateRiemann(pore, n, method);
    state.calculus.result = result;
    const unitPerPixel = getUnitPerPixel();
    const convertArea = (value) => unitPerPixel ? value * unitPerPixel ** 2 : value;
    $("#riemannActual").textContent = `${formatNumber(convertArea(result.actualPx), 3)} ${areaUnit()}`;
    $("#riemannEstimate").textContent = `${formatNumber(convertArea(result.estimatePx), 3)} ${areaUnit()}`;
    $("#riemannAbsoluteError").textContent = `${formatNumber(convertArea(result.absoluteErrorPx), 3)} ${areaUnit()}`;
    $("#riemannPercentError").textContent = `${formatNumber(result.percentError, 2)}%`;
    drawRiemannChart(result);
    drawConvergenceChart(pore, method);
  }

  function prepareChartCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.max(420, rect.width || 900);
    const cssHeight = Math.max(300, rect.height || Number(canvas.getAttribute("height")) || 420);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width: cssWidth, height: cssHeight };
  }

  function clearChart(canvas, message = "ยังไม่มีข้อมูล") {
    const { ctx, width, height } = prepareChartCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = COLORS.muted;
    ctx.font = "16px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(message, width / 2, height / 2);
    ctx.textAlign = "left";
  }

  function drawAxes(ctx, width, height, padding, xLabel, yLabel) {
    ctx.strokeStyle = "#94a3b8";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, height - padding.bottom);
    ctx.lineTo(width - padding.right, height - padding.bottom);
    ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.font = "13px sans-serif";
    ctx.fillText(yLabel, padding.left, padding.top - 12);
    ctx.textAlign = "right";
    ctx.fillText(xLabel, width - padding.right, height - padding.bottom + 34);
    ctx.textAlign = "left";
  }

  function drawRiemannChart(result) {
    const canvas = $("#riemannChart");
    const { ctx, width, height } = prepareChartCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, height);
    const padding = { left: 62, right: 26, top: 34, bottom: 55 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const maxHeight = Math.max(1, ...result.heights);
    drawAxes(ctx, width, height, padding, "แนวแกน x ของรูพรุน", "ความสูงของรูพรุน (process px)");

    ctx.strokeStyle = "#0e7490";
    ctx.lineWidth = 2;
    ctx.beginPath();
    result.heights.forEach((value, index) => {
      const x = padding.left + index / Math.max(1, result.heights.length - 1) * plotWidth;
      const y = padding.top + plotHeight - value / maxHeight * plotHeight;
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    for (const bar of result.bars) {
      const x = padding.left + bar.x0 / result.heights.length * plotWidth;
      const barWidth = (bar.x1 - bar.x0) / result.heights.length * plotWidth;
      const barHeight = bar.height / maxHeight * plotHeight;
      const y = padding.top + plotHeight - barHeight;
      ctx.fillStyle = "rgba(249,115,22,.18)";
      ctx.fillRect(x, y, Math.max(1, barWidth), barHeight);
      ctx.strokeStyle = "rgba(249,115,22,.72)";
      ctx.strokeRect(x, y, Math.max(1, barWidth), barHeight);
    }

    ctx.fillStyle = COLORS.navy;
    ctx.font = "bold 14px sans-serif";
    ctx.fillText(`${result.method} · n = ${result.n} · Error = ${formatNumber(result.percentError, 2)}%`, padding.left, 22);
  }

  function drawLineChart(canvas, points, options = {}) {
    const { ctx, width, height } = prepareChartCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, height);
    if (!points.length) {
      ctx.fillStyle = COLORS.muted;
      ctx.font = "16px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(options.emptyMessage || "ยังไม่มีข้อมูล", width / 2, height / 2);
      ctx.textAlign = "left";
      return;
    }
    const padding = { left: 72, right: 30, top: 38, bottom: 58 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    let minX = Math.min(...xs);
    let maxX = Math.max(...xs);
    let minY = Math.min(...ys);
    let maxY = Math.max(...ys);
    if (minX === maxX) { minX -= 1; maxX += 1; }
    if (minY === maxY) { minY -= 1; maxY += 1; }
    const yPad = (maxY - minY) * .12;
    minY -= yPad;
    maxY += yPad;
    const sx = (value) => padding.left + (value - minX) / (maxX - minX) * plotWidth;
    const sy = (value) => padding.top + plotHeight - (value - minY) / (maxY - minY) * plotHeight;

    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 1;
    ctx.fillStyle = COLORS.muted;
    ctx.font = "12px sans-serif";
    for (let i = 0; i <= 5; i += 1) {
      const y = padding.top + i / 5 * plotHeight;
      const value = maxY - i / 5 * (maxY - minY);
      ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(width - padding.right, y); ctx.stroke();
      ctx.textAlign = "right"; ctx.fillText(formatNumber(value, 2), padding.left - 8, y + 4);
    }
    ctx.textAlign = "left";
    drawAxes(ctx, width, height, padding, options.xLabel || "x", options.yLabel || "y");

    ctx.strokeStyle = options.lineColor || "#0891b2";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    points.forEach((point, index) => {
      const x = sx(point.x); const y = sy(point.y);
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    for (const point of points) {
      ctx.beginPath();
      ctx.arc(sx(point.x), sy(point.y), 4, 0, Math.PI * 2);
      ctx.fillStyle = options.pointColor || "#0e7490";
      ctx.fill();
    }
    if (options.title) {
      ctx.fillStyle = COLORS.navy;
      ctx.font = "bold 14px sans-serif";
      ctx.fillText(options.title, padding.left, 23);
    }
  }

  function drawConvergenceChart(pore, method) {
    const ns = [4, 6, 8, 12, 16, 20, 30, 40, 60, 80, 100];
    const points = ns.map((n) => ({ x: n, y: calculateRiemann(pore, n, method).percentError }));
    drawLineChart($("#convergenceChart"), points, {
      xLabel: "จำนวนช่วง n",
      yLabel: "Percent Error (%)",
      title: `${method}: Error convergence`,
      lineColor: "#f97316",
      pointColor: "#ea580c",
    });
  }

  function getMetadataFromForm() {
    return {
      groupName: $("#groupNameInput").value.trim(),
      sampleCode: $("#sampleCodeInput").value.trim() || `SD-${String(state.repository.length + 1).padStart(3, "0")}`,
      seriesCode: $("#seriesCodeInput").value.trim() || "SERIES-A",
      fermentationMinute: Number($("#fermentationInput").value) || 0,
      temperatureC: Number($("#temperatureInput").value) || null,
      hydrationPercent: Number($("#hydrationInput").value) || null,
      notes: $("#notesInput").value.trim(),
    };
  }

  function makeCompressedImageDataUrl(maxDimension = 1200, quality = .78) {
    if (!state.image) return "";
    const scale = Math.min(1, maxDimension / Math.max(state.imageWidth, state.imageHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(state.imageWidth * scale);
    canvas.height = Math.round(state.imageHeight * scale);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(state.image, 0, 0, canvas.width, canvas.height);
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

  function saveCurrentSample() {
    if (!state.image || !state.analysis) {
      alert("กรุณาอัปโหลดภาพและวิเคราะห์รูพรุนก่อนบันทึก");
      return;
    }
    const metadata = getMetadataFromForm();
    const record = {
      id: uid("sample"),
      createdAt: new Date().toISOString(),
      metadata,
      imageName: state.imageName,
      imageDataUrl: makeCompressedImageDataUrl(),
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
      geometryAttempts: buildGeometryAttemptsForSave(),
      calculusAttempt: state.calculus.result ? {
        poreId: state.calculus.poreId,
        n: state.calculus.n,
        method: state.calculus.method,
        estimatePx: state.calculus.result.estimatePx,
        actualPx: state.calculus.result.actualPx,
        percentError: state.calculus.result.percentError,
      } : null,
    };
    state.repository.push(record);
    persistRepository();
    renderRepository();
    updateDashboardControls();
    alert(`บันทึก ${metadata.sampleCode} เข้าคลังแล้ว`);
  }

  function buildGeometryAttemptsForSave() {
    if (!state.analysis) return [];
    return state.analysis.pores.map((pore) => {
      const previous = state.geometry.selectedPoreId;
      state.geometry.selectedPoreId = pore.id;
      const metrics = geometryMetrics();
      state.geometry.selectedPoreId = previous;
      const shapes = state.geometry.shapes.filter((shape) => shape.poreId === pore.id);
      if (!shapes.length || !metrics) return null;
      return {
        poreId: pore.id,
        shapes: JSON.parse(JSON.stringify(shapes)),
        unionAreaPx: metrics.unionAreaPx,
        percentError: metrics.percentError,
        iou: metrics.iou,
      };
    }).filter(Boolean);
  }

  function persistRepository() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.repository));
    } catch (error) {
      console.error(error);
      alert("พื้นที่จัดเก็บในเบราว์เซอร์เต็ม กรุณาส่งออก JSON แล้วลบตัวอย่างเก่าบางส่วน");
    }
  }

  function loadRepository() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      state.repository = raw ? JSON.parse(raw) : [];
    } catch (error) {
      console.error(error);
      state.repository = [];
    }
  }

  function renderRepository() {
    dom.repositoryCount.textContent = `${state.repository.length} ตัวอย่าง`;
    if (!state.repository.length) {
      dom.repositoryCards.innerHTML = '<div class="table-empty-state">ยังไม่มีข้อมูลในคลัง</div>';
      return;
    }
    const sorted = [...state.repository].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    dom.repositoryCards.innerHTML = sorted.map((record) => {
      const summary = record.summary;
      const useReal = Boolean(record.unitPerPixel);
      const meanArea = useReal ? summary.meanAreaReal : summary.meanAreaPx;
      const totalArea = useReal ? summary.totalAreaReal : summary.totalAreaPx;
      return `
        <article class="repository-card">
          <img class="repository-thumb" src="${record.imageDataUrl}" alt="${escapeHtml(record.metadata.sampleCode)}" />
          <div class="repository-card-body">
            <h3>${escapeHtml(record.metadata.sampleCode)}</h3>
            <div class="repository-meta">
              <span>กลุ่ม: ${escapeHtml(record.metadata.groupName || "—")}</span>
              <span>Series: ${escapeHtml(record.metadata.seriesCode || "—")}</span>
              <span>เวลาหมัก: ${formatNumber(record.metadata.fermentationMinute, 0)} นาที</span>
            </div>
            <div class="repository-summary">
              <div><span>จำนวนรู</span><strong>${summary.poreCount}</strong></div>
              <div><span>Porosity</span><strong>${formatNumber(summary.porosityPercent, 2)}%</strong></div>
              <div><span>พื้นที่เฉลี่ย</span><strong>${formatNumber(meanArea, 2)}</strong></div>
              <div><span>พื้นที่รวม</span><strong>${formatNumber(totalArea, 2)}</strong></div>
            </div>
            <div class="repository-card-actions">
              <button type="button" data-load-record="${record.id}">เปิดภาพ</button>
              <button type="button" class="delete" data-delete-record="${record.id}">ลบ</button>
            </div>
          </div>
        </article>`;
    }).join("");
    $$('[data-load-record]', dom.repositoryCards).forEach((button) => {
      button.addEventListener("click", () => loadRecordIntoWorkspace(button.dataset.loadRecord));
    });
    $$('[data-delete-record]', dom.repositoryCards).forEach((button) => {
      button.addEventListener("click", () => deleteRecord(button.dataset.deleteRecord));
    });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    }[char]));
  }

  async function loadRecordIntoWorkspace(recordId) {
    const record = state.repository.find((item) => item.id === recordId);
    if (!record) return;
    await loadImageFromDataUrl(record.imageDataUrl, record.imageName || record.metadata.sampleCode);
    state.calibration = JSON.parse(JSON.stringify(record.calibration || state.calibration));
    state.roi = JSON.parse(JSON.stringify(record.roi));
    state.processing = { ...state.processing, ...record.processing };
    syncProcessingInputs();
    syncMetadataForm(record.metadata);
    updateCalibrationReadout();
    setActiveTab("analyze");
    setStatus("โหลดภาพและการตั้งค่าแล้ว — กดวิเคราะห์รูพรุนเพื่อสร้าง Mask ใหม่", "done");
    drawWorkspace();
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
    $("#notesInput").value = metadata.notes || "";
  }

  function deleteRecord(recordId) {
    const record = state.repository.find((item) => item.id === recordId);
    if (!record || !confirm(`ลบ ${record.metadata.sampleCode} ออกจากคลังหรือไม่`)) return;
    state.repository = state.repository.filter((item) => item.id !== recordId);
    persistRepository();
    renderRepository();
    updateDashboardControls();
    updateDashboard();
  }

  function downloadText(filename, text, type = "text/plain;charset=utf-8") {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function csvEscape(value) {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function exportPoreCsv() {
    if (!state.analysis?.pores.length) {
      alert("ยังไม่มีข้อมูลรูพรุน");
      return;
    }
    const headers = ["pore_id", "area_px2", `area_${state.calibration.unit}2`, "perimeter_px", `perimeter_${state.calibration.unit}`, "equivalent_diameter_px", `equivalent_diameter_${state.calibration.unit}`, "circularity", "center_x_px", "center_y_px"];
    const rows = state.analysis.pores.map((pore) => [
      pore.id, pore.areaPx, pore.areaReal ?? "", pore.perimeterPx, pore.perimeterReal ?? "",
      pore.equivalentDiameterPx, pore.equivalentDiameterReal ?? "", pore.circularity, pore.center.x, pore.center.y,
    ]);
    const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
    downloadText(`pore-data-${Date.now()}.csv`, `\uFEFF${csv}`, "text/csv;charset=utf-8");
  }

  function exportRepositoryJson() {
    downloadText(`mathvision-repository-${Date.now()}.json`, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), records: state.repository }, null, 2), "application/json");
  }

  function exportRepositoryCsv() {
    const headers = ["sample_code", "group_name", "series_code", "fermentation_minute", "temperature_c", "hydration_percent", "pore_count", "porosity_percent", "total_area_px2", "mean_area_px2", "total_area_real", "mean_area_real", "area_unit", "created_at"];
    const rows = state.repository.map((record) => [
      record.metadata.sampleCode, record.metadata.groupName, record.metadata.seriesCode, record.metadata.fermentationMinute,
      record.metadata.temperatureC ?? "", record.metadata.hydrationPercent ?? "", record.summary.poreCount,
      record.summary.porosityPercent, record.summary.totalAreaPx, record.summary.meanAreaPx,
      record.summary.totalAreaReal ?? "", record.summary.meanAreaReal ?? "", record.areaUnit, record.createdAt,
    ]);
    const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
    downloadText(`mathvision-summary-${Date.now()}.csv`, `\uFEFF${csv}`, "text/csv;charset=utf-8");
  }

  async function importRepository(file) {
    try {
      const payload = JSON.parse(await file.text());
      const records = Array.isArray(payload) ? payload : payload.records;
      if (!Array.isArray(records)) throw new Error("รูปแบบไฟล์ไม่ถูกต้อง");
      const existingIds = new Set(state.repository.map((record) => record.id));
      for (const record of records) {
        const next = { ...record, id: existingIds.has(record.id) ? uid("sample") : record.id || uid("sample") };
        state.repository.push(next);
      }
      persistRepository();
      renderRepository();
      updateDashboardControls();
      alert(`นำเข้า ${records.length} ตัวอย่างแล้ว`);
    } catch (error) {
      alert(error.message || "นำเข้าไฟล์ไม่สำเร็จ");
    }
  }

  function updateDashboardControls() {
    const series = [...new Set(state.repository.map((record) => record.metadata.seriesCode || "SERIES-A"))].sort();
    const current = dom.dashboardSeriesSelect.value;
    dom.dashboardSeriesSelect.innerHTML = '<option value="">ทั้งหมด</option>' + series.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
    if (series.includes(current)) dom.dashboardSeriesSelect.value = current;
  }

  function metricInfo(metric) {
    const map = {
      meanArea: { label: "พื้นที่รูพรุนเฉลี่ย", realKey: "meanAreaReal", pxKey: "meanAreaPx", unitType: "area" },
      totalArea: { label: "พื้นที่รูพรุนรวม", realKey: "totalAreaReal", pxKey: "totalAreaPx", unitType: "area" },
      porosity: { label: "Porosity", key: "porosityPercent", unit: "%" },
      poreCount: { label: "จำนวนรูพรุน", key: "poreCount", unit: "รู" },
    };
    return map[metric] || map.meanArea;
  }

  function recordMetricValue(record, metric) {
    const info = metricInfo(metric);
    if (info.unitType === "area") {
      const hasReal = Number.isFinite(record.summary?.[info.realKey]);
      return {
        value: hasReal ? record.summary[info.realKey] : record.summary?.[info.pxKey],
        unit: hasReal ? record.areaUnit : "px²",
      };
    }
    return { value: record.summary?.[info.key], unit: info.unit };
  }

  function finiteDifferences(points) {
    return points.map((point, index) => {
      if (points.length < 2) return { ...point, derivative: 0 };
      let derivative;
      if (index === 0) {
        derivative = (points[1].y - point.y) / ((points[1].x - point.x) || 1);
      } else if (index === points.length - 1) {
        derivative = (point.y - points[index - 1].y) / ((point.x - points[index - 1].x) || 1);
      } else {
        derivative = (points[index + 1].y - points[index - 1].y) / ((points[index + 1].x - points[index - 1].x) || 1);
      }
      return { ...point, derivative };
    });
  }

  function updateDashboard() {
    const seriesFilter = dom.dashboardSeriesSelect.value;
    const metric = dom.dashboardMetricSelect.value;
    const info = metricInfo(metric);
    const filtered = state.repository
      .filter((record) => !seriesFilter || (record.metadata.seriesCode || "SERIES-A") === seriesFilter)
      .map((record) => {
        const metricData = recordMetricValue(record, metric);
        return {
          x: Number(record.metadata.fermentationMinute) || 0,
          y: Number(metricData.value),
          unit: metricData.unit,
          series: record.metadata.seriesCode || "SERIES-A",
          sampleCode: record.metadata.sampleCode,
        };
      })
      .filter((point) => Number.isFinite(point.y))
      .sort((a, b) => a.x - b.x);

    $("#growthChartTitle").textContent = `${info.label}ตามเวลา`;
    if (!filtered.length) {
      clearChart($("#growthChart"), "บันทึกตัวอย่างอย่างน้อย 1 ตัวอย่างในคลังก่อน");
      clearChart($("#derivativeChart"), "ต้องมีข้อมูลอย่างน้อย 2 เวลา");
      dom.growthTableBody.innerHTML = '<tr><td colspan="5" class="empty-table-cell">ยังไม่มีข้อมูลเพียงพอ</td></tr>';
      return;
    }

    const units = [...new Set(filtered.map((point) => point.unit))];
    const unitLabel = units.length === 1 ? units[0] : "mixed units";
    drawLineChart($("#growthChart"), filtered, {
      xLabel: "เวลาหมัก (นาที)",
      yLabel: `${info.label} (${unitLabel})`,
      title: seriesFilter ? `Series ${seriesFilter}` : "ทุก Series",
    });

    const derivativePoints = finiteDifferences(filtered);
    drawLineChart($("#derivativeChart"), derivativePoints.map((point) => ({ x: point.x, y: point.derivative })), {
      xLabel: "เวลาหมัก (นาที)",
      yLabel: `อัตราการเปลี่ยนแปลง (${unitLabel}/min)`,
      lineColor: "#f97316",
      pointColor: "#ea580c",
      emptyMessage: "ต้องมีข้อมูลอย่างน้อย 2 เวลา",
    });

    dom.growthTableBody.innerHTML = derivativePoints.map((point) => `
      <tr>
        <td>${escapeHtml(point.series)}</td>
        <td>${formatNumber(point.x, 1)}</td>
        <td>${formatNumber(point.y, 4)}</td>
        <td>${formatNumber(point.derivative, 5)}</td>
        <td>${escapeHtml(point.unit)} / min</td>
      </tr>`).join("");
  }

  function clearAllRepository() {
    if (!state.repository.length || !confirm("ล้างข้อมูลทั้งหมดในคลังหรือไม่ การกระทำนี้ย้อนกลับไม่ได้")) return;
    state.repository = [];
    persistRepository();
    renderRepository();
    updateDashboardControls();
    updateDashboard();
  }

  function syncProcessingStateFromInputs() {
    state.processing.threshold = Number(dom.thresholdInput.value);
    state.processing.poreMode = $("#poreModeSelect").value;
    state.processing.minAreaPx = Number($("#minAreaInput").value);
    state.processing.maxAreaPercent = Number($("#maxAreaInput").value);
    state.processing.cleanMask = $("#cleanMaskInput").checked;
    state.processing.excludeBoundary = $("#excludeBoundaryInput").checked;
  }

  function handleSettingChange(message) {
    syncProcessingStateFromInputs();
    if (state.analysis) resetAnalysis(`${message} กรุณาวิเคราะห์ใหม่`);
  }

  function bindEvents() {
    $$(".tab-button").forEach((button) => button.addEventListener("click", () => setActiveTab(button.dataset.tab)));
    $$(".tool-button").forEach((button) => button.addEventListener("click", () => setTool(button.dataset.tool)));
    $$(".geometry-tool").forEach((button) => button.addEventListener("click", () => setGeometryTool(button.dataset.geometryTool)));
    $$(".view-button").forEach((button) => button.addEventListener("click", () => {
      state.viewMode = button.dataset.view;
      $$(".view-button").forEach((item) => item.classList.toggle("active", item === button));
      drawWorkspace();
    }));

    dom.imageInput.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) return alert("กรุณาเลือกไฟล์ภาพ");
      if (file.size > 20 * 1024 * 1024) return alert("ไฟล์เกิน 20 MB");
      const reader = new FileReader();
      reader.onload = async () => loadImageFromDataUrl(reader.result, file.name);
      reader.readAsDataURL(file);
    });

    dom.demoImageBtn.addEventListener("click", async () => {
      await loadImageFromDataUrl(createDemoImage(), "demo-sourdough.jpg");
      state.roi = { type: "ellipse", x: 195, y: 112, width: 1010, height: 680 };
      state.calibration.point1 = { x: 140, y: 835 };
      state.calibration.point2 = { x: 640, y: 835 };
      state.calibration.realLength = 100;
      state.calibration.unit = "mm";
      dom.realLengthInput.value = 100;
      dom.unitSelect.value = "mm";
      updateCalibrationReadout();
      drawWorkspace();
      setStatus("โหลดภาพทดลองแล้ว — กด Otsu และวิเคราะห์รูพรุนได้ทันที", "done");
    });

    $("#fitImageBtn").addEventListener("click", () => fitImage("workspaceView"));
    $("#fitGeometryBtn").addEventListener("click", fitGeometryToSelectedPore);
    $("#clearRoiBtn").addEventListener("click", () => {
      state.roi = null;
      resetAnalysis("ล้าง ROI แล้ว");
    });
    $("#clearScaleBtn").addEventListener("click", () => {
      state.calibration.point1 = null;
      state.calibration.point2 = null;
      updateCalibrationReadout();
      resetAnalysis("ล้างสเกลแล้ว ข้อมูลจะใช้หน่วยพิกเซล");
    });

    dom.realLengthInput.addEventListener("input", () => {
      state.calibration.realLength = Number(dom.realLengthInput.value);
      updateCalibrationReadout();
      if (state.analysis) resetAnalysis("เปลี่ยนความยาวจริงแล้ว กรุณาวิเคราะห์ใหม่");
    });
    dom.unitSelect.addEventListener("change", () => {
      state.calibration.unit = dom.unitSelect.value;
      updateCalibrationReadout();
      if (state.analysis) resetAnalysis("เปลี่ยนหน่วยแล้ว กรุณาวิเคราะห์ใหม่");
    });

    dom.thresholdInput.addEventListener("input", () => {
      dom.thresholdValue.textContent = dom.thresholdInput.value;
      handleSettingChange("ปรับ Threshold แล้ว");
    });
    ["#poreModeSelect", "#minAreaInput", "#maxAreaInput", "#cleanMaskInput", "#excludeBoundaryInput"].forEach((selector) => {
      $(selector).addEventListener("change", () => handleSettingChange("ปรับค่าการประมวลผลแล้ว"));
    });

    $("#otsuBtn").addEventListener("click", () => {
      if (!state.image || !state.roi) return alert("กรุณาอัปโหลดภาพและกำหนด ROI ก่อน");
      const source = createProcessingSource(normaliseRoi(state.roi));
      const threshold = otsuThreshold(source.histogram, source.insideCount);
      state.processing.threshold = threshold;
      dom.thresholdInput.value = threshold;
      dom.thresholdValue.textContent = threshold;
      if (state.analysis) resetAnalysis(`Otsu แนะนำ Threshold = ${threshold} กรุณาวิเคราะห์ใหม่`);
      else setStatus(`Otsu แนะนำ Threshold = ${threshold}`, "done");
    });

    $("#analyzeBtn").addEventListener("click", analyzeImage);
    $("#exportPoreCsvBtn").addEventListener("click", exportPoreCsv);
    $("#saveSampleBtn").addEventListener("click", saveCurrentSample);
    $("#saveRepositoryBtn").addEventListener("click", saveCurrentSample);
    $("#printReportBtn").addEventListener("click", () => window.print());

    dom.workspaceCanvas.addEventListener("pointerdown", handleWorkspacePointerDown);
    dom.workspaceCanvas.addEventListener("pointermove", handleWorkspacePointerMove);
    dom.workspaceCanvas.addEventListener("pointerup", handleWorkspacePointerUp);
    dom.workspaceCanvas.addEventListener("pointercancel", handleWorkspacePointerUp);
    dom.workspaceCanvas.addEventListener("wheel", (event) => handleCanvasWheel(event, "workspaceView", drawWorkspace), { passive: false });

    dom.geometryCanvas.addEventListener("pointerdown", handleGeometryPointerDown);
    dom.geometryCanvas.addEventListener("pointermove", handleGeometryPointerMove);
    dom.geometryCanvas.addEventListener("pointerup", handleGeometryPointerUp);
    dom.geometryCanvas.addEventListener("pointercancel", handleGeometryPointerUp);
    dom.geometryCanvas.addEventListener("wheel", (event) => handleCanvasWheel(event, "geometryView", drawGeometryCanvas), { passive: false });

    dom.geometryPoreSelect.addEventListener("change", () => {
      state.geometry.selectedPoreId = dom.geometryPoreSelect.value;
      state.selectedPoreId = dom.geometryPoreSelect.value;
      drawWorkspace();
      fitGeometryToSelectedPore();
      updateGeometryMetrics();
    });
    dom.calculusPoreSelect.addEventListener("change", () => {
      state.calculus.poreId = dom.calculusPoreSelect.value;
      updateCalculus();
    });
    $("#finishPolygonBtn").addEventListener("click", finishPolygon);
    $("#undoGeometryBtn").addEventListener("click", () => {
      const pore = getGeometryPore();
      if (!pore) return;
      for (let i = state.geometry.shapes.length - 1; i >= 0; i -= 1) {
        if (state.geometry.shapes[i].poreId === pore.id) {
          state.geometry.shapes.splice(i, 1);
          break;
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

    $("#riemannNInput").addEventListener("input", (event) => {
      state.calculus.n = Number(event.target.value);
      $("#riemannNValue").textContent = event.target.value;
      updateCalculus();
    });
    $("#riemannMethodSelect").addEventListener("change", (event) => {
      state.calculus.method = event.target.value;
      updateCalculus();
    });
    $("#calculateRiemannBtn").addEventListener("click", updateCalculus);

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

    window.addEventListener("resize", () => {
      resizeCanvases();
      updateCalculus();
      updateDashboard();
    });
  }

  function init() {
    loadRepository();
    bindEvents();
    resizeCanvases();
    updateCalibrationReadout();
    updateSummary();
    renderPoreTable();
    refreshPoreSelects();
    renderRepository();
    updateDashboardControls();
    updateDashboard();
    clearChart($("#riemannChart"), "วิเคราะห์ภาพและเลือกรูพรุนก่อน");
    clearChart($("#convergenceChart"), "ยังไม่มีข้อมูล");
  }

  init();
})();
