// Copyright (c) 2026 DYLO Gaming LLC. All rights reserved.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const els = {
  toggleStatus: $("toggleStatus"),
  toggleAction: $("toggleAction"),
  toggleBtn:    $("toggleBtn"),
  sensorSelect:$("sensorSelect"),
  sensorPicker:$("sensorPicker"),
  sensorTrigger:$("sensorTrigger"),
  sensorTriggerText:$("sensorTriggerText"),
  sensorMenu:  $("sensorMenu"),
  refreshBtn:  $("refreshBtn"),
  autostart:   $("autostartChk"),
  startLocked: $("startLockedChk"),
  msg:         $("msg"),
  msgText:     $("msg")?.querySelector(".msg-text"),
  fillPath:    $("fillPath"),
  stars:       $("stars"),
  lockStage:   $("lockStage"),
  cornerShine: $("cornerShine"),
  twinklesBack:  $("twinklesBack"),
  twinklesFront: $("twinklesFront"),
  sky:           $("sky"),
};

let cfg = null;
let sensors = [];
const FAVORITES_KEY = "rotation-lock.favorite-sensors";
let favoriteSensors = new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]"));

// Pause all rAF loops + CSS animations when the window is hidden (minimized to tray).
// Without this the WebView2 GPU process keeps the compositor running at ~100% of one core.
// Default to hidden — Rust pushes the real state (or invoke confirms it) once we're up.
let pageVisible = false;

// ---- State machine ----
const STATE = { UNLOCKED: "unlocked", LOCKING: "locking", LOCKED: "locked", UNLOCKING: "unlocking" };
let uiState = STATE.UNLOCKED;

function setUiState(s) {
  uiState = s;
  document.body.dataset.state = s;
  if (s === STATE.LOCKED) {
    els.toggleStatus.textContent = "Locked";
    els.toggleAction.textContent = "Tap to unlock rotation";
  } else if (s === STATE.UNLOCKED) {
    els.toggleStatus.textContent = "Unlocked";
    els.toggleAction.textContent = "Tap to lock rotation";
  } else if (s === STATE.LOCKING) {
    els.toggleStatus.textContent = "Locking…";
    els.toggleAction.textContent = "Engaging laptop mode";
  } else if (s === STATE.UNLOCKING) {
    els.toggleStatus.textContent = "Unlocking…";
    els.toggleAction.textContent = "Releasing rotation";
  }
  const day = (s === STATE.LOCKED || s === STATE.LOCKING);
  if (typeof sky !== "undefined") sky.setMode(day ? "day" : "night");
}

function showMsg(text, kind = "") {
  els.msg.dataset.kind = kind || "";
  els.msg.dataset.visible = text ? "true" : "false";
  els.msgText.textContent = text || "";
  if (text && kind !== "busy") {
    setTimeout(() => {
      if (els.msgText.textContent === text) {
        els.msg.dataset.visible = "false";
      }
    }, 3500);
  }
}

// ---- Liquid gold fill ----
const FILL_TOP = 22, FILL_BOTTOM = 148, FILL_RANGE = FILL_BOTTOM - FILL_TOP;
const SVG_W = 120, SVG_BOTTOM = 160;
let liquidLevel = SVG_BOTTOM;     // current surface y
let liquidPhaseA = 0, liquidPhaseB = 0;
let liquidPrevLevel = SVG_BOTTOM;
let liquidLastT = 0;

function progressToLevel(p) {
  const c = Math.max(0, Math.min(1, p));
  return FILL_BOTTOM - c * FILL_RANGE;
}
function setToggleFillProgress(p) {
  const pct = Math.max(0, Math.min(1, p)) * 100;
  els.toggleBtn.style.setProperty("--toggle-fill", `${pct.toFixed(1)}%`);
}

function setFillProgress(p) {
  liquidLevel = progressToLevel(p);
  liquidPrevLevel = liquidLevel;
  setToggleFillProgress(p);
}

