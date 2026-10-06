'use strict';
// CT-like rendering of a Vessel model into canvases.
//
// Three views share one sampler: every pixel is mapped to a point in the
// vessel's cylindrical frame (s, r, theta) and, for background, into world
// space, so rotating the vessel (phi) or scrolling the cross-section position
// (sPos) is just a change of the mapping. The tissue-class map produced
// alongside the HU map drives the ground-truth overlay.
//
// Performance: lumen/outer-wall radii are computed once per CPR column (or per
// angle bin for the cross-section) and only wall/plaque pixels go through the
// full tissue sampler. Noise uses one integer hash per pixel.

const Render = (() => {
  const T = Vessel.TISSUE;
  const OVERLAY = {
    [T.LUMEN]: [255, 60, 60],
    [T.NCP]:   [255, 214, 0],
    [T.LAP]:   [255, 120, 0],
    [T.CALC]:  [120, 220, 255],
  };
  const OVERLAY_ALPHA = 0.5;
  const NOISE_HU = 24;

  // --- World-space background: epicardial fat, myocardium, side branches ----
  function background(v, w) {
    const m = RNG.vnoise(w[0] * 0.04, w[1] * 0.05, w[2] * 0.05, v.bgSeed);
    const edge = w[1] * 0.08 + (m - 0.5) * 2.4;
    let hu;
    if (edge > 0.9) hu = Vessel.HU.MYO + 20 * (RNG.hash3(w[0] * 1.5 | 0, w[1] * 1.5 | 0, w[2] * 1.5 | 0, v.bgSeed + 1) - 0.5);
    else if (edge > 0.75) hu = Vessel.HU.FAT + (edge - 0.75) / 0.15 * (Vessel.HU.MYO - Vessel.HU.FAT);
    else {
      hu = Vessel.HU.FAT;
      const strand = RNG.vnoise(w[0] * 0.3, w[1] * 0.5, w[2] * 0.5, v.bgSeed + 3);
      if (strand > 0.82) hu += (strand - 0.82) / 0.18 * 120;
    }
    return hu;
  }

  function branchHU(v, w, sApprox) {
    for (const b of v.branches) {
      if (Math.abs(sApprox - b.s) > 22) continue;
      const i = Math.min(v.cl.P.length - 1, Math.max(0, Math.round(b.s / v.cl.step)));
      const P = v.cl.P[i], N = v.cl.N[i], B = v.cl.B[i], Tn = v.cl.T[i];
      const c = Math.cos(b.theta), sn = Math.sin(b.theta);
      let d = [N[0] * c + B[0] * sn + Tn[0] * (0.9 + b.dir), N[1] * c + B[1] * sn + Tn[1] * (0.9 + b.dir), N[2] * c + B[2] * sn + Tn[2] * (0.9 + b.dir)];
      const l = Math.hypot(d[0], d[1], d[2]); d = [d[0] / l, d[1] / l, d[2] / l];
      const rel = [w[0] - P[0], w[1] - P[1], w[2] - P[2]];
      const u = rel[0] * d[0] + rel[1] * d[1] + rel[2] * d[2];
      if (u < 0 || u > 20) continue;
      const perp = Math.hypot(rel[0] - u * d[0], rel[1] - u * d[1], rel[2] - u * d[2]);
      const rb = b.r * (1 - u / 30);
      if (perp < rb) return Vessel.HU.LUMEN - 20;
      if (perp < rb + 0.3) return Vessel.HU.WALL;
    }
    return null;
  }

  function frameAt(v, s) {
    const i = Math.min(v.cl.P.length - 1, Math.max(0, Math.round(s / v.cl.step)));
    return { P: v.cl.P[i], N: v.cl.N[i], B: v.cl.B[i] };
  }

  // Quantum mottle: one hash on 0.4 mm voxel grid; the 3x3 blur turns it into CT-like texture.
  function mottle(v, w) {
    return NOISE_HU * 3.4 * (RNG.hash3(Math.floor(w[0] * 2.5), Math.floor(w[1] * 2.5), Math.floor(w[2] * 2.5), v.bgSeed + 77) - 0.5);
  }

  // Core sampler with precomputed lumen/outer radii. Returns [hu, cls].
  function sampleHU(v, s, r, th, rl, ro, fr) {
    if (v.isReal) return v.sampleReal(s, r * Math.cos(th), r * Math.sin(th));
    const c = Math.cos(th) * r, sn = Math.sin(th) * r;
    const w = [fr.P[0] + fr.N[0] * c + fr.B[0] * sn, fr.P[1] + fr.N[1] * c + fr.B[1] * sn, fr.P[2] + fr.N[2] * c + fr.B[2] * sn];
    let hu, cls;
    if (r < rl) { hu = Vessel.HU.LUMEN - 35 * (s / v.length); cls = T.LUMEN; }
    else if (r >= ro) {
      const bh = branchHU(v, w, s);
      hu = bh != null ? bh : background(v, w);
      cls = -1;
    } else {
      const t = v.sampleTissue(s, r, th, rl, ro);
      hu = t.hu; cls = t.t;
    }
    return [hu + mottle(v, w), cls];
  }

  // --- Buffers ----------------------------------------------------------------
  function makeBuffers(wpx, hpx) {
    return { hu: new Float32Array(wpx * hpx), cls: new Int8Array(wpx * hpx), w: wpx, h: hpx };
  }
  function fill(buf, x, y, st, hu, cls) {
    const { w, h } = buf;
    for (let dy = 0; dy < st && y + dy < h; dy++) {
      const row = (y + dy) * w;
      for (let dx = 0; dx < st && x + dx < w; dx++) { buf.hu[row + x + dx] = hu; buf.cls[row + x + dx] = cls; }
    }
  }
  function blur(buf) {
    const { hu, w, h } = buf;
    const tmp = new Float32Array(hu.length), out = new Float32Array(hu.length);
    // separable [1 2 1]
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const l = hu[row + Math.max(0, x - 1)], c = hu[row + x], r = hu[row + Math.min(w - 1, x + 1)];
        tmp[row + x] = (l + 2 * c + r) * 0.25;
      }
    }
    for (let y = 0; y < h; y++) {
      const up = Math.max(0, y - 1) * w, row = y * w, dn = Math.min(h - 1, y + 1) * w;
      for (let x = 0; x < w; x++) out[row + x] = (tmp[up + x] + 2 * tmp[row + x] + tmp[dn + x]) * 0.25;
    }
    buf.hu = out;
  }
  function toImage(ctx, buf, wl, overlay) {
    const img = ctx.createImageData(buf.w, buf.h);
    const d = img.data;
    const lo = wl.level - wl.width / 2, k = 255 / wl.width;
    for (let i = 0; i < buf.hu.length; i++) {
      let g = (buf.hu[i] - lo) * k;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      let r = g, gg = g, b = g;
      if (overlay) {
        const c = OVERLAY[buf.cls[i]];
        if (c) { r = g * (1 - OVERLAY_ALPHA) + c[0] * OVERLAY_ALPHA; gg = g * (1 - OVERLAY_ALPHA) + c[1] * OVERLAY_ALPHA; b = g * (1 - OVERLAY_ALPHA) + c[2] * OVERLAY_ALPHA; }
      }
      const o = i * 4; d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  // --- CPRs: x -> s, y -> signed radial distance along phi ------------------
  // `centreOf(x)` gives the vessel-centre pixel row for column x (straight: constant).
  function renderCPR(v, canvas, state, centreOf) {
    const w = canvas.width, h = canvas.height;
    const scale = v.length / w;
    const buf = makeBuffers(w, h);
    const st = state.stride || 1;
    const phi = state.phi, phi2 = phi + Math.PI;
    for (let x = 0; x < w; x += st) {
      const s = (x + 0.5) * scale;
      const fr = v.isReal ? null : frameAt(v, s);
      const rl0 = v.lumenRadius(s, phi), ro0 = v.outerRadius(s, phi);
      const rl1 = v.lumenRadius(s, phi2), ro1 = v.outerRadius(s, phi2);
      const cy = centreOf(x);
      for (let y = 0; y < h; y += st) {
        const d = (y - cy + 0.5) * scale;
        const r = Math.abs(d);
        let res;
        if (v.isReal && v.sampleWide) res = v.sampleWide(s, d, phi);           // true curved reformat with surroundings
        else res = d >= 0 ? sampleHU(v, s, r, phi, rl0, ro0, fr) : sampleHU(v, s, r, phi2, rl1, ro1, fr);
        fill(buf, x, y, st, res[0], res[1]);
      }
    }
    if (st === 1) blur(buf);
    toImage(canvas.getContext('2d'), buf, state.wl, state.overlay);
    return { scale };
  }

  function straightCPR(v, canvas, state) {
    const h = canvas.height;
    return renderCPR(v, canvas, state, () => h / 2);
  }

  // Stretched CPR: centre deviates by the centerline displacement projected on
  // the viewing direction, so the reader sees true curvature at this rotation.
  function stretchedCPR(v, canvas, state) {
    const w = canvas.width, h = canvas.height;
    const scale = v.length / w;
    const cph = Math.cos(state.phi), sph = Math.sin(state.phi);
    const P0 = v.cl.P[0], PL = v.cl.P[v.cl.P.length - 1];
    // Mean axis of the vessel; curvature is shown as displacement perpendicular to it.
    let ax = [PL[0] - P0[0], PL[1] - P0[1], PL[2] - P0[2]];
    const al = Math.hypot(ax[0], ax[1], ax[2]) || 1; ax = ax.map(c => c / al);
    let u = Math.abs(ax[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const du = u[0] * ax[0] + u[1] * ax[1] + u[2] * ax[2]; u = u.map((c, i) => c - du * ax[i]);
    const ul = Math.hypot(u[0], u[1], u[2]) || 1; u = u.map(c => c / ul);
    const wv = [ax[1] * u[2] - ax[2] * u[1], ax[2] * u[0] - ax[0] * u[2], ax[0] * u[1] - ax[1] * u[0]];
    const centre = new Float32Array(w);
    let minC = Infinity, maxC = -Infinity;
    for (let x = 0; x < w; x++) {
      const s = (x + 0.5) * scale;
      const P = v.cl.P[Math.min(v.cl.P.length - 1, Math.round(s / v.cl.step))];
      const d = [P[0] - P0[0], P[1] - P0[1], P[2] - P0[2]];
      const pu = d[0] * u[0] + d[1] * u[1] + d[2] * u[2], pw = d[0] * wv[0] + d[1] * wv[1] + d[2] * wv[2];
      const off = pu * cph + pw * sph;
      centre[x] = off; if (off < minC) minC = off; if (off > maxC) maxC = off;
    }
    const span = maxC - minC;
    const fit = Math.min(1, (h * scale - 9) / Math.max(1e-3, span));
    const mid = (minC + maxC) / 2;
    return renderCPR(v, canvas, state, x => h / 2 + (centre[x] - mid) * fit / scale);
  }

  // --- Cross-section --------------------------------------------------------
  function crossSection(v, canvas, state) {
    const w = canvas.width, h = canvas.height;
    const fov = 9;
    const scale = fov / w;
    const buf = makeBuffers(w, h);
    const s = state.sPos;
    const st = state.stride || 1;
    const fr = v.isReal ? null : frameAt(v, s);
    const NB = 360;
    const RL = new Float32Array(NB), RO = new Float32Array(NB);
    for (let k = 0; k < NB; k++) { const th = k / NB * Math.PI * 2; RL[k] = v.lumenRadius(s, th); RO[k] = v.outerRadius(s, th); }
    const TWO_PI = Math.PI * 2;
    for (let y = 0; y < h; y += st) for (let x = 0; x < w; x += st) {
      const a = (x - w / 2 + 0.5) * scale, b = -(y - h / 2 + 0.5) * scale;
      const r = Math.hypot(a, b);
      // Rotate with the CPR: cross-section LEFT = CPR left edge (theta = phi).
      let th = Math.atan2(b, a) + state.phi + Math.PI;
      th = th - Math.floor(th / TWO_PI) * TWO_PI;
      const k = Math.floor(th / TWO_PI * NB) % NB;
      const res = sampleHU(v, s, r, th, RL[k], RO[k], fr);
      fill(buf, x, y, st, res[0], res[1]);
    }
    if (st === 1) blur(buf);
    toImage(canvas.getContext('2d'), buf, state.wl, state.overlay);
    return { scale, fov };
  }

  // --- Lumen profile chart (feedback) ---------------------------------------
  function lumenProfile(v, canvas, truth) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const pad = { l: 30, r: 8, t: 14, b: 18 };
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const maxD = 2 * v.r0 * 1.15;
    const X = s => pad.l + s / v.length * pw;
    const Y = d => pad.t + ph - d / maxD * ph;
    for (const L of truth.lesions) { ctx.fillStyle = 'rgba(255,214,0,0.12)'; ctx.fillRect(X(L.sStart), pad.t, X(L.sEnd) - X(L.sStart), ph); }
    for (const g of v.segments) { ctx.strokeStyle = '#333'; ctx.beginPath(); ctx.moveTo(X(g.s1), pad.t); ctx.lineTo(X(g.s1), pad.t + ph); ctx.stroke(); ctx.fillStyle = '#778'; ctx.font = '9px system-ui'; ctx.fillText(g.name, X(g.s0) + 3, pad.t + ph - 3); }
    ctx.strokeStyle = '#555'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, pad.t + ph); ctx.lineTo(w - pad.r, pad.t + ph); ctx.stroke();
    ctx.fillStyle = '#9aa'; ctx.font = '9px system-ui';
    for (let d = 0; d <= maxD; d += 1) ctx.fillText(d.toFixed(0), 8, Y(d) + 3);
    if (!v.segments) return;
    ctx.fillText('mm', 4, pad.t - 3);
    for (let s = 0; s <= v.length; s += 20) ctx.fillText(s.toFixed(0), X(s) - 5, h - 5);
    ctx.strokeStyle = '#6fa8dc'; ctx.setLineDash([4, 3]); ctx.beginPath();
    for (let s = 0; s <= v.length; s += 0.5) { const d = 2 * v.refRadius(s); s === 0 ? ctx.moveTo(X(s), Y(d)) : ctx.lineTo(X(s), Y(d)); }
    ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = '#ff5050'; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let s = 0; s <= v.length; s += 0.5) {
      let dmin = Infinity;
      for (let k = 0; k < 18; k++) { const th = k / 18 * Math.PI; dmin = Math.min(dmin, v.lumenRadius(s, th) + v.lumenRadius(s, th + Math.PI)); }
      s === 0 ? ctx.moveTo(X(s), Y(dmin)) : ctx.lineTo(X(s), Y(dmin));
    }
    ctx.stroke();
    ctx.fillStyle = '#6fa8dc'; ctx.fillText('reference diameter', w - 200, pad.t - 3);
    ctx.fillStyle = '#ff5050'; ctx.fillText('minimal lumen diameter', w - 105, pad.t - 3);
  }

  return { straightCPR, stretchedCPR, crossSection, lumenProfile, OVERLAY };
})();
