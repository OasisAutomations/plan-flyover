// Plan Flyover: everything stays on this device (IndexedDB). No uploads, no analytics.
import * as pdfjsLib from './vendor/pdf.min.mjs';
import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';
pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
const VER = 'v1.0';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d = 0) => { const n = parseFloat(String(v ?? '').replace(/[$,%\s]/g, '')); return isFinite(n) ? n : d; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const COARSE = matchMedia('(pointer: coarse)').matches;
const PDF_OPTS = { cMapUrl: './vendor/cmaps/', cMapPacked: true, standardFontDataUrl: './vendor/standard_fonts/', isEvalSupported: false };

/* ---------- IndexedDB ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('plan-flyover', 1);
      r.onupgradeneeded = () => { const d = r.result; for (const s of ['projects', 'files', 'meta']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }); };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode), q = fn(t.objectStore(store)); let out;
      if (q) q.onsuccess = () => { out = q.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  get(s, id) { return this.tx(s, 'readonly', st => st.get(id)); },
  all(s) { return this.tx(s, 'readonly', st => st.getAll()); },
  put(s, v) { return this.tx(s, 'readwrite', st => st.put(v)); },
  del(s, id) { return this.tx(s, 'readwrite', st => st.delete(id)); },
};

/* ---------- feet / inches ---------- */
function fmtFtIn(ft) {
  if (ft == null || !isFinite(ft)) return '—';
  const neg = ft < 0; ft = Math.abs(ft);
  const e8 = Math.round(ft * 96); let f = Math.floor(e8 / 96), rem = e8 - f * 96, inch = Math.floor(rem / 8), e = rem - inch * 8, frac = '';
  if (e) { let n = e, d = 8; while (n % 2 === 0) { n /= 2; d /= 2; } frac = ' ' + n + '/' + d; }
  return (neg ? '-' : '') + f + "'-" + inch + frac + '"';
}
const fmtIn = ft => { const i = Math.round(ft * 12 * 8) / 8, w = Math.floor(i), e = Math.round((i - w) * 8); let fr = ''; if (e) { let n = e, d = 8; while (n % 2 === 0) { n /= 2; d /= 2; } fr = ' ' + n + '/' + d; } return w + fr + '"'; };
const fmtN = (n, d = 2) => (n == null || !isFinite(n)) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
function parseInches(s) {   // "6", "6.5", "6 1/2", "1/2"
  s = String(s ?? '').trim().replace(/["”]|in(ch(es)?)?$/i, '').trim(); if (!s) return 0;
  const m = s.match(/^(\d+(?:\.\d+)?)?\s*(?:(\d+)\s*\/\s*(\d+))?$/); if (!m) return NaN;
  let v = m[1] ? parseFloat(m[1]) : 0; if (m[2]) v += parseInt(m[2]) / parseInt(m[3]); return v;
}
// Parse a length typed as 8, 8', 8'6", 8-6, 8 6, 6" (inches when it has only "), 4 1/2"
function parseLen(s, defUnit = 'ft') {
  s = String(s ?? '').trim().toLowerCase().replace(/[’′]/g, "'").replace(/[”″]/g, '"').replace(/\s+/g, ' '); if (!s) return NaN;
  let m = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*-?\s*(.*)$/);
  if (m) { const i = m[2] ? parseInches(m[2]) : 0; return isFinite(i) ? parseFloat(m[1]) + i / 12 : NaN; }
  if (/("|in|inch|inches)$/.test(s)) { const i = parseInches(s); return isFinite(i) ? i / 12 : NaN; }
  m = s.match(/^(\d+)\s*[- ]\s*(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)$/);
  if (m && defUnit === 'ft') { const i = parseInches(m[2]); return isFinite(i) ? parseInt(m[1]) + i / 12 : NaN; }
  const v = parseInches(s); if (!isFinite(v)) return NaN;
  return defUnit === 'ft' ? v : v / 12;
}

/* ---------- scales (ft per plan unit; a PDF unit is 1 pt = 1/72 paper inch) ---------- */
const ARCH = [['1/32"', 1 / 32], ['1/16"', 1 / 16], ['3/32"', 3 / 32], ['1/8"', 1 / 8], ['3/16"', 3 / 16], ['1/4"', 1 / 4], ['3/8"', 3 / 8], ['1/2"', 1 / 2], ['3/4"', 3 / 4], ['1"', 1], ['1 1/2"', 1.5], ['3"', 3]];
const ENG = [10, 20, 30, 40, 50, 60, 100, 200];
const METRIC = [1, 5, 10, 20, 25, 50, 75, 100, 200, 250, 500, 1000];
const SCALES = [   // ftPerIn = real feet per paper inch
  ...ARCH.map(([l, x]) => ({ group: 'Architectural', label: `${l} = 1'-0"`, ftPerIn: 1 / x })),
  ...ENG.map(f => ({ group: 'Engineering', label: `1" = ${f}'`, ftPerIn: f })),
  ...METRIC.map(n => ({ group: 'Metric', label: `1:${n}`, ftPerIn: n / 12 })),
];
const unitsPerIn = () => S.project?.plan?.kind === 'image' ? (S.project.plan.dpi || 150) : 72;
function nearPreset(k) { const fpi = k * unitsPerIn(); const p = SCALES.find(s => Math.abs(s.ftPerIn - fpi) / s.ftPerIn < 0.01); return p ? p.label : null; }

/* ---------- state ---------- */
const S = {
  project: null, pdf: null, planCanvas: null, W: 0, H: 0, res: 1, z: 1, tx: 0, ty: 0,
  tool: 'select', drawing: null, hover: null, sel: null, undo: [], redo: [], view: 'plan', snap: true,
};
const K = () => S.project?.k || 0;   // ft per plan unit

/* ---------- UI helpers ---------- */
function toast(msg, ms = 2400) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), ms); }
function setSave(s) { $('#saveState').textContent = s; }
function openModal(html, mount, cls = '') {
  const back = $('#modalBack'), m = $('#modal'); m.className = cls; m.innerHTML = html; back.classList.remove('hidden');
  const close = () => { back.classList.add('hidden'); m.innerHTML = ''; };
  m.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
  if (mount) mount(m, close);
  const f = m.querySelector('[autofocus]'); if (f && !COARSE) { f.focus(); f.select?.(); }
  return close;
}
const modalOpen = () => !$('#modalBack').classList.contains('hidden');
function askText(title, label, value = '') {
  return new Promise(res => {
    openModal(`<h3>${esc(title)}</h3><form id="af"><div class="field"><label>${esc(label)}</label><input id="aval" value="${esc(value)}" autofocus></div>
      <div class="btns"><button type="button" data-close>Cancel</button><button class="accent">OK</button></div></form>`, (m, close) => {
      m.querySelector('[data-close]').onclick = () => { close(); res(null); };
      m.querySelector('#af').onsubmit = e => { e.preventDefault(); const v = m.querySelector('#aval').value.trim(); close(); res(v || null); };
    });
  });
}
function askConfirm(title, msg, okLabel = 'Delete') {
  return new Promise(res => {
    openModal(`<h3>${esc(title)}</h3><p>${msg}</p><div class="btns"><button id="cn">Cancel</button><button id="cy" class="accent">${esc(okLabel)}</button></div>`, (m, close) => {
      m.querySelector('#cn').onclick = () => { close(); res(false); };
      m.querySelector('#cy').onclick = () => { close(); res(true); };
    });
  });
}
function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const safeName = s => String(s || 'project').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'project';

/* ---------- saving ---------- */
let saveT;
function touch() { if (!S.project) return; S.project.updated = Date.now(); S.dirty3d = true; setSave('Saving…'); clearTimeout(saveT); saveT = setTimeout(flush, 300); }
async function flush() { clearTimeout(saveT); if (!S.project) return; try { await DB.put('projects', S.project); setSave('Saved'); } catch (e) { setSave('Save failed'); console.warn(e); } }
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
window.addEventListener('pagehide', () => flush());

/* ---------- projects ---------- */
function newProjectObj(name) {
  return { id: uid(), name: name || 'Untitled plan', created: Date.now(), updated: Date.now(), plan: null, k: 0, scaleLabel: '',
    walls: [], openings: [], defH: 8, defT: 4.5 / 12 };
}
async function loadProject(p) {
  await flush();
  S.project = p; S.undo = []; S.redo = []; S.sel = null; S.drawing = null; S.pdf = null; S.planCanvas = null; S.dirty3d = true;
  await DB.put('meta', { id: 'last', projectId: p.id });
  $('#projName').textContent = p.name;
  $('#defH').value = fmtFtIn(p.defH); $('#defT').value = fmtIn(p.defT);
  if (p.plan) { try { await renderPlan(); } catch (e) { console.warn(e); toast('Could not open this plan file'); clearPlanView(); } }
  else clearPlanView();
  updateScaleLabel(); renderOverlay(); refreshPanel();
  if (S.view === 'three') show3D();
}
async function createProject(name) { const p = newProjectObj(name); await DB.put('projects', p); await loadProject(p); return p; }

/* ---------- plan files (PDF or image) ---------- */
async function getPdf() {
  if (S.pdf) return S.pdf;
  const f = await DB.get('files', S.project.plan.fileId); if (!f) throw new Error('plan file missing');
  S.pdf = await pdfjsLib.getDocument({ data: new Uint8Array(f.data.slice(0)), ...PDF_OPTS }).promise; return S.pdf;
}
async function openPlanFile(file) {
  if (!file) return;
  if (!S.project) await createProject(file.name.replace(/\.[^.]+$/, ''));
  const data = await file.arrayBuffer(), isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
  if (!isPdf && !/^image\//.test(file.type)) return toast('Pick a PDF or an image file');
  let page = 1;
  if (isPdf) {
    let pdf; try { pdf = await pdfjsLib.getDocument({ data: new Uint8Array(data.slice(0)), ...PDF_OPTS }).promise; } catch (e) { console.warn(e); return toast('That PDF could not be opened'); }
    if (pdf.numPages > 1) { page = await pickPage(pdf); if (!page) return; }
    S.pdf = pdf;
  } else S.pdf = null;
  const fileId = uid(); await DB.put('files', { id: fileId, name: file.name, type: file.type || (isPdf ? 'application/pdf' : 'image/png'), data });
  const P = S.project, old = P.plan?.fileId;
  pushUndo();
  P.plan = { kind: isPdf ? 'pdf' : 'image', fileId, name: file.name, page, dpi: isPdf ? 72 : 150 };
  P.k = 0; P.scaleLabel = '';
  if (old && old !== fileId) DB.del('files', old).catch(() => { });
  S.undo = []; S.redo = [];   // undo can't bring back the old file
  touch(); await renderPlan(); updateScaleLabel(); renderOverlay(); refreshPanel();
  toast('Plan loaded. Next: set the scale.'); setTimeout(() => scaleModal('wall'), 350);
}
function pickPage(pdf) {
  return new Promise(res => {
    const n = pdf.numPages;
    openModal(`<h3>Pick the floor plan page</h3><p class="muted small">${n} pages in this PDF.</p><div class="pages" id="pgGrid">${Array.from({ length: n }, (_, i) => `<button data-p="${i + 1}"><canvas></canvas><span>Page ${i + 1}</span></button>`).join('')}</div>
      <div class="btns"><button data-close>Cancel</button></div>`, (m, close) => {
      m.querySelector('[data-close]').onclick = () => { close(); res(0); };
      m.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { close(); res(+b.dataset.p); });
      (async () => { for (const b of m.querySelectorAll('[data-p]')) { try { const pg = await pdf.getPage(+b.dataset.p), v1 = pg.getViewport({ scale: 1 }), sc = 220 / Math.max(v1.width, v1.height), vp = pg.getViewport({ scale: sc }), c = b.querySelector('canvas'); c.width = vp.width; c.height = vp.height; await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; } catch { } } })();
    }, 'wide');
  });
}
async function renderPlan() {
  const P = S.project, plan = P.plan, c = $('#planCanvas');
  let src;
  if (plan.kind === 'pdf') {
    const pdf = await getPdf(), pg = await pdf.getPage(clamp(plan.page, 1, pdf.numPages)), v1 = pg.getViewport({ scale: 1 });
    S.W = v1.width; S.H = v1.height;
    const b = Math.min((COARSE ? 3072 : 4096) / Math.max(S.W, S.H), 4, Math.sqrt(14e6 / (S.W * S.H)));
    const vp = pg.getViewport({ scale: b }); src = document.createElement('canvas'); src.width = Math.floor(vp.width); src.height = Math.floor(vp.height);
    const ctx = src.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, src.width, src.height);
    await pg.render({ canvasContext: ctx, viewport: vp }).promise; S.res = src.width / S.W;
  } else {
    const f = await DB.get('files', plan.fileId); const bmp = await createImageBitmap(new Blob([f.data], { type: f.type }));
    S.W = bmp.width; S.H = bmp.height; const b = Math.min(1, 4096 / Math.max(S.W, S.H));
    src = document.createElement('canvas'); src.width = Math.round(S.W * b); src.height = Math.round(S.H * b);
    const ctx = src.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, src.width, src.height); ctx.drawImage(bmp, 0, 0, src.width, src.height); S.res = src.width / S.W;
  }
  S.planCanvas = src; c.width = src.width; c.height = src.height; c.getContext('2d').drawImage(src, 0, 0);
  const stage = $('#stage'); for (const el of [stage, c]) { el.style.width = S.W + 'px'; el.style.height = S.H + 'px'; }
  const svg = $('#overlay'); svg.setAttribute('viewBox', `0 0 ${S.W} ${S.H}`); svg.setAttribute('width', S.W); svg.setAttribute('height', S.H);
  stage.style.display = 'block'; $('#empty').style.display = 'none';
  $('#planInfo').innerHTML = `${esc(plan.name)}${plan.kind === 'pdf' ? ` · page ${plan.page}` : ''}`;
  S.dirty3d = true; S.texDirty = true; fitPlan();
}
function clearPlanView() { S.W = S.H = 0; S.planCanvas = null; $('#stage').style.display = 'none'; $('#empty').style.display = ''; $('#planInfo').textContent = 'No plan yet.'; }