function buildLiquidPath(level, pA, pB, amp) {
  const SEG = 22;
  let d = "";
  for (let i = 0; i <= SEG; i++) {
    const x = (SVG_W * i) / SEG;
    const u = i / SEG;
    // two stacked sine waves for organic look
    const w1 = Math.sin(pA + u * Math.PI * 2.6) * amp;
    const w2 = Math.sin(pB + u * Math.PI * 4.7) * amp * 0.4;
    const y = level + w1 + w2;
    d += (i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  d += ` L ${SVG_W} ${SVG_BOTTOM} L 0 ${SVG_BOTTOM} Z`;
  return d;
}

function tickLiquid(t) {
  if (!pageVisible) return;
  const dt = liquidLastT ? Math.min(0.05, (t - liquidLastT) / 1000) : 0.016;
  liquidLastT = t;
  liquidPhaseA += dt * 1.6;
  liquidPhaseB += dt * 2.7;
  // Slosh based on speed of level change
  const dLevel = (liquidLevel - liquidPrevLevel) / Math.max(0.001, dt);
  liquidPrevLevel = liquidLevel;
  const baseAmp = (liquidLevel >= SVG_BOTTOM - 0.5 || liquidLevel <= FILL_TOP + 0.5) ? 0 : 1.8;
  const slosh = Math.min(4.5, Math.abs(dLevel) * 0.06);
  const amp = baseAmp + slosh;
  els.fillPath.setAttribute("d", buildLiquidPath(liquidLevel, liquidPhaseA, liquidPhaseB, amp));
  requestAnimationFrame(tickLiquid);
}
if (pageVisible) requestAnimationFrame(tickLiquid);

// Tween fill level over duration. The liquid loop renders waves on top.
function animateFill(from, to, durationMs) {
  return new Promise((resolve) => {
    const start = performance.now();
    const fromL = progressToLevel(from);
    const toL = progressToLevel(to);
    const step = (t) => {
      const k = Math.min(1, (t - start) / durationMs);
      const e = k < .5 ? 2*k*k : 1 - Math.pow(-2*k + 2, 2)/2;
      const progress = from + (to - from) * e;
      liquidLevel = fromL + (toL - fromL) * e;
      setToggleFillProgress(progress);
      if (k < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

// ---- Star burst ----
function starBurst(count = 14) {
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + (Math.random() - .5) * .4;
    const dist = 44 + Math.random() * 50;
    const size = .6 + Math.random() * 1.2;
    const el = document.createElement("div");
    el.className = "star";
    el.style.setProperty("--tx", `${Math.cos(angle) * dist}px`);
    el.style.setProperty("--ty", `${Math.sin(angle) * dist}px`);
    el.style.setProperty("--s", size.toFixed(2));
    el.style.animationDuration = `${600 + Math.random() * 300}ms`;
    els.stars.appendChild(el);
    setTimeout(() => el.remove(), 1100);
  }
}

// ---- Twinkles (two canvases: back + front, always running, color depends on state) ----
class TwinkleLayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.particles = [];
    this.dpr = window.devicePixelRatio || 1;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = r.width * this.dpr;
    this.canvas.height = r.height * this.dpr;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(this.dpr, this.dpr);
    this.w = r.width; this.h = r.height;
  }
  spawn() {
    if (this.particles.length >= 2) return;
    const locked = uiState === STATE.LOCKED || uiState === STATE.LOCKING;
    let hue, sat, lum;
    if (locked) {
      // All gold variants when locked
      hue = 40 + Math.random() * 18;
      sat = 85 + Math.random() * 12;
      lum = 60 + Math.random() * 18;
    } else {
      // Cool white/silver shines for night
      hue = 210; sat = 8 + Math.random() * 12; lum = 82 + Math.random() * 12;
    }
    this.particles.push({
      x: this.w * (0.10 + Math.random() * 0.80),
      y: this.h * (0.80 + Math.random() * 0.15),
      vy: -(7 + Math.random() * 11),
      phase: Math.random() * Math.PI * 2,
      freq: 0.5 + Math.random() * 0.9,
      amp: 8 + Math.random() * 14,
      life: 0,
      ttl: 3 + Math.random() * 2.5,
      size: 1.3 + Math.random() * 2.6,
      hue, sat, lum,
      rotInit: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 1.4),
      pulseFreq: 4 + Math.random() * 4,
      pulsePhase: Math.random() * Math.PI * 2,
      // Occasional flash boosts
      flashAt: 0.4 + Math.random() * 0.4,
      flashed: false,
    });
  }
  draw(dt) {
    this.ctx.clearRect(0, 0, this.w, this.h);
    this.particles = this.particles.filter((p) => {
      p.life += dt;
      p.y += p.vy * dt;
      p.x += Math.sin(p.life * p.freq * Math.PI + p.phase) * p.amp * dt;
      if (p.life >= p.ttl || p.y < -10) return false;
      const fade =
        p.life < 0.6 ? (p.life / 0.6) :
        p.life > p.ttl - 0.9 ? ((p.ttl - p.life) / 0.9) : 1;
      // Pulse + occasional flash
      const lifeFrac = p.life / p.ttl;
      let pulse = 0.7 + 0.3 * Math.sin(p.life * p.pulseFreq + p.pulsePhase);
      if (!p.flashed && lifeFrac > p.flashAt) { p.flashed = true; p.flashTime = 0.0; }
      if (p.flashed) {
        p.flashTime += dt;
        if (p.flashTime < 0.18) {
          const k = p.flashTime / 0.18;
          pulse += (1.4 * (1 - k));
        }
      }
      const size = p.size * pulse;
      const lum = p.lum + 8 * Math.sin(p.life * 3 + p.phase);
      const alpha = Math.max(0, Math.min(1, fade));
      const col = `hsla(${p.hue}, ${p.sat}%, ${lum}%, ${alpha})`;
      const colSoft = `hsla(${p.hue}, ${p.sat}%, ${lum}%, ${alpha * 0.55})`;
      const rot = p.rotInit + p.life * p.rotSpeed;
      this.ctx.save();
      this.ctx.translate(p.x, p.y);
      this.ctx.rotate(rot);
      // long cross
      this.ctx.strokeStyle = col;
      this.ctx.lineWidth = 0.7;
      this.ctx.beginPath();
      this.ctx.moveTo(-size*2.8, 0); this.ctx.lineTo(size*2.8, 0);
      this.ctx.moveTo(0, -size*2.8); this.ctx.lineTo(0, size*2.8);
      this.ctx.stroke();
      // diagonal cross (smaller, softer)
      this.ctx.strokeStyle = colSoft;
      this.ctx.beginPath();
      this.ctx.moveTo(-size*1.4, -size*1.4); this.ctx.lineTo(size*1.4, size*1.4);
      this.ctx.moveTo(-size*1.4, size*1.4);  this.ctx.lineTo(size*1.4, -size*1.4);
      this.ctx.stroke();
      // bright core
      this.ctx.fillStyle = col;
      this.ctx.beginPath();
      this.ctx.arc(0, 0, size * 0.85, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.restore();
      return true;
    });
  }
}

class TwinkleSystem {
  constructor(backCanvas, frontCanvas) {
    this.back  = new TwinkleLayer(backCanvas);
    this.front = new TwinkleLayer(frontCanvas);
    this.running = false;
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.lastT = performance.now();
    this.nextSpawn = 0;
    requestAnimationFrame((t) => this.tick(t));
  }
  stop() { this.running = false; }
  tick(t) {
    if (!this.running) return;
    const dt = Math.min(0.05, (t - this.lastT) / 1000);
    this.lastT = t;
    this.nextSpawn -= dt;
    if (this.nextSpawn <= 0) {
      // spawn one in either back or front, random
      (Math.random() < 0.5 ? this.back : this.front).spawn();
      this.nextSpawn = 0.9 + Math.random() * 1.8;
    }
    this.back.draw(dt);
    this.front.draw(dt);
    requestAnimationFrame((nt) => this.tick(nt));
  }
}
const twinkles = new TwinkleSystem(els.twinklesBack, els.twinklesFront);

// ---- Sky scene (night with stars / day with clouds) ----
class SkyScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dpr = window.devicePixelRatio || 1;
    this.t = 0;
    this.transition = 1; // 0 = previous, 1 = current
    this.modeTarget = "night";
    this.modePrev = "night";
    this.stars = [];
    this.clouds = [];
    this.initStars();
    this.initClouds();
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(this.dpr, this.dpr);
    this.w = r.width; this.h = r.height;
  }
  initStars() {
    this.stars = [];
    const n = 55;
    for (let i = 0; i < n; i++) {
      this.stars.push({
        x: Math.random(), y: Math.random() * 0.78,
        baseSize: 0.4 + Math.random() * 1.6,
        phase: Math.random() * Math.PI * 2,
        freq: 0.4 + Math.random() * 0.9,
        // some stars have a long pulse cycle so they twinkle "randomly"
        slowFreq: 0.2 + Math.random() * 0.4,
        slowPhase: Math.random() * Math.PI * 2,
        hue: 210 + Math.random() * 30,
      });
    }
  }
  initClouds() {
    this.clouds = [];
    const n = 5;
    for (let i = 0; i < n; i++) {
      this.clouds.push({
        x: Math.random(),
        y: 0.10 + Math.random() * 0.55,
        size: 60 + Math.random() * 60,
        speed: 0.004 + Math.random() * 0.008,
        opacity: 0.65 + Math.random() * 0.25,
      });
    }
  }
  setMode(m) {
    if (m === this.modeTarget) return;
    this.modePrev = this.modeTarget;
    this.modeTarget = m;
    this.transition = 0;
  }
  drawNight(alpha) {
    if (alpha <= 0) return;
    this.ctx.globalAlpha = alpha;
    const g = this.ctx.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, "#0a0e1f");
    g.addColorStop(0.5, "#0a0d1a");
    g.addColorStop(1, "#070912");
    this.ctx.fillStyle = g;
    this.ctx.fillRect(0, 0, this.w, this.h);
    // Stars
    for (const s of this.stars) {
      const fast = 0.5 + 0.5 * Math.sin(this.t * s.freq + s.phase);
      const slow = 0.5 + 0.5 * Math.sin(this.t * s.slowFreq + s.slowPhase);
      const tw = (fast * 0.6 + slow * 0.6); // 0..1.2
      const a = Math.max(.15, Math.min(1, 0.25 + tw * 0.7));
      const sz = s.baseSize * (0.7 + tw * 0.5);
      this.ctx.fillStyle = `rgba(220, 230, 255, ${a})`;
      this.ctx.beginPath();
      this.ctx.arc(s.x * this.w, s.y * this.h, sz, 0, Math.PI * 2);
      this.ctx.fill();
      // Bright stars get a subtle glow ring
      if (s.baseSize > 1.2 && tw > 0.7) {
        this.ctx.strokeStyle = `rgba(220, 230, 255, ${a * 0.25})`;
        this.ctx.lineWidth = 0.5;
        this.ctx.beginPath();
        this.ctx.arc(s.x * this.w, s.y * this.h, sz * 2.4, 0, Math.PI * 2);
        this.ctx.stroke();
      }
    }
    this.ctx.globalAlpha = 1;
  }
  drawDay(alpha, dt) {
    if (alpha <= 0) return;
    this.ctx.globalAlpha = alpha;
    const g = this.ctx.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, "#73aedf");
    g.addColorStop(0.55, "#a4cce8");
    g.addColorStop(1, "#cbe2f3");
    this.ctx.fillStyle = g;
    this.ctx.fillRect(0, 0, this.w, this.h);
    // Drift clouds
    for (const c of this.clouds) {
      c.x += c.speed * dt;
      if (c.x > 1.25) c.x = -0.25;
      const cx = c.x * this.w, cy = c.y * this.h;
      const sz = c.size;
      this.ctx.fillStyle = `rgba(255, 255, 255, ${c.opacity * alpha})`;
      this.ctx.filter = "blur(7px)";
      this.ctx.beginPath();
      this.ctx.arc(cx,            cy,            sz * 0.50, 0, Math.PI * 2);
      this.ctx.arc(cx + sz * 0.4, cy + sz * 0.10, sz * 0.42, 0, Math.PI * 2);
      this.ctx.arc(cx - sz * 0.4, cy + sz * 0.10, sz * 0.45, 0, Math.PI * 2);
      this.ctx.arc(cx + sz * 0.1, cy + sz * 0.20, sz * 0.48, 0, Math.PI * 2);
      this.ctx.arc(cx - sz * 0.2, cy + sz * 0.22, sz * 0.46, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.filter = "none";
    }
    this.ctx.globalAlpha = 1;
  }
  draw(dt) {
    this.t += dt;
    if (this.transition < 1) this.transition = Math.min(1, this.transition + dt * 1.4);
    this.ctx.clearRect(0, 0, this.w, this.h);
    if (this.modePrev === this.modeTarget || this.transition >= 1) {
      if (this.modeTarget === "night") this.drawNight(1);
      else this.drawDay(1, dt);
    } else {
      const aPrev = 1 - this.transition;
      const aNew = this.transition;
      if (this.modePrev === "night") this.drawNight(aPrev); else this.drawDay(aPrev, dt);
      if (this.modeTarget === "night") this.drawNight(aNew); else this.drawDay(aNew, dt);
    }
  }
}
const sky = new SkyScene(els.sky);
let _skyLastT = 0;
function _skyTick(t) {
  if (!pageVisible) return;
  const dt = _skyLastT ? Math.min(0.05, (t - _skyLastT) / 1000) : 0.016;
  _skyLastT = t;
  sky.draw(dt);
  requestAnimationFrame(_skyTick);
}
if (pageVisible) requestAnimationFrame(_skyTick);

// ---- Visibility gating ----
// When the window is minimized to tray, stop rAF loops + add `app-hidden`
// to <body> so CSS keyframes pause. Without this WebView2's compositor keeps
// burning ~100% of one core. WebView2 doesn't reliably fire visibilitychange
// when its host window is hidden via Win32 SW_HIDE, so Rust drives this
// explicitly via webview.eval() in cmd_hide_window / show_main_window.
function setHiddenState(hidden) {
  const wasVisible = pageVisible;
  pageVisible = !hidden;
  document.body.classList.toggle("app-hidden", hidden);
  if (pageVisible) {
    if (!wasVisible) {
      liquidLastT = 0;
      _skyLastT = 0;
      requestAnimationFrame(tickLiquid);
      requestAnimationFrame(_skyTick);
    }
    twinkles.start();
  } else {
    twinkles.stop();
  }
}
window.__rotationLockSetHidden = setHiddenState;
// Authoritative state from Rust at startup; subsequent transitions are pushed
// via webview.eval in cmd_hide_window / show_main_window. We deliberately ignore
// document.hidden because WebView2 doesn't update it when the host window is
// hidden via Win32 SW_HIDE.
invoke("cmd_is_window_visible")
  .then((visible) => setHiddenState(!visible))
  .catch(() => setHiddenState(false));

// ---- Corner shine scheduler ----
let cornerShineTimer = null;
function startCornerShine() {
  stopCornerShine();
  const loop = () => {
    const delay = 2500 + Math.random() * 3500;
    cornerShineTimer = setTimeout(() => {
      if (uiState === STATE.LOCKED) {
        els.cornerShine.classList.remove("shine");
        // force reflow so re-adding triggers animation
        void els.cornerShine.offsetWidth;
        els.cornerShine.classList.add("shine");
      }
      loop();
    }, delay);
  };
  loop();
}
function stopCornerShine() {
  if (cornerShineTimer) { clearTimeout(cornerShineTimer); cornerShineTimer = null; }
  els.cornerShine.classList.remove("shine");
}

// ---- Lock / unlock with backend-synced fill ----
async function onToggle() {
  if (uiState === STATE.LOCKING || uiState === STATE.UNLOCKING) return;
  const wasLocked = uiState === STATE.LOCKED;
  els.toggleBtn.disabled = true;

  try {
    if (!wasLocked) {
      setUiState(STATE.LOCKING);
      showMsg("Locking...", "busy");
      const backend = invoke("cmd_lock").then(v => ({ ok: true, v }), e => ({ ok: false, e }));
      // Mirror the unlock timings so the fill is the literal reverse of the drain.
      await new Promise(r => setTimeout(r, 280));
      starBurst(14);
      await animateFill(0, 0.65, 380);
      const trickle = animateFill(0.65, 0.92, 1500);
      const result = await backend;
      await trickle.catch(() => {});
      if (!result.ok) throw result.e;
      await animateFill(0.92, 1, 220);
      setUiState(STATE.LOCKED);
      startCornerShine();
      showMsg("Locked.", "success");
    } else {
      setUiState(STATE.UNLOCKING);
      showMsg("Unlocking...", "busy");
      const backend = invoke("cmd_unlock").then(v => ({ ok: true, v }), e => ({ ok: false, e }));
      // Rumble 0..280ms
      await new Promise(r => setTimeout(r, 280));
      // Fast drain to 35%
      await animateFill(1, 0.35, 380);
      // Slow drain to 8% while awaiting backend
      const drain = animateFill(0.35, 0.08, 1500);
      const result = await backend;
      await drain.catch(() => {});
      if (!result.ok) throw result.e;
      await animateFill(0.08, 0, 220);
      stopCornerShine();
      setUiState(STATE.UNLOCKED);
      setFillProgress(0);
      showMsg("Unlocked.", "success");
    }
  } catch (e) {
    setFillProgress(wasLocked ? 1 : 0);
    setUiState(wasLocked ? STATE.LOCKED : STATE.UNLOCKED);
    if (wasLocked) startCornerShine(); else stopCornerShine();
    showMsg(String(e), "error");
  } finally {
    els.toggleBtn.disabled = false;
  }
}

// ---- Sensors / config ----
async function loadSensors() {
  sensors = await invoke("cmd_list_sensors");
  sortSensors();
  els.sensorSelect.innerHTML = "";
  for (const s of sensors) {
    const opt = document.createElement("option");
    opt.value = s.instance_id;
    opt.textContent = `${s.friendly_name}  :  ${s.instance_id}`;
    els.sensorSelect.appendChild(opt);
  }
  if (cfg?.selected_sensor && sensors.some(s => s.instance_id === cfg.selected_sensor)) {
    els.sensorSelect.value = cfg.selected_sensor;
  } else if (sensors.length) {
    els.sensorSelect.value = sensors[0].instance_id;
    await invoke("cmd_set_sensor", { instanceId: sensors[0].instance_id });
    cfg.selected_sensor = sensors[0].instance_id;
  }
  renderSensorPicker();
}

function sortSensors() {
  sensors.sort((a, b) => {
    const af = favoriteSensors.has(a.instance_id) ? 1 : 0;
    const bf = favoriteSensors.has(b.instance_id) ? 1 : 0;
    return bf - af || (b.priority || 0) - (a.priority || 0);
  });
}

function sensorLabel(s) {
  return s ? `${s.friendly_name} : ${s.instance_id}` : "No sensors found";
}

function selectedSensor() {
  return sensors.find(s => s.instance_id === els.sensorSelect.value);
}

function saveFavorites() {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favoriteSensors]));
}

