(() => {
"use strict";
const APP_VERSION = "4.2";
const $ = id => document.getElementById(id);

const form = $("form");
const l = $("l"), w = $("w"), h = $("h");
const resultEl = $("result"), errorEl = $("error"), list = $("list");
const resetBtn = $("resetBtn"), clearHistBtn = $("clearHistBtn");
const installBtn = $("installBtn"), settingsBtn = $("settingsBtn");
const overlay = $("overlay"), modalClose = $("modalClose");
const settingsSave = $("settingsSave"), settingsCancel = $("settingsCancel");
const setDivisor = $("setDivisor"), setUnitIn = $("setUnitIn");
const setUnitOut = $("setUnitOut"), setThreshold = $("setThreshold"), setOcrKey = $("setOcrKey"), setAutoUpdate = $("setAutoUpdate");
const subtitle = $("subtitle"), formula = $("formula"), resultUnit = $("resultUnit");
const unitL = $("unitL"), unitW = $("unitW"), unitH = $("unitH");
const cameraBtn = $("cameraBtn"), fileInput = $("fileInput");
const photoWrap = $("photoWrap"), photoPreview = $("photoPreview");
const photoRetake = $("photoRetake"), photoClear = $("photoClear"), shareBtn = $("shareBtn");
const ocrStatus = $("ocrStatus"), ocrTextBox = $("ocrTextBox"), codeChips = $("codeChips");
const camOverlay = $("camOverlay"), camVideo = $("camVideo");
const camCapture = $("camCapture"), camClose = $("camClose"), camCloseTop = $("camCloseTop");
const camFlash = $("camFlash"), camGallery = $("camGallery");
const updateBanner = $("updateBanner"), updateNowBtn = $("updateNowBtn");
const successBanner = $("successBanner"), successCloseBtn = $("successCloseBtn");
const imgViewer = $("imgViewer"), viewerImg = $("viewerImg"), viewerInfo = $("viewerInfo"), viewerClose = $("viewerClose");

const DEFAULTS = { divisor: 6, unitIn: "cm", unitOut: "kg", threshold: 0.35, ocrKey: "", autoUpdate: false };
let settings = loadSettings();
let history = [];
try { history = JSON.parse(localStorage.getItem("weightHistoryV2") || "[]"); } catch (_) { history = []; }
let deferredPrompt = null;
let currentPhoto = null;
let basePhoto = null;
let resultPhoto = null;
let lastCalc = null;
let camStream = null;
let waitingWorker = null;
let ocrText = "";
let ocrBusy = false;
let tesseractWorker = null;
let flashOn = false;
let calcTimer = null;

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("weightSettingsV2") || "{}");
    const th = Number(s.threshold);
    return {
      divisor: Number.isFinite(Number(s.divisor)) && Number(s.divisor) > 0 ? Number(s.divisor) : DEFAULTS.divisor,
      unitIn: (s.unitIn || DEFAULTS.unitIn).toString().slice(0, 12),
      unitOut: (s.unitOut || DEFAULTS.unitOut).toString().slice(0, 20),
      threshold: Number.isFinite(th) && th > 0 && th < 1 ? th : DEFAULTS.threshold,
      ocrKey: (s.ocrKey || "").toString().slice(0, 80),
      autoUpdate: !!s.autoUpdate
    };
  } catch { return Object.assign({}, DEFAULTS); }
}
function saveSettings() { localStorage.setItem("weightSettingsV2", JSON.stringify(settings)); }

function applySettingsUI() {
  const formulaText = "Dài × Rộng × Cao ÷ " + formatNum(settings.divisor);
  subtitle.textContent = formulaText;
  formula.textContent = formulaText;
  resultUnit.textContent = settings.unitOut;
  unitL.textContent = settings.unitIn;
  unitW.textContent = settings.unitIn;
  unitH.textContent = settings.unitIn;
}

function customRound(n) {
  var num = Number(n);
  if (!Number.isFinite(num) || num < 0) return 0;
  var intPart = Math.floor(num);
  var frac = parseFloat((num - intPart).toFixed(8));
  if (!Number.isFinite(frac) || frac < 0) frac = 0;
  if (frac >= 1) { intPart += 1; frac = 0; }
  var th = parseFloat(settings.threshold);
  if (!Number.isFinite(th) || th <= 0 || th >= 1) th = 0.35;
  return (frac < th) ? intPart : (intPart + 1);
}