/* ======================= GEOMETRY ======================= */
const OPEN_DEF = { door: { sill: 0, head: 80 / 12, w: 3 }, window: { sill: 3, head: 80 / 12, w: 3 } };
function wallSegs(w) {
  const out = []; for (let i = 1; i < w.pts.length; i++) out.push({ a: w.pts[i - 1], b: w.pts[i], i, w });
  if (w.closed && w.pts.length > 2) out.push({ a: w.pts[w.pts.length - 1], b: w.pts[0], i: w.pts.length, w });
  return out.map((s, j) => ({ ...s, i: j }));
}
const allSegs = () => (S.project?.walls || []).flatMap(wallSegs);
function segDistT(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0; t = clamp(t, 0, 1); return { d: Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy), t, q: [a[0] + t * dx, a[1] + t * dy] }; }
const segLen = s => dist(s.a, s.b);
function polyArea(pts) { let s = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]); return s / 2; }
function inPoly(p, pts) { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i], b = pts[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
const openingsOf = (wallId, seg) => (S.project?.openings || []).filter(o => o.wallId === wallId && (seg == null || o.seg === seg));
// clamp openings to their segment, drop ones whose wall/segment is gone
function sanitizeOpenings() {
  const P = S.project, k = K(); if (!P) return;
  P.openings = P.openings.filter(o => {
    const w = P.walls.find(x => x.id === o.wallId); if (!w) return false;
    const s = wallSegs(w)[o.seg]; if (!s) return false;
    const L = segLen(s), hw = k ? o.w / 2 / k : 0; if (L < hw * 2) return false;
    o.d = clamp(o.d, hw, L - hw); return true;
  });
}

/* ---------- rooms: planar faces of the wall centerlines ---------- */
function roomFaces() {
  const k = K(); const segs = allSegs(); if (!segs.length || !k) return [];
  const eps = Math.max(0.03 / k, 1e-6);
  // split every segment where it meets another one
  const cuts = segs.map(() => [0, 1]);
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const A = segs[i], B = segs[j], r = [A.b[0] - A.a[0], A.b[1] - A.a[1]], s = [B.b[0] - B.a[0], B.b[1] - B.a[1]];
    const den = r[0] * s[1] - r[1] * s[0], qp = [B.a[0] - A.a[0], B.a[1] - A.a[1]];
    const LA = Math.hypot(...r), LB = Math.hypot(...s); if (!LA || !LB) continue;
    if (Math.abs(den) > 1e-9 * LA * LB) {
      const t = (qp[0] * s[1] - qp[1] * s[0]) / den, u = (qp[0] * r[1] - qp[1] * r[0]) / den;
      if (t > -eps / LA && t < 1 + eps / LA && u > -eps / LB && u < 1 + eps / LB) { cuts[i].push(clamp(t, 0, 1)); cuts[j].push(clamp(u, 0, 1)); }
    }
    // endpoints lying on the other segment (T-joints, overlaps)
    for (const [P, Q, ci] of [[B.a, A, i], [B.b, A, i], [A.a, B, j], [A.b, B, j]]) { const h = segDistT(P, Q.a, Q.b); if (h.d < eps) cuts[ci].push(h.t); }
  }
  const V = [], vid = p => { for (let i = 0; i < V.length; i++) if (dist(V[i], p) < eps) return i; V.push(p); return V.length - 1; };
  const E = new Map();
  segs.forEach((sg, i) => {
    const ts = [...new Set(cuts[i].map(t => Math.round(t * 1e7) / 1e7))].sort((a, b) => a - b);
    for (let n = 1; n < ts.length; n++) {
      const pa = [sg.a[0] + (sg.b[0] - sg.a[0]) * ts[n - 1], sg.a[1] + (sg.b[1] - sg.a[1]) * ts[n - 1]], pb = [sg.a[0] + (sg.b[0] - sg.a[0]) * ts[n], sg.a[1] + (sg.b[1] - sg.a[1]) * ts[n]];
      const u = vid(pa), v = vid(pb); if (u === v) continue;
      const key = u < v ? u + '-' + v : v + '-' + u; const t = sg.w.t;
      E.set(key, { u: Math.min(u, v), v: Math.max(u, v), t: Math.max(t, E.get(key)?.t || 0) });
    }
  });
  const adj = V.map(() => new Map());
  for (const e of E.values()) { adj[e.u].set(e.v, e.t); adj[e.v].set(e.u, e.t); }
  let pruned = true; while (pruned) { pruned = false; for (let i = 0; i < V.length; i++) if (adj[i].size === 1) { const [j] = adj[i].keys(); adj[i].delete(j); adj[j].delete(i); pruned = true; } }
  const order = adj.map((m, i) => [...m.keys()].sort((a, b) => Math.atan2(V[a][1] - V[i][1], V[a][0] - V[i][0]) - Math.atan2(V[b][1] - V[i][1], V[b][0] - V[i][0])));
  const used = new Set(), faces = [];
  for (let u = 0; u < V.length; u++) for (const v of order[u]) {
    if (used.has(u + '>' + v)) continue;
    const cyc = []; let a = u, b = v, guard = 0;
    while (!used.has(a + '>' + b) && guard++ < 10000) {
      used.add(a + '>' + b); cyc.push(a);
      const ob = order[b], idx = ob.indexOf(a), c = ob[(idx - 1 + ob.length) % ob.length]; a = b; b = c;
    }
    if (cyc.length >= 3) faces.push({ vs: cyc, pts: cyc.map(i => V[i]), A: polyArea(cyc.map(i => V[i])) });
  }
  if (!faces.length) return [];
  const outer = faces.reduce((m, f) => Math.abs(f.A) > Math.abs(m.A) ? f : m, faces[0]), sgn = -Math.sign(outer.A);
  return faces.filter(f => Math.sign(f.A) === sgn && Math.abs(f.A) * k * k > 0.25).map(f => {
    // net floor: offset every edge inward by half its wall thickness
    const n = f.pts.length, pts = sgn > 0 ? f.pts : [...f.pts].reverse(), vs = sgn > 0 ? f.vs : [...f.vs].reverse();
    const lines = pts.map((p, i) => { const q = pts[(i + 1) % n], dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy) || 1, d = (adj[vs[i]].get(vs[(i + 1) % n]) || 0) / 2 / k;
      return { p: [p[0] - dy / L * d, p[1] + dx / L * d], u: [dx / L, dy / L] }; });
    const net = lines.map((l, i) => { const m = lines[(i - 1 + n) % n], den = m.u[0] * l.u[1] - m.u[1] * l.u[0];
      if (Math.abs(den) < 1e-9) return l.p; const w = [l.p[0] - m.p[0], l.p[1] - m.p[1]], t = (w[0] * l.u[1] - w[1] * l.u[0]) / den; return [m.p[0] + m.u[0] * t, m.p[1] + m.u[1] * t]; });
    const cx = pts.reduce((s, p) => s + p[0], 0) / n, cy = pts.reduce((s, p) => s + p[1], 0) / n;
    return { pts, net, sf: Math.abs(f.A) * k * k, netSf: Math.max(0, polyArea(net)) * k * k, c: [cx, cy] };
  });
}
function polyCentroid(pts) { let a = 0, x = 0, y = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]; a += f; x += (pts[j][0] + pts[i][0]) * f; y += (pts[j][1] + pts[i][1]) * f; } return a ? [x / (3 * a), y / (3 * a)] : pts[0]; }

function computeStats() {
  const P = S.project, k = K(); const r = { lf: 0, gross: 0, open: 0, net: 0, floor: 0, floorNet: 0, rooms: [], walls: P?.walls.length || 0, doors: 0, windows: 0 };
  if (!P || !k) return r;
  for (const s of allSegs()) { const L = segLen(s) * k; r.lf += L; r.gross += L * s.w.h; }
  for (const o of P.openings) { const w = P.walls.find(x => x.id === o.wallId); if (!w) continue; const hgt = Math.max(0, Math.min(o.head, w.h) - Math.min(o.sill, w.h)); r.open += o.w * hgt; o.type === 'door' ? r.doors++ : r.windows++; }
  r.net = r.gross - r.open; r.rooms = roomFaces(); r.floor = r.rooms.reduce((s, f) => s + f.sf, 0); r.floorNet = r.rooms.reduce((s, f) => s + f.netSf, 0);
  return r;
}