function renderSensorPicker() {
  sortSensors();
  const current = selectedSensor();
  els.sensorTriggerText.textContent = sensorLabel(current);
  els.sensorMenu.innerHTML = "";
  for (const s of sensors) {
    const row = document.createElement("div");
    row.className = "sensor-row";
    const star = document.createElement("button");
    star.type = "button";
    star.className = "sensor-list-star";
    star.title = favoriteSensors.has(s.instance_id) ? "Remove favorite" : "Favorite this sensor";
    star.textContent = favoriteSensors.has(s.instance_id) ? "★" : "☆";
    star.dataset.active = favoriteSensors.has(s.instance_id) ? "true" : "false";
    star.addEventListener("click", (e) => {
      e.stopPropagation();
      const isFav = !favoriteSensors.has(s.instance_id);
      if (isFav) favoriteSensors.add(s.instance_id);
      else favoriteSensors.delete(s.instance_id);
      saveFavorites();
      star.textContent = isFav ? "★" : "☆";
      star.dataset.active = isFav ? "true" : "false";
      star.title = isFav ? "Remove favorite" : "Favorite this sensor";
      showMsg(isFav ? "Sensor favorited." : "Favorite removed.", "success");
    });

    const item = document.createElement("button");
    item.type = "button";
    item.className = "sensor-option";
    item.role = "option";
    item.dataset.value = s.instance_id;
    item.dataset.selected = s.instance_id === els.sensorSelect.value ? "true" : "false";
    item.innerHTML = `<span class="sensor-option-text"></span>`;
    item.querySelector(".sensor-option-text").textContent = sensorLabel(s);
    item.title = sensorLabel(s);
    item.addEventListener("click", async () => {
      await setSensor(s.instance_id);
      closeSensorMenu();
    });
    row.appendChild(star);
    row.appendChild(item);
    els.sensorMenu.appendChild(row);
  }
}

