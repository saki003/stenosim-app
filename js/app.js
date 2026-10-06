'use strict';
// Mobile app controller: case set -> vessel -> segment reads -> feedback.
(() => {
  const $ = id => document.getElementById(id);
  const cv = { tree: $('tree'), cross: $('cross'), crossRef: $('crossRef'), cpr: $('cpr'), over: $('cprOverlay'), profile: $('profile') };
  const off = document.createElement('canvas');
  const CPR_W = 200;                 // internal strip width (px); CSS stretches to panel width
  const MAX_ZOOM = 8, MIN_ZOOM = 1;

  const SETTINGS_KEY = 'stenosim.settings', READS_KEY = 'stenosim.reads';
  const settings = Object.assign({ baseSeed: 20260918, nCases: 10, difficulty: 'medium' }, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
  let reads = JSON.parse(localStorage.getItem(READS_KEY) || '{}');
  const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  const saveReads = () => localStorage.setItem(READS_KEY, JSON.stringify(reads));

  const trees = {};
  let realIds = [];                                   // de-identified real cases from cases/index.json (shown first)
  const totalCases = () => realIds.length + settings.nCases;
  const isRealCase = idx => idx < realIds.length;
  async function ensureTree(idx) {
    if (trees[idx]) return trees[idx];
    if (isRealCase(idx)) trees[idx] = await Real.loadCase(realIds[idx]);
    else trees[idx] = Tree.create((settings.baseSeed + (idx - realIds.length) * 1000003) >>> 0, settings.difficulty);
    return trees[idx];
  }
  const state = {
    caseIdx: 0, vessel: 'LAD', seg: 0, phi: 0, sPos: 10, wl: { width: 900, level: 250 }, overlay: false, stride: 1,
    view: { az: 0, el: 0.05 }, cprMode: 'stretched', zoom: 1, collapsed: false, sRef: null,   // head-on anterior view
  };

  const tree = () => trees[state.caseIdx];
  const ORDER = () => tree().order;
  const vessel = () => tree().vessels[state.vessel];
  function rec(vKey = state.vessel) { const c = reads[state.caseIdx] || (reads[state.caseIdx] = {}); return c[vKey] || (c[vKey] = { segs: [], submitted: false, result: null, visited: false }); }
  const caseDone = () => ORDER().every(k => rec(k).submitted);
  const nVisited = () => ORDER().filter(k => rec(k).visited).length;
  const segRead = i => { const r = rec(); return r.segs[i] || (r.segs[i] = Scoring.emptyRead()); };

  // --- Navigation -------------------------------------------------------------
  async function openCase(idx, vKey) {
    state.caseIdx = Math.max(0, Math.min(totalCases() - 1, idx));
    if (!trees[state.caseIdx]) {
      $('caseLbl').textContent = `Case ${state.caseIdx + 1} / ${totalCases()}`; $('caseSub').textContent = 'loading…';
      try { await ensureTree(state.caseIdx); }
      catch (e) { $('caseSub').textContent = 'failed to load case'; console.error(e); return; }
    }
    state.view.az = 0; state.view.el = 0.05;   // every case starts in the head-on anterior view
    openVessel(vKey || ORDER()[0]);
  }
  async function openVessel(vKey) {
    state.vessel = vKey; state.seg = 0; state.phi = 0; state.sPos = 6; state.stride = 1; state.zoom = 1; setRef(null);
    const v0 = vessel();
    if (v0.load && !v0.loaded) {                       // real case: image data loads on first open
      $('caseSub').textContent = `loading ${vKey}…`; renderVesselChips();
      try { await v0.load(); } catch (e) { $('caseSub').textContent = `failed to load ${vKey}`; return; }
      if (state.vessel !== vKey) return;                 // user moved on meanwhile
    }
    const r = rec();
    if (!r.visited) { r.visited = true; saveReads(); }
    state.overlay = r.submitted;
    cprKey = ''; csKey = '';
    $('cprs').scrollTop = 0;
    renderHeader(); renderVesselChips(); renderWorksheet();
    if (r.submitted) showFeedback(); else { $('feedback').hidden = true; $('worksheet').hidden = false; }
    requestRender();
    // Open showing the entire vessel; "Fill" / double-tap zooms to fill the width.
  }
  $('prevCase').onclick = () => openCase(state.caseIdx - 1);
  $('nextCase').onclick = () => openCase(state.caseIdx + 1);

  function renderHeader() {
    $('caseLbl').textContent = `Case ${state.caseIdx + 1} / ${totalCases()}`;
    const kind = isRealCase(state.caseIdx) ? 'real CCTA' : settings.difficulty;
    if (caseDone()) {
      const mean = Math.round(ORDER().reduce((a, k) => a + rec(k).result.total, 0) / ORDER().length);
      $('caseSub').textContent = `${kind} · scored ${mean}/100`;
    } else $('caseSub').textContent = `${kind} · ${nVisited()} of ${ORDER().length} vessels viewed`;
  }
  function renderVesselChips() {
    const box = $('vessels'); box.innerHTML = '';
    for (const k of ORDER()) {
      const r = (reads[state.caseIdx] || {})[k];
      const b = document.createElement('button');
      b.className = (k === state.vessel ? 'on ' : '') + (r?.submitted ? 'done ' : '') + (tree().vessels[k].traced ? 'traced' : '');
      b.innerHTML = `${k}<span class="sc">${r?.submitted ? r.result.total + ' pts' : (r?.segs?.some(s => s && s.cat !== '0') ? 'plaque' : r?.visited ? 'normal' : 'unviewed')}</span>`;
      b.onclick = () => openVessel(k);
      box.appendChild(b);
    }
  }

  // --- CPR geometry: fit-to-panel at zoom 1, isotropic pixels ----------------
  function cprGeom() {
    const v = vessel();
    const box = $('cprs');
    const panelH = Math.max(120, box.clientHeight), panelW = Math.max(120, box.clientWidth);
    const H = Math.min(6000, Math.round(panelH * state.zoom));
    // Canvas pixels match CSS pixels of the panel so the whole vessel fits at zoom 1 with no vertical scroll.
    return { H, W: panelW, mmPerPx: v.length / H, panelH };
  }

  // --- Rendering --------------------------------------------------------------
  let pending = false, cprKey = '', csKey = '';
  // setTimeout rather than rAF so rendering also proceeds while the tab is backgrounded.
  function requestRender() { if (!pending) { pending = true; setTimeout(renderAll, 0); } }
  function blitVertical(src, dst) {
    const ctx = dst.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, dst.width, dst.height);
    ctx.translate(dst.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(src, 0, 0); ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  function renderAll() {
    pending = false;
    const t0 = performance.now();
    renderAllInner();
    window.__lastRenderMs = performance.now() - t0;
  }
  window.__sim = { state, requestRender, vessel, tree, rec };
  function renderAllInner() {
    const v = vessel();
    const g = cprGeom();
    const base = `${state.caseIdx}|${state.vessel}|${state.phi}|${state.wl.width}|${state.wl.level}|${state.overlay}|${state.stride}|${state.cprMode}|${g.H}`;
    if (base !== cprKey) {
      cprKey = base;
      if (off.width !== g.H || off.height !== g.W) { off.width = g.H; off.height = g.W; }
      if (cv.cpr.height !== g.H) { cv.cpr.width = cv.over.width = g.W; cv.cpr.height = cv.over.height = g.H; }
      (state.cprMode === 'stretched' ? Render.stretchedCPR : Render.straightCPR)(v, off, state);
      blitVertical(off, cv.cpr);
    }
    const ck = base + '|' + state.sPos.toFixed(2) + '|' + state.sRef;
    if (ck !== csKey) {
      csKey = ck;
      Render.crossSection(v, cv.cross, state); drawCrossDecor(cv.cross);
      if (state.sRef != null) { Render.crossSection(v, cv.crossRef, Object.assign({}, state, { sPos: state.sRef })); drawCrossDecor(cv.crossRef); }
    }
    $('curLbl').textContent = `CURRENT · ${state.sPos.toFixed(1)} mm`;
    if (state.sRef != null) $('refLbl').textContent = `REF · ${state.sRef.toFixed(1)} mm`;
    drawOverlay();
    const tv = { az: state.view.az, el: state.view.el, current: state.vessel, sPos: state.sPos, reveal: rec().submitted };
    tv.onLabels = labels => {
      const box = $('treeLabels'); box.innerHTML = '';
      for (const l of labels) { const s = document.createElement('span'); s.textContent = l.k; s.className = l.k === state.vessel ? 'on' : ''; s.style.left = l.x + 'px'; s.style.top = l.y + 'px'; box.appendChild(s); }
    };
    if (!(typeof Tree3D !== 'undefined' && Tree3D.draw(cv.tree, tree(), tv))) { Tree.draw(cv.tree, tree(), tv); $('treeLabels').innerHTML = ''; }
    $('angleLbl').textContent = `${Math.round(((state.phi * 180 / Math.PI) % 360 + 360) % 360)}°`;
    $('traceBtn').hidden = !(isRealCase(state.caseIdx) && tree().meshes && tree().meshes.length);
    $('csPos').textContent = `${state.vessel} · W${state.wl.width}/L${state.wl.level}`;
    $('zoomLbl').textContent = state.zoom <= 1.01 ? `whole vessel · ${v.length.toFixed(0)} mm` : `${state.zoom.toFixed(1)}×`;
    $('zoomFit').textContent = state.zoom > 1.01 ? 'Fit' : 'Fill';
  }
  function setRef(s) {
    state.sRef = s;
    $('refBox').hidden = s == null;
    $('setRef').textContent = s == null ? 'Set ref' : 'Clear ref';
    $('setRef').classList.toggle('on', s != null);
    csKey = ''; requestRender();
  }
  $('setRef').onclick = () => setRef(state.sRef == null ? state.sPos : null);
  function drawCrossDecor(canvas) {
    const ctx = canvas.getContext('2d'); const w = canvas.width, h = canvas.height;
    ctx.strokeStyle = 'rgba(59,158,255,0.45)'; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(4, h / 2); ctx.lineTo(w - 4, h / 2); ctx.stroke(); ctx.setLineDash([]);
    const pxPerMm = w / 9;
    ctx.fillStyle = '#ddd'; ctx.fillRect(8, h - 10, pxPerMm, 2); ctx.font = '10px system-ui'; ctx.fillText('1 mm', 8, h - 14);
  }
  function drawOverlay() {
    const v = vessel(); const ctx = cv.over.getContext('2d'); const w = cv.over.width, h = cv.over.height;
    ctx.clearRect(0, 0, w, h);
    const Y = s => s / v.length * h;
    const r = rec();
    const small = state.zoom < 1.8;
    ctx.font = `bold ${small ? 9 : 10}px system-ui`;
    v.segments.forEach((g, i) => {
      if (i === state.seg && !r.submitted) { ctx.fillStyle = 'rgba(59,158,255,0.9)'; ctx.fillRect(0, Y(g.s0), 3, Y(g.s1) - Y(g.s0)); }
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(0, Y(g.s1)); ctx.lineTo(w, Y(g.s1)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = i === state.seg ? '#3b9eff' : 'rgba(255,255,255,0.6)';
      ctx.fillText(g.name.toUpperCase().slice(0, small ? 4 : 8), 5, Y(g.s0) + 10);
      const sr = r.segs[i];
      if (sr && sr.cat !== '0' && !r.submitted) { ctx.fillStyle = '#7CFC9A'; ctx.fillText(`${Scoring.CAT_LABEL[sr.cat]}% ${sr.comp.slice(0, 5)}`, 5, Y(g.s0) + 20); }
    });
    if (r.submitted) for (const L of v.truth.lesions) {
      ctx.strokeStyle = 'rgba(255,214,0,0.9)'; ctx.setLineDash([4, 3]); ctx.strokeRect(1.5, Y(L.sStart), w - 3, Y(L.sEnd) - Y(L.sStart)); ctx.setLineDash([]);
      ctx.fillStyle = '#ffd600'; ctx.fillText(`${Math.round(L.diamStenosis * 100)}% ${L.composition.slice(0, 5)}`, w - 70, Y(L.sStart) - 2);
    }
    if (state.sRef != null) {
      ctx.strokeStyle = 'rgba(124,252,154,0.95)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(0, Y(state.sRef)); ctx.lineTo(w, Y(state.sRef)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(124,252,154,0.95)'; ctx.fillText('REF', w - 24, Y(state.sRef) - 3);
    }
    ctx.strokeStyle = 'rgba(59,158,255,0.95)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(0, Y(state.sPos)); ctx.lineTo(w, Y(state.sPos)); ctx.stroke();
    ctx.fillStyle = 'rgba(59,158,255,0.95)'; ctx.beginPath(); ctx.moveTo(0, Y(state.sPos) - 5); ctx.lineTo(0, Y(state.sPos) + 5); ctx.lineTo(6, Y(state.sPos)); ctx.fill();
  }

  // --- View mode & zoom ---------------------------------------------------------
  function setMode(m) { state.cprMode = m; $('viewStretched').classList.toggle('on', m === 'stretched'); $('viewStraight').classList.toggle('on', m === 'straight'); requestRender(); }
  $('viewStretched').onclick = () => setMode('stretched');
  $('viewStraight').onclick = () => setMode('straight');
  // Zoom keeping the vessel position `anchorS` at the same screen row.
  function setZoom(z, anchorS, anchorClientY) {
    z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    const box = $('cprs');
    if (anchorS == null) { anchorS = state.sPos; anchorClientY = box.getBoundingClientRect().top + box.clientHeight / 2; }
    state.zoom = z;
    requestRender();
    // After the canvas resizes, scroll so anchorS sits at anchorClientY.
    setTimeout(() => {
      const rect = cv.cpr.getBoundingClientRect(); const boxRect = box.getBoundingClientRect();
      const yInCanvas = anchorS / vessel().length * rect.height;
      box.scrollTop = Math.max(0, yInCanvas - (anchorClientY - boxRect.top));
    }, 10);
  }
  // Zoom at which the available field of view around the vessel fills the panel width.
  function widthZoom() {
    const v = vessel(), box = $('cprs');
    const W = Math.max(120, box.clientWidth);
    // Fill the width with the available field of view, but never magnify beyond ~14 px/mm.
    const fovW = Math.max(v.isReal ? (v.sampleWide ? 42 : 2 * v.maxR) : 18, W / 14);
    return Math.max(1, (v.length / Math.max(120, box.clientHeight)) / (fovW / W));
  }
  $('zoomIn').onclick = () => setZoom(state.zoom * 1.6);
  $('zoomOut').onclick = () => setZoom(state.zoom / 1.6);
  $('zoomFit').onclick = () => setZoom(state.zoom > 1.01 ? 1 : widthZoom());
  // Re-render on real size changes only (debounced; ignores the small jitter from browser chrome).
  let resizeT = null, lastW = innerWidth, lastH = innerHeight;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      if (Math.abs(innerW() - lastW) > 20 || Math.abs(innerHeight - lastH) > 120) { lastW = innerW(); lastH = innerHeight; cprKey = ''; requestRender(); }
    }, 250);
  });
  function innerW() { return innerWidth; }

  // --- Gestures ---------------------------------------------------------------
  function setS(s) { state.sPos = Math.max(0, Math.min(vessel().length, s)); }
  function selectSegmentAt(s) { const i = vessel().segments.findIndex(g => s >= g.s0 && s < g.s1); if (i >= 0 && i !== state.seg) { state.seg = i; renderWorksheet(); } }
  const sAtClientY = y => { const rect = cv.cpr.getBoundingClientRect(); return (y - rect.top) / rect.height * vessel().length; };

  (() => {
    const canvas = cv.cpr;
    const ptrs = new Map();
    let gesture = null, lastTap = 0;
    canvas.addEventListener('pointerdown', e => {
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 1) gesture = { kind: 'maybe', x: e.clientX, y: e.clientY, phi: state.phi };
      else if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        gesture = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), z0: state.zoom, midY: (a.y + b.y) / 2, s: sAtClientY((a.y + b.y) / 2) };
        canvas.setPointerCapture(e.pointerId);
      }
    });
    canvas.addEventListener('pointermove', e => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!gesture) return;
      if (gesture.kind === 'pinch' && ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        state.stride = 2; setZoom(gesture.z0 * d / gesture.d0, gesture.s, gesture.midY);
      } else if (gesture.kind === 'maybe') {
        const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
        if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) { gesture.kind = 'rotate'; canvas.setPointerCapture(e.pointerId); }
      } else if (gesture.kind === 'rotate') {
        state.phi = gesture.phi + (e.clientX - gesture.x) * 0.015; state.stride = 2; requestRender();
      }
    });
    const end = e => {
      const wasTap = gesture && gesture.kind === 'maybe' && Math.abs(e.clientY - gesture.y) < 6 && Math.abs(e.clientX - gesture.x) < 6;
      ptrs.delete(e.pointerId);
      if (wasTap) {
        const now = Date.now();
        const s = sAtClientY(e.clientY);
        if (now - lastTap < 300) { setZoom(state.zoom > 1.01 ? 1 : widthZoom(), s, e.clientY); lastTap = 0; }
        else { setS(s); selectSegmentAt(s); lastTap = now; }
      }
      if (ptrs.size === 0) { gesture = null; if (state.stride !== 1) state.stride = 1; requestRender(); }
    };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    // Desktop: wheel with ctrl zooms, plain wheel scrolls natively.
    canvas.addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); setZoom(state.zoom * (e.deltaY < 0 ? 1.25 : 0.8), sAtClientY(e.clientY), e.clientY); } }, { passive: false });
  })();

  // Cross-section: horizontal drag rotates, vertical drag scrubs along the vessel.
  (() => {
    let down = null;
    cv.cross.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, phi: state.phi, s: state.sPos }; cv.cross.setPointerCapture(e.pointerId); });
    cv.cross.addEventListener('pointermove', e => {
      if (!down) return;
      state.phi = down.phi + (e.clientX - down.x) * 0.015;
      setS(down.s + (e.clientY - down.y) * 0.08);
      state.stride = 2; requestRender();
    });
    const up = () => { if (!down) return; down = null; state.stride = 1; selectSegmentAt(state.sPos); requestRender(); scrollCprToCursor(); };
    cv.cross.addEventListener('pointerup', up); cv.cross.addEventListener('pointercancel', up);
    cv.cross.addEventListener('wheel', e => { e.preventDefault(); setS(state.sPos + Math.sign(e.deltaY) * (e.shiftKey ? 2 : 0.5)); selectSegmentAt(state.sPos); requestRender(); }, { passive: false });
  })();
  // Tree: drag to orbit.
  (() => {
    let down = null;
    cv.tree.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, az: state.view.az, el: state.view.el }; cv.tree.setPointerCapture(e.pointerId); });
    cv.tree.addEventListener('pointermove', e => { if (!down) return; state.view.az = down.az - (e.clientX - down.x) * 0.02; state.view.el = Math.max(-1.4, Math.min(1.4, down.el + (e.clientY - down.y) * 0.02)); requestRender(); });
    cv.tree.addEventListener('pointerup', () => down = null); cv.tree.addEventListener('pointercancel', () => down = null);
    // Double-tap the locator to snap back to the head-on anterior view.
    let lastTreeTap = 0;
    cv.tree.addEventListener('pointerdown', () => { const now = Date.now(); if (now - lastTreeTap < 300) { state.view.az = 0; state.view.el = 0.05; requestRender(); } lastTreeTap = now; });
  })();
  function scrollCprToCursor() {
    const box = $('cprs'); const y = state.sPos / vessel().length * cv.cpr.getBoundingClientRect().height;
    const top = box.scrollTop, hh = box.clientHeight;
    if (y < top + 30 || y > top + hh - 30) box.scrollTo({ top: Math.max(0, y - hh / 2), behavior: 'smooth' });
  }
  document.addEventListener('keydown', e => {
    if (['INPUT', 'SELECT'].includes(e.target.tagName)) return;
    if (e.key === 'ArrowDown') { setS(state.sPos + (e.shiftKey ? 2 : 0.5)); selectSegmentAt(state.sPos); requestRender(); scrollCprToCursor(); }
    else if (e.key === 'ArrowUp') { setS(state.sPos - (e.shiftKey ? 2 : 0.5)); selectSegmentAt(state.sPos); requestRender(); scrollCprToCursor(); }
    else if (e.key === 'ArrowRight') { state.phi += Math.PI / 12; requestRender(); }
    else if (e.key === 'ArrowLeft') { state.phi -= Math.PI / 12; requestRender(); }
    else if (e.key === '+' || e.key === '=') setZoom(state.zoom * 1.6);
    else if (e.key === '-') setZoom(state.zoom / 1.6);
    else if (e.key === '0') setZoom(1);
    else if (e.key === 'v') setMode(state.cprMode === 'stretched' ? 'straight' : 'stretched');
    else if (e.key === 'r') setRef(state.sRef == null ? state.sPos : null);
  });

  // --- Worksheet --------------------------------------------------------------
  function renderWorksheet() {
    const v = vessel(), r = rec();
    const tabs = $('segtabs'); tabs.innerHTML = '';
    v.segments.forEach((g, i) => {
      const sr = r.segs[i];
      const b = document.createElement('button'); b.className = i === state.seg ? 'on' : '';
      b.innerHTML = `${g.name.slice(0, 4)}${sr && sr.cat !== '0' ? '<i class="dot"></i>' : ''}`;
      b.title = sr && sr.cat !== '0' ? `${Scoring.CAT_LABEL[sr.cat]}% ${sr.comp}` : 'no plaque';
      b.onclick = () => { state.seg = i; setS(g.s0 + 2); renderWorksheet(); requestRender(); scrollCprToCursor(); };
      tabs.appendChild(b);
    });
    const sr = segRead(state.seg);
    const mk = (box, items, isOn, onPick) => {
      box.innerHTML = '';
      for (const it of items) { const b = document.createElement('button'); b.textContent = it.label; b.className = isOn(it.v) ? 'on' : ''; b.disabled = r.submitted; b.onclick = () => { onPick(it.v); saveReads(); renderWorksheet(); renderVesselChips(); requestRender(); }; box.appendChild(b); }
    };
    mk($('catBtns'), Scoring.CATS.map(c => ({ v: c, label: Scoring.CAT_LABEL[c] })), c => sr.cat === c, c => { sr.cat = c; if (c === '0') { sr.comp = 'None'; sr.hrp = {}; } else if (sr.comp === 'None') sr.comp = 'Mixed'; });
    mk($('compBtns'), Scoring.COMPS.map(c => ({ v: c, label: c === 'Non-calcified' ? 'Non-calc' : c === 'Calcified' ? 'Calc' : c })), c => sr.comp === c, c => { sr.comp = c; if (c === 'None') { sr.cat = '0'; sr.hrp = {}; } else if (sr.cat === '0') sr.cat = '1'; });
    mk($('hrpBtns'), Scoring.HRP_KEYS.map(k => ({ v: k, label: Scoring.HRP_SHORT[k] === 'Spotty Ca' ? 'Spotty' : Scoring.HRP_SHORT[k] })), k => !!sr.hrp[k], k => { sr.hrp[k] = !sr.hrp[k]; if (sr.hrp[k] && sr.cat === '0') { sr.cat = '1'; sr.comp = 'Non-calcified'; } });
    const nv = nVisited(), all = nv === ORDER().length;
    $('finishCase').disabled = !all || caseDone();
    $('finishCase').textContent = all ? 'Finish case & reveal' : `Finish case · view all vessels first (${nv}/${ORDER().length})`;
  }

  // --- Finish case & feedback ---------------------------------------------------
  $('finishCase').onclick = () => {
    if (caseDone() || nVisited() < ORDER().length) return;
    const t = tree();
    for (const k of ORDER()) {
      const r = rec(k), v = t.vessels[k];
      v.segments.forEach((_, i) => { if (!r.segs[i]) r.segs[i] = Scoring.emptyRead(); });
      r.result = Scoring.scoreVessel(v, r.segs); r.submitted = true; r.ts = Date.now();
    }
    saveReads(); state.overlay = true;
    renderHeader(); renderVesselChips(); renderWorksheet(); showFeedback(); cprKey = ''; requestRender();
  };
  const pct = x => `${Math.round(x * 100)}%`;
  function showFeedback() {
    const v = vessel(), r = rec(), R = r.result;
    $('worksheet').hidden = true; $('feedback').hidden = false;
    const color = R.total >= 80 ? 'var(--good)' : R.total >= 50 ? 'var(--warn)' : 'var(--bad)';
    $('scoreBig').innerHTML = `<span style="color:${color}">${R.total}</span><small>${state.vessel} pts</small>`;
    const vd = R.vesselDelta === 0 ? '<span class="ok">correct</span>' : R.vesselDelta === 1 ? '<span class="mid">1 off</span>' : '<span class="no">wrong</span>';
    $('vesselVerdict').innerHTML = `CAD-RADS you <b>${R.userCat}</b> / truth <b>${R.trueCat}</b> ${vd}<br>${R.detected}/${R.nPlaque} diseased segs found · ${R.fp} false +`;
    const chips = $('segChips'); chips.innerHTML = '';
    for (const s of R.segs) {
      const cls = s.score >= 85 ? 'good' : s.score >= 40 ? 'part' : 'bad';
      const t = s.truth;
      chips.insertAdjacentHTML('beforeend', `<div class="${cls}">${s.name.slice(0, 4)} · ${s.score}<small>${t.lesion ? Math.round(t.lesion.diamStenosis * 100) + '% ' + t.comp.slice(0, 5) : 'no plaque'}</small></div>`);
    }
    $('fbMore').hidden = true; $('feedback').classList.remove('open'); $('fbDetails').textContent = 'Details ▾';
    const box = $('segFeedback'); box.innerHTML = '';
    for (const s of R.segs) {
      const cls = s.score >= 85 ? 'good' : s.score >= 40 ? 'part' : 'bad';
      const t = s.truth;
      const hrpT = Scoring.HRP_KEYS.filter(k => t.hrp[k]).map(k => Scoring.HRP_SHORT[k]).join(', ') || '—';
      const hrpU = Scoring.HRP_KEYS.map(k => { const u = !!s.read.hrp[k], tt = !!t.hrp[k]; return u === tt ? '' : `<span class="no">${Scoring.HRP_SHORT[k]} ${u ? 'over-called' : 'missed'}</span>`; }).filter(Boolean).join(', ') || '<span class="ok">all correct</span>';
      const sten = s.catDelta === 0 ? `<span class="ok">✓ ${Scoring.CAT_LABEL[s.read.cat]}%</span>` : `<span class="${s.catDelta === 1 ? 'mid' : 'no'}">${s.catDelta === 1 ? '~' : '✗'} you said ${Scoring.CAT_LABEL[s.read.cat]}%</span>`;
      const comp = s.compPts ? `<span class="ok">✓ ${s.read.comp}</span>` : `<span class="no">✗ you said ${s.read.comp}</span>`;
      const truthLine = t.lesion ? `<b>${Math.round(t.lesion.diamStenosis * 100)}%</b> (${Scoring.CAT_WORD[t.cat]}), MLD ${t.lesion.minLumenDiam.toFixed(1)} / ref ${t.lesion.refDiam.toFixed(1)} mm · ${t.comp} (Ca ${pct(t.lesion.calcFrac)}, LAP ${pct(t.lesion.lapFrac)}, RI ${t.lesion.remodelingIndex.toFixed(2)})` : 'No plaque';
      box.insertAdjacentHTML('beforeend', `<div class="fb ${cls}"><h4><span>${s.name}</span><span>${s.score} pts</span></h4>
        <div class="r"><b>Truth</b><div>${truthLine}</div><b>HRP</b><div>${hrpT}</div><b>Stenosis</b><div>${sten}</div><b>Plaque</b><div>${comp}</div><b>HRP read</b><div>${hrpU}</div></div></div>`);
    }
    Render.lumenProfile(v, cv.profile, v.truth);
  }
  $('toggleOverlay').onclick = () => { state.overlay = !state.overlay; requestRender(); };
  $('fbDetails').onclick = () => {
    const open = $('fbMore').hidden; $('fbMore').hidden = !open; $('feedback').classList.toggle('open', open);
    $('fbDetails').textContent = open ? 'Details ▴' : 'Details ▾'; cprKey = ''; requestRender();
  };
  $('nextVessel').onclick = () => {
    const i = ORDER().indexOf(state.vessel);
    if (i < ORDER().length - 1) openVessel(ORDER()[i + 1]);
    else if (state.caseIdx < totalCases() - 1) openCase(state.caseIdx + 1); else $('menuBtn').click();
  };

  // --- Trace mode: pick points on the 3-D coronary surface, server extracts the vessel ---
  const trace = { open: false, pts: [] };
  const tcv = $('traceCanvas');
  function traceAvailable() { return isRealCase(state.caseIdx) && typeof Tree3D !== 'undefined' && Tree3D.canTrace(); }
  function renderTrace() {
    if (!trace.open) return;
    const r = tcv.getBoundingClientRect(); if (tcv.width !== Math.round(r.width) || tcv.height !== Math.round(r.height)) { tcv.width = Math.round(r.width); tcv.height = Math.round(r.height); }
    Tree3D.draw(tcv, tree(), { az: state.view.az, el: state.view.el, current: state.vessel, sPos: state.sPos, reveal: false });
    Tree3D.setTracePoints(trace.pts);
    Tree3D.draw(tcv, tree(), { az: state.view.az, el: state.view.el, current: state.vessel, sPos: state.sPos, reveal: false });
    $('traceConfirm').disabled = trace.pts.length < 2;
    $('traceHint').textContent = trace.pts.length ? `${trace.pts.length} point${trace.pts.length > 1 ? 's' : ''} · keep tapping distally, then Confirm` : 'Tap along the vessel on the 3‑D tree, proximal → distal. Drag to rotate.';
  }
  function openTrace() {
    if (!traceAvailable()) return;
    trace.open = true; trace.pts = []; $('traceView').hidden = false; $('traceStatus').textContent = ''; $('traceStatus').className = 'tracestatus';
    state.view.az = 0; state.view.el = 0.05;
    setTimeout(renderTrace, 30);
  }
  function closeTrace() {
    trace.open = false; $('traceView').hidden = true; Tree3D.setTracePoints([]);
    cprKey = ''; requestRender();   // re-bind the renderer to the small locator
  }
  $('traceBtn').onclick = openTrace;
  $('traceCancel').onclick = closeTrace;
  $('traceUndo').onclick = () => { trace.pts.pop(); renderTrace(); };
  $('traceClear').onclick = () => { trace.pts = []; renderTrace(); };
  (() => {
    let down = null;
    tcv.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, az: state.view.az, el: state.view.el, moved: false }; tcv.setPointerCapture(e.pointerId); });
    tcv.addEventListener('pointermove', e => {
      if (!down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) down.moved = true;
      if (down.moved) { state.view.az = down.az - dx * 0.01; state.view.el = Math.max(-1.4, Math.min(1.4, down.el + dy * 0.01)); renderTrace(); }
    });
    tcv.addEventListener('pointerup', e => {
      if (down && !down.moved) {
        const r = tcv.getBoundingClientRect();
        const p = Tree3D.pick(tcv, e.clientX - r.left, e.clientY - r.top);
        if (p) { trace.pts.push(p); $('traceStatus').textContent = ''; }
        else { $('traceStatus').textContent = 'Tap on a coronary (red) to add a point.'; }
        renderTrace();
      }
      down = null;
    });
  })();
  $('traceConfirm').onclick = async () => {
    if (trace.pts.length < 2) return;
    const name = $('traceName').value, id = realIds[state.caseIdx];
    if (tree().vessels[name] && !confirm(`${name} already exists in this case. Replace it?`)) return;
    $('traceStatus').className = 'tracestatus'; $('traceStatus').textContent = `Extracting ${name}… (10–30 s)`; $('traceConfirm').disabled = true;
    try {
      const r = await fetch('/api/trace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ case: id, name, points: trace.pts }) });
      const res = await r.json();
      if (!r.ok) throw new Error(res.error || r.statusText);
      $('traceStatus').className = 'tracestatus ok'; $('traceStatus').textContent = `${name} added: ${res.length_mm} mm, lumen quality ${res.lumen_quality}`;
      Real.invalidate(id); delete trees[state.caseIdx];
      const c = reads[state.caseIdx] || {}; delete c[name];          // fresh read for the new vessel
      saveReads();
      await ensureTree(state.caseIdx);
      setTimeout(() => { closeTrace(); openVessel(name); }, 900);
    } catch (e) {
      $('traceStatus').className = 'tracestatus err'; $('traceStatus').textContent = 'Failed: ' + e.message; $('traceConfirm').disabled = false;
    }
  };

  // --- Menu / settings / summary ---------------------------------------------
  $('menuBtn').onclick = () => {
    $('nCases').value = settings.nCases; $('difficulty').value = settings.difficulty;
    $('ww').value = state.wl.width; $('wlv').value = state.wl.level;
    const all = []; for (const c of Object.values(reads)) for (const r of Object.values(c)) if (r.submitted) all.push(r.result);
    const n = all.length, sum = k => all.reduce((a, r) => a + r[k], 0);
    $('kpis').innerHTML = n ? `
      <div class="kpi"><b>${Math.round(sum('total') / n)}</b><span>mean score</span></div>
      <div class="kpi"><b>${n}</b><span>vessels read</span></div>
      <div class="kpi"><b>${sum('nPlaque') ? Math.round(sum('detected') / sum('nPlaque') * 100) : 100}%</b><span>lesion sensitivity</span></div>
      <div class="kpi"><b>${Math.round(sum('stenExact') / sum('nSegs') * 100)}%</b><span>stenosis exact</span></div>
      <div class="kpi"><b>${Math.round(sum('compOK') / sum('nSegs') * 100)}%</b><span>plaque type</span></div>
      <div class="kpi"><b>${Math.round(sum('hrpOK') / (sum('nSegs') * 4) * 100)}%</b><span>HRP features</span></div>
      <div class="kpi"><b>${Math.round(all.filter(r => r.vesselDelta === 0).length / n * 100)}%</b><span>vessel CAD-RADS</span></div>
      <div class="kpi"><b>${sum('fp')}</b><span>false positives</span></div>` : '<div class="kpi"><span>No vessels submitted yet.</span></div>';
    $('menu').showModal();
  };
  $('closeMenu').onclick = () => $('menu').close();
  $('nCases').onchange = e => { settings.nCases = Math.max(1, Math.min(50, +e.target.value || 10)); saveSettings(); renderHeader(); };
  $('difficulty').onchange = e => { settings.difficulty = e.target.value; saveSettings(); newSet(false); };
  $('ww').oninput = e => { state.wl.width = +e.target.value; requestRender(); };
  $('wlv').oninput = e => { state.wl.level = +e.target.value; requestRender(); };
  $('wlCoronary').onclick = () => { state.wl = { width: 900, level: 250 }; $('ww').value = 900; $('wlv').value = 250; requestRender(); };
  $('wlCalc').onclick = () => { state.wl = { width: 1500, level: 450 }; $('ww').value = 1500; $('wlv').value = 450; requestRender(); };
  function newSet(reseed = true) {
    if (reseed) settings.baseSeed = (Math.random() * 2 ** 31) >>> 0;
    saveSettings(); reads = {}; saveReads(); for (const k in trees) delete trees[k];
    $('menu').close(); openCase(0);
  }
  $('newSet').onclick = () => newSet(true);
  $('resetReads').onclick = () => { reads = {}; saveReads(); $('menu').close(); openCase(state.caseIdx); };
  $('exportCsv').onclick = () => {
    const rows = [['case', 'vessel', 'difficulty', 'segment', 'truth_cat', 'truth_comp', 'read_cat', 'read_comp', 'hrp_correct', 'seg_score', 'vessel_score']];
    for (const [ci, c] of Object.entries(reads)) for (const [vk, r] of Object.entries(c)) if (r.submitted)
      for (const s of r.result.segs) rows.push([+ci + 1, vk, isRealCase(+ci) ? 'real' : settings.difficulty, s.name, s.truth.cat, s.truth.comp, s.read.cat, s.read.comp, s.hrpCorrect, s.score, r.result.total]);
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' })); a.download = 'stenosim_reads.csv'; a.click();
  };

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').then(reg => reg.update()).catch(() => {});
    // When a new service worker takes over, reload once so fresh files are used.
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
  }
  (async () => { realIds = await Real.loadIndex(); openCase(0); })();
})();