/* ---------- wall pieces for 3D + walk collisions (feet, plan-aligned) ---------- */
function wallPieces() {
  const P = S.project, k = K(), out = []; if (!P || !k) return out;
  const segs = allSegs(), eps = 0.05 / k;
  const joined = (p, self) => segs.some(o => o !== self && (dist(o.a, p) < eps || dist(o.b, p) < eps));
  for (const s of segs) {
    const L = segLen(s) * k; if (L < 1e-3) continue;
    const h = s.w.h, t = s.w.t, ux = (s.b[0] - s.a[0]) * k / L, uy = (s.b[1] - s.a[1]) * k / L;
    const e0 = joined(s.a, s) ? t / 2 : 0, e1 = joined(s.b, s) ? t / 2 : 0;
    const ops = openingsOf(s.w.id, s.i).map(o => ({ o, s0: o.d * k - o.w / 2, s1: o.d * k + o.w / 2 })).sort((a, b) => a.s0 - b.s0);
    const add = (s0, s1, y0, y1, kind, o) => { if (s1 - s0 > 1e-4 && y1 - y0 > 1e-4) out.push({ seg: s, a: [s.a[0] * k + ux * s0, s.a[1] * k + uy * s0], b: [s.a[0] * k + ux * s1, s.a[1] * k + uy * s1], y0, y1, t, kind, o }); };
    let cur = -e0;
    for (const { o, s0, s1 } of ops) {
      add(cur, s0, 0, h, 'wall');
      add(s0, s1, 0, Math.min(o.sill, h), 'wall');
      add(s0, s1, Math.min(o.head, h), h, 'wall');
      if (o.type === 'window') add(s0, s1, Math.min(o.sill, h), Math.min(o.head, h), 'glass', o);
      cur = s1;
    }
    add(cur, L + e1, 0, h, 'wall');
  }
  return out;
}

/* ======================= 2D PLAN VIEW ======================= */
const viewer = $('#viewer'), stage = $('#stage'), svg = $('#overlay');
let ovRaf = 0;
function applyT() {
  stage.style.transform = `translate(${S.tx}px,${S.ty}px) scale(${S.z})`;
  if (!ovRaf) ovRaf = requestAnimationFrame(() => { ovRaf = 0; renderOverlay(); });
}
const fitZ = () => Math.min((viewer.clientWidth - 30) / S.W, (viewer.clientHeight - 30) / S.H);
function fitPlan() { if (!S.W || viewer.clientWidth < 40 || viewer.clientHeight < 40) return; S.z = fitZ(); S.tx = (viewer.clientWidth - S.W * S.z) / 2; S.ty = (viewer.clientHeight - S.H * S.z) / 2; applyT(); }
function zoomAt(f, sx, sy) { if (!S.W) return; const nz = clamp(S.z * f, fitZ() * 0.3, 80), px = (sx - S.tx) / S.z, py = (sy - S.ty) / S.z; S.z = nz; S.tx = sx - px * nz; S.ty = sy - py * nz; applyT(); }
const toPlan = (sx, sy) => [(sx - S.tx) / S.z, (sy - S.ty) / S.z];
const toScreen = (x, y) => { const r = viewer.getBoundingClientRect(); return [r.left + S.tx + x * S.z, r.top + S.ty + y * S.z]; };
new ResizeObserver(() => { if (S.W && !S.userZoomed) fitPlan(); }).observe(viewer);

/* ---------- undo ---------- */
const snapState = () => JSON.stringify({ walls: S.project.walls, openings: S.project.openings, k: S.project.k, scaleLabel: S.project.scaleLabel });
function pushUndo() { if (!S.project) return; S.undo.push(snapState()); if (S.undo.length > 200) S.undo.shift(); S.redo = []; }
function restoreState(s) { const o = JSON.parse(s); Object.assign(S.project, o); S.sel = null; touch(); updateScaleLabel(); renderOverlay(); refreshPanel(); }
function undo() {
  if (S.drawing?.pts.length) { S.drawing.pts.pop(); if (!S.drawing.pts.length) S.drawing = null; updateFinish(); renderOverlay(); return; }
  if (!S.undo.length) return toast('Nothing to undo'); S.redo.push(snapState()); restoreState(S.undo.pop());
}
function redo() { if (!S.redo.length) return toast('Nothing to redo'); S.undo.push(snapState()); restoreState(S.redo.pop()); }