async function setSensor(instanceId) {
  els.sensorSelect.value = instanceId;
  await invoke("cmd_set_sensor", { instanceId });
  cfg.selected_sensor = instanceId;
  renderSensorPicker();
  showMsg("Sensor saved.", "success");
}

function openSensorMenu() {
  els.sensorPicker.dataset.open = "true";
  els.sensorTrigger.setAttribute("aria-expanded", "true");
}

function closeSensorMenu() {
  const wasOpen = els.sensorPicker.dataset.open === "true";
  els.sensorPicker.dataset.open = "false";
  els.sensorTrigger.setAttribute("aria-expanded", "false");
  if (wasOpen) renderSensorPicker();
}

async function init() {
  cfg = await invoke("cmd_get_config");
  invoke("cmd_get_version")
    .then((v) => { document.getElementById("appVersion").textContent = `v${v}`; })
    .catch(() => {});
  const elevated = await invoke("cmd_is_elevated");
  if (!elevated) showMsg("App is not elevated: lock won't work without admin rights.", "error");

  // Restore visual state from persisted config
  if (cfg.locked) {
    setUiState(STATE.LOCKED);
    setFillProgress(1);
    startCornerShine();
  } else {
    setUiState(STATE.UNLOCKED);
    setFillProgress(0);
  }
  twinkles.start();

  els.autostart.checked = await invoke("cmd_autostart_installed");
  els.startLocked.checked = !!cfg.start_locked;

  await loadSensors();

  els.toggleBtn.addEventListener("click", onToggle);
  els.lockStage.addEventListener("click", onToggle);
  els.refreshBtn.addEventListener("click", () => {
    const btn = els.refreshBtn;
    btn.classList.remove("spinning");
    void btn.offsetWidth; // restart animation on rapid re-clicks
    btn.classList.add("spinning");
    btn.addEventListener("animationend", () => btn.classList.remove("spinning"), { once: true });
    loadSensors();
  });
  els.sensorTrigger.addEventListener("click", () => {
    els.sensorPicker.dataset.open === "true" ? closeSensorMenu() : openSensorMenu();
  });
  document.addEventListener("click", (e) => {
    if (!els.sensorPicker.contains(e.target)) closeSensorMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSensorMenu();
  });
  els.autostart.addEventListener("change", onAutostart);
  els.startLocked.addEventListener("change", onStartLocked);

  const donateBtn = $("donateBtn");
  if (donateBtn) {
    donateBtn.addEventListener("click", async () => {
      try { await invoke("cmd_open_url", { url: "https://ko-fi.com/dylogaming" }); }
      catch (err) { showMsg(String(err), "error"); }
    });
  }

  listen("state-changed", (ev) => {
    if (ev.payload.locked && uiState !== STATE.LOCKED && uiState !== STATE.LOCKING) {
      setUiState(STATE.LOCKED); setFillProgress(1); startCornerShine();
    } else if (!ev.payload.locked && uiState !== STATE.UNLOCKED && uiState !== STATE.UNLOCKING) {
      setUiState(STATE.UNLOCKED); setFillProgress(0); stopCornerShine();
    }
  }).catch((err) => console.warn("state listener unavailable", err));

  // In-app File/Help menus (replaces the native menu bar)
  const menus = Array.from(document.querySelectorAll(".menubar .menu"));
  const closeMenus = () => menus.forEach((m) => {
    m.classList.remove("open");
    m.querySelector(".menu-btn").setAttribute("aria-expanded", "false");
  });
  menus.forEach((m) => {
    const btn = m.querySelector(".menu-btn");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = m.classList.contains("open");
      closeMenus();
      if (!wasOpen) { m.classList.add("open"); btn.setAttribute("aria-expanded", "true"); }
    });
    // Hover-switch between menus while one is open (native menubar behavior)
    btn.addEventListener("mouseenter", () => {
      if (menus.some((o) => o !== m && o.classList.contains("open"))) {
        closeMenus();
        m.classList.add("open");
        btn.setAttribute("aria-expanded", "true");
      }
    });
  });
  document.addEventListener("click", closeMenus);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenus();
  });
  const menuHide = async () => {
    closeMenus();
    try { await invoke("cmd_hide_window"); }
    catch (err) { showMsg(String(err), "error"); }
  };
  const menuQuit = async () => {
    closeMenus();
    try { await invoke("cmd_quit_app"); }
    catch (err) { showMsg(String(err), "error"); }
  };
  document.getElementById("menuHideBtn").addEventListener("click", menuHide);
  const autoUpdateBtn = document.getElementById("menuAutoUpdateBtn");
  autoUpdateBtn.setAttribute("aria-checked", cfg?.auto_update !== false ? "true" : "false");
  autoUpdateBtn.addEventListener("click", async (e) => {
    e.stopPropagation(); // keep the menu open so the checkmark change is visible
    const next = autoUpdateBtn.getAttribute("aria-checked") !== "true";
    try {
      await invoke("cmd_set_auto_update", { value: next });
      autoUpdateBtn.setAttribute("aria-checked", next ? "true" : "false");
      showMsg(next ? "Auto-update enabled." : "Auto-update disabled.");
    } catch (err) { showMsg(String(err), "error"); }
  });
  listen("update-status", (ev) => showMsg(ev.payload))
    .catch((err) => console.warn("update listener unavailable", err));
  document.getElementById("menuQuitBtn").addEventListener("click", menuQuit);
  document.getElementById("menuAboutBtn").addEventListener("click", () => {
    closeMenus();
    document.getElementById("aboutOverlay").dataset.open = "true";
  });
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey) {
      if (e.key === "w" || e.key === "W") { e.preventDefault(); menuHide(); }
      else if (e.key === "q" || e.key === "Q") { e.preventDefault(); menuQuit(); }
    }
  });

  const overlay = document.getElementById("aboutOverlay");
  const closeAbout = () => {
    if (overlay.dataset.open !== "true") return;
    overlay.dataset.open = "closing";
    setTimeout(() => {
      if (overlay.dataset.open === "closing") overlay.dataset.open = "false";
    }, 200);
  };
  document.getElementById("aboutClose").addEventListener("click", closeAbout);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeAbout(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.dataset.open === "true") closeAbout();
  });
  listen("show-about", () => { overlay.dataset.open = "true"; })
    .catch((err) => console.warn("about listener unavailable", err));

  const closeOverlay = $("closeOverlay");
  const hideClosePrompt = () => { closeOverlay.dataset.open = "false"; };
  $("closeMinimizeBtn").addEventListener("click", async () => {
    hideClosePrompt();
    try { await invoke("cmd_hide_window"); }
    catch (err) { showMsg(String(err), "error"); }
  });
  $("closeQuitBtn").addEventListener("click", async () => {
    try { await invoke("cmd_quit_app"); }
    catch (err) { showMsg(String(err), "error"); }
  });
  $("closeCancelBtn").addEventListener("click", hideClosePrompt);
  closeOverlay.addEventListener("click", (e) => {
    if (e.target === closeOverlay) hideClosePrompt();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && closeOverlay.dataset.open === "true") hideClosePrompt();
  });
  listen("close-requested", () => {
    closeOverlay.dataset.open = "true";
    requestAnimationFrame(() => $("closeMinimizeBtn").focus());
  }).catch((err) => console.warn("close listener unavailable", err));
}

async function onAutostart(e) {
  try {
    if (e.target.checked) { await invoke("cmd_install_autostart"); showMsg("Autostart enabled."); }
    else                  { await invoke("cmd_uninstall_autostart"); showMsg("Autostart removed."); }
  } catch (err) { e.target.checked = !e.target.checked; showMsg(String(err), "error"); }
}

async function onStartLocked(e) {
  try { await invoke("cmd_set_start_locked", { value: e.target.checked }); showMsg("Saved."); }
  catch (err) { e.target.checked = !e.target.checked; showMsg(String(err), "error"); }
}

init().catch(err => showMsg(String(err), "error"));