function formatNum(n, maxDigits) {
  if (maxDigits === undefined) maxDigits = 6;
  if (!Number.isFinite(Number(n))) return "0";
  return new Intl.NumberFormat("vi-VN", { maximumFractionDigits: maxDigits, minimumFractionDigits: 0 }).format(Number(n));
}

function fmtResult(n) {
  var v = Math.trunc(customRound(n));
  var s = String(Math.abs(v)), out = "";
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += " ";
    out += s.charAt(i);
  }
  return (v < 0 ? "-" : "") + out;
}

/**
 * Output LUÔN dạng XXXX-YYYY
 * Nhận: a85XXXX-YYYY | a85XXXXYYYY | a85XXXX | XXXX-YYYY
 * YYYY = 0..9999 (thiếu số → -0)
 */
function filterCodes(raw) {
  if (!raw) return [];
  var s = String(raw).replace(/[–—−]/g, "-").replace(/\s+/g, " ");
  var found = [], seen = {};

  function add(letters, numStr) {
    letters = String(letters || "").toUpperCase();
    if (!/^[A-Z]{4}$/.test(letters)) return;
    var n = 0;
    if (numStr != null && String(numStr).length) {
      n = parseInt(String(numStr), 10);
      if (!Number.isFinite(n) || n < 0 || n > 9999) return;
    }
    var code = letters + "-" + n;
    if (!seen[code]) { seen[code] = 1; found.push(code); }
  }

  var m;
  var reA85 = /\ba\s*85\s*([A-Za-z]{4})\s*-?\s*(\d{0,4})\b/gi;
  while ((m = reA85.exec(s)) !== null) add(m[1], m[2]);
  var reA85sticky = /a\s*85\s*([A-Za-z]{4})(\d{1,4})(?!\d)/gi;
  while ((m = reA85sticky.exec(s)) !== null) add(m[1], m[2]);
  var rePlain = /\b([A-Za-z]{4})\s*-?\s*(\d{1,4})\b/g;
  while ((m = rePlain.exec(s)) !== null) {
    var before = s.slice(Math.max(0, m.index - 6), m.index).replace(/\s/g, "").toLowerCase();
    if (/a85$/i.test(before)) continue;
    add(m[1], m[2]);
  }
  return found;
}

function renderCodeChips(codes) {
  codeChips.innerHTML = "";
  if (!codes.length) { codeChips.classList.remove("show"); return; }
  codes.forEach(function (c) {
    var span = document.createElement("span");
    span.className = "code-chip";
    span.textContent = c;
    codeChips.appendChild(span);
  });
  codeChips.classList.add("show");
}

function saveHistory() {
  try { localStorage.setItem("weightHistoryV2", JSON.stringify(history)); }
  catch {
    history = history.map(function (x) { return { l: x.l, w: x.w, h: x.h, r: x.r }; });
    try { localStorage.setItem("weightHistoryV2", JSON.stringify(history)); } catch (_) {}
  }
}

function openViewer(entry) {
  if (!entry || !entry.img) return;
  viewerImg.src = entry.img;
  viewerInfo.textContent = formatNum(entry.l, 2) + " × " + formatNum(entry.w, 2) + " × " + formatNum(entry.h, 2) + " " + settings.unitIn + " → " + fmtResult(entry.r) + " " + settings.unitOut;
  imgViewer.classList.add("open");
}
function closeViewer() { imgViewer.classList.remove("open"); viewerImg.src = ""; }

