'use strict';
// Coronary tree for one case: five vessels with anatomically arranged 3D
// centerlines (patient coords, mm: x = left, y = anterior, z = superior,
// aortic root at origin), each backed by a Vessel model with its own lesions.
// Also draws the mini 3D locator.

const Tree = (() => {
  const ORDER = ['LAD', 'D1', 'LCX', 'OM1', 'RCA'];
  // Nominal control points. Branch first point is replaced by the parent's point at `at`.
  const NOMINAL = {
    LAD: { pts: [[14, 6, -4], [22, 20, -12], [28, 30, -28], [30, 34, -48], [28, 32, -68], [20, 26, -85], [12, 18, -97]] },
    D1:  { parent: 'LAD', at: 0.28, pts: [[0, 0, 0], [40, 28, -35], [50, 22, -50], [55, 14, -64]] },
    LCX: { pts: [[14, 6, -4], [26, 0, -8], [38, -10, -14], [46, -22, -22], [48, -34, -34], [44, -42, -48], [36, -46, -62]] },
    OM1: { parent: 'LCX', at: 0.35, pts: [[0, 0, 0], [54, -12, -34], [58, -8, -52], [54, -4, -70]] },
    RCA: { pts: [[-4, 6, -2], [-18, 14, -8], [-30, 10, -20], [-38, 0, -34], [-40, -12, -48], [-34, -26, -60], [-20, -36, -68], [-4, -40, -74]] },
  };
  const LESIONS_PER_CASE = { easy: [1, 2], medium: [2, 4], hard: [4, 6] };

  function catmullRom(ctrl, step) {
    const out = [];
    const P = [ctrl[0], ...ctrl, ctrl[ctrl.length - 1]];
    for (let i = 1; i < P.length - 2; i++) {
      const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
      const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
      const n = Math.max(2, Math.round(segLen / step));
      for (let k = 0; k < n; k++) {
        const t = k / n, t2 = t * t, t3 = t2 * t;
        out.push([0, 1, 2].map(c => 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3)));
      }
    }
    out.push(ctrl[ctrl.length - 1]);
    return out;
  }

  function create(seed, difficulty) {
    const rand = RNG.mulberry32(seed ^ 0x9e3779b9);
    const jitter = () => (rand() - 0.5) * 7;
    const vessels = {}, pts = {};
    for (const key of ORDER) {
      const nom = NOMINAL[key];
      const ctrl = nom.pts.map(p => [p[0] + jitter(), p[1] + jitter(), p[2] + jitter()]);
      if (nom.parent) {
        const par = pts[nom.parent];
        ctrl[0] = par[Math.floor(nom.at * (par.length - 1))].slice();
      }
      pts[key] = catmullRom(ctrl, 0.5);
    }
    // Distribute lesions across vessels.
    const [lo, hi] = LESIONS_PER_CASE[difficulty] || LESIONS_PER_CASE.medium;
    const total = lo + Math.floor(rand() * (hi - lo + 1));
    const counts = Object.fromEntries(ORDER.map(k => [k, 0]));
    const weights = { LAD: 3, LCX: 2, RCA: 3, D1: 1, OM1: 1 };
    for (let i = 0; i < total; i++) {
      let r = rand() * 10; for (const k of ORDER) { r -= weights[k]; if (r <= 0) { counts[k]++; break; } }
    }
    for (const key of ORDER) {
      vessels[key] = Vessel.create({
        seed: (seed * 31 + ORDER.indexOf(key) * 7919) >>> 0, segment: key, difficulty,
        pts: pts[key], nLesions: Math.min(counts[key], key === 'D1' || key === 'OM1' ? 2 : 3), isBranch: key === 'D1' || key === 'OM1',
      });
      vessels[key].key = key;
    }
    // Aortic root / ascending aorta stub for the locator (mm, same frame as the vessels).
    const aorta = { pts: [[0, 0, -4], [-1, 1, 4], [-3, 3, 12], [-6, 4, 20], [-9, 5, 28]], r: 14 };
    return { seed, difficulty, vessels, order: ORDER, nLesions: total, aorta };
  }

  // --- Mini 3D locator -------------------------------------------------------
  function project(p, az, el) {
    const ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
    const x = p[0] * ca - p[1] * sa, y = p[0] * sa + p[1] * ca; // rotate about z
    const z = p[2];
    return [x, z * ce - y * se, z * se + y * ce]; // screen x, screen y (up), depth
  }

  // Shaded, depth-sorted tube rendering of the aortic root + coronary tree.
  function draw(canvas, tree, view) {
    const ctx = canvas.getContext('2d'); const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const bg = ctx.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w); bg.addColorStop(0, '#141920'); bg.addColorStop(1, '#07090c');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    const az = view.az, el = view.el;
    const aorta = tree.aorta || { pts: [[0, 0, -4], [-6, 4, 24]], r: 14 };
    // Fit all points (vessels + aorta).
    const all = [];
    for (const k of tree.order) for (const p of tree.vessels[k].cl.P) all.push(project(p, az, el));
    for (const p of aorta.pts) all.push(project(p, az, el));
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, mind = Infinity, maxd = -Infinity;
    for (const q of all) { minx = Math.min(minx, q[0]); maxx = Math.max(maxx, q[0]); miny = Math.min(miny, q[1]); maxy = Math.max(maxy, q[1]); mind = Math.min(mind, q[2]); maxd = Math.max(maxd, q[2]); }
    const pad = Math.max(10, aorta.r * 0.6);
    const sc = Math.min((w - 2 * pad) / (maxx - minx + aorta.r), (h - 2 * pad) / (maxy - miny + aorta.r));
    const ox = (w - (maxx - minx) * sc) / 2, oy = (h - (maxy - miny) * sc) / 2;
    // Mirrored horizontally (patient's left shown on the right).
    const X = q => w - ox - (q[0] - minx) * sc, Y = q => h - oy - (q[1] - miny) * sc;
    const shade = d => 0.45 + 0.55 * (d - mind) / Math.max(1e-6, maxd - mind); // nearer = brighter

    // Heart silhouette (shaded ellipsoid behind everything), centred on the vessel cloud.
    let cen = [0, 0, 0], n = 0;
    for (const k of tree.order) for (const p of tree.vessels[k].cl.P) { cen[0] += p[0]; cen[1] += p[1]; cen[2] += p[2]; n++; }
    cen = cen.map(c => c / Math.max(1, n));
    const hc = project([cen[0], cen[1] - 6, cen[2] - 8], az, el);
    const hg = ctx.createRadialGradient(X(hc) - 10 * sc, Y(hc) - 12 * sc, 4, X(hc), Y(hc), 52 * sc);
    hg.addColorStop(0, 'rgba(190,80,90,0.45)'); hg.addColorStop(1, 'rgba(90,30,40,0.15)');
    ctx.save(); ctx.translate(X(hc), Y(hc)); ctx.beginPath(); ctx.ellipse(0, 0, 46 * sc, 52 * sc, -0.25, 0, Math.PI * 2); ctx.restore();
    ctx.fillStyle = hg; ctx.fill();

    // Collect tube segments.
    const segs = [];
    const addTube = (pts, step, radiusAt, color, key) => {
      for (let i = 0; i < pts.length - step; i += step) {
        const a = project(pts[i], az, el), b = project(pts[Math.min(pts.length - 1, i + step)], az, el);
        segs.push({ a, b, d: (a[2] + b[2]) / 2, r: radiusAt(i), color, key });
      }
    };
    addTube(aorta.pts, 1, () => aorta.r, [235, 150, 150], 'AO');
    for (const k of tree.order) {
      const v = tree.vessels[k];
      const col = k === view.current ? [255, 95, 95] : [205, 110, 110];
      addTube(v.cl.P, 4, i => v.refRadius(i * v.cl.step) * (k === view.current ? 1.25 : 1), col, k);
    }
    segs.sort((p, q) => p.d - q.d);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of segs) {
      const t = shade(s.d), [r, g, b] = s.color;
      const wpx = Math.max(1.6, s.r * 2 * sc);
      // dark rim then lit core -> cylindrical look
      ctx.strokeStyle = `rgba(${r * 0.35 | 0},${g * 0.25 | 0},${b * 0.25 | 0},${s.key === 'AO' ? 0.9 : 0.8})`; ctx.lineWidth = wpx + 1.5;
      ctx.beginPath(); ctx.moveTo(X(s.a), Y(s.a)); ctx.lineTo(X(s.b), Y(s.b)); ctx.stroke();
      ctx.strokeStyle = `rgb(${Math.min(255, r * t) | 0},${Math.min(255, g * t) | 0},${Math.min(255, b * t) | 0})`; ctx.lineWidth = wpx;
      ctx.beginPath(); ctx.moveTo(X(s.a), Y(s.a)); ctx.lineTo(X(s.b), Y(s.b)); ctx.stroke();
      if (wpx > 4) { // specular highlight
        ctx.strokeStyle = `rgba(255,255,255,${0.18 * t})`; ctx.lineWidth = wpx * 0.3;
        ctx.beginPath(); ctx.moveTo(X(s.a) - wpx * 0.2, Y(s.a) - wpx * 0.2); ctx.lineTo(X(s.b) - wpx * 0.2, Y(s.b) - wpx * 0.2); ctx.stroke();
      }
    }
    // Labels, lesions, cursor on top.
    ctx.font = '10px system-ui';
    const ao = project(aorta.pts[aorta.pts.length - 1], az, el);
    ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillText('Ao', X(ao) - 6, Y(ao) - aorta.r * sc - 2);
    for (const k of tree.order) {
      const v = tree.vessels[k], sel = k === view.current;
      if (view.reveal) for (const L of v.truth.lesions) {
        const q = project(v.cl.P[Math.min(v.cl.P.length - 1, Math.round(L.s0 / v.cl.step))], az, el);
        ctx.fillStyle = L.diamStenosis >= 0.7 ? '#ff3030' : L.diamStenosis >= 0.5 ? '#ffa030' : '#ffe040';
        ctx.beginPath(); ctx.arc(X(q), Y(q), 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
      }
      const q0 = project(v.cl.P[Math.round(v.cl.P.length * 0.6)], az, el);
      ctx.fillStyle = sel ? '#fff' : 'rgba(255,255,255,0.65)'; ctx.font = `${sel ? 'bold ' : ''}10px system-ui`;
      ctx.fillText(k, X(q0) + 5, Y(q0) - 4);
    }
    if (view.current) {
      const v = tree.vessels[view.current];
      const q = project(v.cl.P[Math.min(v.cl.P.length - 1, Math.round(view.sPos / v.cl.step))], az, el);
      ctx.strokeStyle = '#3b9eff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X(q), Y(q), 6, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#3b9eff'; ctx.beginPath(); ctx.arc(X(q), Y(q), 2.2, 0, Math.PI * 2); ctx.fill();
    }
  }

  return { create, draw, ORDER };
})();