/* ---------- tools ---------- */
const HINTS = {
  wall: 'Wall: tap each corner. Tap the first point to close the room · double-tap, Enter or ✓ Finish to end.',
  door: 'Door: tap on a wall to cut a door (width from the toolbar).',
  window: 'Window: tap on a wall to add a window (width from the toolbar).',
  calibrate: 'Calibrate: tap both ends of a dimension you know.',
  select: '',
};
function setTool(t) {
  if (!S.W && t !== 'select') { toast('Open a floor plan first'); return; }
  if (t !== 'calibrate' && t !== 'select' && !K()) { scaleModal(t); return; }
  S.drawing = null; S.hover = null; S.tool = t;
  $$('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  viewer.classList.toggle('drawing', t !== 'select');
  const h = $('#hint'); h.textContent = HINTS[t] || ''; h.classList.toggle('on', !!HINTS[t]);
  updateFinish(); renderOverlay();
}
function updateFinish() { $('#btnFinish').disabled = !(S.drawing && S.drawing.pts.length >= 2 && S.drawing.type === 'wall'); $('#btnDel').disabled = !S.sel; }
function finishWall(closed = false) {
  const d = S.drawing; if (!d || d.type !== 'wall') return;
  if (d.pts.length < 2) { S.drawing = null; renderOverlay(); updateFinish(); return; }
  if (closed && d.pts.length < 3) closed = false;
  pushUndo();
  const P = S.project, w = { id: uid(), pts: d.pts, closed, h: P.defH, t: P.defT };
  P.walls.push(w); S.drawing = null; S.hover = null; S.sel = { type: 'wall', id: w.id };
  touch(); updateFinish(); renderOverlay(); refreshPanel();
}
function deleteSel() {
  const s = S.sel, P = S.project; if (!s) return; pushUndo();
  if (s.type === 'wall') { P.walls = P.walls.filter(w => w.id !== s.id); }
  else P.openings = P.openings.filter(o => o.id !== s.id);
  sanitizeOpenings(); S.sel = null; touch(); updateFinish(); renderOverlay(); refreshPanel();
}

/* ---------- snapping ---------- */
const snapTol = () => (COARSE ? 18 : 11) / S.z;
function snapPoint(raw, from, noSnap, skip) {
  if (noSnap || !S.snap) return { p: raw, kind: '' };
  const tol = snapTol();
  let best = null, bd = tol;
  const verts = []; for (const w of S.project.walls) w.pts.forEach((p, i) => { if (!(skip && skip.w === w && skip.i === i)) verts.push(p); });
  if (S.drawing) S.drawing.pts.forEach(p => verts.push(p));
  for (const v of verts) { const d = dist(v, raw); if (d < bd) { bd = d; best = v; } }
  if (best && (!from || dist(best, from) > 1e-9)) return { p: [...best], kind: 'end' };
  const segs = allSegs().filter(s => !(skip && s.w === skip.w && (s.i === skip.i || s.i === skip.i - 1 || (s.w.closed && skip.i === 0 && s.i === s.w.pts.length - 1))));
  if (from) {
    const a = Math.atan2(raw[1] - from[1], raw[0] - from[0]), sa = Math.round(a / (Math.PI / 4)) * (Math.PI / 4), u = [Math.cos(sa), Math.sin(sa)];
    const L = (raw[0] - from[0]) * u[0] + (raw[1] - from[1]) * u[1], p = [from[0] + u[0] * L, from[1] + u[1] * L];
    // where the snapped ray crosses an existing wall
    let hit = null, hd = tol;
    for (const s of segs) {
      const r = [s.b[0] - s.a[0], s.b[1] - s.a[1]], den = u[0] * r[1] - u[1] * r[0]; if (Math.abs(den) < 1e-9) continue;
      const q = [s.a[0] - from[0], s.a[1] - from[1]], t = (q[0] * r[1] - q[1] * r[0]) / den, v = (q[0] * u[1] - q[1] * u[0]) / den;
      if (v < 0 || v > 1 || t <= 1e-6) continue; const ip = [from[0] + u[0] * t, from[1] + u[1] * t], d = dist(ip, p); if (d < hd) { hd = d; hit = ip; }
    }
    if (hit) return { p: hit, kind: 'wall' };
    // line up with an existing corner along the snapped direction
    let al = null, ad = tol;
    for (const v of verts) { if (dist(v, from) < 1e-9) continue; if (Math.abs(u[0]) > 0.99) { const d = Math.abs(v[0] - p[0]); if (d < ad) { ad = d; al = [v[0], from[1] + (v[0] - from[0]) * u[1] / u[0]]; } } else if (Math.abs(u[1]) > 0.99) { const d = Math.abs(v[1] - p[1]); if (d < ad) { ad = d; al = [from[0] + (v[1] - from[1]) * u[0] / u[1], v[1]]; } } }
    if (al) return { p: al, kind: 'align' };
    return { p, kind: 'angle' };
  }
  let hit = null, hd = tol;
  for (const s of segs) { const h = segDistT(raw, s.a, s.b); if (h.d < hd) { hd = h.d; hit = h.q; } }
  return hit ? { p: hit, kind: 'wall' } : { p: raw, kind: '' };
}

/* ---------- hit testing ---------- */
function hitOpening(q) {
  const tol = snapTol(); let best = null, bd = Infinity;
  for (const o of S.project.openings) { const g = openingGeom(o); if (!g) continue; const d = segDistT(q, g.a, g.b).d - g.t / 2; if (d < tol && d < bd) { bd = d; best = o; } }
  return best;
}
function hitWall(q) {
  const tol = snapTol(), k = K(); let best = null, bd = Infinity;
  for (const s of allSegs()) { const d = segDistT(q, s.a, s.b).d - (k ? s.w.t / k / 2 : 0); if (d < tol && d < bd) { bd = d; best = s; } }
  return best;
}
function hitHandle(q) {
  if (S.sel?.type !== 'wall') return null; const w = S.project.walls.find(x => x.id === S.sel.id); if (!w) return null;
  const tol = (COARSE ? 20 : 10) / S.z; let bi = -1, bd = tol;
  w.pts.forEach((p, i) => { const d = dist(p, q); if (d < bd) { bd = d; bi = i; } });
  return bi >= 0 ? { w, i: bi } : null;
}
function openingGeom(o) {
  const w = S.project.walls.find(x => x.id === o.wallId); if (!w) return null; const s = wallSegs(w)[o.seg]; if (!s) return null;
  const L = segLen(s), k = K(); if (!L || !k) return null; const u = [(s.b[0] - s.a[0]) / L, (s.b[1] - s.a[1]) / L], hw = o.w / 2 / k;
  return { a: [s.a[0] + u[0] * (o.d - hw), s.a[1] + u[1] * (o.d - hw)], b: [s.a[0] + u[0] * (o.d + hw), s.a[1] + u[1] * (o.d + hw)], u, t: w.t / k, s, w };
}
function addOpening(q, type) {
  const s = hitWall(q); if (!s) return toast('Tap right on a wall');
  const k = K(), wft = parseLen($('#openW').value); if (!(wft > 0)) return toast('Enter an opening width');
  const L = segLen(s), hw = wft / 2 / k; if (L < hw * 2 + 1e-9) return toast(`That wall piece is only ${fmtFtIn(L * k)} long`);
  const h = segDistT(q, s.a, s.b); pushUndo();
  const o = { id: uid(), wallId: s.w.id, seg: s.i, d: clamp(h.t * L, hw, L - hw), w: wft, type, sill: OPEN_DEF[type].sill, head: Math.min(OPEN_DEF[type].head, s.w.h) };
  S.project.openings.push(o); S.sel = { type: 'opening', id: o.id }; touch(); updateFinish(); renderOverlay(); refreshPanel();
}

/* ---------- tap handling ---------- */
function tap(sx, sy, e) {
  if (!S.W) return;
  const q = toPlan(sx, sy), t = S.tool, noSnap = e.shiftKey;
  if (t === 'select') {
    const o = hitOpening(q), w = o ? null : hitWall(q);
    S.sel = o ? { type: 'opening', id: o.id } : w ? { type: 'wall', id: w.w.id } : null;
    updateFinish(); renderOverlay(); refreshPanel(); return;
  }
  if (t === 'door' || t === 'window') return addOpening(q, t);
  if (!S.drawing) S.drawing = { type: t, pts: [] };
  const d = S.drawing, now = Date.now(), last = d.pts[d.pts.length - 1];
  const sp = snapPoint(q, last, noSnap).p;
  if (last && t === 'wall') {
    if (now - (S.lastTap || 0) < 380 && dist(last, q) * S.z < 14) { S.lastTap = 0; finishWall(false); return; }
    if (d.pts.length >= 3 && (dist(d.pts[0], sp) * S.z < 3 || dist(d.pts[0], q) * S.z < (COARSE ? 18 : 11))) { finishWall(true); return; }
    if (dist(last, sp) * S.z < 2) return;
  }
  S.lastTap = now; d.pts.push(sp); S.hover = null; updateFinish(); renderOverlay();
  if (t === 'calibrate' && d.pts.length === 2) { const pts = d.pts; S.drawing = null; renderOverlay(); calibrateModal(dist(pts[0], pts[1])); }
}

/* ---------- overlay rendering ---------- */
const OC = { wall: '#2f9e91', wallSel: '#58d3c2', center: '#123c38', door: '#d08a4a', window: '#5aa9d6', draw: '#e0884a', cal: '#d1495b' };
function renderOverlay() {
  if (!S.project || !S.W) { svg.innerHTML = ''; return; }
  const z = S.z, k = K(), px = n => n / z, P = S.project; let h = '';
  const fs = px(COARSE ? 13 : 11.5);
  const label = (x, y, txt, col = '#0f3330') => `<text x="${x}" y="${y}" font-size="${fs}" fill="${col}" stroke="#fff" stroke-width="${px(3)}" paint-order="stroke" text-anchor="middle" dominant-baseline="middle" font-weight="600">${esc(txt)}</text>`;
  // rooms
  const rooms = k ? roomFaces() : [];
  rooms.forEach((r, i) => { h += `<polygon points="${r.pts.map(p => p.join(',')).join(' ')}" fill="#2f9e91" fill-opacity=".10"/>`; });
  // walls
  for (const w of P.walls) {
    const sel = S.sel?.type === 'wall' && S.sel.id === w.id, sw = Math.max(k ? w.t / k : px(4), px(3));
    const pts = w.pts.map(p => p.join(',')).join(' '), tag = w.closed ? 'polygon' : 'polyline';
    h += `<${tag} points="${pts}" fill="none" stroke="${sel ? OC.wallSel : OC.wall}" stroke-opacity="${sel ? .8 : .62}" stroke-width="${sw}" stroke-linejoin="miter" stroke-miterlimit="10" stroke-linecap="butt"/>`;
    h += `<${tag} points="${pts}" fill="none" stroke="${OC.center}" stroke-width="${px(1)}" stroke-dasharray="${px(6)} ${px(3)}"/>`;
  }
  // openings
  for (const o of P.openings) {
    const g = openingGeom(o); if (!g) continue; const sel = S.sel?.type === 'opening' && S.sel.id === o.id, col = OC[o.type];
    h += `<line x1="${g.a[0]}" y1="${g.a[1]}" x2="${g.b[0]}" y2="${g.b[1]}" stroke="#fff" stroke-width="${Math.max(g.t, px(3)) + px(1)}"/>`;
    h += `<line x1="${g.a[0]}" y1="${g.a[1]}" x2="${g.b[0]}" y2="${g.b[1]}" stroke="${col}" stroke-opacity="${sel ? 1 : .75}" stroke-width="${Math.max(g.t * (o.type === 'window' ? .45 : 1), px(3))}"/>`;
    if (o.type === 'door') { const r = dist(g.a, g.b), n = [-g.u[1], g.u[0]], e = [g.a[0] + n[0] * r, g.a[1] + n[1] * r]; h += `<path d="M${g.a[0]},${g.a[1]} L${e[0]},${e[1]} A${r},${r} 0 0 1 ${g.b[0]},${g.b[1]}" fill="none" stroke="${col}" stroke-width="${px(1.2)}" stroke-dasharray="${px(4)} ${px(2)}"/>`; }
    if (sel) h += `<line x1="${g.a[0]}" y1="${g.a[1]}" x2="${g.b[0]}" y2="${g.b[1]}" stroke="#fff" stroke-width="${px(1.5)}" stroke-dasharray="${px(3)} ${px(3)}"/>`;
  }
  // dimensions on every wall piece long enough to read
  if (k) for (const s of allSegs()) {
    const L = segLen(s); if (L * z < 46) continue; const m = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2], n = [-(s.b[1] - s.a[1]) / L, (s.b[0] - s.a[0]) / L], off = s.w.t / k / 2 + px(10);
    h += label(m[0] + n[0] * off, m[1] + n[1] * off, fmtFtIn(L * k));
  }
  rooms.forEach((r, i) => { const c = polyCentroid(r.pts), inside = inPoly(c, r.pts) ? c : r.c; h += label(inside[0], inside[1] - fs * .7, `Room ${i + 1}`, '#1f6f66') + label(inside[0], inside[1] + fs * .7, `${fmtN(r.sf, 1)} SF`, '#1f6f66'); });
  // selected wall handles
  if (S.sel?.type === 'wall') { const w = P.walls.find(x => x.id === S.sel.id); if (w) for (const p of w.pts) h += `<circle cx="${p[0]}" cy="${p[1]}" r="${px(COARSE ? 9 : 6)}" fill="#fff" stroke="${OC.wallSel}" stroke-width="${px(2.5)}"/>`; }
  // drawing in progress
  const d = S.drawing, live = $('#live'); live.style.display = 'none';
  if (d) {
    const col = d.type === 'calibrate' ? OC.cal : OC.draw, pts = [...d.pts]; let sk = '';
    if (S.hover && pts.length) { const r = snapPoint(S.hover, pts[pts.length - 1], S.hoverShift); pts.push(r.p); sk = r.kind; }
    else if (S.hover) { const r = snapPoint(S.hover, null, S.hoverShift); sk = r.kind; if (sk) h += `<circle cx="${r.p[0]}" cy="${r.p[1]}" r="${px(7)}" fill="none" stroke="#e0884a" stroke-width="${px(2)}"/>`; }
    if (pts.length > 1 && d.type === 'wall' && k) h += `<polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="none" stroke="${col}" stroke-opacity=".35" stroke-width="${Math.max(P.defT / k, px(3))}" stroke-linejoin="miter"/>`;
    if (pts.length > 1) h += `<polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="none" stroke="${col}" stroke-width="${px(2)}"/>`;
    pts.forEach((p, i) => { h += `<circle cx="${p[0]}" cy="${p[1]}" r="${px(i === 0 && d.type === 'wall' && pts.length > 3 ? 7 : 4)}" fill="${i === 0 ? '#fff' : col}" stroke="${col}" stroke-width="${px(2)}"/>`; });
    if (sk && S.hover && d.pts.length) { const p = pts[pts.length - 1]; h += `<circle cx="${p[0]}" cy="${p[1]}" r="${px(7)}" fill="none" stroke="${sk === 'end' ? '#fff' : '#e0884a'}" stroke-width="${px(2)}"/>`; }
    if (pts.length > 1) {
      const a = pts[pts.length - 2], b = pts[pts.length - 1], Lp = dist(a, b), [sx, sy] = [S.tx + b[0] * z, S.ty + b[1] * z];
      live.textContent = (k ? fmtFtIn(Lp * k) : fmtN(Lp / unitsPerIn(), 2) + '" on sheet') + (sk ? ` · ${{ end: 'corner', wall: 'on wall', angle: Math.round((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI + 360) % 180) + '°', align: 'lined up' }[sk]}` : '');
      Object.assign(live.style, { display: 'block', left: (sx + 14) + 'px', top: (sy + 14) + 'px' });
    }
  } else if (S.hover && (S.tool === 'door' || S.tool === 'window') && k) {
    const s = hitWall(S.hover), wft = parseLen($('#openW').value);
    if (s && wft > 0) { const L = segLen(s), hw = wft / 2 / k, u = [(s.b[0] - s.a[0]) / L, (s.b[1] - s.a[1]) / L], c = clamp(segDistT(S.hover, s.a, s.b).t * L, hw, L - hw);
      h += `<line x1="${s.a[0] + u[0] * (c - hw)}" y1="${s.a[1] + u[1] * (c - hw)}" x2="${s.a[0] + u[0] * (c + hw)}" y2="${s.a[1] + u[1] * (c + hw)}" stroke="${OC[S.tool]}" stroke-opacity=".7" stroke-width="${Math.max(s.w.t / k, px(3)) + px(2)}"/>`; }
  }
  svg.innerHTML = h;
}

/* ---------- pointer input (mouse, touch, pen) ---------- */
const ptrs = new Map(); let G = null, spaceDown = false;
const local = e => { const r = viewer.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
viewer.addEventListener('pointerdown', e => {
  if (!S.W || e.target.closest('#empty')) return;
  try { viewer.setPointerCapture(e.pointerId); } catch { }
  const p = local(e); ptrs.set(e.pointerId, p);
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; G = { type: 'pinch', d0: dist(a, b) || 1, m0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], z0: S.z, tx0: S.tx, ty0: S.ty }; return; }
  if (ptrs.size > 2) return;
  if (e.button === 1 || e.button === 2 || spaceDown) { G = { type: 'pan', s: p, tx0: S.tx, ty0: S.ty }; viewer.classList.add('panning'); e.preventDefault(); return; }
  if (S.tool === 'select') {
    const q = toPlan(...p), hh = hitHandle(q);
    if (hh) { pushUndo(); G = { type: 'vertex', ...hh, s: p }; return; }
    const o = S.sel?.type === 'opening' && hitOpening(q); if (o && o.id === S.sel.id) { pushUndo(); G = { type: 'opening', o, s: p }; return; }
  }
  G = { type: 'pending', s: p, tx0: S.tx, ty0: S.ty, thr: e.pointerType === 'touch' ? 10 : 5 };
});
viewer.addEventListener('pointermove', e => {
  const p = local(e);
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, p);
  if (G?.type === 'pinch' && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()], d = dist(a, b), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const nz = clamp(G.z0 * d / G.d0, fitZ() * 0.3, 80), px = (G.m0[0] - G.tx0) / G.z0, py = (G.m0[1] - G.ty0) / G.z0;
    S.z = nz; S.tx = m[0] - px * nz; S.ty = m[1] - py * nz; S.userZoomed = true; applyT(); return;
  }
  if (G?.type === 'pending' && dist(p, G.s) > G.thr) { G.type = 'pan'; viewer.classList.add('panning'); }
  if (G?.type === 'pan') { S.tx = G.tx0 + p[0] - G.s[0]; S.ty = G.ty0 + p[1] - G.s[1]; S.userZoomed = true; applyT(); return; }
  if (G?.type === 'vertex') {
    const w = G.w, n = w.pts.length, prev = G.i > 0 ? w.pts[G.i - 1] : (w.closed ? w.pts[n - 1] : null);
    w.pts[G.i] = snapPoint(toPlan(...p), prev, e.shiftKey, { w, i: G.i }).p; G.moved = true; sanitizeOpenings(); renderOverlay(); return;
  }
  if (G?.type === 'opening') { const g = openingGeom(G.o); if (g) { const h = segDistT(toPlan(...p), g.s.a, g.s.b); G.o.d = h.t * segLen(g.s); sanitizeOpenings(); G.moved = true; renderOverlay(); } return; }
  if (!G && e.pointerType !== 'touch' && S.tool !== 'select') { S.hover = toPlan(...p); S.hoverShift = e.shiftKey; renderOverlay(); }
});
function endPtr(e, cancel) {
  const had = ptrs.delete(e.pointerId); viewer.classList.remove('panning');
  if (!G) return;
  if (G.type === 'pinch') { if (ptrs.size === 0) G = null; return; }
  if (ptrs.size) return;
  const g = G; G = null;
  if (cancel || !had) return;
  if (g.type === 'pending') tap(...local(e), e);
  if (g.type === 'vertex' || g.type === 'opening') { if (g.moved) { touch(); refreshPanel(); } else S.undo.pop(); }
}
viewer.addEventListener('pointerup', e => endPtr(e, false));
viewer.addEventListener('pointercancel', e => endPtr(e, true));
viewer.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch' && !G && S.hover) { S.hover = null; renderOverlay(); } });
viewer.addEventListener('contextmenu', e => e.preventDefault());
viewer.addEventListener('wheel', e => {
  if (!S.W) return; e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  const p = local(e); S.userZoomed = true; zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)), p[0], p[1]);
}, { passive: false });
['gesturestart', 'gesturechange'].forEach(n => viewer.addEventListener(n, e => e.preventDefault()));
document.addEventListener('keydown', e => {
  if (e.target.closest('input,textarea,select') || modalOpen()) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (S.view !== 'plan') return;
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod) return;
  if (k === ' ') { spaceDown = true; e.preventDefault(); }
  else if (k === 'enter') finishWall(false);
  else if (k === 'escape') { if (S.drawing) { S.drawing = null; updateFinish(); renderOverlay(); } else setTool('select'); }
  else if (k === 'backspace' || k === 'delete') { e.preventDefault(); if (S.drawing?.pts.length) undo(); else deleteSel(); }
  else if (k === 'v') setTool('select'); else if (k === 'w') setTool('wall'); else if (k === 'd') setTool('door'); else if (k === 'n') setTool('window');
  else if (k === 'f') { S.userZoomed = false; fitPlan(); } else if (k === '+' || k === '=') zoomAt(1.25, viewer.clientWidth / 2, viewer.clientHeight / 2); else if (k === '-') zoomAt(0.8, viewer.clientWidth / 2, viewer.clientHeight / 2);
});
document.addEventListener('keyup', e => { if (e.key === ' ') spaceDown = false; });

