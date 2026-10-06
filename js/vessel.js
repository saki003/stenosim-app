'use strict';
// Procedural coronary artery model with lesion-level ground truth.
//
// A vessel is defined along its arc length s (mm). At each s we know:
//   - centerline position (3D, mm) and a local frame
//   - reference lumen radius (tapering, healthy)
//   - a list of lesions. Each lesion defines plaque occupying the space
//     between the true lumen boundary and the outer wall boundary, with
//     angular eccentricity, composition (calcified / non-calcified /
//     low-attenuation), and remodeling (outward growth of the outer wall).
//
// Everything downstream (renderer, scorer) queries this model through
// sampleTissue(s, r, theta) which returns a tissue class + HU for a point
// in the vessel-centric cylindrical frame. Because the same function drives
// every view, the images and the ground truth overlay are always consistent.

const Vessel = (() => {
  const TISSUE = {
    FAT: 0, MYO: 1, LUMEN: 2, WALL: 3, NCP: 4, LAP: 5, CALC: 6
  };

  const HU = {
    FAT: -85, MYO: 95, LUMEN: 380, WALL: 60, NCP: 85, LAP: 15, CALC: 750
  };

  const SEGMENTS = {
    LAD: { name: 'Left anterior descending (LAD)', length: 110, r0: 1.85, r1: 0.75 },
    LCX: { name: 'Left circumflex (LCX)', length: 85, r0: 1.7, r1: 0.8 },
    RCA: { name: 'Right coronary artery (RCA)', length: 120, r0: 1.9, r1: 0.9 },
    D1:  { name: 'First diagonal (D1)', length: 55, r0: 1.25, r1: 0.6 },
    OM1: { name: 'First obtuse marginal (OM1)', length: 55, r0: 1.3, r1: 0.6 },
  };

  function smoothstep(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // --- Centerline -----------------------------------------------------------
  // Sum of low-frequency sinusoids with per-vessel random phases. Returns a
  // table of points + Frenet-like frames, resampled at 0.25 mm.
  function buildCenterline(seg, rand, givenPts) {
    let pts;
    if (givenPts) {
      pts = givenPts;
    } else {
      const n = Math.round(seg.length / 0.25) + 1;
      const amp = [rand() * 9 + 4, rand() * 7 + 3, rand() * 3 + 1];
      const freq = [rand() * 0.8 + 0.6, rand() * 1.6 + 1.2, rand() * 3 + 2.5];
      const ph = [rand() * 6.28, rand() * 6.28, rand() * 6.28, rand() * 6.28];
      pts = [];
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const x = t * seg.length;
        const y = amp[0] * Math.sin(t * freq[0] * Math.PI + ph[0]) + amp[2] * Math.sin(t * freq[2] * Math.PI + ph[2]);
        const z = amp[1] * Math.sin(t * freq[1] * Math.PI + ph[1]) + amp[2] * 0.6 * Math.cos(t * freq[2] * Math.PI + ph[3]);
        pts.push([x, y, z]);
      }
    }
    const n = pts.length;
    // Re-parameterize by arc length.
    const arc = [0];
    for (let i = 1; i < n; i++) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
      arc.push(arc[i - 1] + d);
    }
    const total = arc[n - 1];
    const step = 0.25;
    const m = Math.floor(total / step) + 1;
    const P = [], T = [];
    let j = 0;
    for (let i = 0; i < m; i++) {
      const s = i * step;
      while (j < n - 2 && arc[j + 1] < s) j++;
      const f = (s - arc[j]) / Math.max(1e-6, arc[j + 1] - arc[j]);
      const p = [0, 1, 2].map(k => lerp(pts[j][k], pts[j + 1][k], f));
      P.push(p);
    }
    for (let i = 0; i < m; i++) {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(m - 1, i + 1)];
      const t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const l = Math.hypot(...t) || 1;
      T.push(t.map(v => v / l));
    }
    // Rotation-minimizing normal frames (parallel transport).
    const N = [], B = [];
    let n0 = [0, 1, 0];
    const d0 = n0[0] * T[0][0] + n0[1] * T[0][1] + n0[2] * T[0][2];
    n0 = n0.map((v, k) => v - d0 * T[0][k]);
    let ln = Math.hypot(...n0); n0 = n0.map(v => v / ln);
    N.push(n0);
    for (let i = 1; i < m; i++) {
      const prev = N[i - 1];
      const d = prev[0] * T[i][0] + prev[1] * T[i][1] + prev[2] * T[i][2];
      let nn = prev.map((v, k) => v - d * T[i][k]);
      const l = Math.hypot(...nn) || 1;
      N.push(nn.map(v => v / l));
    }
    for (let i = 0; i < m; i++) {
      const t = T[i], nn = N[i];
      B.push([t[1] * nn[2] - t[2] * nn[1], t[2] * nn[0] - t[0] * nn[2], t[0] * nn[1] - t[1] * nn[0]]);
    }
    return { P, T, N, B, length: (m - 1) * step, step };
  }

  // --- Lesion generation ----------------------------------------------------
  // Lesion parameters (all mm / degrees / fractions):
  //   s0            centre along vessel
  //   len           total length
  //   stenosis      true diameter stenosis fraction at the worst point (0..1)
  //   ecc           angular eccentricity 0 (concentric) .. 1 (fully eccentric)
  //   thetaC        angular centre of the plaque (rad)
  //   remodel       remodeling index (outer wall diam / reference), 1.0-1.5
  //   calcFrac      fraction of plaque volume that is calcified
  //   lapFrac       fraction that is low-attenuation (<30 HU)
  //   spotty        spotty calcification present (small calc foci <3 mm)
  //   napkin        napkin-ring sign (LAP core with peripheral higher rim)
  const DIFFICULTY = {
    easy:   { lesions: [1, 1], stenRange: [[0.0, 0.0], [0.30, 0.45], [0.55, 0.65], [0.75, 0.92]] },
    medium: { lesions: [1, 2], stenRange: [[0.08, 0.22], [0.26, 0.48], [0.50, 0.69], [0.70, 0.95]] },
    hard:   { lesions: [2, 3], stenRange: [[0.15, 0.24], [0.40, 0.49], [0.50, 0.58], [0.66, 0.74], [0.95, 1.0]] },
  };

  function makeLesion(rand, segLen, difficulty, idx, used) {
    const d = DIFFICULTY[difficulty];
    const rr = d.stenRange[Math.floor(rand() * d.stenRange.length)];
    const stenosis = lerp(rr[0], rr[1], rand());
    // Place lesion, avoiding overlap with others.
    let s0, len, tries = 0;
    do {
      len = 6 + rand() * 14;
      s0 = 8 + len / 2 + rand() * (segLen * 0.75 - len - 8);
      tries++;
    } while (tries < 40 && used.some(u => Math.abs(u.s0 - s0) < (u.len + len) / 2 + 4));
    used.push({ s0, len });

    const composition = rand();
    let calcFrac, lapFrac;
    if (composition < 0.3)       { calcFrac = 0.75 + rand() * 0.25; lapFrac = 0; }               // predominantly calcified
    else if (composition < 0.6)  { calcFrac = 0.2 + rand() * 0.4;  lapFrac = rand() * 0.2; }     // mixed
    else                         { calcFrac = rand() * 0.08;        lapFrac = rand() * 0.55; }   // non-calcified
    const occlusion = stenosis >= 0.99;
    if (occlusion) { calcFrac = Math.min(calcFrac, 0.4); }

    const spotty = calcFrac > 0.03 && calcFrac < 0.45 && rand() < 0.55;
    const napkin = lapFrac > 0.3 && rand() < 0.5;
    const remodel = stenosis < 0.05 ? 1 : lerp(0.95, 1.5, rand() * (lapFrac > 0.2 ? 1 : 0.6));
    const ecc = stenosis < 0.05 ? 0 : (rand() < 0.65 ? 0.55 + rand() * 0.45 : rand() * 0.4);

    return {
      id: idx + 1, s0, len, stenosis, ecc,
      thetaC: rand() * Math.PI * 2,
      remodel, calcFrac, lapFrac, spotty, napkin, occlusion,
      // Spotty calcium foci: small spheres placed within the plaque.
      spots: spotty ? Array.from({ length: 2 + Math.floor(rand() * 4) }, () => ({
        ds: (rand() - 0.5) * len * 0.7, dth: (rand() - 0.5) * 2.2, rr: rand(), size: 0.6 + rand() * 0.8
      })) : [],
      // Macro-calcification blobs (for mixed / calcified plaque).
      blobs: Array.from({ length: 1 + Math.floor(rand() * 3) }, () => ({
        ds: (rand() - 0.5) * len * 0.8, dth: (rand() - 0.5) * 1.6, rr: rand(), size: 0.4 + rand() * 0.6
      })),
      noiseSeed: Math.floor(rand() * 1e6),
    };
  }

  // --- Vessel assembly ------------------------------------------------------
  function create(opts) {
    const seed = opts.seed >>> 0;
    const rand = RNG.mulberry32(seed);
    const segKey = opts.segment || ['LAD', 'LCX', 'RCA', 'D1', 'OM1'][Math.floor(rand() * 5)];
    const seg = SEGMENTS[segKey];
    const cl = buildCenterline(seg, rand, opts.pts);
    const difficulty = opts.difficulty || 'medium';
    const d = DIFFICULTY[difficulty];
    const nLesions = opts.nLesions != null ? opts.nLesions :
      d.lesions[0] + Math.floor(rand() * (d.lesions[1] - d.lesions[0] + 1));
    const used = [];
    const lesions = [];
    for (let i = 0; i < nLesions; i++) lesions.push(makeLesion(rand, cl.length, difficulty, i, used));
    lesions.sort((a, b) => a.s0 - b.s0);
    lesions.forEach((l, i) => l.id = i + 1);
    // Normal-variant wiggle in the reference lumen (mild physiologic irregularity).
    const wiggleSeed = Math.floor(rand() * 1e6);
    // Side branches (visual only): small vessels leaving at random s.
    const branches = Array.from({ length: 2 + Math.floor(rand() * 3) }, () => ({
      s: 10 + rand() * (cl.length - 20), theta: rand() * Math.PI * 2, r: 0.45 + rand() * 0.45, dir: (rand() - 0.5) * 1.2
    })).filter(b => !lesions.some(l => Math.abs(b.s - l.s0) < l.len / 2 + 6));
    const v = {
      seed, segKey, segName: seg.name, cl, length: cl.length, lesions, branches, difficulty,
      r0: seg.r0, r1: seg.r1, wiggleSeed, bgSeed: Math.floor(rand() * 1e6),
    };
    v.refRadius = s => refRadius(v, s);
    v.sampleTissue = (s, r, th, rl, ro) => sampleTissue(v, s, r, th, rl, ro);
    v.lumenRadius = (s, th) => lumenRadius(v, s, th);
    v.outerRadius = (s, th) => outerRadius(v, s, th);
    v.truth = computeTruth(v);
    // Reporting segments: proximal / mid / distal thirds (branches: proximal / distal halves).
    const names = opts.isBranch ? ['Proximal', 'Distal'] : ['Proximal', 'Mid', 'Distal'];
    v.segments = names.map((name, i) => ({ name, s0: v.length * i / names.length, s1: v.length * (i + 1) / names.length }));
    v.truth.lesions.forEach(L => { L.segment = v.segments.findIndex(g => L.s0 >= g.s0 && L.s0 < g.s1); if (L.segment < 0) L.segment = v.segments.length - 1; });
    return v;
  }

  function refRadius(v, s) {
    const t = clamp(s / v.length, 0, 1);
    const base = lerp(v.r0, v.r1, t * t * 0.4 + t * 0.6);
    return base * (1 + 0.035 * RNG.gnoise(s * 0.12, 0, 0, v.wiggleSeed));
  }

  // Longitudinal plaque profile: smooth bump, 0..1, with a slightly asymmetric shoulder.
  function lesionProfile(l, s) {
    const u = (s - l.s0) / (l.len / 2);
    if (Math.abs(u) >= 1) return 0;
    const w = Math.cos(u * Math.PI / 2);
    return Math.pow(w, 1.35);
  }

  // Angular plaque weight: eccentric plaques are thick at thetaC and thin opposite.
  function angularWeight(l, th) {
    const c = Math.cos(th - l.thetaC);
    const w = (1 - l.ecc) + l.ecc * Math.max(0, (c + 1) / 2) ** 1.6;
    return w;
  }

  // Lumen radius at (s, theta). Diameter stenosis is defined on the minimal
  // lumen diameter vs reference, so the mean inward encroachment scales with
  // stenosis and the angular distribution redistributes it eccentrically.
  function lumenRadius(v, s, th) {
    const R = refRadius(v, s);
    let r = R;
    for (const l of v.lesions) {
      const p = lesionProfile(l, s);
      if (p <= 0) continue;
      const aw = angularWeight(l, th);
      // Normalize so the diameter through thetaC equals R*2*(1-stenosis) at the apex.
      const awMax = angularWeight(l, l.thetaC), awMin = angularWeight(l, l.thetaC + Math.PI);
      const meanAW = (awMax + awMin) / 2;
      const encroach = l.stenosis * R * aw / Math.max(1e-6, meanAW);
      r -= encroach * p;
    }
    if (r < 0.08) r = 0;
    return Math.max(0, r);
  }

  // Outer wall radius at (s, theta): reference wall thickness + remodeling bulge.
  function outerRadius(v, s, th) {
    const R = refRadius(v, s);
    const wallT = 0.35 + 0.08 * R;
    let ro = R + wallT;
    for (const l of v.lesions) {
      const p = lesionProfile(l, s);
      if (p <= 0) continue;
      const aw = angularWeight(l, th);
      const awMax = angularWeight(l, l.thetaC);
      ro += (l.remodel - 1) * R * p * (0.35 + 0.65 * aw / awMax) * 1.2;
    }
    return ro;
  }

  // Tissue + HU at a cylindrical point. Returns { t, hu }.
  function sampleTissue(v, s, r, th, rlPre, roPre) {
    if (s < 0 || s > v.length) return { t: TISSUE.FAT, hu: HU.FAT };
    const rl = rlPre != null ? rlPre : lumenRadius(v, s, th);
    const ro = roPre != null ? roPre : outerRadius(v, s, th);
    if (r < rl) return { t: TISSUE.LUMEN, hu: HU.LUMEN - 35 * (s / v.length) }; // contrast falls off distally
    if (r >= ro) {
      // Outside the vessel: epicardial fat with myocardium beyond a boundary.
      return null; // caller fills background
    }
    const R = refRadius(v, s);
    const wallT = 0.35 + 0.08 * R;
    // Plaque occupies the ring between the reference lumen (R) ... but it is
    // simpler: anything in the wall ring thicker than normal wall is plaque.
    const thick = ro - rl;
    const inPlaque = thick > wallT * 1.15;
    if (!inPlaque) return { t: TISSUE.WALL, hu: HU.WALL };
    // Normalized depth within plaque: 0 at lumen, 1 at adventitia.
    const depth = (r - rl) / Math.max(1e-6, thick);
    // Which lesion dominates here.
    let best = null, bp = 0;
    for (const l of v.lesions) { const p = lesionProfile(l, s); if (p > bp) { bp = p; best = l; } }
    if (!best) return { t: TISSUE.WALL, hu: HU.WALL };
    const l = best;
    // Leave a thin fibrous cap next to lumen and thin adventitia outside.
    if (depth > 0.92) return { t: TISSUE.WALL, hu: HU.WALL };
    // Calcification: large blobs + spotty foci, modulated by calcFrac.
    const nz = RNG.vnoise(s * 0.8, th * 1.3, r * 1.6, l.noiseSeed);
    let calc = false;
    if (l.calcFrac > 0.02) {
      // Calcium clumps concentrate on the thick (eccentric) side of the plaque.
      const awN = angularWeight(l, th) / angularWeight(l, l.thetaC);
      const thr = 1 - Math.min(0.85, l.calcFrac) * 0.75;
      if (nz * (0.55 + 0.45 * awN) > thr && depth > 0.15) calc = true;
      for (const b of l.blobs) {
        const bs = l.s0 + b.ds, bth = l.thetaC + b.dth, br = rl + (0.25 + 0.6 * b.rr) * thick;
        const dx = (s - bs) / (b.size * 2.2 + l.calcFrac * 3);
        const dth = Math.atan2(Math.sin(th - bth), Math.cos(th - bth)) * r / (b.size * 1.2 + l.calcFrac * 1.5);
        const dr = (r - br) / (b.size * 0.8 + l.calcFrac);
        if (dx * dx + dth * dth + dr * dr < 1 && l.calcFrac > 0.15) calc = true;
      }
    }
    for (const sp of l.spots) {
      const bs = l.s0 + sp.ds, bth = l.thetaC + sp.dth, br = rl + (0.2 + 0.6 * sp.rr) * thick;
      const dx = (s - bs) / sp.size;
      const dth = Math.atan2(Math.sin(th - bth), Math.cos(th - bth)) * r / sp.size;
      const dr = (r - br) / (sp.size * 0.9);
      if (dx * dx + dth * dth + dr * dr < 1) calc = true;
    }
    if (calc) {
      const hu = HU.CALC + 250 * (nz - 0.5) + 150 * RNG.gnoise(s * 3, th * 3, r * 3, l.noiseSeed + 7) * 0.3;
      return { t: TISSUE.CALC, hu: clamp(hu, 400, 1200) };
    }
    // Low attenuation core: central depth band, modulated by lapFrac.
    if (l.lapFrac > 0.05) {
      const core = 1 - Math.abs(depth - 0.42) / 0.4; // 1 at core, 0 at edges
      const nz2 = RNG.vnoise(s * 0.9, th * 1.2, r * 1.5, l.noiseSeed + 99);
      const lapScore = core * (0.5 + 0.5 * nz2) * angularWeight(l, th) / angularWeight(l, l.thetaC) * bp;
      if (lapScore > 1 - l.lapFrac * 1.1) {
        const hu = HU.LAP + 18 * RNG.gnoise(s * 2.5, th * 2.5, r * 2.5, l.noiseSeed + 3);
        return { t: TISSUE.LAP, hu };
      }
      if (l.napkin && lapScore > 1 - l.lapFrac * 1.1 - 0.12) {
        // Napkin ring: higher attenuation rim around the LAP core.
        return { t: TISSUE.NCP, hu: 130 + 15 * RNG.gnoise(s * 2.5, th * 2.5, r * 2.5, l.noiseSeed + 5) };
      }
    }
    const hu = HU.NCP + 22 * RNG.gnoise(s * 2.0, th * 2.0, r * 2.0, l.noiseSeed + 11);
    return { t: TISSUE.NCP, hu };
  }

  // --- Ground truth summary -------------------------------------------------
  // For each lesion: minimal lumen diameter, area stenosis, plaque volume by
  // component (approximate via sampling), high-risk features, CAD-RADS grade.
  function cadRads(sten) {
    if (sten >= 0.99) return '5';
    if (sten >= 0.70) return '4A';
    if (sten >= 0.50) return '3';
    if (sten >= 0.25) return '2';
    if (sten > 0.0) return '1';
    return '0';
  }
  function stenosisCategory(sten) {
    if (sten >= 0.99) return 'Occluded (100%)';
    if (sten >= 0.70) return 'Severe (70–99%)';
    if (sten >= 0.50) return 'Moderate (50–69%)';
    if (sten >= 0.25) return 'Mild (25–49%)';
    if (sten > 0.0) return 'Minimal (1–24%)';
    return 'None (0%)';
  }

  function computeTruth(v) {
    const out = [];
    for (const l of v.lesions) {
      // Measure true min lumen diameter across the lesion.
      let minD = Infinity, minS = l.s0, refD = 0, minArea = Infinity, refArea = 0;
      for (let s = l.s0 - l.len / 2; s <= l.s0 + l.len / 2; s += 0.25) {
        let area = 0, dmin = Infinity;
        for (let k = 0; k < 36; k++) {
          const th = k / 36 * Math.PI * 2;
          const r1 = lumenRadius(v, s, th), r2 = lumenRadius(v, s, th + Math.PI);
          dmin = Math.min(dmin, r1 + r2);
          area += 0.5 * r1 * r1 * (Math.PI * 2 / 36);
        }
        if (dmin < minD) { minD = dmin; minS = s; }
        minArea = Math.min(minArea, area);
      }
      refD = 2 * refRadius(v, minS);
      refArea = Math.PI * refRadius(v, minS) ** 2;
      const diamSten = clamp(1 - minD / refD, 0, 1);
      const areaSten = clamp(1 - minArea / refArea, 0, 1);
      // Plaque composition via Monte-Carlo sampling in the plaque shell.
      const counts = { CALC: 0, NCP: 0, LAP: 0, total: 0 };
      const rand = RNG.mulberry32(l.noiseSeed ^ 0x5bd1e995);
      for (let i = 0; i < 6000; i++) {
        const s = l.s0 + (rand() - 0.5) * l.len;
        const th = rand() * Math.PI * 2;
        const rl = lumenRadius(v, s, th), ro = outerRadius(v, s, th);
        const r = rl + rand() * (ro - rl);
        const t = sampleTissue(v, s, r, th);
        if (!t) continue;
        const w = r; // cylindrical volume weight
        if (t.t === TISSUE.CALC) counts.CALC += w;
        else if (t.t === TISSUE.NCP) counts.NCP += w;
        else if (t.t === TISSUE.LAP) counts.LAP += w;
        else continue;
        counts.total += w;
      }
      const T = counts.total || 1;
      const calcF = counts.CALC / T, lapF = counts.LAP / T, ncpF = counts.NCP / T;
      let composition;
      if (calcF > 0.7) composition = 'Calcified';
      else if (calcF < 0.08) composition = 'Non-calcified';
      else composition = 'Mixed';
      const hrp = {
        lowAttenuation: lapF > 0.08,
        positiveRemodeling: l.remodel >= 1.1,
        spottyCalcification: l.spots.length > 0 && calcF < 0.5,
        napkinRing: l.napkin && lapF > 0.08,
      };
      out.push({
        id: l.id, s0: l.s0, len: l.len, sStart: l.s0 - l.len / 2, sEnd: l.s0 + l.len / 2,
        minLumenDiam: minD, refDiam: refD, diamStenosis: diamSten, areaStenosis: areaSten,
        stenosisCategory: stenosisCategory(diamSten), cadRads: cadRads(diamSten),
        composition, calcFrac: calcF, ncpFrac: ncpF, lapFrac: lapF,
        remodelingIndex: l.remodel, hrp,
        hrpCount: Object.values(hrp).filter(Boolean).length,
        occlusion: diamSten >= 0.99,
      });
    }
    const worst = out.reduce((a, b) => (!a || b.diamStenosis > a.diamStenosis) ? b : a, null);
    return { lesions: out, vesselCadRads: worst ? worst.cadRads : '0', worstLesionId: worst ? worst.id : null };
  }

  return { create, TISSUE, HU, SEGMENTS, cadRads, stenosisCategory };
})();