function render() {
  list.innerHTML = "";
  if (!history.length) {
    var e = document.createElement("div");
    e.style.cssText = "color:#9ca3af;font-size:12px";
    e.textContent = "Chưa có phép tính nào.";
    list.appendChild(e);
    return;
  }
  history.slice(0, 50).forEach(function (x) {
    var row = document.createElement("div");
    row.className = "item" + (x.img ? " has-img" : "");
    var left = document.createElement("div");
    left.className = "item-left";
    if (x.img) {
      var thumb = document.createElement("img");
      thumb.className = "item-thumb";
      thumb.src = x.img;
      thumb.alt = "";
      left.appendChild(thumb);
    }
    var d = document.createElement("div");
    d.className = "dims-txt";
    d.textContent = formatNum(x.l, 2) + " × " + formatNum(x.w, 2) + " × " + formatNum(x.h, 2);
    left.appendChild(d);
    var v = document.createElement("div");
    v.className = "val";
    v.textContent = fmtResult(x.r) + " " + settings.unitOut;
    row.append(left, v);
    if (x.img) row.addEventListener("click", function () { openViewer(x); });
    list.appendChild(row);
  });
}

function showPhoto(dataUrl, isResult) {
  if (isResult) {
    resultPhoto = dataUrl;
  } else {
    basePhoto = dataUrl;
    currentPhoto = dataUrl;
    resultPhoto = null;
  }
  photoPreview.src = dataUrl;
  photoWrap.classList.add("show");
  shareBtn.style.display = isResult ? "inline-block" : "none";
}

function clearPhotoUI() {
  currentPhoto = null;
  basePhoto = null;
  resultPhoto = null;
  ocrText = "";
  ocrBusy = false;
  photoPreview.src = "";
  photoWrap.classList.remove("show");
  shareBtn.style.display = "none";
  ocrStatus.textContent = "";
  ocrTextBox.style.display = "none";
  ocrTextBox.textContent = "";
  renderCodeChips([]);
}

function resetFormFull() {
  form.reset();
  l.value = ""; w.value = ""; h.value = "";
  errorEl.textContent = "";
  resultEl.textContent = "0";
  lastCalc = null;
  clearPhotoUI();
}

function compressImage(fileOrBlob, maxW, quality) {
  if (maxW === undefined) maxW = 720;
  if (quality === undefined) quality = 0.72;
  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(fileOrBlob);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var ww = img.width, hh = img.height;
      if (ww > maxW) { hh = Math.round(hh * maxW / ww); ww = maxW; }
      var canvas = document.createElement("canvas");
      canvas.width = ww; canvas.height = hh;
      canvas.getContext("2d").drawImage(img, 0, 0, ww, hh);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("Không đọc được ảnh")); };
    img.src = url;
  });
}

function drawResultOnPhoto(photoDataUrl, calc) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.onload = function () {
      var canvas = document.createElement("canvas");
      var maxW = 1080;
      var ww = img.width, hh = img.height;
      if (ww > maxW) { hh = Math.round(hh * maxW / ww); ww = maxW; }
      canvas.width = ww; canvas.height = hh;
      var ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, ww, hh);
      var barH = Math.max(90, Math.round(hh * 0.18));
      var pad = Math.round(ww * 0.04);
      ctx.fillStyle = "rgba(17,24,39,0.78)";
      ctx.fillRect(0, hh - barH, ww, barH);
      var intR = customRound(calc.r);
      var resultText = fmtResult(intR) + " " + settings.unitOut;
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold " + Math.round(barH * 0.38) + "px system-ui,sans-serif";
      ctx.textBaseline = "top";
      ctx.fillText(resultText, pad, hh - barH + Math.round(barH * 0.12));
      var dimText = formatNum(calc.l, 1) + " × " + formatNum(calc.w, 1) + " × " + formatNum(calc.h, 1) + " " + settings.unitIn;
      ctx.font = Math.round(barH * 0.2) + "px system-ui,sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillText(dimText, pad, hh - barH + Math.round(barH * 0.58));
      var badge = "Tính khối lượng";
      ctx.font = "bold " + Math.round(ww * 0.035) + "px system-ui,sans-serif";
      var tw = ctx.measureText(badge).width;
      var bh = Math.round(ww * 0.055);
      ctx.fillStyle = "rgba(17,24,39,0.7)";
      roundRect(ctx, pad - 6, pad - 4, tw + 16, bh, 8);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "middle";
      ctx.fillText(badge, pad + 2, pad + bh / 2 - 2);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = function () { reject(new Error("Không vẽ được ảnh")); };
    img.src = photoDataUrl;
  });
}