/* ======================= SCALE ======================= */
function updateScaleLabel() {
  const k = K(), b = $('#btnScale');
  $('#scaleLabel').textContent = k ? S.project.scaleLabel : (S.W ? 'Set scale' : 'No scale'); b.classList.toggle('warn', !!S.W && !k);
}
function setScale(k, label) {
  pushUndo(); S.project.k = k; S.project.scaleLabel = label; sanitizeOpenings();
  touch(); updateScaleLabel(); renderOverlay(); refreshPanel(); toast(`Scale set: ${label}`);
}
function scaleModal(nextTool) {
  if (!S.W) return toast('Open a floor plan first');
  const P = S.project, img = P.plan.kind === 'image', groups = [...new Set(SCALES.map(s => s.group))], curFpi = P.k * unitsPerIn();
  const opts = groups.map(g => `<optgroup label="${g}">${SCALES.filter(s => s.group === g).map(s => `<option value="${SCALES.indexOf(s)}" ${P.k && Math.abs(curFpi - s.ftPerIn) / s.ftPerIn < 1e-6 ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</optgroup>`).join('');
  openModal(`<h3>Plan scale</h3>
    <p class="muted small">Current: <b>${esc(P.k ? P.scaleLabel : 'not set')}</b>. ${img ? 'For a photo or scan, <b>calibrating</b> on a known dimension is the reliable way.' : 'Presets assume the PDF is at full sheet size (as issued). For half-size prints, calibrate instead.'}</p>
    <div class="field"><label>Preset scale</label><select id="scSel">${P.k ? '' : '<option value="">Choose a scale…</option>'}${opts}</select></div>
    ${img ? `<div class="field"><label>Image resolution (DPI the drawing was scanned at)</label><input id="scDpi" inputmode="numeric" value="${P.plan.dpi || 150}"></div>` : ''}
    <div class="btns"><button id="scMeasure">Calibrate from a known dimension…</button><button data-close>Cancel</button><button id="scOk" class="accent">Use preset</button></div>`, (m, close) => {
    m.querySelector('#scOk').onclick = () => {
      const v = m.querySelector('#scSel').value; if (v === '') return toast('Pick a scale');
      if (img) { const dpi = num(m.querySelector('#scDpi').value, 0); if (!(dpi > 0)) return toast('Enter the DPI'); P.plan.dpi = dpi; }
      const s = SCALES[+v]; close(); setScale(s.ftPerIn / unitsPerIn(), s.label); if (nextTool) setTool(nextTool);
    };
    m.querySelector('#scMeasure').onclick = () => { S.calNext = nextTool; close(); setTool('calibrate'); };
  });
}
function calibrateModal(dUnits) {
  openModal(`<h3>Calibrate</h3><p class="muted small">Measured ${fmtN(dUnits / unitsPerIn(), 3)}" on the sheet. What is the real length?</p>
    <form id="cf"><div class="ftin"><input id="cFt" inputmode="decimal" placeholder="feet" autofocus><span>ft</span><input id="cIn" placeholder='inches (e.g. 6 1/2)'><span>in</span></div>
    <div class="btns"><button type="button" data-close>Cancel</button><button class="accent" id="cOk">Set scale</button></div></form>`, (m, close) => {
    m.querySelector('[data-close]').onclick = () => { close(); setTool('select'); };
    m.querySelector('#cf').onsubmit = e => {
      e.preventDefault(); const ft = num(m.querySelector('#cFt').value, 0), inch = parseInches(m.querySelector('#cIn').value);
      const real = ft + (isFinite(inch) ? inch : 0) / 12; if (!(real > 0) || !isFinite(inch)) return toast('Enter the real length');
      const k = real / dUnits, near = nearPreset(k);
      const label = near ? `${near} (calibrated)` : `1" = ${fmtFtIn(k * unitsPerIn())} (calibrated)`;
      close(); setScale(k, label); const nt = S.calNext; S.calNext = null; setTool(nt || 'select');
    };
  });
}

/* ======================= SIDE PANEL ======================= */
function statsHtml(r) {
  return `<span>Walls (centerline)</span><b>${fmtN(r.lf, 1)} LF</b>
    <span>Wall area, one face</span><b>${fmtN(r.net, 0)} SF</b>
    <span class="sub">gross ${fmtN(r.gross, 0)} − openings ${fmtN(r.open, 0)}</span><span></span>
    <span>Floor area</span><b>${fmtN(r.floor, 1)} SF</b>
    <span class="sub">inside walls ≈ ${fmtN(r.floorNet, 1)} SF</span><span></span>
    <span>Rooms · doors · windows</span><b>${r.rooms.length} · ${r.doors} · ${r.windows}</b>`;
}
function refreshPanel() {
  const P = S.project; updateFinish();
  if (!P) { $('#stats').innerHTML = '<span class="muted">No project</span>'; $('#selBody').innerHTML = ''; return; }
  const r = computeStats(); S.lastStats = r;
  $('#stats').innerHTML = K() ? statsHtml(r) : '<span class="muted small">Set the scale to see lengths and areas.</span>';
  const b = $('#selBody'), s = S.sel;
  const w = s?.type === 'wall' && P.walls.find(x => x.id === s.id), o = s?.type === 'opening' && P.openings.find(x => x.id === s.id);
  if (w) {
    const lf = wallSegs(w).reduce((a, sg) => a + segLen(sg), 0) * K();
    b.innerHTML = `<div class="small"><b>Wall</b> · ${w.pts.length} points · ${fmtFtIn(lf)} long</div>
      <div class="row2"><label class="field"><span>Height</span><input id="sH" value="${fmtFtIn(w.h)}"></label><label class="field"><span>Thickness</span><input id="sT" value="${fmtIn(w.t)}"></label></div>
      <label class="field row small"><input type="checkbox" id="sClosed" ${w.closed ? 'checked' : ''} ${w.pts.length < 3 ? 'disabled' : ''}> Closed loop</label>
      <div class="btnrow"><button class="small" id="sAll">Apply height + thickness to all walls</button><button class="small" id="sDel">🗑 Delete wall</button></div>`;
    b.querySelector('#sH').onchange = e => { const v = parseLen(e.target.value); if (!(v > 0)) return toast('Enter a height like 8 or 9\'6"'); pushUndo(); w.h = v; P.openings.filter(x => x.wallId === w.id).forEach(x => x.head = Math.min(x.head, v)); touch(); refreshPanel(); };
    b.querySelector('#sT').onchange = e => { const v = parseLen(e.target.value, 'in'); if (!(v > 0)) return toast('Enter a thickness like 4 1/2"'); pushUndo(); w.t = v; touch(); renderOverlay(); refreshPanel(); };
    b.querySelector('#sClosed').onchange = e => { pushUndo(); w.closed = e.target.checked; sanitizeOpenings(); touch(); renderOverlay(); refreshPanel(); };
    b.querySelector('#sAll').onclick = () => { pushUndo(); for (const x of P.walls) { x.h = w.h; x.t = w.t; } touch(); renderOverlay(); refreshPanel(); toast('Applied to all walls'); };
    b.querySelector('#sDel').onclick = deleteSel;
  } else if (o) {
    b.innerHTML = `<div class="row2"><label class="field"><span>Type</span><select id="oT"><option value="door" ${o.type === 'door' ? 'selected' : ''}>Door</option><option value="window" ${o.type === 'window' ? 'selected' : ''}>Window</option></select></label>
      <label class="field"><span>Width</span><input id="oW" value="${fmtFtIn(o.w)}"></label>
      <label class="field"><span>Sill (bottom)</span><input id="oS" value="${fmtFtIn(o.sill)}"></label><label class="field"><span>Head (top)</span><input id="oH" value="${fmtFtIn(o.head)}"></label></div>
      <p class="muted tiny">Drag the selected opening along its wall to move it.</p>
      <div class="btnrow"><button class="small" id="oDel">🗑 Delete ${o.type}</button></div>`;
    const set = (fn) => e => { pushUndo(); fn(e.target.value); sanitizeOpenings(); touch(); renderOverlay(); refreshPanel(); };
    b.querySelector('#oT').onchange = set(v => { o.type = v; o.sill = OPEN_DEF[v].sill; o.head = OPEN_DEF[v].head; });
    b.querySelector('#oW').onchange = set(v => { const x = parseLen(v); if (x > 0) o.w = x; });
    b.querySelector('#oS').onchange = set(v => { const x = parseLen(v); if (x >= 0 && x < o.head) o.sill = x; });
    b.querySelector('#oH').onchange = set(v => { const x = parseLen(v); if (x > o.sill) o.head = x; });
    b.querySelector('#oDel').onclick = deleteSel;
  } else b.innerHTML = '<span class="muted small">Pick <b>Select</b> and tap a wall or an opening to edit it.</span>';
}

