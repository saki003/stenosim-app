'use strict';
// Author mode: create / edit vessel centrelines on the 3-D segmentation, preview the CPR,
// and curate ground-truth lesions. Talks to tools/serve.py (/api/trace, /api/untrace, /api/truth).
(() => {
  const $ = id => document.getElementById(id);
  const tcv = $('tree3');
  const st = { caseId: null, tree: null, sel: null, view: { az: 0, el: 0.05 }, edit: null, prevPhi: 0 };
  const status = (msg, cls = '') => { $('status').textContent = msg; $('status').className = 'hint ' + cls; };

  // --- Case loading ------------------------------------------------------------
  async function init() {
    const ids = await Real.loadIndex();
    const sel = $('caseSel'); sel.innerHTML = '';
    ids.forEach((id, i) => { const o = document.createElement('option'); o.value = id; o.textContent = `${i + 1} · ${id}`; sel.appendChild(o); });
    sel.onchange = () => openCase(sel.value);
    if (ids.length) openCase(ids[0]); else status('No real cases found in cases/index.json', 'err');
  }
  async function openCase(id) {
    status(`loading ${id}…`);
    Real.invalidate(id);
    st.caseId = id; st.tree = await Real.loadCase(id); st.sel = st.tree.order[0] || null; st.edit = null;
    $('caseInfo').textContent = `${st.tree.order.length} vessels · meshes ${st.tree.meshes ? st.tree.meshes.length : 0}`;
    renderVessels(); draw(); await preview(); renderTruth();
    status(st.tree.meshes && st.tree.meshes.length ? 'ready' : 'this case has no meshes (tracing unavailable)', st.tree.meshes ? '' : 'err');
  }

  // --- 3-D view -----------------------------------------------------------------
  function draw() {
    if (!st.tree) return;
    const r = tcv.getBoundingClientRect();
    if (tcv.width !== Math.round(r.width) || tcv.height !== Math.round(r.height)) { tcv.width = Math.round(r.width); tcv.height = Math.round(r.height); }
    const v = st.sel && st.tree.vessels[st.sel];
    const tv = { az: st.view.az, el: st.view.el, current: st.sel, sPos: 0, reveal: false };
    Tree3D.draw(tcv, st.tree, tv);
    Tree3D.setHighlightLine(st.edit && st.edit.mode === 'edit' && v ? v.cl.P : null);
    Tree3D.setTracePoints(st.edit ? st.edit.pts : []);
    Tree3D.draw(tcv, st.tree, tv);
    $('applyEdit').disabled = !(st.edit && st.edit.pts.length >= 2);
    $('viewHint').textContent = `${Math.round(st.view.az * 180 / Math.PI)}° / ${Math.round(st.view.el * 180 / Math.PI)}°`;
  }
  (() => {
    let down = null;
    tcv.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, az: st.view.az, el: st.view.el, moved: false }; tcv.setPointerCapture(e.pointerId); });
    tcv.addEventListener('pointermove', e => {
      if (!down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) down.moved = true;
      if (down.moved) { st.view.az = down.az - dx * 0.01; st.view.el = Math.max(-1.4, Math.min(1.4, down.el + dy * 0.01)); draw(); }
    });
    tcv.addEventListener('pointerup', e => {
      if (down && !down.moved && st.edit) {
        const r = tcv.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
        // tap on an existing control point removes it
        let hit = -1;
        st.edit.pts.forEach((p, i) => { const q = Tree3D.project(tcv, p); if (q && Math.hypot(q.x - px, q.y - py) < 10) hit = i; });
        if (hit >= 0) st.edit.pts.splice(hit, 1);
        else {
          const p = Tree3D.pick(tcv, px, py);
          if (p) insertPoint(p); else $('editHint').textContent = 'Tap on the coronary surface to add a point.';
        }
        draw(); updateEditHint();
      }
      down = null;
    });
  })();
  // Insert a point where it best continues the sequence (between its two nearest neighbours).
  function insertPoint(p) {
    const pts = st.edit.pts;
    if (pts.length < 2) { pts.push(p); return; }
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    let best = pts.length, bc = d(pts[pts.length - 1], p);        // append cost
    if (d(pts[0], p) < bc) { best = 0; bc = d(pts[0], p); }
    for (let i = 0; i < pts.length - 1; i++) { const c = d(pts[i], p) + d(p, pts[i + 1]) - d(pts[i], pts[i + 1]); if (c < bc) { bc = c; best = i + 1; } }
    pts.splice(best, 0, p);
  }
  function updateEditHint() {
    if (!st.edit) { $('editHint').textContent = 'Select a vessel on the right and press Edit, or start a new vessel.'; return; }
    $('editHint').textContent = `${st.edit.mode === 'edit' ? 'Editing ' + st.edit.name : 'New vessel ' + st.edit.name} · ${st.edit.pts.length} control points (yellow line = current centreline). Apply re‑extracts the path through the segmentation.`;
  }

  // --- Editing actions -------------------------------------------------------------
  $('startNew').onclick = () => { st.edit = { mode: 'new', name: $('newName').value, pts: [] }; draw(); updateEditHint(); };
  $('undoPt').onclick = () => { if (st.edit) { st.edit.pts.pop(); draw(); updateEditHint(); } };
  $('clearPts').onclick = () => { if (st.edit) { st.edit.pts = []; draw(); updateEditHint(); } };
  $('cancelEdit').onclick = () => { st.edit = null; draw(); updateEditHint(); };
  function startEdit(name) {
    const v = st.tree.vessels[name];
    const stepMm = 15, every = Math.max(1, Math.round(stepMm / v.cl.step));
    const pts = v.cl.P.filter((_, i) => i % every === 0 || i === v.cl.P.length - 1).map(p => p.slice());
    st.sel = name; st.edit = { mode: 'edit', name, pts }; renderVessels(); draw(); updateEditHint(); preview(); renderTruth();
  }
  $('applyEdit').onclick = async () => {
    if (!st.edit || st.edit.pts.length < 2) return;
    const { name, pts } = st.edit;
    if (st.edit.mode === 'new' && st.tree.vessels[name] && !confirm(`${name} exists — replace it?`)) return;
    status(`extracting ${name}… (10–30 s)`); $('applyEdit').disabled = true;
    try {
      const r = await fetch('/api/trace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ case: st.caseId, name, points: pts }) });
      const res = await r.json(); if (!r.ok) throw new Error(res.error || r.statusText);
      status(`${name}: ${res.length_mm} mm, lumen quality ${res.lumen_quality}`, 'ok');
      st.edit = null; await openCase(st.caseId); st.sel = name; renderVessels(); draw(); await preview(); renderTruth();
    } catch (e) { status('failed: ' + e.message, 'err'); $('applyEdit').disabled = false; }
  };
  async function deleteVessel(name) {
    if (!confirm(`Delete ${name} from ${st.caseId}?`)) return;
    const r = await fetch('/api/untrace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ case: st.caseId, name }) });
    if (r.ok) { status(`${name} removed`, 'ok'); await openCase(st.caseId); } else status('delete failed', 'err');
  }

  // --- Vessel table --------------------------------------------------------------------
  function renderVessels() {
    const t = $('vtable');
    t.innerHTML = '<tr><th>Vessel</th><th>Length</th><th>Source</th><th>Truth</th><th></th></tr>';
    for (const k of st.tree.order) {
      const v = st.tree.vessels[k];
      const cur = (st.tree.curated || {})[k] || v.truth.lesions.some(L => L.curated);
      const tr = document.createElement('tr'); tr.className = k === st.sel ? 'sel' : '';
      tr.innerHTML = `<td><b>${k}</b></td><td>${v.length.toFixed(0)} mm</td><td>${v.traced ? 'traced ✎' : 'auto'}</td><td>${cur ? '<span class="ok">curated</span>' : `draft (${v.truth.lesions.length} lesions)`}</td>
        <td><button data-a="sel">Preview</button> <button data-a="edit">Edit</button> <button data-a="del" class="danger">Delete</button></td>`;
      tr.querySelector('[data-a=sel]').onclick = async () => { st.sel = k; renderVessels(); draw(); await preview(); renderTruth(); };
      tr.querySelector('[data-a=edit]').onclick = () => startEdit(k);
      tr.querySelector('[data-a=del]').onclick = () => deleteVessel(k);
      t.appendChild(tr);
    }
  }

  // --- CPR preview -----------------------------------------------------------------------
  async function preview() {
    const v = st.sel && st.tree.vessels[st.sel];
    $('prevName').textContent = st.sel || '—';
    if (!v) return;
    if (v.load && !v.loaded) { status(`loading ${st.sel}…`); await v.load(); status('ready'); }
    const s = { phi: st.prevPhi, wl: { width: 900, level: 250 }, overlay: $('prevOverlay').checked, stride: 1, sPos: 0 };
    if (v.wideData) { Render.realCPR(v, $('prevStraight'), s, 'straight'); Render.realCPR(v, $('prevStretched'), s, 'stretched'); }
    // lesion bands from truth on the straight preview
    const c = $('prevStraight'), ctx = c.getContext('2d');
    for (const L of v.truth.lesions) {
      const y0 = L.sStart / v.length * c.height, y1 = L.sEnd / v.length * c.height;
      ctx.strokeStyle = L.curated ? '#43d17a' : '#ffd600'; ctx.setLineDash([4, 3]); ctx.strokeRect(1, y0, c.width - 2, y1 - y0); ctx.setLineDash([]);
      ctx.fillStyle = ctx.strokeStyle; ctx.font = '11px system-ui'; ctx.fillText(`${Math.round(L.diamStenosis * 100)}%`, 4, y0 - 2);
    }
    for (const g of v.segments) { const y = g.s1 / v.length * c.height; ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(c.width, y); ctx.stroke(); ctx.fillStyle = '#aaa'; ctx.fillText(g.name, 4, g.s0 / v.length * c.height + 12); }
  }
  $('prevPhi').oninput = e => { st.prevPhi = +e.target.value * Math.PI / 180; preview(); };
  $('prevOverlay').onchange = () => preview();

  // --- Truth editor ------------------------------------------------------------------------
  const HRP = Scoring.HRP_KEYS;
  function renderTruth() {
    const v = st.sel && st.tree.vessels[st.sel]; const t = $('ltable'); t.innerHTML = '';
    if (!v) return;
    t.innerHTML = '<tr><th>#</th><th>start</th><th>end</th><th>stenosis %</th><th>plaque</th><th>high-risk</th><th></th></tr>';
    v.truth.lesions.forEach((L, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i + 1}</td><td><input type="number" step="0.5" value="${L.sStart.toFixed(1)}" data-k="sStart"></td><td><input type="number" step="0.5" value="${L.sEnd.toFixed(1)}" data-k="sEnd"></td>
        <td><input type="number" min="0" max="100" value="${Math.round(L.diamStenosis * 100)}" data-k="pct"></td>
        <td><select data-k="comp">${['Calcified', 'Non-calcified', 'Mixed'].map(c => `<option ${c === L.composition ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
        <td>${HRP.map(k => `<label><input type="checkbox" data-h="${k}" ${L.hrp && L.hrp[k] ? 'checked' : ''}>${Scoring.HRP_SHORT[k]}</label>`).join('')}</td>
        <td><button class="danger" data-a="del">✕</button></td>`;
      tr.querySelector('[data-a=del]').onclick = () => { v.truth.lesions.splice(i, 1); renderTruth(); preview(); };
      t.appendChild(tr);
    });
  }
  $('addLesion').onclick = () => {
    const v = st.sel && st.tree.vessels[st.sel]; if (!v) return;
    v.truth.lesions.push({ sStart: 20, sEnd: 30, s0: 25, diamStenosis: 0.5, composition: 'Mixed', hrp: {}, cadRads: '3', minLumenDiam: 0, refDiam: 0 });
    renderTruth(); preview();
  };
  $('saveTruth').onclick = async () => {
    const v = st.sel && st.tree.vessels[st.sel]; if (!v) return;
    const rows = [...$('ltable').querySelectorAll('tr')].slice(1);
    const lesions = rows.map((tr, i) => {
      const g = k => tr.querySelector(`[data-k=${k}]`).value;
      const hrp = {}; HRP.forEach(k => hrp[k] = tr.querySelector(`[data-h=${k}]`).checked);
      const old = v.truth.lesions[i] || {};
      return { sStart: +g('sStart'), sEnd: +g('sEnd'), diamStenosis: +g('pct') / 100, composition: g('comp'), hrp,
               minLumenDiam: old.minLumenDiam || 0, refDiam: old.refDiam || 0, calcFrac: old.calcFrac || 0, ncpFrac: old.ncpFrac || 0, lapFrac: old.lapFrac || 0, remodelingIndex: old.remodelingIndex || 1 };
    });
    status('saving truth…');
    const r = await fetch('/api/truth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ case: st.caseId, vessel: st.sel, lesions }) });
    const res = await r.json();
    if (r.ok) { status(`truth saved for ${st.sel} (${res.n} lesions)`, 'ok'); const keep = st.sel; await openCase(st.caseId); st.sel = keep; renderVessels(); draw(); await preview(); renderTruth(); }
    else status('save failed: ' + (res.error || r.statusText), 'err');
  };

  window.addEventListener('resize', draw);
  init();
})();