function roundRect(ctx, x, y, ww, hh, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + ww, y, x + ww, y + hh, r);
  ctx.arcTo(x + ww, y + hh, x, y + hh, r);
  ctx.arcTo(x, y + hh, x, y, r);
  ctx.arcTo(x, y, x + ww, y, r);
  ctx.closePath();
}

function dataURLtoBlob(dataUrl) {
  var parts = dataUrl.split(",");
  var mime = parts[0].match(/:(.*?);/)[1];
  var bin = atob(parts[1]);
  var arr = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function ocrCloud(dataUrl) {
  var key = (settings.ocrKey || "").trim();
  if (!key || !navigator.onLine) return null;
  ocrStatus.textContent = "OCR cloud…";
  var fd = new FormData();
  fd.append("base64Image", dataUrl);
  fd.append("language", "auto");
  fd.append("isOverlayRequired", "false");
  fd.append("OCREngine", "2");
  fd.append("scale", "true");
  fd.append("detectOrientation", "true");
  var res = await fetch("https://api.ocr.space/parse/image", { method: "POST", headers: { apikey: key }, body: fd });
  if (!res.ok) throw new Error("HTTP " + res.status);
  var json = await res.json();
  if (json.IsErroredOnProcessing) {
    var em = json.ErrorMessage;
    throw new Error(Array.isArray(em) ? em.join("; ") : (em || "cloud error"));
  }
  return (json.ParsedResults || []).map(function (p) { return p.ParsedText || ""; }).join("\n").replace(/[ \t]+\n/g, "\n").trim();
}

async function ensureOCRWorker() {
  if (tesseractWorker) return tesseractWorker;
  if (typeof Tesseract === "undefined") throw new Error("Thiếu Tesseract");
  ocrStatus.textContent = "Đang tải OCR…";
  tesseractWorker = await Tesseract.createWorker("vie+eng", 1, {
    logger: function (m) {
      if (m.status === "loading tesseract core") ocrStatus.textContent = "Tải core OCR…";
      else if (m.status === "loading language traineddata") ocrStatus.textContent = "Tải model chữ…";
      else if (m.status === "recognizing text" && m.progress != null) ocrStatus.textContent = "Nhận diện… " + Math.round(m.progress * 100) + "%";
    }
  });
  await tesseractWorker.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1" });
  return tesseractWorker;
}

async function ocrLocal(dataUrl) {
  ocrStatus.textContent = "OCR local…";
  var worker = await ensureOCRWorker();
  var result = await worker.recognize(dataUrl);
  return (result && result.data && result.data.text ? result.data.text : "").replace(/[ \t]+\n/g, "\n").trim();
}

async function runOCR(dataUrl) {
  if (ocrBusy) return;
  ocrBusy = true;
  ocrText = "";
  ocrTextBox.style.display = "none";
  ocrTextBox.textContent = "";
  renderCodeChips([]);
  if (!navigator.onLine) {
    ocrStatus.textContent = "Không có mạng — bỏ qua OCR";
    ocrBusy = false;
    return;
  }
  ocrStatus.textContent = "Đang nhận diện chữ…";
  try {
    var text = null, source = "";
    if ((settings.ocrKey || "").trim()) {
      try { text = await ocrCloud(dataUrl); source = "cloud"; }
      catch (e) { console.warn(e); ocrStatus.textContent = "Cloud lỗi, chuyển local…"; }
    }
    if (!text) { text = await ocrLocal(dataUrl); source = "local"; }
    ocrText = text || "";
    var codes = filterCodes(ocrText);
    if (ocrText) {
      ocrStatus.textContent = "Đã nhận diện (" + source + ")" + (codes.length ? " · " + codes.length + " mã" : "");
      ocrTextBox.textContent = ocrText;
      ocrTextBox.style.display = "block";
    } else ocrStatus.textContent = "Không thấy chữ trên ảnh";
    renderCodeChips(codes);
  } catch (err) {
    ocrStatus.textContent = "OCR lỗi: " + (err && err.message ? err.message : "lỗi");
    ocrText = "";
    renderCodeChips([]);
  } finally { ocrBusy = false; }
}

async function shareToZalo() {
  var imgData = resultPhoto || currentPhoto;
  if (!imgData) return;
  var blob = dataURLtoBlob(imgData);
  var file = new File([blob], "khoi-luong.jpg", { type: "image/jpeg" });
  var shared = false;
  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); shared = true; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  if (!shared) {
    var a = document.createElement("a");
    a.href = imgData; a.download = "khoi-luong.jpg"; a.click();
    alert("Đã tải ảnh. Mở Zalo → chọn ảnh vừa tải để gửi.");
    shared = true;
  }
  if (shared) resetFormFull();
}