/* ======================= PROJECTS ======================= */
async function projectsModal() {
  const list = (await DB.all('projects')).sort((a, b) => b.updated - a.updated);
  openModal(`<h3>Projects</h3><div class="plist">${list.map(p => `<div class="pitem ${p.id === S.project?.id ? 'cur' : ''}"><span class="nm"><b>${esc(p.name)}</b><br><span class="muted tiny">${p.walls.length} walls · ${new Date(p.updated).toLocaleString()}</span></span>
      <button class="small" data-open="${p.id}">Open</button><button class="small" data-ren="${p.id}">Rename</button><button class="small" data-del="${p.id}">🗑</button></div>`).join('') || '<p class="muted">No projects yet.</p>'}</div>
    <div class="btns"><button id="pmImport">Import file…</button><button id="pmExport" ${S.project ? '' : 'disabled'}>Export this project</button><button data-close>Close</button><button id="pmNew" class="accent">New project</button></div>
    <p class="muted tiny">Projects are saved in this browser only. Export a .flyover file to back up or move a project to another device.</p>`, (m, close) => {
    m.querySelectorAll('[data-open]').forEach(b => b.onclick = async () => { close(); await loadProject(list.find(p => p.id === b.dataset.open)); });
    m.querySelectorAll('[data-ren]').forEach(b => b.onclick = async () => { const p = list.find(x => x.id === b.dataset.ren); const n = await askText('Rename project', 'Name', p.name); if (!n) return projectsModal(); p.name = n; await DB.put('projects', p); if (S.project?.id === p.id) { S.project.name = n; $('#projName').textContent = n; } projectsModal(); });
    m.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const p = list.find(x => x.id === b.dataset.del); if (!await askConfirm('Delete project?', `“${esc(p.name)}” and its plan will be removed from this device.`)) return projectsModal();
      await DB.del('projects', p.id); if (p.plan?.fileId) await DB.del('files', p.plan.fileId);
      if (S.project?.id === p.id) { S.project = null; clearPlanView(); $('#projName').textContent = 'No project'; refreshPanel(); renderOverlay(); }
      projectsModal();
    });
    m.querySelector('#pmNew').onclick = async () => { const n = await askText('New project', 'Name', 'New plan'); if (!n) return projectsModal(); await createProject(n); $('#filePlan').click(); };
    m.querySelector('#pmExport').onclick = () => { close(); exportProject(); };
    m.querySelector('#pmImport').onclick = () => { close(); $('#fileImport').click(); };
  });
}
function b64(buf) { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s) { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }
async function exportProject() {
  await flush(); const P = S.project; if (!P) return;
  const f = P.plan ? await DB.get('files', P.plan.fileId) : null;
  const out = { app: 'plan-flyover', version: 1, exported: new Date().toISOString(), project: P, file: f ? { name: f.name, type: f.type, data: b64(f.data) } : null };
  download(safeName(P.name) + '.flyover', JSON.stringify(out), 'application/json'); toast('Project exported');
}
async function importProject(file) {
  try {
    const o = JSON.parse(await file.text()); if (o.app !== 'plan-flyover' || !o.project) throw new Error('not a Plan Flyover file');
    const p = { ...newProjectObj(), ...o.project, id: uid(), updated: Date.now() };
    if (o.file && p.plan) { const fid = uid(); await DB.put('files', { id: fid, name: o.file.name, type: o.file.type, data: unb64(o.file.data) }); p.plan = { ...p.plan, fileId: fid }; } else p.plan = null;
    await DB.put('projects', p); await loadProject(p); toast(`Imported “${p.name}”`);
  } catch (e) { console.warn(e); toast('That file is not a Plan Flyover project'); }
}

/* ======================= 3D VIEW ======================= */
const T3 = { renderer: null, scene: null, cam: null, orbit: null, group: null, mode: 'orbit', raf: 0, last: 0, rise: 1, fly: null, keys: new Set(), yaw: 0, pitch: 0, pos: null, joy: { x: 0, y: 0 }, blockers: [], info: null, lookPtr: null };
const EYE = 5.5;
const cvs3 = $('#threeCanvas'), wrap3 = $('#threeWrap');
function init3D() {
  if (T3.renderer) return true;
  try { T3.renderer = new THREE.WebGLRenderer({ canvas: cvs3, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' }); }
  catch (e) { console.warn(e); $('#noWalls').innerHTML = '<h3>3D not available</h3><p>This browser could not start WebGL.</p>'; $('#noWalls').classList.remove('hidden'); return false; }
  const R = T3.renderer; R.setPixelRatio(Math.min(devicePixelRatio || 1, COARSE ? 1.5 : 2)); R.shadowMap.enabled = true; R.shadowMap.type = THREE.PCFSoftShadowMap;
  R.toneMapping = THREE.ACESFilmicToneMapping; R.toneMappingExposure = 1.05; R.outputColorSpace = THREE.SRGBColorSpace;
  const sc = T3.scene = new THREE.Scene(); sc.fog = new THREE.Fog('#53646f', 200, 900);
  { const c = document.createElement('canvas'); c.width = 4; c.height = 256; const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, '#1c252d'); gr.addColorStop(0.55, '#3b4b56'); gr.addColorStop(1, '#6b7f8a'); g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; sc.background = t; }
  T3.cam = new THREE.PerspectiveCamera(50, 1, 0.1, 3000);
  T3.hemi = new THREE.HemisphereLight('#e3edf3', '#3b4752', 1.35); sc.add(T3.hemi);
  T3.sun = new THREE.DirectionalLight('#fff3e2', 2.4); T3.sun.castShadow = true; T3.sun.shadow.mapSize.set(2048, 2048); T3.sun.shadow.bias = -0.0004; T3.sun.shadow.normalBias = 0.04; T3.sun.shadow.radius = 4; sc.add(T3.sun, T3.sun.target);
  T3.fill = new THREE.DirectionalLight('#bfe3ff', 0.85); sc.add(T3.fill);
  T3.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: '#2a343d', roughness: 1 })); T3.ground.rotation.x = -Math.PI / 2; T3.ground.position.y = -0.03; T3.ground.receiveShadow = true; sc.add(T3.ground);
  T3.mats = {
    wall: new THREE.MeshStandardMaterial({ color: '#efebe5', roughness: 0.82, metalness: 0, vertexColors: true }),
    top: new THREE.MeshStandardMaterial({ color: '#3f5361', roughness: 0.7 }),
    glass: new THREE.MeshPhysicalMaterial({ color: '#a7dcef', roughness: 0.05, transmission: 0, transparent: true, opacity: 0.28, depthWrite: false }),
  };
  T3.orbit = new OrbitControls(T3.cam, cvs3); T3.orbit.enableDamping = true; T3.orbit.dampingFactor = 0.08; T3.orbit.maxPolarAngle = Math.PI / 2 - 0.03; T3.orbit.screenSpacePanning = true;
  T3.orbit.addEventListener('start', () => stopFly());
  new ResizeObserver(resize3D).observe(wrap3);
  return true;
}
function resize3D() { if (!T3.renderer) return; const w = wrap3.clientWidth, h = wrap3.clientHeight; if (!w || !h) return; T3.renderer.setSize(w, h, false); T3.cam.aspect = w / h; T3.cam.updateProjectionMatrix(); }

function floorTexture(b) {
  if (!S.planCanvas) return null; const k = K(), res = S.res;
  const x0 = b.minX / k, y0 = b.minY / k, x1 = b.maxX / k, y1 = b.maxY / k;   // plan units
  const sw = (x1 - x0) * res, sh = (y1 - y0) * res, f = Math.min(1, 2048 / Math.max(sw, sh));
  const c = document.createElement('canvas'); c.width = Math.max(2, Math.round(sw * f)); c.height = Math.max(2, Math.round(sh * f));
  const g = c.getContext('2d'); g.fillStyle = '#f4f2ee'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(S.planCanvas, x0 * res, y0 * res, sw, sh, 0, 0, c.width, c.height);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = T3.renderer.capabilities.getMaxAnisotropy(); return t;
}
function build3D() {
  if (!init3D()) return false;
  const k = K(), P = S.project, pieces = k ? wallPieces() : [];
  if (T3.group) { T3.scene.remove(T3.group); T3.group.traverse(o => { o.geometry?.dispose(); if (o.material?.map) o.material.map.dispose(); }); }
  const g = T3.group = new THREE.Group(); T3.scene.add(g);
  $('#noWalls').classList.toggle('hidden', pieces.length > 0);
  // bounds in feet
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pieces) for (const q of [p.a, p.b]) { minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0]); minY = Math.min(minY, q[1]); maxY = Math.max(maxY, q[1]); }
  if (!pieces.length) { minX = minY = -10; maxX = maxY = 10; }
  const m = 5, b = { minX: minX - m, minY: minY - m, maxX: maxX + m, maxY: maxY + m }, cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const R = Math.max(maxX - minX, maxY - minY, 10) / 2; const H = Math.max(8, ...((P?.walls || []).map(w => w.h)));
  T3.info = { cx, cy, R, H, b };
  // floor with the plan on it
  const tex = k ? floorTexture(b) : null;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(b.maxX - b.minX, b.maxY - b.minY), new THREE.MeshStandardMaterial({ map: tex, color: tex ? '#e4e0d8' : '#c9c4bb', roughness: 0.93 }));
  floor.rotation.x = -Math.PI / 2; floor.position.set((b.minX + b.maxX) / 2 - cx, 0, (b.minY + b.maxY) / 2 - cy); floor.receiveShadow = true; g.add(floor);
  T3.ground.scale.set(R * 40, R * 40, 1);
  // walls
  const wallsG = T3.walls = new THREE.Group(); g.add(wallsG); const mats = [T3.mats.wall, T3.mats.wall, T3.mats.top, T3.mats.wall, T3.mats.wall, T3.mats.wall];
  T3.blockers = [];
  for (const p of pieces) {
    const dx = p.b[0] - p.a[0], dz = p.b[1] - p.a[1], L = Math.hypot(dx, dz), hgt = p.y1 - p.y0; if (L < 1e-3) continue;
    const glass = p.kind === 'glass', th = glass ? Math.max(0.06, p.t * 0.15) : p.t;
    const geo = new THREE.BoxGeometry(L, hgt, th);
    if (!glass) { // soft fake ambient occlusion: walls darken toward the floor
      const pos = geo.attributes.position, col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) { const y = p.y0 + hgt / 2 + pos.getY(i), f = 0.62 + 0.38 * Math.min(1, Math.pow(y / 3.2, 0.7)); col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = f; }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    const mesh = new THREE.Mesh(geo, glass ? T3.mats.glass : mats);
    mesh.position.set((p.a[0] + p.b[0]) / 2 - cx, p.y0 + hgt / 2, (p.a[1] + p.b[1]) / 2 - cy); mesh.rotation.y = -Math.atan2(dz, dx);
    if (!glass) { mesh.castShadow = true; mesh.receiveShadow = true; } wallsG.add(mesh);
    if (p.y0 < 4.5) T3.blockers.push({ a: [p.a[0] - cx, p.a[1] - cy], b: [p.b[0] - cx, p.b[1] - cy], r: p.t / 2 });
  }
  // lights sized to the model
  T3.sun.position.set(R * 0.9, R * 2.2 + 20, R * 0.7); T3.sun.target.position.set(0, 0, 0);
  const sc = T3.sun.shadow.camera; Object.assign(sc, { left: -R * 1.5, right: R * 1.5, top: R * 1.5, bottom: -R * 1.5, near: 1, far: R * 6 + 80 }); sc.updateProjectionMatrix();
  T3.fill.position.set(-R, R * 1.2, -R * 0.8);
  T3.scene.fog.near = R * 6; T3.scene.fog.far = R * 18;
  T3.cam.far = R * 30 + 500; T3.cam.updateProjectionMatrix();
  // stats
  const r = computeStats();
  $('#stats3').innerHTML = `<span>Walls</span><b>${fmtN(r.lf, 1)} LF</b><span>Wall area (1 face)</span><b>${fmtN(r.net, 0)} SF</b><span>Floor area</span><b>${fmtN(r.floor, 1)} SF</b><span>Rooms · doors · windows</span><b>${r.rooms.length} · ${r.doors} · ${r.windows}</b>`;
  T3.rooms = r.rooms; S.dirty3d = false; T3.rise = 0;
  return true;
}
function homeCam() {
  const { R } = T3.info; T3.cam.position.set(R * 1.15, R * 1.25 + 6, R * 1.55); T3.orbit.target.set(0, 2, 0); T3.orbit.minDistance = 2; T3.orbit.maxDistance = R * 10 + 60; T3.orbit.update();
}
function show3D() {
  if (!init3D()) return; resize3D();
  if (S.dirty3d || !T3.group) { const first = !T3.group; build3D(); if (first || T3.mode === 'orbit') { setMode('orbit'); homeCam(); } else setMode(T3.mode); }
  startLoop();
}
function startLoop() { if (T3.raf) return; T3.last = performance.now(); const tick = now => { T3.raf = S.view === 'three' ? requestAnimationFrame(tick) : 0; const dt = Math.min(0.1, (now - T3.last) / 1000); T3.last = now; step3D(dt); }; T3.raf = requestAnimationFrame(tick); }
const easeIO = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
function step3D(dt) {
  if (T3.rise < 1 && T3.walls) { T3.rise = Math.min(1, T3.rise + dt / 1.3); const e = 1 - Math.pow(1 - T3.rise, 3); T3.walls.scale.y = Math.max(0.001, e); }
  if (T3.fly) stepFly(dt);
  else if (T3.mode === 'walk') stepWalk(dt);
  else T3.orbit.update();
  T3.renderer.render(T3.scene, T3.cam); T3.frames = (T3.frames || 0) + 1;
}

