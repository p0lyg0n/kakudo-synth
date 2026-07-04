/* Kakudo Synth — tilt-controlled Web Audio synthesizer PWA
 *
 * Modes:
 *   axis   : gamma (left/right) -> pitch, beta (front/back) -> brightness
 *   center : distance from the calibrated center -> pitch (farther = higher);
 *            brightness also opens up as you move away from center.
 *
 * Hold the phone face-down and roughly level, then tilt.
 */
(() => {
  "use strict";

  // ---------- Voice / preset definitions ----------
  const VOICES = {
    sine:   { label: "サイン",   emoji: "〰️", type: "sine",     detune: 0,  sub: false },
    warm:   { label: "ウォーム", emoji: "🟣", type: "triangle", detune: 0,  sub: true  },
    square: { label: "スクエア", emoji: "⬛", type: "square",   detune: 0,  sub: false },
    saw:    { label: "ノコギリ", emoji: "🔺", type: "sawtooth", detune: 0,  sub: false },
    super:  { label: "スーパー", emoji: "🌈", type: "supersaw", detune: 14, sub: false },
    fm:     { label: "ベル(FM)", emoji: "🔔", type: "fm",       detune: 0,  sub: false },
  };
  const VOICE_ORDER = ["sine", "warm", "square", "saw", "super", "fm"];

  const MODES = {
    axis:   { label: "軸モード",   emoji: "✛", desc: "左右に傾ける→音程 / 前後に傾ける→明るさ" },
    center: { label: "中心モード", emoji: "◉", desc: "中心で低くこもった音。どの方向でも中心から離れるほど、高く・明るくなります（左右も前後も同じ効き）" },
  };
  const MODE_ORDER = ["axis", "center"];

  const SCALES = {
    major:      [0, 2, 4, 5, 7, 9, 11],
    minor:      [0, 2, 3, 5, 7, 8, 10],
    pentatonic: [0, 2, 4, 7, 9],
    blues:      [0, 3, 5, 6, 7, 10],
    chromatic:  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    whole:      [0, 2, 4, 6, 8, 10],
  };
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const BASE_FREQ = 220; // A3 as the center pitch

  // Center mode: degrees of tilt (times sensitivity) per semitone of pitch.
  // Smaller = the pitch reaches its range with a shallower tilt (more responsive).
  const CENTER_K = 2.2;

  // ---------- State ----------
  const state = {
    running: false,
    mode: "axis",
    voice: "super",
    sensitivity: 1.4,
    rate: 55,
    rangeSemis: 19,
    brightness: 6000,
    volume: 0.7,
    scale: "pentatonic", // "continuous" = 無段階
    root: 0,      // key transpose in semitones (0 = A)
    echo: 20,     // 0..100 -> reverb-ish delay wet
    vibrato: 0,   // 0..100 -> vibrato depth
    shake: true,      // vibration -> boing jump sound
    shakeSens: 70,    // 0..100, higher = triggers on gentler shakes
    autoHold: true,   // play while held, auto-stop when set down (still)
    tiltX: 0, // left/right (roll), relative to calibrated center
    tiltY: 0, // front/back (pitch), relative to calibrated center
    haveOrientation: false,
  };

  // ---------- Persistence ----------
  const SETTINGS_KEY = "kakudo-synth-settings-v1";
  const PERSIST_KEYS = [
    "mode", "voice", "sensitivity", "rate", "rangeSemis",
    "brightness", "volume", "scale", "root", "echo", "vibrato", "shake", "shakeSens", "autoHold",
  ];

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      PERSIST_KEYS.forEach((k) => {
        if (saved[k] !== undefined) state[k] = saved[k];
      });
      // guard against unknown values from older versions
      if (!MODES[state.mode]) state.mode = "axis";
      if (!VOICES[state.voice]) state.voice = "super";
      if (!SCALES[state.scale] && state.scale !== "continuous") state.scale = "pentatonic";
    } catch (e) { /* ignore corrupt storage */ }
  }

  function saveSettings() {
    try {
      const out = {};
      PERSIST_KEYS.forEach((k) => (out[k] = state[k]));
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(out));
    } catch (e) { /* storage unavailable / full */ }
  }

  // ---------- Audio graph ----------
  let ctx = null, master = null, filter = null, voiceGain = null;
  let delay = null, feedback = null, wet = null;   // echo
  let lfo = null, lfoGain = null;                   // vibrato
  let nodes = [];

  function ensureContext() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = state.volume;
    filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = state.brightness;
    filter.Q.value = 1.0;
    voiceGain = ctx.createGain();
    voiceGain.gain.value = 0;

    // echo (feedback delay) send
    delay = ctx.createDelay(1.0);
    delay.delayTime.value = 0.28;
    feedback = ctx.createGain();
    feedback.gain.value = 0.34;
    wet = ctx.createGain();
    wet.gain.value = echoWet();

    // vibrato LFO (modulates oscillator detune, in cents)
    lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 5.2;
    lfoGain = ctx.createGain();
    lfoGain.gain.value = vibratoCents();
    lfo.connect(lfoGain);
    lfo.start();

    voiceGain.connect(filter);
    filter.connect(master);        // dry
    filter.connect(delay);         // wet send
    delay.connect(feedback);
    feedback.connect(delay);       // feedback loop
    delay.connect(wet);
    wet.connect(master);
    master.connect(ctx.destination);
  }

  function echoWet() { return (state.echo / 100) * 0.6; }
  function vibratoCents() { return (state.vibrato / 100) * 55; }

  function smoothTime() {
    const t = state.rate / 100;
    return 0.4 * Math.pow(0.025, t);
  }

  function buildVoice() {
    stopVoiceNodes();
    const def = VOICES[state.voice];
    const now = ctx.currentTime;
    const freq = currentFreq();

    if (def.type === "fm") {
      const carrier = ctx.createOscillator();
      carrier.type = "sine";
      carrier.frequency.value = freq;
      const mod = ctx.createOscillator();
      mod.type = "sine";
      mod.frequency.value = freq * 2;
      const modGain = ctx.createGain();
      modGain.gain.value = freq * 3;
      mod.connect(modGain);
      modGain.connect(carrier.frequency);
      carrier.connect(voiceGain);
      carrier.start(now);
      mod.start(now);
      nodes = [carrier, mod, modGain];
      nodes.fmMod = mod;
      nodes.fmModGain = modGain;
    } else if (def.type === "supersaw") {
      const spread = [-1, -0.5, 0, 0.5, 1];
      nodes = [];
      spread.forEach((s) => {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = freq;
        o.detune.value = s * def.detune;
        o.connect(voiceGain);
        o.start(now);
        nodes.push(o);
      });
    } else {
      const o = ctx.createOscillator();
      o.type = def.type;
      o.frequency.value = freq;
      o.connect(voiceGain);
      o.start(now);
      nodes = [o];
      if (def.sub) {
        const sub = ctx.createOscillator();
        sub.type = "sine";
        sub.frequency.value = freq / 2;
        const subGain = ctx.createGain();
        subGain.gain.value = 0.4;
        sub.connect(subGain);
        subGain.connect(voiceGain);
        sub.start(now);
        nodes.push(sub, subGain);
        nodes.sub = sub;
      }
    }
    // apply vibrato to every oscillator's detune
    nodes.forEach((n) => {
      if (n.detune && lfoGain) {
        try { lfoGain.connect(n.detune); } catch (e) { /* noop */ }
      }
    });

    updateFrequency(true);
  }

  function stopVoiceNodes() {
    const now = ctx ? ctx.currentTime : 0;
    nodes.forEach((n) => {
      if (typeof n.stop === "function") {
        try { n.stop(now + 0.02); } catch (e) { /* already stopped */ }
      }
      try { n.disconnect(); } catch (e) { /* noop */ }
    });
    nodes = [];
  }

  // distance from center, 0..~ (deg). Diagonal counts.
  function tiltDistance() {
    return Math.hypot(state.tiltX, state.tiltY);
  }

  function currentFreq() {
    let semis;
    if (state.mode === "center") {
      // distance from center -> upward pitch only
      const d = tiltDistance();
      semis = (d * state.sensitivity) / CENTER_K; // deg -> semis
      semis = Math.max(0, Math.min(state.rangeSemis, semis));
    } else {
      const half = state.rangeSemis / 2;
      semis = ((state.tiltX * state.sensitivity) / 8) * half;
      semis = Math.max(-half, Math.min(half, semis));
    }
    // "continuous" = 無段階（連続）; otherwise snap to the chosen scale
    if (state.scale !== "continuous") semis = quantizeSemis(semis);
    return BASE_FREQ * Math.pow(2, (semis + state.root) / 12);
  }

  function quantizeSemis(semis) {
    const scale = SCALES[state.scale];
    const rounded = Math.round(semis);
    const octave = Math.floor(rounded / 12);
    const within = ((rounded % 12) + 12) % 12;
    let best = scale[0], bestD = 99;
    for (const s of scale) {
      const d = Math.abs(s - within);
      if (d < bestD) { bestD = d; best = s; }
    }
    return octave * 12 + best;
  }

  function currentCutoff() {
    let norm;
    if (state.mode === "center") {
      // Brightness follows the DISTANCE from center (same tilt range as pitch),
      // so left/right and front/back have an identical effect (no weak axis).
      const d = tiltDistance();
      norm = Math.min(1, (d * state.sensitivity) / (CENTER_K * state.rangeSemis));
    } else {
      // Axis mode: front/back tilt controls brightness.
      let by = (state.tiltY * state.sensitivity) / 45;
      by = Math.max(-1, Math.min(1, by));
      norm = (by + 1) / 2;
    }
    const minF = 220;
    return Math.max(minF, minF + norm * (state.brightness - minF));
  }

  function updateFrequency(immediate) {
    if (!ctx || !state.running) return;
    const freq = currentFreq();
    const now = ctx.currentTime;
    const tc = immediate ? 0.005 : smoothTime();
    const def = VOICES[state.voice];

    nodes.forEach((n) => {
      if (n.frequency && n.type !== undefined && n !== nodes.fmMod && n !== nodes.sub) {
        n.frequency.setTargetAtTime(freq, now, tc);
      }
    });
    if (def.type === "fm" && nodes.fmMod) {
      nodes.fmMod.frequency.setTargetAtTime(freq * 2, now, tc);
      nodes.fmModGain.gain.setTargetAtTime(freq * 3, now, tc);
    }
    if (nodes.sub) {
      nodes.sub.frequency.setTargetAtTime(freq / 2, now, tc);
    }

    filter.frequency.setTargetAtTime(currentCutoff(), now, tc);

    updateReadout(freq);
    updatePadDot();
  }

  // ---------- Playback ----------
  function play() {
    ensureContext();
    if (ctx.state === "suspended") ctx.resume();
    buildVoice();
    const now = ctx.currentTime;
    voiceGain.gain.cancelScheduledValues(now);
    voiceGain.gain.setTargetAtTime(0.35, now, 0.03);
    state.running = true;
    lastMoveTime = nowMs(); // grace period so it doesn't auto-stop immediately
    els.powerBtn.textContent = "停止";
    els.powerBtn.setAttribute("aria-pressed", "true");
    els.pad.classList.add("live");
  }

  function stop() {
    state.running = false;
    if (ctx && voiceGain) {
      const now = ctx.currentTime;
      voiceGain.gain.setTargetAtTime(0, now, 0.05);
      setTimeout(stopVoiceNodes, 200);
    }
    els.powerBtn.textContent = "再生";
    els.powerBtn.setAttribute("aria-pressed", "false");
    els.pad.classList.remove("live");
  }

  function toggle() { state.running ? stop() : play(); }

  // Manual power button. With auto-hold on, a manual stop should stay stopped
  // until the phone is set down and picked up again (don't fight the user).
  function onPowerButton() {
    if (state.running) {
      stop();
      if (state.autoHold) holdSuppressed = true;
    } else {
      holdSuppressed = false;
      play();
    }
  }

  // ---------- Boing (spring jump) sound ----------
  // Plays a decaying, wobbling "びよよーん" independent of the tilt synth.
  function playBoing() {
    ensureContext();
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;
    const dur = 0.62;

    const osc = ctx.createOscillator();
    osc.type = "triangle";

    // pitch curve: a fast-decaying vibrato riding an overall downward glide
    const N = 96;
    const curve = new Float32Array(N);
    const fBase = 560;
    for (let i = 0; i < N; i++) {
      const t = (i / (N - 1)) * dur;
      const env = Math.exp(-t * 4.5);                       // wobble decays
      const wobble = Math.sin(2 * Math.PI * 9 * t) * 0.7 * env;
      const drift = -0.9 * (t / dur);                       // slides down
      curve[i] = Math.max(60, fBase * Math.pow(2, wobble + drift));
    }
    osc.frequency.setValueCurveAtTime(curve, now, dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.7, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, now + dur);

    osc.connect(g);
    g.connect(master); // through master volume, bypassing the tilt filter
    osc.start(now);
    osc.stop(now + dur + 0.05);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch (e) { /* noop */ } };
  }

  // ---------- Shake detection ----------
  let lastAcc = null;
  let lastShakeTime = 0;
  const SHAKE_COOLDOWN = 260;   // ms between boings

  // hold-to-play detection — based on whether the TILT ANGLE is frozen.
  // On a table the gravity direction is perfectly still, so the tilt angle does
  // not change at all; a hand always drifts. This is independent of the sensor
  // noise level, so it won't false-stop while held (the earlier jerk-based
  // version could) and still stops reliably when set down.
  let lastMoveTime = 0;         // last time the tilt angle moved beyond STILL_ANGLE
  let holdSuppressed = false;   // after a manual stop, don't auto-restart until set down
  let prevTiltX = null, prevTiltY = null;
  let angSpeedEMA = 0;          // smoothed per-sample tilt change (for pickup)
  let stillRefX = 0, stillRefY = 0; // tilt anchor for the stillness window
  const STILL_ANGLE = 0.7;      // deg; drift below this over the window = still
  const START_SPEED = 0.4;      // deg/sample (smoothed) to auto-start on pickup
  const HOLD_STILL_MS = 1200;   // must be flat & still this long before auto-stopping
  const FLAT_COS = Math.cos(14 * Math.PI / 180); // within ~14deg of horizontal = "flat"

  function nowMs() {
    return (typeof performance !== "undefined" ? performance.now() : Date.now());
  }

  // 0 (needs a hard shake) .. 100 (very sensitive). Returns m/s^2 jerk threshold.
  function shakeThreshold() {
    return 28 - (state.shakeSens / 100) * 21; // 28 .. 7
  }

  function onMotion(e) {
    const a = e.accelerationIncludingGravity || e.acceleration;
    if (!a || a.x == null) return;
    const t = nowMs();

    const jerk = lastAcc
      ? Math.hypot(a.x - lastAcc.x, a.y - lastAcc.y, a.z - lastAcc.z)
      : 0;
    lastAcc = { x: a.x, y: a.y, z: a.z };

    // --- shake -> boing (only when enabled) ---
    if (state.shake && jerk > shakeThreshold() && t - lastShakeTime > SHAKE_COOLDOWN) {
      lastShakeTime = t;
      playBoing();
    }

    // --- tilt from gravity vs. calibrated reference (robust in any orientation) ---
    if (e.accelerationIncludingGravity && e.accelerationIncludingGravity.x != null) {
      const g = e.accelerationIncludingGravity;
      if (!gravity) gravity = { x: g.x, y: g.y, z: g.z };
      const k = 0.8; // low-pass to isolate gravity from motion
      gravity.x = k * gravity.x + (1 - k) * g.x;
      gravity.y = k * gravity.y + (1 - k) * g.y;
      gravity.z = k * gravity.z + (1 - k) * g.z;
      usingMotionTilt = true;
      state.haveOrientation = true;
      updateMotionTilt();
    }

    // --- hold-to-play: stop ONLY when the phone lies flat (parallel to the
    //     ground) and still — i.e. set down on a table. While tilted (playing)
    //     it never stops, regardless of how steady the hand is. ---
    if (state.autoHold && gravity) {
      const dAng = (prevTiltX === null)
        ? 0
        : Math.hypot(state.tiltX - prevTiltX, state.tiltY - prevTiltY);
      prevTiltX = state.tiltX;
      prevTiltY = state.tiltY;
      angSpeedEMA = angSpeedEMA * 0.7 + dAng * 0.3;

      // flatness: |gz| dominates when the phone is horizontal (screen up or down)
      const gMag = Math.hypot(gravity.x, gravity.y, gravity.z) || 1;
      const isFlat = Math.abs(gravity.z) / gMag > FLAT_COS;

      const movedFromRef = Math.hypot(state.tiltX - stillRefX, state.tiltY - stillRefY);
      if (movedFromRef > STILL_ANGLE) {
        stillRefX = state.tiltX;
        stillRefY = state.tiltY;
        lastMoveTime = t;                 // still being moved
      }
      const still = (t - lastMoveTime > HOLD_STILL_MS);
      if (isFlat && still) holdSuppressed = false; // set down -> re-arm auto start

      if (!state.running) {
        // start when picked up / tilted off flat
        if (!holdSuppressed && (!isFlat || angSpeedEMA > START_SPEED)) play();
      } else if (isFlat && still) {
        stop();                           // lying flat & still = on the table
      }
    }
  }

  async function requestMotionPermission() {
    const M = window.DeviceMotionEvent;
    if (M && typeof M.requestPermission === "function") {
      try { return (await M.requestPermission()) === "granted"; }
      catch (e) { return false; }
    }
    return true;
  }

  // ---------- Tilt sensing ----------
  // Tilt is measured as the deviation of the GRAVITY vector from a calibrated
  // reference pose, decomposed onto the device's left/right (X) and front/back
  // (Y) axes projected into the plane of that pose. This is robust to holding
  // the phone face-up, face-down, or upside-down: whichever pose you calibrate
  // becomes the neutral center, and both axes respond symmetrically around it.
  // (The old global roll/pitch could lose the X axis in certain orientations.)
  let gravity = null;              // low-pass filtered gravity vector
  let usingMotionTilt = false;     // true once devicemotion drives the tilt
  let gRef = null;                 // calibrated reference gravity (unit vector)
  let exRef = null, eyRef = null;  // in-plane basis (device X / Y) at calibration
  let needsRef = true;             // (re)capture the reference on the next sample
  // fallback (deviceorientation only) calibration
  let fbCenterB = null, fbCenterG = null;

  function unit(v) {
    const m = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / m, v[1] / m, v[2] / m];
  }
  function projPerp(v, g) {
    const d = v[0] * g[0] + v[1] * g[1] + v[2] * g[2];
    return unit([v[0] - d * g[0], v[1] - d * g[1], v[2] - d * g[2]]);
  }

  function setReferenceFrame() {
    if (!gravity) return;
    gRef = unit([gravity.x, gravity.y, gravity.z]);
    exRef = projPerp([1, 0, 0], gRef); // device X (left/right)
    eyRef = projPerp([0, 1, 0], gRef); // device Y (front/back)
    needsRef = false;
  }

  function updateMotionTilt() {
    if (needsRef || !gRef) setReferenceFrame();
    if (!gRef) return;
    const g = unit([gravity.x, gravity.y, gravity.z]);
    const rad = 180 / Math.PI;
    const cx = Math.max(-1, Math.min(1, g[0] * exRef[0] + g[1] * exRef[1] + g[2] * exRef[2]));
    const cy = Math.max(-1, Math.min(1, g[0] * eyRef[0] + g[1] * eyRef[1] + g[2] * eyRef[2]));
    state.tiltX = Math.asin(cx) * rad;
    state.tiltY = Math.asin(cy) * rad;
    updateFrequency(false);
  }

  // Fallback only (used when devicemotion gravity is unavailable).
  function onOrientation(e) {
    if (usingMotionTilt) return;
    if (e.beta === null || e.gamma === null) return;
    state.haveOrientation = true;
    if (fbCenterB === null) { fbCenterB = e.beta; fbCenterG = e.gamma; }
    let dB = e.beta - fbCenterB, dG = e.gamma - fbCenterG;
    if (dB > 180) dB -= 360;
    if (dB < -180) dB += 360;
    state.tiltX = dG;
    state.tiltY = dB;
    updateFrequency(false);
  }

  function calibrate() {
    // Make the current posture the neutral center (works in any orientation).
    needsRef = true;
    if (gravity) setReferenceFrame();
    fbCenterB = null;
    fbCenterG = null;
    state.tiltX = 0;
    state.tiltY = 0;
    // reset hold-to-play anchors so it doesn't immediately auto-stop
    stillRefX = 0;
    stillRefY = 0;
    prevTiltX = null;
    prevTiltY = null;
    lastMoveTime = nowMs();
    updatePadDot();
    updateFrequency(false);
    showToast("中央にセットしました");
  }

  async function requestOrientationPermission() {
    const D = window.DeviceOrientationEvent;
    if (D && typeof D.requestPermission === "function") {
      try { return (await D.requestPermission()) === "granted"; }
      catch (e) { return false; }
    }
    return true;
  }

  // Android: hide the OS navigation bar by going fullscreen (no-op on iOS Safari),
  // and lock to portrait. MUST be called synchronously inside the tap handler —
  // after an `await`, the browser no longer treats it as a user gesture and the
  // fullscreen request is silently rejected.
  function tryFullscreen() {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen ||
      el.mozRequestFullScreen || el.msRequestFullscreen;
    if (!req) return;
    let p;
    try { p = req.call(el, { navigationUI: "hide" }); } catch (e) { return; }
    if (p && typeof p.then === "function") {
      p.then(lockPortrait).catch(() => {});
    } else {
      lockPortrait();
    }
  }

  function lockPortrait() {
    try {
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock("portrait").catch(() => {});
      }
    } catch (e) { /* not supported (e.g. iOS Safari) */ }
  }

  // ---------- UI wiring ----------
  const els = {};
  function cacheEls() {
    [
      "overlay", "startBtn", "permHint", "app", "powerBtn", "pad", "padDot",
      "padRing", "noteReadout", "freqReadout", "modePicker", "modeDesc",
      "voicePicker", "sens", "sensVal", "rate", "rateVal", "range", "rangeVal",
      "bri", "briVal", "vib", "vibVal", "echo", "echoVal", "vol", "volVal",
      "root", "scale", "shake", "shakeSens", "shakeSensVal", "autoHold",
      "calibrateBtn", "toast", "settingsBtn", "settingsClose", "settings", "sheetBackdrop",
      "shareBtn", "copyBtn", "qrcode", "shareUrl",
    ].forEach((id) => (els[id] = document.getElementById(id)));
  }

  function buildModePicker() {
    els.modePicker.innerHTML = "";
    MODE_ORDER.forEach((key) => {
      const m = MODES[key];
      const btn = document.createElement("button");
      btn.className = "mode-btn" + (key === state.mode ? " active" : "");
      btn.dataset.mode = key;
      btn.innerHTML = `<span class="emoji">${m.emoji}</span>${m.label}`;
      btn.addEventListener("click", () => selectMode(key));
      els.modePicker.appendChild(btn);
    });
    applyModeUI();
  }

  function selectMode(key) {
    state.mode = key;
    [...els.modePicker.children].forEach((b) =>
      b.classList.toggle("active", b.dataset.mode === key)
    );
    applyModeUI();
    updateFrequency(false);
    saveSettings();
  }

  function applyModeUI() {
    els.modeDesc.textContent = MODES[state.mode].desc;
    const center = state.mode === "center";
    els.padRing.hidden = !center;
    // update pad edge labels per mode
    const labels = document.querySelectorAll(".pad-labels span");
    if (labels.length === 4) {
      const [top, bottom, left, right] = labels;
      if (center) {
        top.textContent = "外ほど 高音・明るい";
        bottom.textContent = "中心=低音・こもる";
        left.textContent = "◀ 外へ";
        right.textContent = "外へ ▶";
      } else {
        top.textContent = "高音 / 明";
        bottom.textContent = "低音 / 暗";
        left.textContent = "◀ 音程";
        right.textContent = "音程 ▶";
      }
    }
  }

  function buildVoicePicker() {
    els.voicePicker.innerHTML = "";
    VOICE_ORDER.forEach((key) => {
      const v = VOICES[key];
      const btn = document.createElement("button");
      btn.className = "voice-btn" + (key === state.voice ? " active" : "");
      btn.dataset.voice = key;
      btn.innerHTML = `<span class="emoji">${v.emoji}</span>${v.label}`;
      btn.addEventListener("click", () => selectVoice(key));
      els.voicePicker.appendChild(btn);
    });
  }

  function selectVoice(key) {
    state.voice = key;
    [...els.voicePicker.children].forEach((b) =>
      b.classList.toggle("active", b.dataset.voice === key)
    );
    if (state.running) buildVoice();
    saveSettings();
  }

  function updateReadout(freq) {
    els.freqReadout.textContent = Math.round(freq) + " Hz";
    const midi = Math.round(69 + 12 * Math.log2(freq / 440));
    const name = NOTE_NAMES[((midi % 12) + 12) % 12];
    const oct = Math.floor(midi / 12) - 1;
    els.noteReadout.textContent = name + oct;
  }

  function updatePadDot() {
    // The dot must reach the pad edge exactly when the sound reaches its limit,
    // so the mapping mirrors currentFreq()/currentCutoff() per mode.
    let px, py; // -1..1, then scaled by 48% of the pad
    if (state.mode === "center") {
      // pitch saturates when semis == rangeSemis, i.e. d == CENTER_K*rangeSemis/sens
      const d = tiltDistance();
      const rMax = (CENTER_K * state.rangeSemis) / state.sensitivity;
      const r = rMax > 0 ? Math.min(1, d / rMax) : 0;
      if (d > 1e-4) { px = (state.tiltX / d) * r; py = (state.tiltY / d) * r; }
      else { px = 0; py = 0; }
    } else {
      // axis mode: X drives pitch (÷8), Y drives brightness (÷45) — matches sound
      px = Math.max(-1, Math.min(1, (state.tiltX * state.sensitivity) / 8));
      py = Math.max(-1, Math.min(1, (state.tiltY * state.sensitivity) / 45));
    }
    els.padDot.style.left = (50 + px * 48) + "%";
    els.padDot.style.top = (50 - py * 48) + "%";
  }

  function bindControls() {
    els.powerBtn.addEventListener("click", onPowerButton);
    els.calibrateBtn.addEventListener("click", calibrate);

    const fmtRate = (v) => (v >= 90 ? "速い" : v <= 15 ? "遅い" : String(v));
    els.sens.addEventListener("input", () => {
      state.sensitivity = parseFloat(els.sens.value);
      els.sensVal.textContent = state.sensitivity.toFixed(2);
      updateFrequency(false);
      saveSettings();
    });
    els.rate.addEventListener("input", () => {
      state.rate = parseInt(els.rate.value, 10);
      els.rateVal.textContent = fmtRate(state.rate);
      saveSettings();
    });
    els.range.addEventListener("input", () => {
      state.rangeSemis = parseInt(els.range.value, 10);
      els.rangeVal.textContent = state.rangeSemis;
      updateFrequency(false);
      saveSettings();
    });
    els.bri.addEventListener("input", () => {
      state.brightness = parseInt(els.bri.value, 10);
      els.briVal.textContent = Math.round(state.brightness / 1000) + "k";
      updateFrequency(false);
      saveSettings();
    });
    els.vib.addEventListener("input", () => {
      state.vibrato = parseInt(els.vib.value, 10);
      els.vibVal.textContent = state.vibrato;
      if (lfoGain && ctx) lfoGain.gain.setTargetAtTime(vibratoCents(), ctx.currentTime, 0.05);
      saveSettings();
    });
    els.echo.addEventListener("input", () => {
      state.echo = parseInt(els.echo.value, 10);
      els.echoVal.textContent = state.echo;
      if (wet && ctx) wet.gain.setTargetAtTime(echoWet(), ctx.currentTime, 0.05);
      saveSettings();
    });
    els.root.addEventListener("change", () => {
      state.root = parseInt(els.root.value, 10);
      updateFrequency(false);
      saveSettings();
    });
    els.vol.addEventListener("input", () => {
      state.volume = parseInt(els.vol.value, 10) / 100;
      els.volVal.textContent = Math.round(state.volume * 100);
      if (master && ctx) master.gain.setTargetAtTime(state.volume, ctx.currentTime, 0.02);
      saveSettings();
    });
    els.scale.addEventListener("change", () => {
      state.scale = els.scale.value;
      updateFrequency(false);
      saveSettings();
    });
    els.shake.addEventListener("change", () => {
      state.shake = els.shake.checked;
      saveSettings();
      if (state.shake) showToast("振ると「びよよーん」がON");
    });
    els.shakeSens.addEventListener("input", () => {
      state.shakeSens = parseInt(els.shakeSens.value, 10);
      els.shakeSensVal.textContent = state.shakeSens;
      saveSettings();
    });
    els.autoHold.addEventListener("change", () => {
      state.autoHold = els.autoHold.checked;
      holdSuppressed = false;
      saveSettings();
      showToast(state.autoHold ? "持つと鳴る：ON" : "持つと鳴る：OFF");
    });

    // settings sheet
    els.settingsBtn.addEventListener("click", openSettings);
    els.settingsClose.addEventListener("click", closeSettings);
    els.sheetBackdrop.addEventListener("click", closeSettings);

    // share
    els.shareBtn.addEventListener("click", shareApp);
    els.copyBtn.addEventListener("click", copyLink);

    // Stop the sound when the screen dims / locks or the app is backgrounded
    // (otherwise Android keeps playing forever while idle).
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && state.running) {
        stop();
        if (ctx) { try { ctx.suspend(); } catch (e) { /* noop */ } }
      }
    });
    window.addEventListener("pagehide", () => { if (state.running) stop(); });
    window.addEventListener("blur", () => {
      // covers cases where the display sleeps without a visibility change
      if (document.hidden && state.running) stop();
    });
  }

  function openSettings() {
    els.settings.hidden = false;
    document.body.classList.add("settings-open");
  }
  function closeSettings() {
    els.settings.hidden = true;
    document.body.classList.remove("settings-open");
  }

  // ---------- Share / QR ----------
  function appUrl() {
    // canonical URL without hash/query
    return location.origin + location.pathname;
  }

  async function shareApp() {
    const url = appUrl();
    const data = { title: "Kakudo Synth · 傾きシンセ", text: "スマホを傾けて音を奏でるシンセ", url };
    if (navigator.share) {
      try { await navigator.share(data); return; } catch (e) { /* cancelled */ return; }
    }
    copyLink();
  }

  async function copyLink() {
    const url = appUrl();
    try {
      await navigator.clipboard.writeText(url);
      showToast("リンクをコピーしました");
    } catch (e) {
      showToast(url);
    }
  }

  function renderQR() {
    const url = appUrl();
    els.shareUrl.textContent = url;
    if (typeof window.qrcode !== "function") return;
    try {
      const qr = window.qrcode(0, "M"); // auto type, medium ECC
      qr.addData(url);
      qr.make();
      els.qrcode.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
      const svg = els.qrcode.querySelector("svg");
      if (svg) {
        svg.removeAttribute("width");
        svg.removeAttribute("height");
      }
    } catch (e) {
      els.qrcode.textContent = "QRコードを生成できませんでした";
    }
  }

  function syncControlLabels() {
    els.sens.value = state.sensitivity;
    els.sensVal.textContent = state.sensitivity.toFixed(2);
    els.rate.value = state.rate;
    els.rateVal.textContent = state.rate >= 90 ? "速い" : state.rate <= 15 ? "遅い" : String(state.rate);
    els.range.value = state.rangeSemis;
    els.rangeVal.textContent = state.rangeSemis;
    els.bri.value = state.brightness;
    els.briVal.textContent = Math.round(state.brightness / 1000) + "k";
    els.vib.value = state.vibrato;
    els.vibVal.textContent = state.vibrato;
    els.echo.value = state.echo;
    els.echoVal.textContent = state.echo;
    els.vol.value = Math.round(state.volume * 100);
    els.volVal.textContent = Math.round(state.volume * 100);
    els.root.value = state.root;
    els.scale.value = state.scale;
    els.shake.checked = state.shake;
    els.shakeSens.value = state.shakeSens;
    els.shakeSensVal.textContent = state.shakeSens;
    els.autoHold.checked = state.autoHold;
  }

  let toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (els.toast.hidden = true), 1800);
  }

  async function start() {
    // Do this FIRST, synchronously, while we still have the tap gesture,
    // so Android hides its navigation bar (fullscreen) and locks portrait.
    tryFullscreen();

    ensureContext();
    if (ctx.state === "suspended") await ctx.resume();

    const granted = await requestOrientationPermission();
    if (granted) {
      window.addEventListener("deviceorientation", onOrientation, true);
    } else {
      els.permHint.textContent = "センサーが許可されませんでした。パッドを指で操作できます。";
    }

    // motion (shake -> boing); separate permission on iOS
    if (await requestMotionPermission()) {
      window.addEventListener("devicemotion", onMotion, true);
    }

    els.overlay.classList.add("hidden");
    els.app.hidden = false;

    enablePadDrag();
    play();

    setTimeout(() => {
      if (!state.haveOrientation) {
        showToast("傾きセンサーが無い端末はパッドを指でドラッグ");
      }
    }, 1500);
  }

  function enablePadDrag() {
    let dragging = false;
    const setFromPointer = (clientX, clientY) => {
      const r = els.pad.getBoundingClientRect();
      const nx = (clientX - r.left) / r.width;
      const ny = (clientY - r.top) / r.height;
      state.tiltX = ((nx * 2 - 1) * 8) / state.sensitivity;
      state.tiltY = ((1 - ny * 2) * 45) / state.sensitivity;
      updateFrequency(false);
    };
    const down = (e) => {
      if (state.haveOrientation) return;
      dragging = true;
      const p = e.touches ? e.touches[0] : e;
      setFromPointer(p.clientX, p.clientY);
    };
    const move = (e) => {
      if (!dragging) return;
      const p = e.touches ? e.touches[0] : e;
      setFromPointer(p.clientX, p.clientY);
      e.preventDefault();
    };
    const up = () => (dragging = false);
    els.pad.addEventListener("pointerdown", down);
    els.pad.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // ---------- Boot ----------
  function init() {
    cacheEls();
    loadSettings();
    buildModePicker();
    buildVoicePicker();
    bindControls();
    syncControlLabels();
    renderQR();
    els.startBtn.addEventListener("click", start);

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch(() => {});
      });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