function stopCamera() {
  flashOn = false;
  if (camStream) {
    try {
      var tr = camStream.getVideoTracks()[0];
      if (tr) tr.applyConstraints({ advanced: [{ torch: false }] }).catch(function () {});
    } catch (_) {}
    camStream.getTracks().forEach(function (t) { t.stop(); });
    camStream = null;
  }
  camVideo.srcObject = null;
  camOverlay.classList.remove("open");
  if (camFlash) { camFlash.style.display = "none"; camFlash.classList.remove("on"); }
}

function updateFlashButton() {
  if (!camStream) { camFlash.style.display = "none"; flashOn = false; return; }
  var track = camStream.getVideoTracks()[0];
  if (!track) { camFlash.style.display = "none"; return; }
  var caps = track.getCapabilities ? track.getCapabilities() : {};
  if (caps.torch) {
    camFlash.style.display = "flex";
    camFlash.classList.toggle("on", flashOn);
  } else camFlash.style.display = "none";
}

async function setTorch(on) {
  if (!camStream) return;
  var track = camStream.getVideoTracks()[0];
  if (!track) return;
  try {
    await track.applyConstraints({ advanced: [{ torch: !!on }] });
    flashOn = !!on;
  } catch (e) { flashOn = false; }
  updateFlashButton();
}

async function openLiveCamera() {
  flashOn = false;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    openAlbum();
    return;
  }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    camVideo.srcObject = camStream;
    camOverlay.classList.add("open");
    updateFlashButton();
  } catch { openAlbum(); }
}

/** Áp ảnh: nếu đã có lastCalc → vẽ kết quả lên luôn + lưu lịch sử */
async function applyPhoto(dataUrl) {
  showPhoto(dataUrl, false);
  if (lastCalc) {
    try {
      var withResult = await drawResultOnPhoto(basePhoto || dataUrl, lastCalc);
      showPhoto(withResult, true);
      var entry = { l: lastCalc.l, w: lastCalc.w, h: lastCalc.h, r: lastCalc.r, img: withResult };
      history.unshift(entry);
      history = history.slice(0, 50);
      saveHistory();
      render();
    } catch {
      shareBtn.style.display = "inline-block";
    }
  }
  runOCR(dataUrl);
}

async function refreshPhotoOverlay() {
  if (!basePhoto || !lastCalc) return;
  try {
    var withResult = await drawResultOnPhoto(basePhoto, lastCalc);
    showPhoto(withResult, true);
  } catch (e) {
    console.warn("refresh overlay", e);
  }
}

function doCalculate(fromAuto) {
  errorEl.textContent = "";
  var a = [l, w, h].map(function (x) { return Number(x.value); });
  if (a.some(function (x) { return !Number.isFinite(x); })) {
    if (!fromAuto) errorEl.textContent = "Vui lòng nhập đủ 3 kích thước.";
    return false;
  }
  if (a.some(function (x) { return x < 0; })) {
    errorEl.textContent = "Kích thước không được nhỏ hơn 0.";
    return false;
  }
  var rRaw = a[0] * a[1] * a[2] / settings.divisor;
  var r = Math.trunc(customRound(rRaw));
  resultEl.textContent = fmtResult(r);
  lastCalc = { l: a[0], w: a[1], h: a[2], r: r };
  // Có ảnh → cập nhật chữ kg trên ảnh theo input mới
  if (basePhoto) refreshPhotoOverlay();
  return true;
}