/* ---------- walk mode ---------- */
function setMode(mode) {
  T3.mode = mode; $('#mOrbit').classList.toggle('on', mode === 'orbit'); $('#mWalk').classList.toggle('on', mode === 'walk');
  T3.orbit.enabled = mode === 'orbit' && !T3.fly;
  const touchy = COARSE || navigator.maxTouchPoints > 0;
  $('#joy').classList.toggle('on', mode === 'walk' && touchy);
  $('#help3').innerHTML = mode === 'orbit' ? (touchy ? 'Drag to spin · pinch to zoom · two fingers to pan' : 'Drag to spin · scroll to zoom · right-drag to pan')
    : (touchy ? 'Left stick to walk · drag anywhere to look' : 'WASD / arrows to walk · drag to look · Shift = faster · double-click to lock mouse');
  if (mode === 'orbit' && document.pointerLockElement) document.exitPointerLock();
}
function enterWalk(pos, yaw) {
  const info = T3.info; let p = pos;
  if (!p) { const big = (T3.rooms || []).slice().sort((a, b) => b.sf - a.sf)[0], k = K(); p = big ? (() => { const c = polyCentroid(big.pts), q = inPoly(c, big.pts) ? c : big.c; return [q[0] * k - info.cx, q[1] * k - info.cy]; })() : [0, info.R + 6]; }
  T3.pos = new THREE.Vector3(p[0], EYE, p[1]); T3.yaw = yaw ?? Math.atan2(p[0], p[1]); T3.pitch = -0.05;
  T3.cam.position.copy(T3.pos); T3.cam.rotation.set(T3.pitch, T3.yaw, 0, 'YXZ');
  setMode('walk');
}
function collide(p) {
  const r = 0.9;
  for (let it = 0; it < 3; it++) for (const w of T3.blockers) {
    const h = segDistT([p.x, p.z], w.a, w.b), min = w.r + r;
    if (h.d < min) { const n = h.d > 1e-6 ? [(p.x - h.q[0]) / h.d, (p.z - h.q[1]) / h.d] : [0, 1]; p.x = h.q[0] + n[0] * min; p.z = h.q[1] + n[1] * min; }
  }
}
function stepWalk(dt) {
  const k = T3.keys, run = k.has('shift') ? 2 : 1, sp = 5 * run * dt;
  let f = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0), s = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0);
  T3.yaw += ((k.has('arrowleft') ? 1 : 0) - (k.has('arrowright') ? 1 : 0)) * 1.8 * dt;
  f += -T3.joy.y; s += T3.joy.x;
  if (f || s) { const fx = -Math.sin(T3.yaw), fz = -Math.cos(T3.yaw), rx = Math.cos(T3.yaw), rz = -Math.sin(T3.yaw); T3.pos.x += (fx * f + rx * s) * sp; T3.pos.z += (fz * f + rz * s) * sp; collide(T3.pos); }
  T3.cam.position.copy(T3.pos); T3.cam.rotation.set(T3.pitch, T3.yaw, 0, 'YXZ');
}
const look = (dx, dy, f = 0.0042) => { T3.yaw -= dx * f; T3.pitch = clamp(T3.pitch - dy * f, -1.35, 1.35); };
cvs3.addEventListener('pointerdown', e => { stopFly(); if (T3.mode !== 'walk') return; T3.lookPtr = { id: e.pointerId, x: e.clientX, y: e.clientY }; try { cvs3.setPointerCapture(e.pointerId); } catch { } });
cvs3.addEventListener('pointermove', e => {
  if (T3.mode !== 'walk') return;
  if (document.pointerLockElement === cvs3) { look(e.movementX, e.movementY, 0.0028); return; }
  const L = T3.lookPtr; if (!L || L.id !== e.pointerId) return; look(e.clientX - L.x, e.clientY - L.y); L.x = e.clientX; L.y = e.clientY;
});
const endLook = e => { if (T3.lookPtr?.id === e.pointerId) T3.lookPtr = null; };
cvs3.addEventListener('pointerup', endLook); cvs3.addEventListener('pointercancel', endLook);
cvs3.addEventListener('dblclick', () => { if (T3.mode === 'walk' && !COARSE) cvs3.requestPointerLock?.()?.catch?.(() => { }); });
cvs3.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
  if (S.view !== 'three' || e.target.closest('input,textarea,select') || modalOpen()) return;
  const k = e.key.toLowerCase();
  if (['w', 'a', 's', 'd', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) { if (T3.mode !== 'walk' && k !== 'shift') { stopFly(); enterWalk(); } T3.keys.add(k); e.preventDefault(); }
  else if (k === 'o') { stopFly(); setMode('orbit'); homeCam(); } else if (k === 'f') startFly(); else if (k === 'escape') stopFly();
});
document.addEventListener('keyup', e => T3.keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => T3.keys.clear());
// on-screen joystick
(() => {
  const joy = $('#joy'), knob = $('#joyKnob'); let id = null;
  const upd = e => { const r = joy.getBoundingClientRect(), R = r.width / 2; let x = (e.clientX - r.left - R) / R, y = (e.clientY - r.top - R) / R; const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; } T3.joy = { x, y }; knob.style.transform = `translate(${x * R * 0.62}px,${y * R * 0.62}px)`; };
  joy.addEventListener('pointerdown', e => { e.stopPropagation(); id = e.pointerId; stopFly(); try { joy.setPointerCapture(id); } catch { } upd(e); });
  joy.addEventListener('pointermove', e => { if (e.pointerId === id) upd(e); });
  const end = e => { if (e.pointerId !== id) return; id = null; T3.joy = { x: 0, y: 0 }; knob.style.transform = ''; };
  joy.addEventListener('pointerup', end); joy.addEventListener('pointercancel', end);
})();

/* ---------- auto flyover ---------- */
function startFly() {
  if (!T3.info || !T3.walls?.children.length) return toast('Trace some walls first');
  const { R, H } = T3.info, k = K(), P = [], L = [];
  const a0 = Math.atan2(T3.cam.position.z, T3.cam.position.x);
  // spiral in from high above, circling the model
  for (let i = 0; i <= 8; i++) { const t = i / 8, a = a0 + t * Math.PI * 1.75, r = R * (2.3 - 0.95 * t) + 8, y = R * (1.7 - 0.95 * t) + H + 4; P.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r)); L.push(new THREE.Vector3(0, H * 0.25 * t, 0)); }
  // then drop into the biggest room at eye height
  const big = (T3.rooms || []).slice().sort((a, b) => b.sf - a.sf)[0]; let end = null;
  if (big) {
    const c0 = polyCentroid(big.pts), c = inPoly(c0, big.pts) ? c0 : big.c, x = c[0] * k - T3.info.cx, z = c[1] * k - T3.info.cy;
    let dir = new THREE.Vector3(-x, 0, -z); if (dir.length() < 2) dir.set(1, 0, 0); dir.normalize();   // end facing the middle of the plan
    P.push(new THREE.Vector3(x - dir.x * 7, H + 10, z - dir.z * 7)); L.push(new THREE.Vector3(x + dir.x * 6, 1, z + dir.z * 6));
    P.push(new THREE.Vector3(x - dir.x * 2.5, EYE + 0.8, z - dir.z * 2.5)); L.push(new THREE.Vector3(x + dir.x * 10, EYE - 0.4, z + dir.z * 10));
    P.push(new THREE.Vector3(x, EYE, z)); L.push(new THREE.Vector3(x + dir.x * 12, EYE, z + dir.z * 12));
    end = { p: [x, z], yaw: Math.atan2(-dir.x, -dir.z) };
  } else { P.push(new THREE.Vector3(R * 1.1, R * 1.2 + 6, R * 1.5)); L.push(new THREE.Vector3(0, 2, 0)); }
  T3.fly = { pc: new THREE.CatmullRomCurve3(P, false, 'centripetal'), lc: new THREE.CatmullRomCurve3(L, false, 'centripetal'), t: 0, t0: performance.now(), dur: big ? 15 : 11, end };
  T3.orbit.enabled = false; T3.rise = 0; $('#btnFly').textContent = '■ Stop'; $('#joy').classList.remove('on');
}
function stepFly(dt) {
  const F = T3.fly; F.t = Math.min(1, (performance.now() - F.t0) / 1000 / F.dur); const e = easeIO(F.t);   // wall-clock, so slow devices still finish on time
  T3.cam.position.copy(F.pc.getPoint(e)); T3.cam.lookAt(F.lc.getPoint(e));
  if (F.t >= 1) {
    const end = F.end; stopFly();
    if (end) { enterWalk(end.p, end.yaw); T3.pitch = 0; T3.cam.rotation.set(0, T3.yaw, 0, 'YXZ'); toast('Welcome in! You’re walking now. Tap Orbit to zoom back out.'); }
    else { setMode('orbit'); T3.orbit.target.set(0, 2, 0); T3.orbit.update(); }
  }
}
function stopFly() {
  if (!T3.fly) return; T3.fly = null; $('#btnFly').textContent = '▶ Flyover';
  if (T3.mode === 'orbit') { T3.orbit.enabled = true; const d = new THREE.Vector3(); T3.cam.getWorldDirection(d); T3.orbit.target.copy(T3.cam.position).addScaledVector(d, Math.max(10, T3.cam.position.y * 1.2)); T3.orbit.target.y = Math.max(0, T3.orbit.target.y); T3.orbit.update(); }
  else { const d = new THREE.Vector3(); T3.cam.getWorldDirection(d); T3.pos = T3.cam.position.clone(); T3.pos.y = EYE; T3.yaw = Math.atan2(-d.x, -d.z); T3.pitch = 0; setMode('walk'); }
}
function screenshot3D() {
  if (!T3.renderer) return; T3.renderer.render(T3.scene, T3.cam);
  const d = new Date(), stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  cvs3.toBlob(b => { if (!b) return toast('Screenshot failed'); download(`${safeName(S.project?.name)}-3D-${stamp}.png`, b); toast('Screenshot saved'); }, 'image/png');
}

