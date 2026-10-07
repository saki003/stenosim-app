'use strict';
// WebGL coronary-tree locator (three.js): shaded heart, aortic root and tapered
// coronary tubes in the style of a workstation volume rendering. Falls back to the
// 2-D Tree.draw when WebGL is unavailable.

const Tree3D = (() => {
  let renderer = null, scene, camera, group, built = null, ok = typeof THREE !== 'undefined';
  let pickable = null, pickMesh = null, traceGroup = null;
  const COL = { vessel: 0xb8202a, current: 0xff4a52, aorta: 0xc44a60, heart: 0xb97a63, pa: 0x7d8fb8 };

  function init(canvas) {
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      renderer.setSize(canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height, false);
      renderer.outputEncoding = THREE.sRGBEncoding;
      scene = new THREE.Scene(); scene.background = new THREE.Color(0x0a0d12);
      camera = new THREE.PerspectiveCamera(32, 1, 1, 2000);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x223, 0.35));
      const key = new THREE.DirectionalLight(0xffffff, 0.75); key.position.set(-1, 1.2, 1.5); scene.add(key);
      const fill = new THREE.DirectionalLight(0xffd0c0, 0.25); fill.position.set(1, -0.5, 0.8); scene.add(fill);
      const rim = new THREE.DirectionalLight(0x99bbff, 0.2); rim.position.set(0.3, 0.6, -1); scene.add(rim);
      group = new THREE.Group(); scene.add(group);
    } catch (e) { ok = false; }
  }

  // locator frame (x patient-left, y anterior, z superior) -> three (x right, y up, z toward viewer).
  // Anterior view convention: the patient's left is on the viewer's right (RCA on the left).
  const v3 = p => new THREE.Vector3(p[0], p[2], p[1]);

  // Tapered tube: a chain of TubeGeometry pieces with decreasing radius.
  function taperedTube(pts, radiusAt, material, pieces = 10) {
    const g = new THREE.Group();
    const n = pts.length;
    const per = Math.max(2, Math.ceil(n / pieces));
    for (let i = 0; i < n - 1; i += per) {
      const seg = pts.slice(Math.max(0, i - 1), Math.min(n, i + per + 2)).map(v3);
      if (seg.length < 2) continue;
      const curve = new THREE.CatmullRomCurve3(seg);
      const r = radiusAt(Math.min(n - 1, i + per / 2));
      g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(4, seg.length * 2), r, 10, false), material));
      if (i === 0) g.add(new THREE.Mesh(new THREE.SphereGeometry(r, 10, 10), material).translateX(seg[0].x).translateY(seg[0].y).translateZ(seg[0].z));
    }
    const last = v3(pts[n - 1]);
    g.add(new THREE.Mesh(new THREE.SphereGeometry(radiusAt(n - 1), 10, 10), material).translateX(last.x).translateY(last.y).translateZ(last.z));
    return g;
  }

  function heartMesh(centre, size) {
    const geo = new THREE.SphereGeometry(1, 48, 36);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      // Ventricular mass: elongated toward the apex (−y), flattened front/back, a shallow interventricular groove.
      const bulge = 1 + 0.08 * Math.sin(3 * Math.atan2(z, x)) * Math.max(0, -y) + 0.05 * Math.cos(5 * x + 2 * y);
      pos.setXYZ(i, x * size[0] * bulge, y * size[1] * (y < 0 ? 1.25 : 0.95), z * size[2] * bulge);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: COL.heart, roughness: 0.62, metalness: 0.05 });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(v3(centre));
    return m;
  }

  function build(tree, current) {
    while (group.children.length) group.remove(group.children[0]);
    pickMesh = null; traceGroup = null; lineGroup = null;
    // Vessel cloud centre and extent.
    let cen = [0, 0, 0], n = 0, lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (const k of tree.order) for (const p of tree.vessels[k].cl.P) { n++; for (let d = 0; d < 3; d++) { cen[d] += p[d]; lo[d] = Math.min(lo[d], p[d]); hi[d] = Math.max(hi[d], p[d]); } }
    cen = cen.map(c => c / Math.max(1, n));
    const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const aorta = tree.aorta || { pts: [[cen[0], cen[1], hi[2]], [cen[0] - 6, cen[1] + 4, hi[2] + 25]], r: 14 };
    // Heart body sits mostly below/behind the proximal vessels.
    const top = aorta.pts[0];
    // Heart body sits behind (posterior to) the epicardial vessels so they stay visible head-on.
    const hc = [cen[0] + 0.08 * ext[0], cen[1] - 0.32 * ext[1] - 6, Math.min(cen[2], top[2] - 0.45 * ext[2])];
    if (tree.meshes && tree.meshes.length) {
      buildFromMeshes(tree, current);
    } else {
      group.add(heartMesh(hc, [0.40 * ext[0] + 6, 0.5 * ext[2] + 6, 0.34 * ext[1] + 6]));
      // Aortic root + ascending aorta.
      const aoMat = new THREE.MeshStandardMaterial({ color: COL.aorta, roughness: 0.5 });
      group.add(taperedTube(aorta.pts, () => aorta.r, aoMat, 4));
      const root = new THREE.Mesh(new THREE.SphereGeometry(aorta.r * 1.12, 20, 16), aoMat); root.position.copy(v3(aorta.pts[0])); root.scale.set(1, 0.7, 1); group.add(root);
      // Coronaries.
      for (const k of tree.order) {
        const v = tree.vessels[k];
        const mat = new THREE.MeshStandardMaterial({ color: k === current ? COL.current : COL.vessel, roughness: 0.45, emissive: k === current ? 0x441014 : 0x000000 });
        const step = Math.max(1, Math.round(2 / v.cl.step));
        const pts = v.cl.P.filter((_, i) => i % step === 0);
        group.add(taperedTube(pts, i => Math.max(1.0, v.refRadius(i * step * v.cl.step) * 1.3), mat, 12));
      }
    }
    built = { cen, ext, hc, aorta };
  }

  // Real reconstruction: segmentation surfaces. The coronary surface is vertex-coloured by
  // the nearest tracked vessel so the current vessel lights up.
  function buildFromMeshes(tree, current) {
    const toGeo = m => {
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array(m.verts.length);
      for (let i = 0; i < m.verts.length; i += 3) { pos[i] = m.verts[i]; pos[i + 1] = m.verts[i + 2]; pos[i + 2] = m.verts[i + 1]; } // same mapping as v3
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setIndex(new THREE.BufferAttribute(m.faces, 1));
      g.computeVertexNormals();
      return g;
    };
    const root = tree.aorta ? tree.aorta.pts[0] : null;
    for (const m of tree.meshes) {
      if (m.name === 'heart' || m.name === 'pa') continue;            // keep it simple: root + coronaries only
      let geo;
      if (m.name === 'aorta' && root) {
        // Keep only the aortic root / proximal ascending aorta (within 40 mm of the root point).
        const keep = new Uint8Array(m.verts.length / 3);
        for (let i = 0; i < keep.length; i++) { const dx = m.verts[3 * i] - root[0], dy = m.verts[3 * i + 1] - root[1], dz = m.verts[3 * i + 2] - root[2]; keep[i] = (dx * dx + dy * dy + dz * dz) < 1600 ? 1 : 0; }
        const faces = [];
        for (let i = 0; i < m.faces.length; i += 3) if (keep[m.faces[i]] && keep[m.faces[i + 1]] && keep[m.faces[i + 2]]) faces.push(m.faces[i], m.faces[i + 1], m.faces[i + 2]);
        if (!faces.length) continue;
        geo = toGeo({ verts: m.verts, faces: new Uint32Array(faces) });
      } else geo = toGeo(m);
      if (m.name === 'coronary') {
        pickable = geo;
        // nearest-vessel colouring (coarse centreline samples every ~3 mm)
        const samples = tree.order.map(k => { const v = tree.vessels[k]; const st = Math.max(1, Math.round(3 / v.cl.step)); return { k, pts: v.cl.P.filter((_, i) => i % st === 0) }; });
        const colors = new Float32Array(m.verts.length);
        const cCur = new THREE.Color(COL.current), cOth = new THREE.Color(COL.vessel), cFar = new THREE.Color(0x9a4a4a);
        for (let i = 0; i < m.verts.length; i += 3) {
          const x = m.verts[i], y = m.verts[i + 1], z = m.verts[i + 2];
          let best = null, bd = 1e9;
          for (const s of samples) for (const p of s.pts) { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2 + (p[2] - z) ** 2; if (d < bd) { bd = d; best = s.k; } }
          const c = bd > 36 ? cFar : best === current ? cCur : cOth;
          colors[i] = c.r; colors[i + 1] = c.g; colors[i + 2] = c.b;
        }
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        pickMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45 }));
        group.add(pickMesh);
      } else {
        group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: m.color, roughness: m.name === 'heart' ? 0.7 : 0.5 })));
      }
    }
  }

  // Trace support: pick a point on the coronary surface from canvas pixel coordinates.
  // Returns the point in the locator frame [x left, y anterior, z superior] or null.
  function pick(canvas, px, py) {
    if (!pickMesh || !camera) return null;
    const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
    const ndc = new THREE.Vector2(px / w * 2 - 1, -(py / h) * 2 + 1);
    const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, camera);
    const hits = rc.intersectObject(pickMesh, false);
    if (!hits.length) return null;
    const q = hits[0].point;
    return [q.x, q.z, q.y];
  }
  function setTracePoints(pts) {
    if (!group) return;
    if (traceGroup) group.remove(traceGroup);
    traceGroup = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x7cfc9a, emissive: 0x2a7a3a });
    pts.forEach((p, i) => { const m = new THREE.Mesh(new THREE.SphereGeometry(i === 0 ? 2.6 : 2.0, 12, 10), mat); m.position.copy(v3(p)); traceGroup.add(m); });
    if (pts.length > 1) {
      const g = new THREE.BufferGeometry().setFromPoints(pts.map(v3));
      traceGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x7cfc9a })));
    }
    group.add(traceGroup);
  }
  function release() { if (renderer) { renderer.dispose(); renderer = null; built = null; } }
  // Screen position (canvas px) of a locator-frame point, or null before the first draw.
  function project(canvas, p) {
    if (!camera) return null;
    const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
    const q = v3(p).project(camera);
    return { x: (q.x + 1) / 2 * w, y: (1 - q.y) / 2 * h, z: q.z };
  }
  // Highlight an existing centreline (array of locator-frame points) while editing.
  let lineGroup = null;
  function setHighlightLine(pts, color = 0xffd600) {
    if (!group) return;
    if (lineGroup) group.remove(lineGroup);
    lineGroup = null;
    if (pts && pts.length > 1) {
      const g = new THREE.BufferGeometry().setFromPoints(pts.map(v3));
      lineGroup = new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
      group.add(lineGroup);
    }
  }

  function draw(canvas, tree, view) {
    if (!ok) return false;
    if (!renderer || renderer.domElement !== canvas) { release(); init(canvas); }
    if (!ok) return false;
    const key = `${tree.id || tree.seed}|${view.current}`;
    if (!built || built.key !== key) { build(tree, view.current); built.key = key; built.marks = new THREE.Group(); group.add(built.marks); }
    // Dynamic markers: current position + revealed lesions.
    const marks = built.marks; while (marks.children.length) marks.remove(marks.children[0]);
    if (view.current) {
      const v = tree.vessels[view.current];
      const p = v.cl.P[Math.min(v.cl.P.length - 1, Math.round(view.sPos / v.cl.step))];
      const m = new THREE.Mesh(new THREE.SphereGeometry(2.4, 14, 12), new THREE.MeshStandardMaterial({ color: 0x3b9eff, emissive: 0x1a4a88 })); m.position.copy(v3(p)); marks.add(m);
    }
    if (view.reveal) for (const k of tree.order) for (const L of tree.vessels[k].truth.lesions) {
      const v = tree.vessels[k]; const p = v.cl.P[Math.min(v.cl.P.length - 1, Math.round(L.s0 / v.cl.step))];
      const c = L.diamStenosis >= 0.7 ? 0xff2020 : L.diamStenosis >= 0.5 ? 0xffa020 : 0xffe040;
      const m = new THREE.Mesh(new THREE.SphereGeometry(2.0, 12, 10), new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.4 })); m.position.copy(v3(p)); marks.add(m);
    }
    // Camera orbit around the cloud centre.
    const c = v3([built.cen[0], built.cen[1], built.cen[2] + 0.12 * built.ext[2]]);
    const w0 = canvas.clientWidth || canvas.width, h0 = canvas.clientHeight || canvas.height;
    // Fit the tree in portrait canvases too (horizontal FOV shrinks with the aspect ratio).
    const R = (Math.max(...built.ext) * 1.7 + 45) * Math.max(1, Math.min(2.2, h0 / w0 * 0.95));
    const az = view.az, el = Math.max(-1.3, Math.min(1.3, view.el));
    camera.position.set(c.x + R * Math.sin(az) * Math.cos(el), c.y + R * Math.sin(el), c.z + R * Math.cos(az) * Math.cos(el));
    camera.lookAt(c);
    const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    renderer.render(scene, camera);
    if (view.onLabels) {
      const labels = [];
      for (const k of tree.order) {
        const v = tree.vessels[k];
        const q = v3(v.cl.P[Math.round(v.cl.P.length * 0.62)]).project(camera);
        labels.push({ k, x: (q.x + 1) / 2 * w, y: (1 - q.y) / 2 * h });
      }
      const qa = v3(built.aorta.pts[built.aorta.pts.length - 1]).project(camera);
      labels.push({ k: 'Ao', x: (qa.x + 1) / 2 * w, y: (1 - qa.y) / 2 * h });
      view.onLabels(labels);
    }
    return true;
  }

  return { draw, pick, project, setTracePoints, setHighlightLine, release, available: () => ok, canTrace: () => !!pickMesh };
})();