async function doCalculateAndPhoto() {
  if (!doCalculate(false)) return;
  var entry = { l: lastCalc.l, w: lastCalc.w, h: lastCalc.h, r: lastCalc.r };
  if (basePhoto) {
    try {
      var withResult = await drawResultOnPhoto(basePhoto, lastCalc);
      showPhoto(withResult, true);
      entry.img = withResult;
    } catch {
      entry.img = basePhoto;
      shareBtn.style.display = "inline-block";
    }
  }
  history.unshift(entry);
  history = history.slice(0, 50);
  saveHistory();
  render();
}

function tryAutoCalc() {
  clearTimeout(calcTimer);
  calcTimer = setTimeout(function () {
    var a = [l, w, h].map(function (x) { return x.value; });
    if (a.every(function (v) { return v !== "" && Number.isFinite(Number(v)); })) {
      doCalculate(true);
    }
  }, 120);
}

function digitLen(el) {
  return String(el.value || "").replace(/\D/g, "").length;
}

function wireAutoJump(el, next) {
  el.addEventListener("input", function () {
    errorEl.textContent = "";
    if (digitLen(el) >= 2 && next) {
      next.focus();
      try { next.select(); } catch (_) {}
    }
    tryAutoCalc();
  });
}

wireAutoJump(l, w);
wireAutoJump(w, h);
wireAutoJump(h, null);
h.addEventListener("input", tryAutoCalc);

form.addEventListener("submit", function (e) {
  e.preventDefault();
  doCalculateAndPhoto();
});

resetBtn.addEventListener("click", function (e) {
  e.preventDefault();
  resetFormFull();
  try { l.focus(); } catch (_) {}
});

clearHistBtn.addEventListener("click", function (e) {
  e.preventDefault();
  if (!history.length) return;
  if (!confirm("Xóa toàn bộ lịch sử?")) return;
  history = [];
  saveHistory();
  render();
});

cameraBtn.addEventListener("click", function (e) { e.preventDefault(); openLiveCamera(); });
photoRetake.addEventListener("click", function (e) { e.preventDefault(); openLiveCamera(); });
photoClear.addEventListener("click", function (e) { e.preventDefault(); clearPhotoUI(); });
shareBtn.addEventListener("click", function (e) { e.preventDefault(); shareToZalo(); });
viewerClose.addEventListener("click", function (e) { e.preventDefault(); closeViewer(); });
imgViewer.addEventListener("click", function (e) { if (e.target === imgViewer) closeViewer(); });

function closeCam(e) { if (e) e.preventDefault(); stopCamera(); }
camClose.addEventListener("click", closeCam);
if (camCloseTop) camCloseTop.addEventListener("click", closeCam);
function openAlbum() {
  // Không dùng capture → hệ thống ưu tiên album/thư viện ảnh
  fileInput.removeAttribute("capture");
  fileInput.accept = "image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic";
  fileInput.click();
}
camGallery.addEventListener("click", function (e) { e.preventDefault(); openAlbum(); });
camFlash.addEventListener("click", function (e) { e.preventDefault(); setTorch(!flashOn); });

camCapture.addEventListener("click", async function (e) {
  e.preventDefault();
  if (!camVideo.videoWidth) return;
  var canvas = document.createElement("canvas");
  var maxW = 720;
  var ww = camVideo.videoWidth, hh = camVideo.videoHeight;
  if (ww > maxW) { hh = Math.round(hh * maxW / ww); ww = maxW; }
  canvas.width = ww; canvas.height = hh;
  canvas.getContext("2d").drawImage(camVideo, 0, 0, ww, hh);
  var dataUrl = canvas.toDataURL("image/jpeg", 0.72);
  stopCamera();
  await applyPhoto(dataUrl);
});

fileInput.addEventListener("change", async function () {
  var file = fileInput.files && fileInput.files[0];
  fileInput.value = "";
  if (!file) return;
  try {
    stopCamera();
    var dataUrl = await compressImage(file);
    await applyPhoto(dataUrl);
  } catch { errorEl.textContent = "Không thể đọc ảnh."; }
});

function openSettings() {
  setDivisor.value = settings.divisor;
  setUnitIn.value = settings.unitIn;
  setUnitOut.value = settings.unitOut;
  setThreshold.value = settings.threshold;
  setOcrKey.value = settings.ocrKey || "";
  setAutoUpdate.checked = !!settings.autoUpdate;
  overlay.classList.add("open");
}
function closeSettings() { overlay.classList.remove("open"); }