/* ======================= AUTO-DETECT WALLS (beta) ======================= */
// Raster approach: find long, straight, horizontal/vertical bands of dark ink that are wall-thick
// (solid filled walls, or two parallel lines a wall-thickness apart), then join them at corners.
function detectWalls() {
  const k = K(); if (!S.planCanvas || !k) return null;
  const pfFull = S.res / k, f = Math.min(1, 16 / pfFull), pf = pfFull * f;       // px per foot in the work image
  const W = Math.round(S.planCanvas.width * f), H = Math.round(S.planCanvas.height * f);
  if (W * H > 40e6) return { error: 'Plan is too large to scan' };
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(S.planCanvas, 0, 0, W, H); const px = g.getImageData(0, 0, W, H).data;
  const dark = new Uint8Array(W * H); for (let i = 0, j = 0; i < dark.length; i++, j += 4) dark[i] = (px[j] * .3 + px[j + 1] * .59 + px[j + 2] * .11) < 120 ? 1 : 0;
  const tmin = Math.max(2, 2.5 / 12 * pf), tmax = 16 / 12 * pf, thin = Math.max(1.5, tmin * 0.9), Lmin = 3 * pf;
  // scan lines across one axis; returns bands {pos (center), s (along), t}
  function scan(horizontal) {
    const n = horizontal ? W : H, m = horizontal ? H : W, at = horizontal ? (a, b) => dark[b * W + a] : (a, b) => dark[a * W + b];
    const buckets = new Map();
    for (let a = 0; a < n; a++) {
      const runs = []; let st = -1;
      for (let b = 0; b <= m; b++) { const d = b < m && at(a, b); if (d && st < 0) st = b; else if (!d && st >= 0) { runs.push([st, b]); st = -1; } }
      for (let i = 0; i < runs.length; i++) {
        let [r0, r1] = runs[i], len = r1 - r0, used = false;
        if (len >= tmin && len <= tmax) used = true;
        else if (len < thin && i + 1 < runs.length) { const [q0, q1] = runs[i + 1]; if (q1 - q0 < thin && q1 - r0 >= tmin && q1 - r0 <= tmax) { r1 = q1; len = q1 - r0; used = true; i++; } }
        if (!used) continue;
        const key = Math.round((r0 + r1) / 2); let arr = buckets.get(key); if (!arr) buckets.set(key, arr = []); arr.push([a, len]);
      }
    }
    const bands = [];
    for (const [key, arr] of buckets) {
      arr.sort((x, y) => x[0] - y[0]); let s0 = arr[0][0], prev = s0, ts = [arr[0][1]];
      const flush = () => { if (prev - s0 + 1 >= Lmin) { ts.sort((x, y) => x - y); bands.push({ pos: key, s0, s1: prev + 1, t: ts[ts.length >> 1] }); } };
      for (let i = 1; i < arr.length; i++) { const [a, t] = arr[i]; if (a - prev > Math.max(2, tmin)) { flush(); s0 = a; ts = []; } prev = a; ts.push(t); }
      flush();
    }
    // merge bands whose centers jitter by a pixel or two
    bands.sort((x, y) => x.pos - y.pos || x.s0 - y.s0); const out = [];
    for (const b of bands) { const o = out.find(o => Math.abs(o.pos - b.pos) <= Math.max(1.5, b.t / 3) && b.s0 <= o.s1 + 2 && b.s1 >= o.s0 - 2); if (o) { const wa = o.s1 - o.s0, wb = b.s1 - b.s0; o.pos = (o.pos * wa + b.pos * wb) / (wa + wb); o.s0 = Math.min(o.s0, b.s0); o.s1 = Math.max(o.s1, b.s1); o.t = Math.max(o.t, b.t); } else out.push({ ...b }); }
    return out.filter(b => b.s1 - b.s0 >= Lmin);
  }
  const Hs = scan(true).map(b => ({ dir: 'h', y: b.pos, x0: b.s0, x1: b.s1, t: b.t }));
  const Vs = scan(false).map(b => ({ dir: 'v', x: b.pos, y0: b.s0, y1: b.s1, t: b.t }));
  if (Hs.length + Vs.length > 400) return { error: 'Too much linework to auto-detect on this sheet' };
  // join: run each end onto a perpendicular wall it stops against
  const reach = o => o.t / 2 + Math.max(3, o.t * 0.6);
  for (const h of Hs) for (const v of Vs) {
    const tol = v.t / 2 + h.t + 3;
    if (h.y >= v.y0 - tol && h.y <= v.y1 + tol) { if (Math.abs(h.x0 - v.x) <= reach(v) + 1) h.x0 = Math.min(h.x0, v.x); if (Math.abs(h.x1 - v.x) <= reach(v) + 1) h.x1 = Math.max(h.x1, v.x); }
    const tol2 = h.t / 2 + v.t + 3;
    if (v.x >= h.x0 - tol2 && v.x <= h.x1 + tol2) { if (Math.abs(v.y0 - h.y) <= reach(h) + 1) v.y0 = Math.min(v.y0, h.y); if (Math.abs(v.y1 - h.y) <= reach(h) + 1) v.y1 = Math.max(v.y1, h.y); }
  }
  // merge collinear pieces; a 2'-4'6" gap between them becomes a door
  const doors = [];
  function mergeLine(list, posK, aK, bK) {
    list.sort((p, q) => p[posK] - q[posK] || p[aK] - q[aK]); const out = [];
    for (const s of list) {
      const o = out.find(o => Math.abs(o[posK] - s[posK]) <= Math.max(2, Math.min(o.t, s.t) / 2) && s[aK] <= o[bK] + 4.6 * pf && s[bK] >= o[aK]);
      if (!o) { out.push({ ...s, gaps: [] }); continue; }
      const gap = s[aK] - o[bK]; if (gap > 1.9 * pf) o.gaps.push([o[bK], s[aK]]);
      o[bK] = Math.max(o[bK], s[bK]);
    }
    for (const o of out) for (const [g0, g1] of o.gaps) doors.push({ o, g0, g1 });
    return out;
  }
  const H2 = mergeLine(Hs, 'y', 'x0', 'x1'), V2 = mergeLine(Vs, 'x', 'y0', 'y1');
  const u = 1 / (S.res * f), roundT = t => Math.max(2, Math.round(t / pf * 12 * 2) / 2) / 12;
  const walls = [], opens = [];
  for (const s of [...H2, ...V2]) {
    const a = s.dir === 'h' ? [s.x0 * u, s.y * u] : [s.x * u, s.y0 * u], b = s.dir === 'h' ? [s.x1 * u, s.y * u] : [s.x * u, s.y1 * u];
    const w = { id: uid(), pts: [a, b], closed: false, h: S.project.defH, t: roundT(s.t) }; walls.push(w);
    for (const [g0, g1] of s.gaps) { const st = s.dir === 'h' ? s.x0 : s.y0; opens.push({ id: uid(), wallId: w.id, seg: 0, d: ((g0 + g1) / 2 - st) * u, w: Math.round((g1 - g0) / pf * 12) / 12, type: 'door', sill: 0, head: Math.min(80 / 12, w.h) }); }
  }
  return { walls, opens };
}
async function runDetect() {
  if (!S.W) return toast('Open a floor plan first');
  if (!K()) return scaleModal(null);
  const r = detectWalls(); if (!r) return; if (r.error) return toast(r.error);
  if (!r.walls.length) return toast('No walls found. Trace them by hand with the Wall tool.');
  const P = S.project, replace = P.walls.length ? await askConfirm('Auto-detect walls (beta)', `Found ${r.walls.length} wall runs${r.opens.length ? ` and ${r.opens.length} door gaps` : ''}. Replace your ${P.walls.length} current walls?`, 'Replace') : true;
  if (!replace) return;
  pushUndo(); P.walls = r.walls; P.openings = r.opens; sanitizeOpenings(); S.sel = null; touch(); renderOverlay(); refreshPanel();
  toast(`Found ${r.walls.length} walls${r.opens.length ? ` + ${r.opens.length} doors` : ''}. Check them, it's beta. Undo if it's off.`, 4200);
}

/* ======================= WIRING ======================= */
function setView(v) {
  S.view = v; $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  $$('.view').forEach(el => el.classList.toggle('on', el.id === 'view-' + v));
  if (v === 'three') { if (S.drawing) finishWall(false); show3D(); } else { stopFly(); if (document.pointerLockElement) document.exitPointerLock(); if (!S.userZoomed || !(S.z > 0)) fitPlan(); renderOverlay(); }
}
$$('#tabs button').forEach(b => b.onclick = () => setView(b.dataset.view));
$$('.tool').forEach(b => b.onclick = () => setTool(b.dataset.tool));
$('#btnFinish').onclick = () => finishWall(false);
$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo; $('#btnDel').onclick = deleteSel;
$('#btnSnap').onclick = () => { S.snap = !S.snap; $('#btnSnap').classList.toggle('on', S.snap); toast(S.snap ? 'Snapping on (0/45/90° + wall ends)' : 'Snapping off'); };
$('#btnScale').onclick = () => scaleModal(null);
$('#btnDetect').onclick = runDetect;
$('#zoomIn').onclick = () => { S.userZoomed = true; zoomAt(1.3, viewer.clientWidth / 2, viewer.clientHeight / 2); };
$('#zoomOut').onclick = () => { S.userZoomed = true; zoomAt(1 / 1.3, viewer.clientWidth / 2, viewer.clientHeight / 2); };
$('#zoomFit').onclick = () => { S.userZoomed = false; fitPlan(); };
$('#togglePanel').onclick = () => { $('#panel').classList.toggle('hidden2'); };
if (innerWidth <= 900) $('#panel').classList.add('hidden2');
$('#btnProjects').onclick = projectsModal;
$('#btnOpenPlan').onclick = $('#btnReplacePlan').onclick = () => $('#filePlan').click();
$('#btnClearWalls').onclick = async () => { if (!S.project?.walls.length) return; if (!await askConfirm('Clear all walls?', 'Removes every wall, door and window on this plan. You can undo.', 'Clear')) return; pushUndo(); S.project.walls = []; S.project.openings = []; S.sel = null; touch(); renderOverlay(); refreshPanel(); };
$('#filePlan').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; await openPlanFile(f); };
$('#fileImport').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) await importProject(f); };
$('#defH').onchange = e => { const v = parseLen(e.target.value); if (!(v > 0) || !S.project) return toast('Enter a height like 8 or 9\'6"'); S.project.defH = v; e.target.value = fmtFtIn(v); touch(); };
$('#defT').onchange = e => { const v = parseLen(e.target.value, 'in'); if (!(v > 0) || !S.project) return toast('Enter a thickness like 4 1/2"'); S.project.defT = v; e.target.value = fmtIn(v); touch(); };
$('#openW').onchange = e => { const v = parseLen(e.target.value); if (v > 0) e.target.value = fmtFtIn(v); };
$('#mOrbit').onclick = () => { stopFly(); setMode('orbit'); homeCam(); };
$('#mWalk').onclick = () => { stopFly(); enterWalk(); };
$('#btnFly').onclick = () => T3.fly ? stopFly() : startFly();
$('#btnShot').onclick = screenshot3D;
$('#btnRebuild').onclick = () => { stopFly(); build3D(); };
$('#goPlan').onclick = () => setView('plan');
// drag & drop a plan onto the window
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (!f) return; /\.flyover$/i.test(f.name) ? importProject(f) : openPlanFile(f); });

(async () => {
  $('#ver').textContent = VER;
  await DB.open();
  const last = await DB.get('meta', 'last'), p = last && await DB.get('projects', last.projectId);
  if (p) await loadProject(p); else { refreshPanel(); updateScaleLabel(); }
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => { });
  window.PF = { S, T3, K, computeStats, roomFaces, wallPieces, toScreen, toPlan, setView, setTool, fmtFtIn, parseLen, SCALES, detectWalls, startFly, enterWalk, setMode, build3D, openPlanFile, exportProject, importProject, ready: true };
})();
