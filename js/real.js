'use strict';
// Real-case adapter: loads a de-identified case exported by tools/export_case.py
// (vessel-aligned HU + label stacks) and exposes the same interface the
// renderer, scorer and tree locator use for synthetic Vessel objects.
//
// Stack layout: [nS, size, size] with pixel (y, x) at offset a = (x - c) * pitch
// along the frame normal N and b = (c - y) * pitch along binormal B.

const Real = (() => {
  const cache = {};

  async function loadIndex(base = 'cases') {
    try {
      const r = await fetch(`${base}/index.json`, { cache: 'no-cache' });
      if (!r.ok) return [];
      return (await r.json()).cases || [];
    } catch (e) { return []; }
  }

  async function loadCase(id, base = 'cases') {
    if (cache[id]) return cache[id];
    const dir = `${base}/${id}`;
    const [meta, truth] = await Promise.all([
      fetch(`${dir}/case.json`, { cache: 'no-cache' }).then(r => r.json()),
      fetch(`${dir}/truth.json`, { cache: 'no-cache' }).then(r => r.json()),
    ]);
    // Vessels are created from metadata immediately; their image data loads lazily on first open.
    const vessels = {};
    for (const key of meta.order) {
      const m = meta.vessels[key];
      const v = makeVessel(key, m, truth[key]);
      v.loaded = false;
      let loading = null;
      v.load = () => loading || (loading = (async () => {
        const [hb, lb, wb] = await Promise.all([
          m.hu8 ? fetch(`${dir}/${key}.hu8.bin`).then(r => r.arrayBuffer()) : fetch(`${dir}/${key}.hu.bin`).then(r => r.arrayBuffer()),
          fetch(`${dir}/${key}.lbl.bin`).then(r => r.arrayBuffer()),
          m.wide ? fetch(`${dir}/${key}.wide.bin`).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null) : Promise.resolve(null),
        ]);
        v.attach(m.hu8 ? new Uint8Array(hb) : new Int16Array(hb), new Uint8Array(lb), wb ? new Uint8Array(wb) : null);
        v.loaded = true;
      })());
      vessels[key] = v;
    }
    let aorta = meta.aorta;
    if (aorta) {
      // Keep only the root + first ~28 mm of ascending aorta so it does not dwarf the tree.
      const z0 = aorta.pts[0][2];
      const pts = aorta.pts.filter(p => p[2] - z0 <= 28);
      aorta = { pts: pts.length >= 2 ? pts : aorta.pts.slice(0, 2), r: aorta.r };
    }
    if (!aorta) {
      // Older exports: synthesize a root stub above the proximal vessel origins.
      const starts = meta.order.map(k => vessels[k].cl.P[0]);
      const c = starts.reduce((a, p) => [a[0] + p[0] / starts.length, a[1] + p[1] / starts.length, a[2] + p[2] / starts.length], [0, 0, 0]);
      aorta = { pts: [[c[0], c[1], c[2] - 2], [c[0] - 2, c[1] + 2, c[2] + 10], [c[0] - 5, c[1] + 4, c[2] + 22]], r: 14 };
    }
    // Surface meshes (float32 verts then uint32 faces) for the 3-D locator.
    let meshes = null;
    if (meta.meshes && meta.meshes.length) {
      meshes = await Promise.all(meta.meshes.map(async m => {
        try {
          const buf = await fetch(`${dir}/mesh_${m.name}.bin`).then(r => r.ok ? r.arrayBuffer() : null);
          if (!buf) return null;
          return { name: m.name, color: parseInt(m.color, 16), verts: new Float32Array(buf, 0, m.nv * 3), faces: new Uint32Array(buf, m.nv * 12, m.nf * 3) };
        } catch (e) { return null; }
      }));
      meshes = meshes.filter(Boolean);
    }
    const tree = { id, seed: 0, difficulty: meta.difficulty || 'medium', vessels, order: meta.order, real: true, aorta, meshes };
    cache[id] = tree;
    return tree;
  }

  function makeVessel(key, m, truth) {
    const { nS, size: S, pitch, step, length } = m;
    let hu = null, lbl = null, wide = null;
    const hu8 = m.hu8 || null;            // 8-bit HU stack: HU = v * scale + lo
    // Wide curved reformats: [na, nS, nt] uint8, lateral t in mm from the centreline, angle index by phi.
    const W = m.wide || null;
    function sampleWide(s, d, phi) {
      if (!wide) return -1000;
      const na = W.na, nt = W.nt;
      let a = Math.round(phi / (2 * Math.PI) * na); a = ((a % na) + na) % na;
      const n = Math.max(0, Math.min(nS - 1, Math.round(s / step)));
      let x = d / W.pitch + (nt - 1) / 2;
      x = Math.max(0, Math.min(nt - 1, x));
      const x0 = Math.floor(x), x1 = Math.min(nt - 1, x0 + 1), f = x - x0;
      const base = (a * nS + n) * nt;
      const v = wide[base + x0] * (1 - f) + wide[base + x1] * f;
      return v * W.scale + W.lo;
    }
    const c = (S - 1) / 2;
    // Centerline (subsampled every 4 steps in export) -> dense table for the locator.
    const P = [];
    const cl = m.centerline;
    for (let i = 0; i < nS; i++) {
      const t = i / 4, j = Math.min(cl.length - 1, Math.floor(t)), f = t - j, k = Math.min(cl.length - 1, j + 1);
      P.push([0, 1, 2].map(d => cl[j][d] + (cl[k][d] - cl[j][d]) * f));
    }
    const refDiam = truth.refDiam, lumenDiam = truth.lumenDiam;
    const at = (arr, s) => { const i = Math.max(0, Math.min(arr.length - 1, Math.round(s / step))); return arr[i]; };
    const lesions = truth.lesions.map(L => Object.assign({}, L));
    const worst = lesions.reduce((a, b) => (!a || b.diamStenosis > a.diamStenosis) ? b : a, null);

    // Bilinear sample of a stack at (s, a, b).
    function sampleStack(arr, s, a, b) {
      if (!arr) return -1000;
      const n = Math.max(0, Math.min(nS - 1, Math.round(s / step)));
      // Clamp to the stack edge so the CPR never shows black beyond the exported field.
      const x = Math.max(0, Math.min(S - 1, a / pitch + c)), y = Math.max(0, Math.min(S - 1, c - b / pitch));
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const x1 = Math.min(S - 1, x0 + 1), y1 = Math.min(S - 1, y0 + 1);
      const base = n * S * S;
      const v00 = arr[base + y0 * S + x0], v10 = arr[base + y0 * S + x1], v01 = arr[base + y1 * S + x0], v11 = arr[base + y1 * S + x1];
      const v = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
      return hu8 ? v * hu8.scale + hu8.lo : v;
    }
    function labelAt(s, a, b) {
      if (!lbl) return -1;
      const n = Math.max(0, Math.min(nS - 1, Math.round(s / step)));
      const x = Math.round(a / pitch + c), y = Math.round(c - b / pitch);
      if (x < 0 || y < 0 || x >= S || y >= S) return -1;
      const l = lbl[n * S * S + y * S + x];
      return l === 0 ? -1 : l;
    }

    const v = {
      key, isReal: true, traced: !!m.traced, segKey: key, segName: key, length, r0: (refDiam[0] || 3) / 2, r1: (refDiam[refDiam.length - 1] || 2) / 2,
      cl: { P, step, length }, branches: [], difficulty: 'real', lumenHU: m.lumenHU,
      segments: m.segments,
      truth: { lesions, vesselCadRads: worst ? worst.cadRads : '0', worstLesionId: worst ? worst.id : null },
      refRadius: s => at(refDiam, s) / 2,
      lumenRadius: (s) => at(lumenDiam, s) / 2,
      outerRadius: (s) => at(lumenDiam, s) / 2 + 0.6,
      // Real sampler used by Render: returns [hu, cls] for a point (s, a, b) in the vessel frame.
      sampleReal: (s, a, b) => [sampleStack(hu, s, a, b), labelAt(s, a, b)],
      // Signed lateral sample along angle phi (d may be negative) from the wide curved reformats.
      sampleWide: W ? (s, d, phi) => [sampleWide(s, d, phi), Math.abs(d) <= (S / 2 - 1) * pitch ? labelAt(s, d * Math.cos(phi), d * Math.sin(phi)) : -1] : null,
      wideHalf: W ? (W.nt - 1) / 2 * W.pitch : 0,
      maxR: (S / 2 - 1) * pitch * 0.98,
      attach: (h, l, w) => { hu = h; lbl = l; wide = w; },
    };
    return v;
  }

  function invalidate(id) { delete cache[id]; }
  return { loadIndex, loadCase, invalidate };
})();