settingsBtn.addEventListener("click", function (e) { e.preventDefault(); openSettings(); });
modalClose.addEventListener("click", function (e) { e.preventDefault(); closeSettings(); });
settingsCancel.addEventListener("click", function (e) { e.preventDefault(); closeSettings(); });
overlay.addEventListener("click", function (e) { if (e.target === overlay) closeSettings(); });

settingsSave.addEventListener("click", function (e) {
  e.preventDefault();
  var div = Number(setDivisor.value);
  if (!Number.isFinite(div) || div <= 0) { alert("Mức chia phải lớn hơn 0."); return; }
  var th = Number(setThreshold.value);
  if (!Number.isFinite(th) || th <= 0 || th >= 1) { alert("Ngưỡng làm tròn phải trong (0, 1)."); return; }
  settings.divisor = div;
  settings.unitIn = (setUnitIn.value.trim() || DEFAULTS.unitIn).slice(0, 12);
  settings.unitOut = (setUnitOut.value.trim() || DEFAULTS.unitOut).slice(0, 20);
  settings.threshold = th;
  settings.ocrKey = (setOcrKey.value || "").trim().slice(0, 80);
  settings.autoUpdate = !!setAutoUpdate.checked;
  saveSettings();
  applySettingsUI();
  if (settings.autoUpdate && typeof window.__pwaCheckUpdate === "function") {
    window.__pwaCheckUpdate();
  }
  if (lastCalc) {
    lastCalc.r = Math.trunc(customRound(lastCalc.l * lastCalc.w * lastCalc.h / settings.divisor));
    resultEl.textContent = fmtResult(lastCalc.r);
  }
  render();
  closeSettings();
});

applySettingsUI();
render();

window.addEventListener("beforeinstallprompt", function (e) {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.style.display = "block";
});
installBtn.addEventListener("click", async function (e) {
  e.preventDefault();
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBtn.style.display = "none";
});
window.addEventListener("appinstalled", function () {
  installBtn.style.display = "none";
  $("status").textContent = "V" + APP_VERSION + " · Đã cài như ứng dụng";
});

function showUpdateBanner(worker) {
  waitingWorker = worker;
  updateBanner.classList.add("show");
}
function applyUpdate() {
  sessionStorage.setItem("pwaJustUpdated", APP_VERSION);
  if (waitingWorker) waitingWorker.postMessage("SKIP_WAITING");
  else location.reload();
}
updateNowBtn.addEventListener("click", function (e) {
  e.preventDefault();
  updateNowBtn.textContent = "Đang cập nhật…";
  updateNowBtn.disabled = true;
  applyUpdate();
});
successCloseBtn.addEventListener("click", function (e) {
  e.preventDefault();
  successBanner.classList.remove("show");
});
if (sessionStorage.getItem("pwaJustUpdated")) {
  sessionStorage.removeItem("pwaJustUpdated");
  successBanner.classList.add("show");
}

if ("serviceWorker" in navigator) {
  var refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
  navigator.serviceWorker.register("./sw.js").then(function (reg) {
    if (reg.waiting) showUpdateBanner(reg.waiting);
    reg.addEventListener("updatefound", function () {
      var nw = reg.installing;
      if (!nw) return;
      nw.addEventListener("statechange", function () {
        if (nw.state === "installed" && navigator.serviceWorker.controller) showUpdateBanner(nw);
      });
    });
    function checkUpdate() {
      if (!settings.autoUpdate) return;
      if (!navigator.onLine) return;
      reg.update().catch(function () {});
    }
    window.__pwaCheckUpdate = checkUpdate;
    // Chỉ check ngay khi mở app nếu đã bật auto cập nhật
    if (settings.autoUpdate) checkUpdate();
    window.addEventListener("online", checkUpdate);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") checkUpdate();
    });
    window.addEventListener("focus", checkUpdate);
    setInterval(checkUpdate, 5 * 60 * 1000);
  }).catch(function () {});
}
})();
