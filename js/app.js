/* Kakudo Synth — tilt-controlled Web Audio synthesizer PWA
 *
 * Hold the phone face-down and roughly level. Tilting left/right (gamma) sweeps
 * the pitch; tilting front/back (beta) sweeps brightness (filter cutoff).
 * A calibration step captures the neutral posture so any hold angle works.
 */
(() => {
  "use strict";

  // ---------- Voice / preset definitions ----------
  // Each preset builds its own graph from a shared output gain and filter.
  const VOICES = {
    sine:   { label: "サイン",   emoji: "〰️", type: "sine",     detune: 0,  sub: false },
    warm:   { label: "ウォーム", emoji: "🟣", type: "triangle", detune: 0,  sub: true  },
    square: { label: "スクエア", emoji: "⬛", type: "square",   detune: 0,  sub: false },
    saw:    { label: "ノコギリ", emoji: "🔺", type: "sawtooth", detune: 0,  sub: false },
    super:  { label: "スーパー", emoji: "🌈", type: "supersaw", detune: 14, sub: false },
    fm:     { label: "ベル(FM)", emoji: "🔔", type: "fm",       detune: 0,  sub: false },
  };
  const VOICE_ORDER = ["sine", "warm", "square", "saw", "super", "fm"];

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

  // ---------- State ----------
  const state = {
    running: false,
    voice: "super",
    sensitivity: 1.4,
    rate: 55,        // 0..100 -> smoothing time
    rangeSemis: 19,  // total pitch swing in semitones
    brightness: 6000,
    volume: 0.7,
    quantize: true,
    scale: "pentatonic",
    centerBeta: null,
    centerGamma: null,
    // live tilt (deg, relative to center)
    tiltX: 0, // gamma -> pitch
    tiltY: 0, // beta -> brightness
    haveOrientation: false,
  };

  // ---------- Audio graph ----------
  let ctx = null;
  let master = null;   // master gain (volume)
  let filter = null;   // lowpass for brightness
  let voiceGain = null; // per-voice gain envelope
  let nodes = [];      // oscillators/gains for current voice, to stop on change

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
    voiceGain.connect(filter);
    filter.connect(master);
    master.connect(ctx.destination);
  }

  // time constant for setTargetAtTime, from rate slider (higher = faster)
  function smoothTime() {
    const t = state.rate / 100; // 0..1
    // rate 0 -> ~0.4s glide (slow), rate 100 -> ~0.01s (snappy)
    return 0.4 * Math.pow(0.025, t);
  }

  function buildVoice() {
    stopVoiceNodes();
    const def = VOICES[state.voice];
    const now = ctx.currentTime;
    const freq = currentFreq();

    if (def.type === "fm") {
      // simple 2-op FM: modulator -> carrier.frequency
      const carrier = ctx.createOscillator();
      carrier.type = "sine";
      carrier.frequency.value = freq;
      const mod = ctx.createOscillator();
      mod.type = "sine";
      mod.frequency.value = freq * 2; // harmonic ratio
      const modGain = ctx.createGain();
      modGain.gain.value = freq * 3; // modulation index
      mod.connect(modGain);
      modGain.connect(carrier.frequency);
      carrier.connect(voiceGain);
      carrier.start(now);
      mod.start(now);
      nodes = [carrier, mod, modGain];
      nodes.fmCarrier = carrier;
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

  function currentFreq() {
    // tiltX (deg) * sensitivity -> position within pitch range
    const half = state.rangeSemis / 2;
    let semis = (state.tiltX * state.sensitivity) / 8 * half;
    semis = Math.max(-half, Math.min(half, semis));
    if (state.quantize) {
      semis = quantizeSemis(semis);
    }
    return BASE_FREQ * Math.pow(2, semis / 12);
  }

  function quantizeSemis(semis) {
    const scale = SCALES[state.scale];
    const rounded = Math.round(semis);
    const octave = Math.floor(rounded / 12);
    const within = ((rounded % 12) + 12) % 12;
    // snap `within` to nearest scale degree
    let best = scale[0];
    let bestD = 99;
    for (const s of scale) {
      const d = Math.abs(s - within);
      if (d < bestD) { bestD = d; best = s; }
    }
    return octave * 12 + best;
  }

  function updateFrequency(immediate) {
    if (!ctx || !state.running) return;
    const freq = currentFreq();
    const now = ctx.currentTime;
    const tc = immediate ? 0.005 : smoothTime();
    const def = VOICES[state.voice];

    nodes.forEach((n) => {
      if (n.frequency && n.type !== undefined && n !== nodes.fmMod && n !== nodes.sub) {
        // oscillators (carrier / saws / main). fmMod & sub handled below.
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

    // brightness from tiltY
    const half = 1;
    let by = (state.tiltY * state.sensitivity) / 45; // -1..1-ish
    by = Math.max(-half, Math.min(half, by));
    const norm = (by + 1) / 2; // 0..1
    const minF = 220;
    const cutoff = minF + norm * (state.brightness - minF);
    filter.frequency.setTargetAtTime(Math.max(minF, cutoff), now, tc);

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

  function toggle() {
    if (state.running) stop();
    else play();
  }

  // ---------- Orientation ----------
  function onOrientation(e) {
    if (e.beta === null || e.gamma === null) return;
    state.haveOrientation = true;
    if (state.centerBeta === null) {
      state.centerBeta = e.beta;
      state.centerGamma = e.gamma;
    }
    // relative tilt, with wrap handling for beta
    let dBeta = e.beta - state.centerBeta;
    let dGamma = e.gamma - state.centerGamma;
    if (dBeta > 180) dBeta -= 360;
    if (dBeta < -180) dBeta += 360;
    state.tiltX = dGamma; // left/right -> pitch
    state.tiltY = dBeta;  // front/back -> brightness
    updateFrequency(false);
  }

  function calibrate() {
    state.centerBeta = null;
    state.centerGamma = null;
    state.tiltX = 0;
    state.tiltY = 0;
    updatePadDot();
    showToast("中央にセットしました");
  }

  async function requestOrientationPermission() {
    const D = window.DeviceOrientationEvent;
    if (D && typeof D.requestPermission === "function") {
      try {
        const res = await D.requestPermission();
        return res === "granted";
      } catch (e) {
        return false;
      }
    }
    return true; // Android / desktop: no explicit permission needed
  }

  // ---------- UI wiring ----------
  const els = {};
  function cacheEls() {
    [
      "overlay", "startBtn", "permHint", "app", "powerBtn", "pad", "padDot",
      "noteReadout", "freqReadout", "voicePicker", "sens", "sensVal", "rate",
      "rateVal", "range", "rangeVal", "bri", "briVal", "vol", "volVal",
      "quantize", "scale", "calibrateBtn", "toast",
    ].forEach((id) => (els[id] = document.getElementById(id)));
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
  }

  function updateReadout(freq) {
    els.freqReadout.textContent = Math.round(freq) + " Hz";
    const midi = Math.round(69 + 12 * Math.log2(freq / 440));
    const name = NOTE_NAMES[((midi % 12) + 12) % 12];
    const oct = Math.floor(midi / 12) - 1;
    els.noteReadout.textContent = name + oct;
  }

  function updatePadDot() {
    // map tilt to 0..100% of pad
    const half = state.rangeSemis / 2;
    let px = (state.tiltX * state.sensitivity) / 8 * half; // semis
    px = Math.max(-half, Math.min(half, px)) / half; // -1..1
    let py = (state.tiltY * state.sensitivity) / 45;
    py = Math.max(-1, Math.min(1, py));
    const left = 50 + px * 48;
    const top = 50 - py * 48; // tilt forward (positive beta) -> up = brighter
    els.padDot.style.left = left + "%";
    els.padDot.style.top = top + "%";
  }

  function bindControls() {
    els.powerBtn.addEventListener("click", toggle);
    els.calibrateBtn.addEventListener("click", calibrate);

    const fmtRate = (v) => (v >= 90 ? "速い" : v <= 15 ? "遅い" : v + "");
    els.sens.addEventListener("input", () => {
      state.sensitivity = parseFloat(els.sens.value);
      els.sensVal.textContent = state.sensitivity.toFixed(2);
      updateFrequency(false);
    });
    els.rate.addEventListener("input", () => {
      state.rate = parseInt(els.rate.value, 10);
      els.rateVal.textContent = fmtRate(state.rate);
    });
    els.range.addEventListener("input", () => {
      state.rangeSemis = parseInt(els.range.value, 10);
      els.rangeVal.textContent = state.rangeSemis;
      updateFrequency(false);
    });
    els.bri.addEventListener("input", () => {
      state.brightness = parseInt(els.bri.value, 10);
      els.briVal.textContent = Math.round(state.brightness / 1000) + "k";
      updateFrequency(false);
    });
    els.vol.addEventListener("input", () => {
      state.volume = parseInt(els.vol.value, 10) / 100;
      els.volVal.textContent = Math.round(state.volume * 100);
      if (master && ctx) master.gain.setTargetAtTime(state.volume, ctx.currentTime, 0.02);
    });
    els.quantize.addEventListener("change", () => {
      state.quantize = els.quantize.checked;
      updateFrequency(false);
    });
    els.scale.addEventListener("change", () => {
      state.scale = els.scale.value;
      updateFrequency(false);
    });
  }

  function syncControlLabels() {
    els.sens.value = state.sensitivity;
    els.sensVal.textContent = state.sensitivity.toFixed(2);
    els.rate.value = state.rate;
    els.rateVal.textContent = state.rate >= 90 ? "速い" : state.rate <= 15 ? "遅い" : state.rate + "";
    els.range.value = state.rangeSemis;
    els.rangeVal.textContent = state.rangeSemis;
    els.bri.value = state.brightness;
    els.briVal.textContent = Math.round(state.brightness / 1000) + "k";
    els.vol.value = Math.round(state.volume * 100);
    els.volVal.textContent = Math.round(state.volume * 100);
    els.quantize.checked = state.quantize;
    els.scale.value = state.scale;
  }

  let toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (els.toast.hidden = true), 1600);
  }

  async function start() {
    ensureContext();
    if (ctx.state === "suspended") await ctx.resume();

    const granted = await requestOrientationPermission();
    if (granted) {
      window.addEventListener("deviceorientation", onOrientation, true);
    } else {
      els.permHint.textContent = "センサーが許可されませんでした。タッチ操作は使えません。";
    }

    els.overlay.classList.add("hidden");
    els.app.hidden = false;

    // fallback for devices without orientation: let user drag the pad
    enablePadDrag();

    // auto-start sound
    play();

    // hint if no orientation data soon
    setTimeout(() => {
      if (!state.haveOrientation) {
        showToast("傾きセンサーが無い端末はパッドを指でドラッグ");
      }
    }, 1500);
  }

  // Pointer fallback: drag on the pad to set tilt (useful on desktop / no-sensor)
  function enablePadDrag() {
    let dragging = false;
    const setFromPointer = (clientX, clientY) => {
      const r = els.pad.getBoundingClientRect();
      const nx = (clientX - r.left) / r.width;  // 0..1
      const ny = (clientY - r.top) / r.height;  // 0..1
      // invert the pad-dot mapping (see updatePadDot)
      state.tiltX = ((nx * 2 - 1) * 8) / state.sensitivity;
      state.tiltY = ((1 - ny * 2) * 45) / state.sensitivity;
      updateFrequency(false);
    };
    const down = (e) => {
      if (state.haveOrientation) return; // sensor takes priority
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
    buildVoicePicker();
    bindControls();
    syncControlLabels();
    els.startBtn.addEventListener("click", start, { once: false });

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch(() => {});
      });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
