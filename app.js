'use strict';
/* FINANZAS OS · PWA (SPA en JS vanilla). Todo el contenido dinámico se inserta con textContent (anti-XSS). */
(() => {
  const CFG = Object.assign({ API_URL: '' }, window.FOS_CONFIG || {});
  // Solo se envía el token a una Web App de Apps Script (evita filtrarlo a un host cualquiera).
  const URL_RE = /^https:\/\/script\.google\.com\/(?:a\/macros\/[\w.-]+\/|macros\/)s\/[\w-]+\/exec$/;
  const KEYS = { token: 'fos.token', url: 'fos.url' };
  const NEW_CAT = '__new__';

  /* ---------- storage seguro (puede lanzar en modo privado) ---------- */
  const ls = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin storage */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* sin storage */ } },
  };

  /* ---------- caché local (stale-while-revalidate): pinta al instante lo último visto y refresca por detrás ---------- */
  const CACHE_PREFIX = 'fos.c.';
  const cacheGet = (key) => { try { const j = JSON.parse(localStorage.getItem(CACHE_PREFIX + key)); return j && j.v !== undefined ? j.v : null; } catch { return null; } };
  const cacheSet = (key, v) => { try { const s = JSON.stringify({ t: Date.now(), v }); if (s.length < 1500000) localStorage.setItem(CACHE_PREFIX + key, s); } catch { /* sin espacio: no pasa nada */ } };
  const cacheClear = () => { try { Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX)).forEach((k) => localStorage.removeItem(k)); } catch { /* nada */ } };
  const WRITE_ACTIONS = new Set(['updateMovimiento', 'addMovimientos', 'categorizeBatch', 'resolveDuplicado', 'categorize', 'setPagado', 'toggleCuota', 'setEstado', 'addManual', 'addCreditConsumo', 'addPagoTarjeta', 'syncYape', 'saveCategory']);
  let inflight = 0;
  const busy = (d) => { inflight = Math.max(0, inflight + d); const el = document.getElementById('busy'); if (el) el.classList.toggle('hidden', inflight === 0); };

  /* ---------- utilidades DOM ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const ICONS = { // constantes propias, no datos del usuario
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12A9 9 0 0 1 18.5 5.8L21 8"/><path d="M21 3v5h-5"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>',
    tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r=".5"/>',
    chart: '<path d="M3 3v18h18"/><path d="M7 15v3M12 9v9M17 5v13"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
  };
  function icon(name) {
    const s = document.createElement('span');
    s.className = 'inline-flex';
    s.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
    return s;
  }
  function hydrateIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach((n) => { n.replaceWith(icon(n.dataset.icon)); });
  }

  const money = new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' });
  const fmtMoney = (n) => (n == null ? '—' : money.format(n));
  // "2026-11-04T17:02:13" -> "04/11 17:02" (sin pasar por Date: evita corrimientos de zona horaria)
  const fmtDate = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || '');
    return m ? `${m[3]}/${m[2]} ${m[4]}:${m[5]}` : (iso || '');
  };

  const INPUT = 'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-400';
  const BTN = 'rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200 disabled:cursor-not-allowed disabled:opacity-40';
  const BTN_GHOST = 'rounded-lg border border-slate-700 px-4 py-2.5 text-sm text-slate-200 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400';

  /* ---------- toast ---------- */
  let toastTimer;
  function toast(msg, kind = 'ok') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'pointer-events-none fixed inset-x-4 bottom-24 z-50 mx-auto max-w-sm rounded-xl border px-4 py-3 text-sm shadow-lg ' +
      (kind === 'err' ? 'border-rose-500/50 bg-rose-950 text-rose-100' : 'border-emerald-500/50 bg-emerald-950 text-emerald-100');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
  }

  /* ---------- cliente API ---------- */
  class ApiError extends Error {
    constructor(code, message) { super(message || code); this.code = code; }
  }
  const ERR_TEXT = {
    NETWORK: 'Sin conexión con el servidor.',
    TIMEOUT: 'El servidor tardó demasiado.',
    BAD_RESPONSE: 'Respuesta inesperada del servidor (¿URL o despliegue incorrectos?).',
    BUSY: 'El servidor está ocupado, reintenta en unos segundos.',
    NOT_FOUND: 'Ese movimiento ya no existe en la hoja.',
    NOT_AVAILABLE: 'Función no disponible en el backend.',
    INTERNAL: 'Error interno del backend (revisa Telegram / Ejecuciones).',
  };
  const errText = (e) => ERR_TEXT[e.code] || e.message || 'Error desconocido.';

  /**
   * Apps Script no lee headers ni responde preflight CORS, así que el token va en el cuerpo
   * y el Content-Type es text/plain (petición "simple", sin OPTIONS).
   */
  async function api(action, payload = {}, { timeoutMs = 30000, creds } = {}) {
    const url = creds ? creds.url : ls.get(KEYS.url);
    const token = creds ? creds.token : ls.get(KEYS.token);
    if (!url || !token) throw new ApiError('NO_CREDENTIALS');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    busy(1);
    try {
      res = await fetch(url, {
        method: 'POST', redirect: 'follow', credentials: 'omit', signal: ctrl.signal,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ token, action, payload }),
      });
    } catch (e) {
      throw new ApiError(e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
    } finally {
      clearTimeout(timer); busy(-1);
    }
    let json;
    try { json = await res.json(); } catch { throw new ApiError('BAD_RESPONSE'); }
    if (!json || json.ok !== true) {
      const code = (json && json.error) || 'BAD_RESPONSE';
      if (code === 'UNAUTHORIZED' && !creds) { ls.del(KEYS.token); openSetup('El token ya no es válido. Ingresa el nuevo.'); }
      throw new ApiError(code, json && json.message);
    }
    harvestEmojis(json.data);
    if (WRITE_ACTIONS.has(action)) cacheClear(); // lo guardado ya no es fiel: mejor cargar de nuevo que mostrar algo viejo
    return json.data;
  }

  /* ---------- setup (URL + token) ---------- */
  function openSetup(errorMsg) {
    const dlg = $('#setup');
    $('#setup-url').value = ls.get(KEYS.url) || CFG.API_URL || '';
    $('#setup-token').value = '';
    const err = $('#setup-error');
    err.classList.toggle('hidden', !errorMsg);
    err.textContent = errorMsg || '';
    if (!dlg.open) dlg.showModal();
  }
  function initSetup() {
    const dlg = $('#setup');
    dlg.addEventListener('cancel', (e) => { if (!hasCreds()) e.preventDefault(); }); // sin credenciales no se puede cerrar
    $('#setup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = $('#setup-url').value.trim();
      const token = $('#setup-token').value.trim();
      const err = $('#setup-error');
      const btn = $('#setup-submit');
      const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };
      if (!URL_RE.test(url)) return fail('La URL debe ser de una Web App de Apps Script (termina en /exec).');
      btn.disabled = true; btn.textContent = 'Verificando…';
      try {
        await api('ping', {}, { creds: { url, token }, timeoutMs: 20000 });
        ls.set(KEYS.url, url); ls.set(KEYS.token, token); cacheClear();
        dlg.close();
        route();
      } catch (ex) {
        fail(ex.code === 'UNAUTHORIZED' ? 'Token incorrecto.' : errText(ex));
      } finally {
        btn.disabled = false; btn.textContent = 'Verificar y guardar';
      }
    });
  }
  const hasCreds = () => !!(ls.get(KEYS.url) && ls.get(KEYS.token));

  /* ---------- estado ---------- */
  let navTok = 0; // se incrementa en cada cambio de vista: una respuesta tardía no pisa otra pantalla
  async function swr(root, key, fetcher, paint, { loadingText = 'Cargando…', retry, onError } = {}) {
    const tok = navTok;
    const cached = cacheGet(key);
    if (cached) paint(cached, true); else root.replaceChildren(loading(loadingText));
    let fresh;
    try { fresh = await fetcher(); } catch (e) {
      if (tok !== navTok || e.code === 'UNAUTHORIZED' || e.code === 'NO_CREDENTIALS') return;
      if (cached) { toast('Sin conexión: mostrando lo último guardado', 'err'); return; }
      if (onError && onError(e)) return;
      root.replaceChildren(failure(e, retry));
      return;
    }
    cacheSet(key, fresh);
    if (tok !== navTok) return;
    if (cached) {
      if (JSON.stringify(cached) === JSON.stringify(fresh)) return; // nada cambió: sin parpadeo
      const a = document.activeElement;
      if (a && root.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return; // no pisar lo que estás escribiendo
    }
    paint(fresh, false);
  }

  const state = { cats: [] };
  const mergeCats = (list) => {
    const set = new Set([...state.cats, ...list]);
    state.cats = [...set].sort((a, b) => a.localeCompare(b, 'es'));
  };
  const validCat = (c) => c.length > 0 && c.length <= 40 && !/^[=+\-@]/.test(c);

  /* ---------- emojis de categorías (el servidor manda { nombre-normalizado: emoji }) ---------- */
  const EMOJI_RE = /^(?:\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}])?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}])?)*|\p{Regional_Indicator}{2})$/u;
  const validEmoji = (e) => { e = String(e || '').trim(); return e.length > 0 && e.length <= 16 && EMOJI_RE.test(e); };
  const normKey = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const emojiStore = (() => { try { return JSON.parse(localStorage.getItem('fos.emojis')) || {}; } catch { return {}; } })();
  state.emojis = emojiStore;
  function mergeEmojis(m) {
    if (!m || typeof m !== 'object') return;
    state.emojis = Object.assign({}, m); // el servidor manda el mapa completo: reemplaza (así un renombrado no deja basura)
    try { localStorage.setItem('fos.emojis', JSON.stringify(state.emojis)); } catch { /* sin storage */ }
  }
  const harvestEmojis = (data) => {
    if (!data) return;
    if (data.emojis) mergeEmojis(data.emojis);
    if (data.tipos) mergeTipos(data.tipos);
    if (Array.isArray(data.results)) data.results.forEach((r) => { if (r && r.ok && r.data) { if (r.data.emojis) mergeEmojis(r.data.emojis); if (r.data.tipos) mergeTipos(r.data.tipos); } });
  };
  state.tipos = (() => { try { return JSON.parse(localStorage.getItem('fos.tipos')) || {}; } catch { return {}; } })();
  function mergeTipos(m) {
    if (!m || typeof m !== 'object') return;
    state.tipos = Object.assign({}, m);
    try { localStorage.setItem('fos.tipos', JSON.stringify(state.tipos)); } catch { /* sin storage */ }
  }
  const tipoOf = (c) => state.tipos[normKey(c)] || null;               // null = categoría antigua sin tipo: se ofrece en ambos lados
  const catsFor = (tipo) => state.cats.filter((c) => !tipoOf(c) || tipoOf(c) === tipo);
  const setCats = (list) => { state.cats = [...new Set(list)].sort((a, b) => a.localeCompare(b, 'es')); };
  const emojiOf = (c) => state.emojis[normKey(c)] || '';
  const catLabel = (c) => (emojiOf(c) ? `${emojiOf(c)} ${c}` : c);
  const EMOJI_PALETTE = ['🍽️', '🛒', '☕', '🍔', '🍕', '🥤', '🚌', '🚕', '⛽', '🏠', '💡', '📶', '📱', '💊', '🩺', '🏋️', '🎮', '🎬', '🎁', '👕', '🛍️', '💇', '👨‍👩‍👧', '🐶', '📚', '✈️', '🧾', '💸', '🔧', '🧴'];
  function emojiPicker(input, onPick) {
    return h('div', { class: 'mt-2 flex flex-wrap gap-1', role: 'group', 'aria-label': 'Emojis sugeridos' }, EMOJI_PALETTE.map((e) =>
      h('button', { type: 'button', class: 'h-9 w-9 rounded-lg border border-slate-700 bg-slate-950 text-lg hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300', 'aria-label': `Usar ${e}`,
        onclick: () => { input.value = e; if (onPick) onPick(); input.dispatchEvent(new Event('input')); } }, e)));
  }

  /* ---------- vista: Inbox ---------- */
  function loading(text = 'Cargando…') { return h('p', { class: 'animate-pulse py-10 text-center text-sm text-slate-400' }, text); }
  function failure(e, retry) {
    return h('div', { class: 'rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-100' },
      h('p', {}, errText(e)),
      h('button', { class: BTN_GHOST + ' mt-3', onclick: retry }, 'Reintentar'));
  }

  const inbox = { kind: 'debito', phase: 1, data: null };
  const KINDS = [['debito', 'Débito'], ['credito', 'Crédito']];

  const INBOX_CALLS = ['getInbox', 'getCreditInbox', 'getCards', 'getCalendar', 'getPendingEstado'];
  // Una sola petición para todo el Inbox. Si el backend aún no tiene `batch`, cae a llamadas sueltas.
  async function fetchInboxRaw() {
    try {
      return (await api('batch', { calls: INBOX_CALLS.map((action) => ({ action })) })).results;
    } catch (e) {
      if (e.code !== 'BAD_ACTION' && e.code !== 'BAD_BATCH') throw e;
      const all = await Promise.allSettled(INBOX_CALLS.map((a) => api(a)));
      return all.map((r) => (r.status === 'fulfilled' ? { ok: true, data: r.value } : { ok: false, error: r.reason.code, message: r.reason.message }));
    }
  }
  function shapeInbox(results) {
    const [d, c, cards, cal, pend] = results;
    const ok = (r) => (r.ok ? r.data : null), err = (r) => (r.ok ? null : new ApiError(r.error, r.message));
    if (!d.ok) throw new ApiError(d.error, d.message);
    return {
      debito: d.data, credito: ok(c), creditoError: err(c), cards: ok(cards), cardsError: err(cards),
      cal: ok(cal), calError: err(cal), pend: ok(pend), pendError: err(pend),
    };
  }
  async function viewInbox(root, refetch = true) {
    if (!refetch && inbox.data) { renderInbox(root); return; }
    await swr(root, 'inbox', async () => { const raw = await fetchInboxRaw(); shapeInbox(raw); return raw; },
      (raw) => {
        inbox.data = shapeInbox(raw);
        setCats([...inbox.data.debito.categories, ...(inbox.data.credito ? inbox.data.credito.categories : [])]);
        renderInbox(root);
      }, { loadingText: 'Cargando movimientos…', retry: () => viewInbox(root) });
  }

  const unpaidList = (data) => (data.cards ? (data.cards.cards || []).flatMap((c) => c.pendientes.map((p) => Object.assign({ tarjeta: c.tarjeta }, p))) : []);
  const dueFees = (data) => (data.cal ? (data.cal.rows || []).filter((r) => r.montos[0] != null && !r.pagadas[0]) : []);

  function phaseBar(root, badge1) {
    const data = inbox.data;
    const n1 = (data.debito ? data.debito.items.length : 0) + (data.credito ? data.credito.items.length : 0);
    const defs = [[1, 'Categorizar', n1], [2, 'Créditos por pagar', data.cards ? unpaidList(data).length : '–'], [3, 'Cuotas del mes', data.cal ? dueFees(data).length : '–'], [4, 'Por procesar', data.pend ? (data.pend.items || []).length : '–']];
    return h('div', { class: 'mb-4 grid grid-cols-2 gap-1 rounded-xl sm:grid-cols-4 border border-slate-800 bg-slate-900 p-1', role: 'tablist', 'aria-label': 'Fases de revisión' },
      defs.map(([n, label, c]) => {
        const on = inbox.phase === n;
        const b = h('span', { class: 'ml-1.5 rounded-full px-2 py-0.5 text-xs ' + (c === 0 ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-amber-300') }, c === 0 ? '✓' : c);
        if (n === 1 && badge1) badge1.el = b;
        return h('button', {
          type: 'button', role: 'tab', 'aria-selected': on ? 'true' : 'false',
          onclick: () => { inbox.phase = n; renderInbox(root); },
          class: 'rounded-lg px-2 py-2 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 sm:text-sm ' + (on ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'),
        }, h('span', { class: 'text-slate-500' }, `${n}. `), label, b);
      }));
  }

  function phasePay(root) {
    const data = inbox.data;
    if (!data.cards) return failure(data.cardsError || new ApiError('NOT_AVAILABLE'), () => viewInbox(root));
    const items = unpaidList(data).sort((a, b) => (a.vence || a.fecha || '').localeCompare(b.vence || b.fecha || ''));
    if (!items.length) return h('div', { class: 'rounded-xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-300' }, h('p', { class: 'text-2xl' }, '✓'), h('p', { class: 'mt-2 text-sm' }, 'No hay consumos de crédito sin pagar.'));
    const total = items.reduce((s, p) => s + p.monto, 0);
    return h('div', {},
      h('p', { class: 'mb-3 text-sm text-slate-400' }, 'Consumos de tarjeta aún sin pagar · total ', h('b', { class: 'text-slate-200' }, fmtMoney(total)), ' · marca ✓ cuando ya los pagaste.'),
      h('ul', { class: 'grid gap-2 lg:grid-cols-2' }, items.map((p) => {
        const box = h('input', { type: 'checkbox', class: 'h-5 w-5 shrink-0 accent-emerald-500', disabled: !p.id, 'aria-label': `Marcar como pagado: ${p.detalle}` });
        box.addEventListener('change', () => {
          if (!box.checked) return;
          markPaid(p, box, () => {
            data.cards.cards.forEach((c) => { c.pendientes = c.pendientes.filter((x) => x.id !== p.id); });
            renderInbox(root);
          });
        });
        return h('li', { class: 'flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900 p-3 text-sm' }, box,
          h('div', { class: 'min-w-0 flex-1' },
            h('p', { class: 'truncate font-medium' }, p.detalle),
            h('p', { class: 'truncate text-xs text-slate-500' }, `${p.tarjeta} · ${fmtD(p.fecha)} · ${p.tipo}${p.vence ? ` · vence ${fmtD(p.vence)}` : ''}`)),
          h('span', { class: 'tabular-nums' }, fmtMoney(p.monto)));
      })));
  }

  function phaseFees(root) {
    const data = inbox.data;
    if (!data.cal) return failure(data.calError || new ApiError('NOT_AVAILABLE'), () => viewInbox(root));
    const rows = dueFees(data);
    if (!rows.length) return h('div', { class: 'rounded-xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-300' }, h('p', { class: 'text-2xl' }, '✓'), h('p', { class: 'mt-2 text-sm' }, 'No quedan cuotas por pagar este mes.'));
    const total = rows.reduce((s, r) => s + r.montos[0], 0);
    return h('div', {},
      h('p', { class: 'mb-3 text-sm text-slate-400' }, `Cuotas de ${data.cal.months[0]} sin pagar · total `, h('b', { class: 'text-slate-200' }, fmtMoney(total)), ' · marca ✓ cuando la pagues.'),
      h('ul', { class: 'grid gap-2 lg:grid-cols-2' }, rows.map((r) => {
        const box = h('input', { type: 'checkbox', class: 'h-5 w-5 shrink-0 accent-emerald-500', disabled: !r.id, 'aria-label': `Marcar cuota pagada: ${r.compra}` });
        box.addEventListener('change', async () => {
          if (!box.checked) return;
          box.disabled = true;
          try {
            await api('toggleCuota', { id: r.id, mes: data.cal.keys[0], pagada: true });
            r.pagadas[0] = true; toast(`Cuota pagada: ${r.compra}`); renderInbox(root);
          } catch (e) { box.checked = false; box.disabled = false; toast(errText(e), 'err'); }
        });
        return h('li', { class: 'flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900 p-3 text-sm' }, box,
          h('div', { class: 'min-w-0 flex-1' }, h('p', { class: 'truncate font-medium' }, r.compra), r.tarjeta && h('p', { class: 'truncate text-xs text-slate-500' }, r.tarjeta)),
          h('span', { class: 'tabular-nums' }, fmtMoney(r.montos[0])));
      })));
  }

  // Movimientos de Crédito con Estado «Pendiente»: se marcan cuando ya aparecen procesados en la app del banco.
  function phaseProcess(root) {
    const data = inbox.data;
    if (!data.pend) return failure(data.pendError || new ApiError('NOT_AVAILABLE'), () => viewInbox(root));
    const items = data.pend.items || [];
    const warn = data.pend.withoutId > 0 && h('p', { class: 'mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100' }, `${data.pend.withoutId} fila(s) pendientes sin ID no aparecen aquí. Ejecuta fosBackfillIds() en Apps Script.`);
    if (!items.length) return h('div', {}, warn, h('div', { class: 'rounded-xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-300' }, h('p', { class: 'text-2xl' }, '✓'), h('p', { class: 'mt-2 text-sm' }, 'No hay movimientos de crédito pendientes de procesar.')));
    return h('div', {},
      warn,
      h('p', { class: 'mb-3 text-sm text-slate-400' }, 'Movimientos de tarjeta con Estado «Pendiente». Marca ✓ los que ya figuran como procesados en la app del banco.'),
      h('ul', { class: 'grid gap-2 lg:grid-cols-2' }, items.map((p) => {
        const box = h('input', { type: 'checkbox', class: 'h-5 w-5 shrink-0 accent-emerald-500', 'aria-label': `Marcar como procesado: ${p.detalle}` });
        box.addEventListener('change', async () => {
          if (!box.checked) return;
          box.disabled = true;
          try {
            await api('setEstado', { id: p.id, estado: 'Procesado' });
            data.pend.items = data.pend.items.filter((x) => x.id !== p.id);
            toast(`Procesado: ${p.detalle}`); renderInbox(root);
          } catch (e) { box.checked = false; box.disabled = false; toast(errText(e), 'err'); }
        });
        return h('li', { class: 'flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900 p-3 text-sm' }, box,
          h('div', { class: 'min-w-0 flex-1' },
            h('p', { class: 'truncate font-medium' }, p.detalle),
            h('p', { class: 'truncate text-xs text-slate-500' }, `${p.tarjeta} · ${fmtDate(p.fecha)} · ${p.tipo}${p.cuotas ? ` · ${p.cuotas} cuotas` : ''}`)),
          h('span', { class: 'tabular-nums ' + (p.monto < 0 ? 'text-rose-300' : 'text-emerald-300') }, fmtMoney(p.monto)));
      })));
  }

  function renderInbox(root) {
    const data = inbox.data;
    if (inbox.phase !== 1) {
      root.replaceChildren(
        h('div', { class: 'mb-3 flex justify-end' }, h('button', { class: BTN_GHOST + ' !px-3 !py-1.5', onclick: () => viewInbox(root) }, 'Actualizar')),
        phaseBar(root), inbox.phase === 2 ? phasePay(root) : inbox.phase === 3 ? phaseFees(root) : phaseProcess(root));
      return;
    }
    const counts = {};
    const badge1 = {};
    const refreshCounts = () => {
      KINDS.forEach(([k]) => { counts[k].textContent = data[k] ? data[k].items.length : '–'; });
      if (badge1.el) { const n = (data.debito ? data.debito.items.length : 0) + (data.credito ? data.credito.items.length : 0); badge1.el.textContent = n === 0 ? '✓' : n; }
    };
    const tab = ([k, label]) => {
      counts[k] = h('span', { class: 'ml-1.5 rounded-full bg-slate-800 px-2 py-0.5 text-xs text-emerald-300' });
      const on = inbox.kind === k;
      return h('button', {
        type: 'button', role: 'tab', 'aria-selected': on ? 'true' : 'false',
        class: 'rounded-lg px-3 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 ' + (on ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'),
        onclick: () => { inbox.kind = k; renderInbox(root); },
      }, label, counts[k]);
    };

    const cur = data[inbox.kind];
    const body = h('div');
    const bar = saveBar(root);
    if (!cur) {
      body.append(failure(data.creditoError || new ApiError('NOT_AVAILABLE'), () => viewInbox(root)));
    } else {
      pruneStage(data);
      const list = h('ul', { class: 'grid gap-3 lg:grid-cols-2' });
      const empty = h('div', { class: 'rounded-xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-300' },
        h('p', { class: 'text-2xl' }, '✓'), h('p', { class: 'mt-2 text-sm' }, 'Todo categorizado. No hay movimientos pendientes.'));
      const sync = () => { empty.classList.toggle('hidden', list.children.length > 0); refreshCounts(); };
      cur.items.forEach((it) => list.append(inboxCard(it, inbox.kind, bar.update)));
      const dups = inbox.kind === 'debito' && Array.isArray(cur.duplicados) ? cur.duplicados : [];
      body.append(...[
        cur.withoutId > 0 && h('p', { class: 'mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100' },
          `${cur.withoutId} fila(s) sin ID no aparecen aquí. Ejecuta fosBackfillIds() en Apps Script.`),
        dups.length > 0 && h('div', { class: 'mb-4 space-y-2' }, dups.map((p) => dupAlert(p, root))),
        cur.items.length > 0 && h('p', { class: 'mb-2 text-xs text-slate-400' }, 'Elige la categoría de cada movimiento y guarda todo de una vez con el botón de abajo.'),
        list, empty].filter(Boolean));
      queueMicrotask(sync);
    }

    root.replaceChildren(...[
      h('div', { class: 'mb-3 flex items-center justify-between gap-2' },
        h('div', { class: 'grid grid-cols-2 gap-1 rounded-xl bg-slate-900 p-1', role: 'tablist' }, KINDS.map(tab)),
        h('button', { class: BTN_GHOST + ' !px-3 !py-1.5', onclick: () => viewInbox(root) }, 'Actualizar')),
      body, bar.el].filter(Boolean));
    root.prepend(phaseBar(root, badge1));
    refreshCounts(); bar.update();
  }

  /* ---- clasificar en lote: lo elegido queda "en preparación" y se guarda todo junto ---- */
  const STAGE_KEY = 'fos.stage';
  const stage = (() => { let s = {}; try { s = JSON.parse(ls.get(STAGE_KEY)) || {}; } catch { s = {}; } return { debito: s.debito || {}, credito: s.credito || {}, errs: {} }; })();
  const saveStage = () => ls.set(STAGE_KEY, JSON.stringify({ debito: stage.debito, credito: stage.credito }));
  const stagedTotal = () => Object.keys(stage.debito).length + Object.keys(stage.credito).length;
  function pruneStage(data) { // lo que ya no está pendiente (se categorizó en otro lado) deja de estar en preparación
    KINDS.forEach(([k]) => {
      if (!data[k]) return;
      const ids = new Set(data[k].items.map((i) => i.id));
      Object.keys(stage[k]).forEach((id) => { if (!ids.has(id)) delete stage[k][id]; });
    });
    saveStage();
  }

  function saveBar(root) {
    const btn = h('button', { type: 'button', class: BTN + ' px-5' }, 'Guardar');
    const clear = h('button', { type: 'button', class: BTN_GHOST, onclick: () => { stage.debito = {}; stage.credito = {}; stage.errs = {}; saveStage(); renderInbox(root); } }, 'Descartar');
    const label = h('span', { class: 'text-sm text-slate-200' });
    const el = h('div', { class: 'sticky bottom-20 z-20 mt-4 hidden items-center justify-between gap-3 rounded-xl border border-emerald-500/40 bg-slate-900/95 p-3 shadow-xl backdrop-blur md:bottom-4', role: 'region', 'aria-label': 'Cambios sin guardar' }, label, h('div', { class: 'flex gap-2' }, clear, btn));
    const update = () => {
      const n = stagedTotal();
      el.classList.toggle('hidden', n === 0); el.classList.toggle('flex', n > 0);
      label.textContent = `${n} movimiento${n === 1 ? '' : 's'} listo${n === 1 ? '' : 's'} para guardar`;
      btn.textContent = `Guardar ${n} cambio${n === 1 ? '' : 's'}`;
    };
    btn.addEventListener('click', async () => {
      btn.disabled = true; clear.disabled = true; btn.textContent = 'Guardando…';
      let ok = 0, fail = 0;
      for (const [k] of KINDS) {
        const ids = Object.keys(stage[k]);
        if (!ids.length || !inbox.data[k]) continue;
        const items = ids.map((id) => { const v = stage[k][id]; return v.pago ? { id, categoria: 'Pago Tarjeta', pagoTarjeta: true } : { id, categoria: v.categoria, emoji: v.emoji }; });
        for (let i = 0; i < items.length; i += 100) {
          try {
            const r = await api('categorizeBatch', { hoja: k, items: items.slice(i, i + 100) });
            r.results.forEach((x) => {
              if (x.ok) {
                ok++; delete stage[k][x.id]; delete stage.errs[x.id];
                inbox.data[k].items = inbox.data[k].items.filter((it) => it.id !== x.id);
                if (x.categoria && x.categoria !== 'Pago Tarjeta') mergeCats([x.categoria]);
              } else { fail++; stage.errs[x.id] = ERR_TEXT[x.error] || x.message || x.error; }
            });
          } catch (e) { toast(errText(e), 'err'); fail += items.slice(i, i + 100).length; }
        }
      }
      saveStage();
      toast(fail ? `${ok} guardado(s) · ${fail} con error (míralas abajo)` : `${ok} movimiento(s) guardado(s)`, fail ? 'err' : 'ok');
      renderInbox(root);
    });
    return { el, update };
  }

  function dupAlert(p, root) {
    const row = (tag, x) => h('div', { class: 'flex items-baseline justify-between gap-3 text-sm' },
      h('span', { class: 'min-w-0 truncate' }, h('span', { class: 'mr-2 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-200' }, tag), x.detalle),
      h('span', { class: 'shrink-0 tabular-nums text-rose-300' }, `${fmtMoney(x.monto)} · ${fmtDate(x.fecha)}`));
    const act = async (accion, dup) => {
      el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        await api('resolveDuplicado', { accion, a: p.yape.id, b: p.banco.id, duplicado: dup });
        if (dup) { delete stage.debito[dup]; saveStage(); }
        toast(accion === 'marcar' ? 'Marcado como duplicado: ya no cuenta en tus totales' : 'Listo: no se volverá a avisar de este par');
        viewInbox(root);
      } catch (e) { toast(errText(e), 'err'); el.querySelectorAll('button').forEach((b) => { b.disabled = false; }); }
    };
    const el = h('div', { class: 'rounded-xl border border-amber-500/50 bg-amber-500/10 p-3', role: 'alert' },
      h('p', { class: 'text-sm font-semibold text-amber-100' }, `⚠ Posible duplicado Yape ↔ BCP · confianza ${p.confianza} · a ${p.minutos} min`),
      h('div', { class: 'mt-2 space-y-1' }, row('Yape', p.yape), row('BCP', p.banco)),
      h('p', { class: 'mt-1 text-xs text-slate-400' }, 'Un pago por Yape a una billetera externa puede entrar dos veces: por Yape y por el consumo débito del BCP.'),
      h('div', { class: 'mt-2 flex flex-wrap gap-2' },
        h('button', { type: 'button', class: BTN + ' !px-3 !py-1.5', onclick: () => act('marcar', p.banco.id) }, 'Es duplicado: ocultar el del BCP'),
        h('button', { type: 'button', class: BTN_GHOST + ' !px-3 !py-1.5', onclick: () => act('marcar', p.yape.id) }, 'Ocultar el de Yape'),
        h('button', { type: 'button', class: BTN_GHOST + ' !px-3 !py-1.5', onclick: () => act('descartar') }, 'No es duplicado')));
    return el;
  }

  function inboxCard(it, kind, onChange) {
    const itemTipo = kind === 'credito' || (it.monto || 0) < 0 ? 'Egreso' : 'Ingreso'; // las categorías se filtran por el signo del monto
    const st = stage[kind][it.id];
    const stagedNew = st && st.categoria && !catsFor(itemTipo).includes(st.categoria);
    const sel = h('select', { class: INPUT, 'aria-label': 'Categoría' },
      h('option', { value: '', disabled: true }, 'Elegir categoría…'),
      catsFor(itemTipo).map((c) => h('option', { value: c }, catLabel(c))),
      h('option', { value: NEW_CAT }, `+ Nueva categoría de ${itemTipo.toLowerCase()}…`));
    sel.value = st && st.categoria ? (stagedNew ? NEW_CAT : st.categoria) : '';
    const newInp = h('input', { class: INPUT + (stagedNew ? '' : ' hidden') + ' mt-2', placeholder: 'Nombre de la categoría', maxlength: '40', 'aria-label': 'Nueva categoría', value: stagedNew ? st.categoria : '' });
    const emoInp = h('input', { class: INPUT + ' mt-2 w-24 text-center text-xl', placeholder: '😀', maxlength: '16', 'aria-label': 'Emoji de la nueva categoría (obligatorio)', inputmode: 'text', value: stagedNew ? st.emoji || '' : '' });
    const emoBox = h('div', { class: 'hidden' }, h('p', { class: 'mt-2 text-xs text-slate-400' }, 'Toda categoría nueva necesita un emoji:'), emoInp, emojiPicker(emoInp));
    const isNewName = () => sel.value === NEW_CAT && !state.cats.some((c) => normKey(c) === normKey(newInp.value));
    const payBtn = h('button', { class: 'mt-2 text-xs text-slate-400 underline decoration-dotted underline-offset-2 hover:text-slate-200', type: 'button' });
    const flag = h('span', { class: 'hidden rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-300' }, '✓ listo');
    const errP = h('p', { class: 'mt-2 text-xs text-rose-300' }, stage.errs[it.id] || '');
    const chosen = () => (sel.value === NEW_CAT ? newInp.value.trim() : sel.value);
    const li = h('li', { class: 'rounded-xl border bg-slate-900 p-4' });
    const paint = () => {
      const s = stage[kind][it.id];
      emoBox.classList.toggle('hidden', !isNewName());
      flag.classList.toggle('hidden', !s);
      li.className = 'rounded-xl border bg-slate-900 p-4 ' + (s ? 'border-emerald-500/50' : 'border-slate-800');
      payBtn.textContent = s && s.pago ? '✓ Marcado como pago de tarjeta (quitar)' : 'Es un pago de tarjeta (no es gasto)';
      errP.classList.toggle('hidden', !errP.textContent);
    };
    const restage = () => {
      const c = chosen();
      if (validCat(c) && (!isNewName() || validEmoji(emoInp.value))) stage[kind][it.id] = isNewName() ? { categoria: c, emoji: emoInp.value.trim() } : { categoria: c };
      else delete stage[kind][it.id];
      delete stage.errs[it.id]; errP.textContent = '';
      saveStage(); paint(); onChange();
    };
    sel.addEventListener('change', () => { newInp.classList.toggle('hidden', sel.value !== NEW_CAT); if (sel.value === NEW_CAT) newInp.focus(); restage(); });
    newInp.addEventListener('input', restage);
    emoInp.addEventListener('input', restage);
    payBtn.addEventListener('click', () => {
      const s = stage[kind][it.id];
      if (s && s.pago) delete stage[kind][it.id]; else { stage[kind][it.id] = { pago: true }; sel.value = ''; newInp.classList.add('hidden'); }
      delete stage.errs[it.id]; errP.textContent = '';
      saveStage(); paint(); onChange();
    });

    li.append(...[
      h('div', { class: 'flex items-start justify-between gap-3' },
        h('div', { class: 'min-w-0' },
          h('p', { class: 'truncate font-medium' }, it.detalle || '(sin detalle)'),
          it.descripcion && h('p', { class: 'truncate text-sm text-slate-400' }, it.descripcion),
          h('p', { class: 'mt-0.5 text-xs text-slate-500' }, `${fmtDate(it.fecha)} · ${it.banco}`, it.cuotas ? ` · ${it.cuotas} cuotas` : '')),
        h('div', { class: 'flex shrink-0 flex-col items-end gap-1' },
          h('p', { class: 'font-semibold tabular-nums ' + ((it.monto || 0) < 0 ? 'text-rose-300' : 'text-emerald-300') }, fmtMoney(it.monto)), flag)),
      h('div', { class: 'mt-3' }, h('div', {}, sel, newInp, emoBox)),
      kind === 'debito' && payBtn, errP].filter(Boolean));
    paint();
    return li;
  }

  /* ---------- vista: Movimientos (una cuenta a la vez, tabla editable y panel para cargar varias filas) ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const nowLocalInput = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  function rand4() {
    if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase();
    const b = new Uint8Array(2); crypto.getRandomValues(b);
    return [...b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  // MAN_YYYYMMDD_HHMM_XXXX (la fecha del ID es la del movimiento)
  const manualId = (local) => `MAN_${local.slice(0, 10).replace(/-/g, '')}_${local.slice(11, 16).replace(':', '')}_${rand4()}`;
  const fmtFull = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}` : (iso || ''); };
  const r2 = (n) => Math.round(n * 100) / 100;

  const HIST_NAMES = { debito: 'Débito', credito: 'Crédito' };
  const MOV_KEY = 'fos.mov';
  const mov = (() => {
    let saved = {};
    try { saved = JSON.parse(ls.get(MOV_KEY)) || {}; } catch { saved = {}; }
    return {
      hoja: saved.hoja === 'credito' ? 'credito' : 'debito', cuenta: saved.cuenta || {}, drafts: saved.drafts || {}, banco: saved.banco || {},
      d: null, mes: '', q: '', limit: 200, drawer: false, ui: null, queue: Promise.resolve(),
    };
  })();
  const saveMov = () => ls.set(MOV_KEY, JSON.stringify({ hoja: mov.hoja, cuenta: mov.cuenta, drafts: mov.drafts, banco: mov.banco }));
  const dkey = () => `${mov.hoja}|${mov.cuenta[mov.hoja] || (mov.d && mov.d.cuenta) || ''}`;
  const draftList = () => (mov.drafts[dkey()] = mov.drafts[dkey()] || []);

  const colIdx = (d, name) => d.columns.findIndex((c) => normKey(c) === normKey(name));
  function ensureCol(d, name) { // columnas que el servidor crea al primer uso (Comentario, Categoría): se muestran igual
    if (colIdx(d, name) >= 0) return;
    d.columns.push(name); d.rows.forEach((r) => r.push(null));
  }

  /* --- totales y vista previa --- */
  const isDup = (d, r) => { const i = colIdx(d, 'Categoría'); return i >= 0 && normKey(r[i]) === 'duplicado'; };
  function scopeTotals(d, rows) {
    const iM = colIdx(d, 'Monto');
    let ing = 0, egr = 0;
    rows.forEach((r) => { const m = r[iM]; if (typeof m !== 'number' || isDup(d, r)) return; if (m > 0) ing += m; else egr += -m; });
    return { ingresos: r2(ing), egresos: r2(egr), neto: r2(ing - egr) };
  }
  const draftMonto = (r) => { const n = Number(String(r.monto).replace(',', '.')); return Number.isFinite(n) && n > 0 && n <= 1000000 ? n : 0; };
  function draftProblem(r) {
    if (!draftMonto(r)) return 'Falta el monto';
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(r.fecha || '')) return 'Falta la fecha';
    if (mov.hoja === 'debito') {
      if (r.tipo === 'Pago') return r.tarjeta ? '' : 'Elige la tarjeta';
      return r.detalle.trim() ? '' : 'Falta el detalle';
    }
    if (r.tipo === 'Abono') return '';
    if (!r.detalle.trim()) return 'Falta el detalle';
    if (r.tipo === 'Cuotas') { const c = Number(r.cuotas); if (!(Number.isInteger(c) && c >= 2 && c <= 48)) return 'Cuotas: de 2 a 48'; }
    return '';
  }
  const draftSign = (r) => (r.tipo === 'Ingreso' || r.tipo === 'Abono' ? 1 : -1);
  function draftEffect(mes) {
    let ing = 0, egr = 0, n = 0;
    draftList().forEach((r) => {
      if (draftProblem(r)) return;
      if (mes && !r.fecha.startsWith(mes)) return;
      const m = draftMonto(r); n++;
      if (draftSign(r) > 0) ing += m; else egr += m;
    });
    return { ingresos: r2(ing), egresos: r2(egr), neto: r2(ing - egr), n };
  }

  /* --- carga --- */
  async function viewHistory(root, refetch = false) {
    const k = mov.hoja, want = mov.cuenta[k] || '';
    const fetcher = async () => {
      try { return await api('getHistory', want ? { hoja: k, cuenta: want } : { hoja: k }); } catch (e) {
        if (want && e.code === 'BAD_CUENTA') { mov.cuenta[k] = ''; return api('getHistory', { hoja: k }); }
        throw e;
      }
    };
    const paint = (d) => {
      if (mov.hoja !== k) return;
      ensureCol(d, 'Comentario'); if (k === 'credito') ensureCol(d, 'Categoría');
      setCats(d.categories || state.cats);
      mov.d = d; mov.cuenta[k] = d.cuenta || ''; saveMov();
      if (mov.ui && mov.ui.root === root && root.contains(mov.ui.el)) mov.ui.refresh(); else buildMov(root);
    };
    if (refetch) cacheClear();
    await swr(root, `mov:${k}:${want}`, fetcher, (d) => paint(d), { loadingText: 'Cargando movimientos…', retry: () => viewHistory(root, true) });
  }

  const MOV_COLS = {
    debito: [['fecha', 'Fecha', 'Fecha', 'dt'], ['detalle', 'Detalle', 'Detalle/Comercio', 'text'], ['desc', 'Descripción', 'Descripción', 'ro'], ['categoria', 'Categoría', 'Categoría', 'cat'],
      ['monto', 'Monto', 'Monto', 'money'], ['comentario', 'Comentario', 'Comentario', 'text']],
    credito: [['fecha', 'Fecha', 'Fecha', 'dt'], ['detalle', 'Detalle', 'Detalle/Comercio', 'text'], ['modalidad', 'Modalidad', 'Modalidad', 'ro'], ['cuotas', 'Cuotas', 'N° Cuotas', 'ro'],
      ['categoria', 'Categoría', 'Categoría', 'cat'], ['monto', 'Monto', 'Monto', 'money'], ['estado', 'Estado', 'Estado', 'estado'], ['pagado', 'Pagado', 'Pagado', 'bool'], ['comentario', 'Comentario', 'Comentario', 'text']],
  };

  function movToast(e) { toast(e.code === 'CONFLICT' ? 'Ese dato cambió en la hoja mientras lo editabas. Recargué para que veas el actual.' : errText(e), 'err'); }
  Object.assign(ERR_TEXT, {
    CONFLICT: 'Ese dato cambió en la hoja. Recarga para ver el actual.', PAGO_LINKED: 'Es un pago de tarjeta (partida doble): solo se puede comentar.',
    UNKNOWN_CATEGORY: 'Esa categoría no existe: créala en Categorías.', TIPO_MISMATCH: 'La categoría no corresponde a un ingreso/egreso de ese monto.',
    BAD_CUENTA: 'Cuenta no reconocida.', BAD_CATEGORIA: 'Categoría no permitida.', BAD_AMOUNT: 'Monto inválido.', BAD_ESTADO: 'Estado inválido.',
  });

  function buildMov(root) {
    const d = () => mov.d;
    const tilesBox = h('div', { class: 'mb-3 grid grid-cols-3 gap-2' });
    const info = h('p', { class: 'my-2 text-sm text-slate-400', 'aria-live': 'polite' });
    const wrap = h('div', { class: 'max-h-[62vh] overflow-auto rounded-xl border border-slate-800 bg-slate-900' });
    const more = h('button', { type: 'button', class: BTN_GHOST + ' mt-3 hidden', onclick: () => { mov.limit += 200; drawTable(); } }, 'Mostrar más');
    const controls = h('div', { class: 'mb-3 space-y-2' });
    const drawerBox = h('div', {});
    const el = h('div', { class: mov.drawer ? 'md:mr-[31rem]' : '' }, controls, tilesBox, info, wrap, more);
    root.replaceChildren(el, drawerBox);
    mov.ui = { root, el, refresh };

    /* ---- controles ---- */
    function drawControls() {
      const D = d();
      const tab = (key) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': mov.hoja === key ? 'true' : 'false',
        onclick: () => { if (mov.hoja === key) return; mov.hoja = key; mov.mes = ''; mov.q = ''; mov.limit = 200; saveMov(); mov.d = null; viewHistory(root); },
        class: 'rounded-lg px-4 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 ' + (mov.hoja === key ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'),
      }, HIST_NAMES[key]);
      const selCta = h('select', { class: INPUT + ' sm:w-auto font-semibold', 'aria-label': mov.hoja === 'credito' ? 'Tarjeta' : 'Cuenta' },
        D.cuentas.map((c) => h('option', { value: c.nombre, selected: c.nombre === D.cuenta }, `${c.nombre} (${c.n})`)));
      selCta.addEventListener('change', () => { mov.cuenta[mov.hoja] = selCta.value; mov.mes = ''; mov.limit = 200; saveMov(); viewHistory(root); });
      const months = [...new Set(D.rows.map((r) => (r[colIdx(D, 'Fecha')] || '').slice(0, 7)).filter(Boolean))];
      if (mov.mes && !months.includes(mov.mes)) mov.mes = '';
      const selMes = h('select', { class: INPUT + ' sm:w-auto', 'aria-label': 'Mes' }, h('option', { value: '' }, 'Todo el historial'),
        months.map((m) => h('option', { value: m, selected: m === mov.mes }, mesLabel(m))));
      selMes.addEventListener('change', () => { mov.mes = selMes.value; mov.limit = 200; drawTiles(); drawTable(); });
      const q = h('input', { type: 'search', class: INPUT + ' sm:max-w-xs', placeholder: 'Buscar comercio, monto…', value: mov.q, 'aria-label': 'Buscar' });
      q.addEventListener('input', () => { mov.q = q.value; mov.limit = 200; drawTiles(); drawTable(); });
      controls.replaceChildren(
        h('div', { class: 'flex flex-wrap items-center justify-between gap-2' },
          h('div', { role: 'tablist', class: 'flex gap-1 rounded-xl bg-slate-900 p-1' }, tab('debito'), tab('credito')),
          h('div', { class: 'flex gap-2' },
            h('button', { type: 'button', class: BTN_GHOST + ' !px-3 !py-1.5', onclick: () => viewHistory(root, true) }, 'Actualizar'),
            h('button', { type: 'button', 'data-act': 'drawer', class: BTN + ' !px-3 !py-1.5', onclick: () => toggleDrawer(!mov.drawer) }, mov.drawer ? 'Cerrar panel' : '+ Cargar varios'))),
        h('div', { class: 'flex flex-col gap-2 sm:flex-row' }, selCta, selMes, q));
    }

    /* ---- tiles: Débito = Ingresos / Egresos / Neto · Crédito = Ingresos / Egresos / Saldo disponible ---- */
    function scopeRows() {
      const D = d(), iF = colIdx(D, 'Fecha'), needle = normKey(mov.q);
      return D.rows.filter((r) => (!mov.mes || (r[iF] || '').startsWith(mov.mes)) && (!needle || normKey(r.map((v) => (v == null ? '' : v)).join(' ')).includes(needle)));
    }
    function drawTiles() {
      const D = d(), cred = mov.hoja === 'credito';
      const filtered = !!(mov.mes || mov.q);
      const base = filtered && !D.truncated ? scopeTotals(D, scopeRows()) : D.totales;
      const fx = draftEffect(mov.mes);
      const tile = (label, v, after, tone, note) => h('div', { class: 'rounded-xl border border-slate-800 bg-slate-900 p-3' },
        h('p', { class: 'text-xs text-slate-400' }, label),
        h('p', { class: 'mt-1 text-lg font-semibold tabular-nums sm:text-xl ' + tone }, fmtMoney(v)),
        after != null && fx.n ? h('p', { class: 'text-xs tabular-nums text-amber-300' }, `quedaría ${fmtMoney(after)}`) : null,
        note ? h('p', { class: 'text-[11px] text-slate-500' }, note) : null);
      const third = cred ? D.totales.saldo : base.neto;
      const thirdFx = cred ? D.totales.saldo + (fx.ingresos - fx.egresos) : base.neto + (fx.ingresos - fx.egresos);
      const hasFx = (mov.mes ? fx : draftEffect('')).n;
      tilesBox.replaceChildren(
        tile('Ingresos', base.ingresos, base.ingresos + fx.ingresos, 'text-emerald-300', filtered ? (mov.mes ? mesLabel(mov.mes) : 'con tu búsqueda') : 'todo el historial'),
        tile('Egresos', base.egresos, base.egresos + fx.egresos, 'text-rose-300', filtered ? (mov.mes ? mesLabel(mov.mes) : 'con tu búsqueda') : 'todo el historial'),
        tile(cred ? 'Saldo disponible' : 'Neto', third, hasFx ? thirdFx : null, third < 0 ? 'text-rose-300' : 'text-slate-100', cred ? 'actual de la tarjeta' : (filtered ? 'ingresos − egresos' : 'ingresos − egresos')));
    }

    /* ---- tabla editable ---- */
    const rowById = (id) => { const D = d(), iI = colIdx(D, 'ID'); return D.rows.find((r) => String(r[iI]) === id); };
    function enqueue(job) { mov.queue = mov.queue.then(job, job); return mov.queue; }

    function saveCell(row, key, newLocal, payloadVal, oldPayloadVal) {
      const D = d(), iI = colIdx(D, 'ID'), id = String(row[iI]);
      const cdef = MOV_COLS[mov.hoja].find((c) => c[0] === key);
      const idx = colIdx(D, cdef[2]);
      const before = row[idx], beforeTipo = colIdx(D, 'Tipo') >= 0 ? row[colIdx(D, 'Tipo')] : undefined;
      row[idx] = newLocal;
      if (key === 'monto' && mov.hoja === 'debito' && colIdx(D, 'Tipo') >= 0) row[colIdx(D, 'Tipo')] = newLocal < 0 ? 'Egreso' : 'Ingreso';
      if (key === 'fecha') D.rows.sort((a, b) => String(b[colIdx(D, 'Fecha')] || '').localeCompare(String(a[colIdx(D, 'Fecha')] || '')));
      recompute(); drawTiles(); drawTable();
      return enqueue(async () => {
        try {
          await api('updateMovimiento', { hoja: mov.hoja, id, cambios: { [key]: payloadVal }, expect: { [key]: oldPayloadVal } });
        } catch (e) {
          row[idx] = before; if (beforeTipo !== undefined) row[colIdx(D, 'Tipo')] = beforeTipo;
          recompute(); drawTiles(); drawTable();
          movToast(e);
          if (e.code === 'CONFLICT') viewHistory(root, true);
        }
      });
    }
    function recompute() { const D = d(); if (!D.truncated) D.totales = Object.assign({}, D.totales, scopeTotals(D, D.rows), { saldo: scopeTotals(D, D.rows).neto }); }

    function editable(td, { display, edit, locked }) {
      if (locked) { td.classList.add('text-slate-500'); td.title = 'Bloqueado: pago de tarjeta (partida doble)'; return td; }
      td.tabIndex = 0; td.classList.add('cursor-text', 'hover:bg-slate-800', 'focus:outline-none', 'focus-visible:ring-1', 'focus-visible:ring-emerald-400');
      const go = () => edit(td);
      td.addEventListener('click', (e) => { if (!td.querySelector('input,select')) go(e); });
      td.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !td.querySelector('input,select')) { e.preventDefault(); go(e); } });
      return td;
    }
    function inlineInput(td, { type, value, onCommit, attrs = {} }) {
      const inp = h('input', Object.assign({ type, value, class: 'w-full min-w-[7rem] rounded border border-emerald-500 bg-slate-950 px-2 py-1 text-sm text-slate-100 focus:outline-none' }, attrs));
      let done = false;
      const finish = (ok) => { if (done) return; done = true; if (ok && inp.value !== value) onCommit(inp.value); else drawTable(); };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
      inp.addEventListener('blur', () => finish(true));
      td.replaceChildren(inp); inp.focus(); if (type === 'text') inp.select();
    }
    function cell(r, c) {
      const D = d(), [key, , header, kind] = c, i = colIdx(D, header);
      const v = i >= 0 ? r[i] : null, iI = colIdx(D, 'ID'), hasId = !!(iI >= 0 && r[iI]);
      const catIdx = colIdx(D, 'Categoría'), isPago = catIdx >= 0 && normKey(r[catIdx]) === 'pago tarjeta';
      const td = h('td', { class: 'whitespace-nowrap px-3 py-2 ' });
      const blank = v === null || v === '';
      const dim = isDup(D, r) ? ' line-through opacity-60' : '';
      const lockedBase = !hasId;
      if (kind === 'ro') { td.className += 'text-slate-400' + dim; td.textContent = blank ? '·' : String(v); return td; }
      if (kind === 'bool') {
        td.className += 'text-center';
        const cb = h('input', { type: 'checkbox', class: 'h-4 w-4 accent-emerald-500', 'aria-label': 'Pagado', disabled: lockedBase || normKey(r[colIdx(D, 'Tipo')]) !== 'egreso' });
        cb.checked = v === true;
        cb.addEventListener('change', () => saveCell(r, key, cb.checked, cb.checked, v === true));
        td.append(cb); return td;
      }
      if (kind === 'estado') {
        const pend = normKey(v) === 'pendiente';
        const b = h('button', { type: 'button', disabled: lockedBase || blank, title: pend ? 'Marcar como procesado' : 'Volver a pendiente',
          class: 'rounded-full px-2 py-0.5 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 ' + (pend ? 'bg-amber-500/20 text-amber-200 hover:bg-amber-500/30' : 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25') }, blank ? '·' : String(v));
        b.addEventListener('click', () => { const nuevo = pend ? 'Procesado' : 'Pendiente'; saveCell(r, key, nuevo, nuevo, v == null ? '' : String(v)); });
        td.append(b); return td;
      }
      if (kind === 'dt') {
        td.className += 'tabular-nums text-slate-300' + dim; td.textContent = fmtFull(v);
        return editable(td, { locked: lockedBase || isPago, edit: () => inlineInput(td, { type: 'datetime-local', value: (v || '').slice(0, 16),
          onCommit: (nv) => { if (!nv) return drawTable(); saveCell(r, key, nv + ':00', nv, v); } }) });
      }
      if (kind === 'money') {
        const neg = typeof v === 'number' && v < 0;
        td.className += 'text-right tabular-nums ' + (neg ? 'text-rose-300' : 'text-emerald-300') + dim; td.textContent = typeof v === 'number' ? fmtMoney(v) : '·';
        td.title = 'Escribe el monto; con + o − al inicio cambias el signo';
        return editable(td, { locked: lockedBase || isPago, edit: () => inlineInput(td, { type: 'text', value: String(v ?? ''), attrs: { inputmode: 'decimal', class: 'w-24 rounded border border-emerald-500 bg-slate-950 px-2 py-1 text-right text-sm text-slate-100 focus:outline-none' },
          onCommit: (nv) => {
            const s = nv.replace(/[^\d.,+\-]/g, '').replace(',', '.'); const n = Math.abs(Number(s.replace(/^[+-]/, '')));
            if (!Number.isFinite(n) || n === 0 || n > 1000000) { toast('Monto inválido.', 'err'); return drawTable(); }
            const sign = s.startsWith('+') ? 1 : s.startsWith('-') ? -1 : (typeof v === 'number' && v < 0 ? -1 : 1);
            const val = r2(sign * n);
            if (val === v) return drawTable();
            saveCell(r, key, val, val, v);
          } }) });
      }
      if (kind === 'cat') {
        td.className += 'text-slate-200' + dim; td.textContent = blank ? '·' : catLabel(v);
        if (blank) td.className = td.className.replace('text-slate-200', 'text-slate-600');
        return editable(td, { locked: lockedBase || isPago, edit: () => {
          const m = r[colIdx(D, 'Monto')];
          const tipo = typeof m === 'number' && m > 0 ? 'Ingreso' : 'Egreso';
          const list = catsFor(tipo);
          const sel = h('select', { class: 'rounded border border-emerald-500 bg-slate-950 px-2 py-1 text-sm text-slate-100 focus:outline-none' },
            h('option', { value: '' }, '— Sin categoría'),
            ...[...new Set([...(v && !list.includes(v) && normKey(v) !== 'duplicado' ? [v] : []), ...list])].map((x) => h('option', { value: x, selected: x === v }, catLabel(x))),
            mov.hoja === 'debito' ? h('option', { value: 'Duplicado', selected: normKey(v) === 'duplicado' }, '♻️ Duplicado') : null);
          if (!v) sel.value = '';
          let done = false;
          sel.addEventListener('change', () => { done = true; const nv = sel.value; if (nv === (v || '')) drawTable(); else saveCell(r, key, nv || null, nv, v == null ? '' : String(v)); });
          sel.addEventListener('blur', () => { if (!done) drawTable(); });
          td.replaceChildren(sel); sel.focus();
        } });
      }
      // texto libre: detalle / comentario
      td.className += (key === 'comentario' ? 'text-slate-400 ' : 'text-slate-200 ') + dim;
      if (key === 'detalle' && td.className) td.className += ' max-w-[18rem] truncate';
      td.textContent = blank ? (key === 'comentario' ? '＋ comentario' : '·') : String(v);
      if (blank) td.className += ' text-slate-600';
      const canEdit = !lockedBase && !(isPago && key !== 'comentario');
      return editable(td, { locked: !canEdit, edit: () => inlineInput(td, { type: 'text', value: v == null ? '' : String(v), attrs: { maxlength: key === 'detalle' ? '120' : '200', placeholder: key === 'comentario' ? 'Comentario' : '' },
        onCommit: (nv) => {
          const t = nv.trim();
          if (key === 'detalle' && !t) { toast('El detalle no puede quedar vacío.', 'err'); return drawTable(); }
          if (/^[=+\-@]/.test(t)) { toast('No puede empezar con = + - @', 'err'); return drawTable(); }
          saveCell(r, key, t || null, t, v == null ? '' : String(v));
        } }) });
    }
    function drawTable() {
      const D = d(), rows = scopeRows(), shown = rows.slice(0, mov.limit);
      const cols = MOV_COLS[mov.hoja].filter((c) => !(mov.drawer && c[3] === 'ro') && (c[3] === 'cat' || c[3] === 'money' || colIdx(D, c[2]) >= 0 || c[0] === 'comentario'));
      const sc = scopeTotals(D, rows);
      info.replaceChildren(...[`${rows.length} fila(s) de ${D.cuenta}`, rows.length === D.rows.length ? '' : ` (de ${D.total} en total)`,
        D.truncated ? ` · se cargan las ${D.rows.length} más recientes` : '', ' · ', h('span', { class: 'text-slate-500' }, 'toca una celda para editarla'),
        mov.q || mov.mes ? [' · ', 'entradas ', h('b', { class: 'text-emerald-300' }, fmtMoney(sc.ingresos)), ' · salidas ', h('b', { class: 'text-rose-300' }, fmtMoney(sc.egresos))] : ''].flat());
      wrap.replaceChildren(rows.length ? h('table', { class: 'w-full text-sm' },
        h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: 'sticky top-0 z-10 whitespace-nowrap bg-slate-800 px-3 py-2 font-medium text-slate-300 ' + (c[3] === 'money' ? 'text-right' : c[3] === 'bool' ? 'text-center' : 'text-left') }, c[1])))),
        h('tbody', {}, shown.map((r) => h('tr', { class: 'border-t border-slate-800 hover:bg-slate-800/40' }, cols.map((c) => cell(r, c))))))
        : h('p', { class: 'p-8 text-center text-sm text-slate-500' }, mov.q || mov.mes ? 'Sin resultados.' : 'Esta cuenta aún no tiene movimientos: usa «+ Cargar varios».'));
      more.classList.toggle('hidden', rows.length <= shown.length);
    }

    /* ---- panel para cargar varios movimientos (derecha en PC, abajo en el celular) ---- */
    function newDraft() {
      const list = draftList(), last = list[list.length - 1], f = last ? last.fecha : nowLocalInput();
      const base = { id: manualId(f), fecha: f, monto: '', detalle: '', categoria: '', comentario: '', err: '' };
      return mov.hoja === 'debito' ? Object.assign(base, { tipo: last ? last.tipo : 'Egreso', tarjeta: last ? last.tarjeta : '' })
        : Object.assign(base, { tipo: last ? last.tipo : 'Directo', cuotas: '', pagado: false });
    }
    function toggleDrawer(on) {
      mov.drawer = on;
      if (on && !draftList().length) draftList().push(newDraft());
      el.className = on ? 'md:mr-[31rem]' : '';
      drawControls(); drawDrawer();
    }
    const TIPOS = { debito: [['Egreso', 'Egreso'], ['Ingreso', 'Ingreso'], ['Pago', 'Pago de tarjeta']], credito: [['Directo', 'Consumo directo'], ['Cuotas', 'Consumo en cuotas'], ['Abono', 'Abono / ingreso']] };
    const SMALL = 'rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none';
    function drawDrawer() {
      if (!mov.drawer) { drawerBox.replaceChildren(); return; }
      const D = d(), list = draftList(), cred = mov.hoja === 'credito';
      const pv = h('div', { class: 'rounded-lg bg-slate-800/70 p-2 text-xs tabular-nums', 'aria-live': 'polite' });
      const bancoIn = h('input', { type: 'number', step: '0.01', inputmode: 'decimal', class: SMALL + ' w-28 text-right', placeholder: '0.00', 'aria-label': 'Saldo en la app del banco', value: mov.banco[dkey()] ?? '' });
      const cuadre = h('span', { class: 'text-xs' });
      function preview() {
        const fx = draftEffect('');
        const T = D.totales, saldo = cred ? T.saldo : T.neto, saldoFx = r2(saldo + fx.ingresos - fx.egresos);
        pv.replaceChildren(...[
          h('div', { class: 'flex flex-wrap gap-x-4 gap-y-1' },
            h('span', {}, 'Ingresos ', h('b', { class: 'text-emerald-300' }, fmtMoney(T.ingresos)), fx.n ? [' → ', h('b', { class: 'text-amber-300' }, fmtMoney(r2(T.ingresos + fx.ingresos)))] : ''),
            h('span', {}, 'Egresos ', h('b', { class: 'text-rose-300' }, fmtMoney(T.egresos)), fx.n ? [' → ', h('b', { class: 'text-amber-300' }, fmtMoney(r2(T.egresos + fx.egresos)))] : ''),
            h('span', {}, cred ? 'Disponible ' : 'Neto ', h('b', { class: 'text-slate-100' }, fmtMoney(saldo)), fx.n ? [' → ', h('b', { class: 'text-amber-300' }, fmtMoney(saldoFx))] : '')),
          fx.n ? h('p', { class: 'mt-1 text-[11px] text-slate-400' }, `${fx.n} fila(s) válida(s) sin registrar`) : null].filter(Boolean));
        const raw = bancoIn.value.trim();
        if (raw === '' || !Number.isFinite(Number(raw))) { cuadre.textContent = ''; return; }
        const diff = r2(Number(raw) - saldoFx);
        cuadre.className = 'text-xs font-semibold ' + (diff === 0 ? 'text-emerald-300' : 'text-amber-300');
        cuadre.textContent = diff === 0 ? '✓ cuadra con tu app' : `diferencia ${fmtMoney(diff)} (app − sistema)`;
      }
      bancoIn.addEventListener('input', () => { mov.banco[dkey()] = bancoIn.value; saveMov(); preview(); });

      const rowsBox = h('div', { class: 'space-y-2' });
      function addRow(focus) {
        list.push(newDraft()); saveMov(); drawRows(); drawTiles(); preview();
        if (focus) { const last = rowsBox.lastElementChild; const f = last && last.querySelector('[data-f=monto]'); if (f) f.focus(); }
      }
      function drawRows() {
        rowsBox.replaceChildren(...list.map((r, n) => draftEl(r, n)));
      }
      function touch() { saveMov(); drawTiles(); preview(); }
      function draftEl(r, n) {
        const wrapEl = h('div', { class: 'rounded-lg border bg-slate-900 p-2 ' + (r.err ? 'border-rose-500/60' : 'border-slate-700') });
        const inp = (prop, type, cls, attrs = {}) => {
          const i = h('input', Object.assign({ type, class: SMALL + ' ' + cls, value: r[prop] ?? '', 'data-f': prop }, attrs));
          i.addEventListener('input', () => { r[prop] = i.value; r.err = ''; touch(); });
          if (type === 'text') i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (n === list.length - 1) addRow(true); } });
          return i;
        };
        const tipo = h('select', { class: SMALL, 'aria-label': 'Tipo' }, TIPOS[mov.hoja].map(([v, l]) => h('option', { value: v, selected: v === r.tipo }, l)));
        tipo.addEventListener('change', () => { r.tipo = tipo.value; if (r.tipo === 'Pago' || r.tipo === 'Abono') r.categoria = ''; r.err = ''; saveMov(); wrapEl.replaceWith(draftEl(r, n)); drawTiles(); preview(); });
        const catTipo = draftSign(r) > 0 ? 'Ingreso' : 'Egreso';
        const cat = h('select', { class: SMALL + ' min-w-0 flex-1', 'aria-label': 'Categoría' }, h('option', { value: '' }, 'Sin categoría'),
          catsFor(catTipo).map((c) => h('option', { value: c, selected: c === r.categoria }, catLabel(c))));
        cat.addEventListener('change', () => { r.categoria = cat.value; saveMov(); });
        const del = h('button', { type: 'button', class: 'rounded-md px-2 text-slate-400 hover:bg-slate-800 hover:text-rose-300', 'aria-label': 'Quitar fila', onclick: () => { list.splice(n, 1); if (!list.length) list.push(newDraft()); saveMov(); drawRows(); drawTiles(); preview(); } }, '✕');
        const noCat = r.tipo === 'Pago' || r.tipo === 'Abono';
        const tarjetas = (D.tarjetas || []);
        const second = r.tipo === 'Pago'
          ? h('select', { class: SMALL + ' min-w-0 flex-1', 'aria-label': 'Tarjeta que pagas' }, h('option', { value: '' }, 'Tarjeta que pagas…'), tarjetas.map((t) => h('option', { value: t, selected: t === r.tarjeta }, t)))
          : inp('detalle', 'text', 'min-w-0 flex-1', { placeholder: r.tipo === 'Abono' ? 'Detalle (opcional)' : 'Detalle / comercio', maxlength: '120' });
        if (r.tipo === 'Pago') second.addEventListener('change', () => { r.tarjeta = second.value; r.err = ''; touch(); });
        wrapEl.append(...[
          h('div', { class: 'flex items-center gap-2' }, inp('fecha', 'datetime-local', 'min-w-0 flex-1'), del),
          h('div', { class: 'mt-2 flex items-center gap-2' }, tipo, inp('monto', 'text', 'w-28 text-right', { inputmode: 'decimal', placeholder: '0.00' })),
          h('div', { class: 'mt-2 flex' }, second),
          h('div', { class: 'mt-2 flex flex-wrap items-center gap-2' }, noCat ? null : cat,
            cred && r.tipo === 'Cuotas' ? inp('cuotas', 'number', 'w-20', { min: '2', max: '48', placeholder: 'cuotas' }) : null,
            cred && r.tipo === 'Directo' ? h('label', { class: 'flex items-center gap-1 whitespace-nowrap text-xs text-slate-300' }, (() => { const c = h('input', { type: 'checkbox', class: 'h-4 w-4 accent-emerald-500' }); c.checked = !!r.pagado; c.addEventListener('change', () => { r.pagado = c.checked; saveMov(); }); return c; })(), 'ya pagado') : null,
            inp('comentario', 'text', 'min-w-[8rem] flex-1', { placeholder: 'Comentario', maxlength: '200' })),
          r.err ? h('p', { class: 'mt-1 text-xs text-rose-300' }, r.err) : null,
        ].filter(Boolean));
        return wrapEl;
      }

      async function register() {
        const todo = list.filter((r) => !draftProblem(r));
        list.forEach((r) => { r.err = draftProblem(r); });
        if (!todo.length) { drawRows(); toast('Completa al menos una fila (monto y detalle).', 'err'); return; }
        btn.disabled = true; btn.textContent = 'Registrando…';
        let added = 0, dup = 0, failed = 0;
        try {
          const payload = (r) => (cred
            ? { id: r.id, fecha: r.fecha, tipo: r.tipo === 'Abono' ? 'Ingreso' : 'Egreso', monto: draftMonto(r), detalle: r.detalle.trim(), categoria: r.categoria, comentario: r.comentario.trim(), modalidad: r.tipo === 'Cuotas' ? 'Cuotas Sin Interes' : 'Directo', cuotas: r.tipo === 'Cuotas' ? Number(r.cuotas) : null, pagado: r.tipo === 'Directo' && !!r.pagado }
            : { id: r.id, fecha: r.fecha, tipo: r.tipo === 'Ingreso' ? 'Ingreso' : 'Egreso', monto: draftMonto(r), detalle: r.tipo === 'Pago' ? '' : r.detalle.trim(), categoria: r.categoria, comentario: r.comentario.trim(), tarjeta: r.tipo === 'Pago' ? r.tarjeta : undefined });
          for (let i = 0; i < todo.length; i += 50) {
            const chunk = todo.slice(i, i + 50);
            const res = await api('addMovimientos', { hoja: mov.hoja, cuenta: D.cuenta, rows: chunk.map(payload) });
            res.results.forEach((x, k) => {
              const r = chunk[k];
              if (x.ok) { x.duplicate ? dup++ : added++; r.done = true; } else { failed++; r.err = x.message || x.error; }
            });
          }
        } catch (e) { toast(errText(e), 'err'); }
        mov.drafts[dkey()] = list.filter((r) => !r.done);
        if (!mov.drafts[dkey()].length) mov.drafts[dkey()].push(newDraft());
        saveMov();
        toast(`${added} registrado(s)${dup ? `, ${dup} ya estaban` : ''}${failed ? `, ${failed} con error (revísalas)` : ''}`, failed ? 'err' : 'ok');
        await viewHistory(root, true);
      }
      const btn = h('button', { type: 'button', class: BTN + ' w-full', onclick: register }, 'Registrar todo');
      const count = () => list.filter((r) => !draftProblem(r)).length;
      const panel = h('aside', { 'aria-label': 'Cargar movimientos', class: 'fixed inset-x-0 bottom-0 z-40 flex max-h-[85vh] flex-col rounded-t-2xl border border-slate-700 bg-slate-950 shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[30rem] md:rounded-none md:border-y-0 md:border-r-0' },
        h('div', { class: 'flex items-center justify-between border-b border-slate-800 px-4 py-3' },
          h('div', {}, h('h2', { class: 'text-sm font-semibold' }, `Cargar movimientos · ${D.cuenta}`), h('p', { class: 'text-xs text-slate-400' }, 'Ve anotando fila por fila y registra todo de una vez.')),
          h('button', { type: 'button', class: 'rounded-md px-2 py-1 text-slate-300 hover:bg-slate-800', 'aria-label': 'Cerrar panel', onclick: () => toggleDrawer(false) }, '✕')),
        h('div', { class: 'space-y-3 overflow-y-auto px-4 py-3' }, pv,
          h('div', { class: 'flex flex-wrap items-center gap-2 text-xs text-slate-300' }, h('label', { for: 'banco-in' }, 'Saldo en tu app del banco'), bancoIn, cuadre),
          rowsBox,
          h('div', { class: 'flex gap-2' },
            h('button', { type: 'button', class: BTN_GHOST + ' flex-1', onclick: () => addRow(true) }, '+ Fila'),
            h('button', { type: 'button', class: BTN_GHOST, onclick: () => { if (list.some((r) => r.monto || r.detalle) && !confirm('¿Borrar todas las filas sin registrar?')) return; mov.drafts[dkey()] = [newDraft()]; saveMov(); drawDrawer(); drawTiles(); } }, 'Limpiar'))),
        h('div', { class: 'border-t border-slate-800 p-3' }, btn));
      bancoIn.id = 'banco-in';
      drawerBox.replaceChildren(panel);
      drawRows(); preview();
    }

    function refresh() { drawControls(); drawTiles(); drawTable(); drawDrawer(); }
    refresh();
  }

  /* ---------- vista: Categorías (editar nombre y emoji; el emoji es obligatorio) ---------- */
  function openCatEditor(item, d, root) {
    const isNew = !item;
    const dlg = h('dialog', { class: 'w-[calc(100%-2rem)] max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-0 text-slate-100', 'aria-label': isNew ? 'Nueva categoría' : `Editar ${item.nombre}` });
    const name = h('input', { class: INPUT, value: isNew ? '' : item.nombre, maxlength: '40', required: true, 'aria-label': 'Nombre de la categoría' });
    const emo = h('input', { class: INPUT + ' w-24 text-center text-2xl', value: isNew ? '' : (item.emoji || ''), placeholder: '😀', maxlength: '16', required: true, 'aria-label': 'Emoji (obligatorio)' });
    const tipoDefault = isNew ? '' : (item.tipo || (item.tipoUso === 'Egreso' || item.tipoUso === 'Ingreso' ? item.tipoUso : ''));
    let tipoSel = tipoDefault;
    const tipoBtns = ['Egreso', 'Ingreso'].map((tp) => {
      const b = h('button', { type: 'button', role: 'radio', 'aria-checked': tipoSel === tp ? 'true' : 'false', class: 'flex-1 rounded-lg border px-3 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300' }, tp === 'Egreso' ? 'Egreso (gasto)' : 'Ingreso');
      b.dataset.tipo = tp;
      b.addEventListener('click', () => { tipoSel = tp; sync(); });
      return b;
    });
    const paintTipo = () => tipoBtns.forEach((b) => {
      const on = tipoSel === b.dataset.tipo;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.className = 'flex-1 rounded-lg border px-3 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 ' + (on ? 'border-emerald-400 bg-emerald-500/15 text-emerald-200' : 'border-slate-700 text-slate-300 hover:bg-slate-800');
    });
    const note = h('p', { class: 'min-h-[1.25rem] text-xs text-slate-400', 'aria-live': 'polite' });
    const err = h('p', { class: 'hidden rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200' });
    const save = h('button', { type: 'submit', class: BTN, disabled: true }, 'Guardar');
    const others = d.items.filter((i) => !item || normKey(i.nombre) !== normKey(item.nombre));
    const sync = () => {
      const nm = name.value.trim(), em = emo.value.trim();
      const clash = others.find((i) => normKey(i.nombre) === normKey(nm));
      const nameOk = validCat(nm) && !(item === null && clash) && !(clash && clash.sistema) && !d.items.some((i) => i.sistema && normKey(i.nombre) === normKey(nm));
      paintTipo();
      let msg = '';
      const tipoClash = clash && clash.tipo && tipoSel && clash.tipo !== tipoSel;
      if (!tipoSel) msg = 'Elige si es de Egreso o de Ingreso.';
      else if (tipoClash) msg = `No se puede fusionar con «${clash.nombre}»: es de ${clash.tipo}.`;
      else if (!em) msg = 'Falta el emoji: es obligatorio.';
      else if (!validEmoji(em)) msg = 'Pon un solo emoji (sin letras ni números).';
      else if (isNew && clash) msg = 'Ya existe una categoría con ese nombre.';
      else if (clash) msg = `Se fusionará con «${clash.nombre}»: sus movimientos pasarán a esa categoría.`;
      else if (item && nm && nm !== item.nombre) msg = `Se renombrará en ${item.debito + item.credito} movimiento(s) (Débito ${item.debito} · Crédito ${item.credito}).`;
      note.textContent = msg;
      note.className = 'min-h-[1.25rem] text-xs ' + (!tipoSel || tipoClash || !em || !validEmoji(em) ? 'text-rose-300' : clash && !isNew ? 'text-amber-300' : 'text-slate-400');
      save.disabled = !(nameOk && validEmoji(em) && tipoSel && !tipoClash);
    };
    name.addEventListener('input', sync); emo.addEventListener('input', sync);
    const form = h('form', { class: 'space-y-3 p-6', autocomplete: 'off' },
      h('h2', { class: 'text-lg font-semibold' }, isNew ? 'Nueva categoría' : 'Editar categoría'),
      h('label', { class: 'block text-sm' }, 'Nombre', name),
      h('div', { class: 'text-sm' }, h('span', {}, 'Tipo '), h('span', { class: 'text-rose-300' }, '(obligatorio)'), h('div', { class: 'mt-1 flex gap-2', role: 'radiogroup', 'aria-label': 'Tipo de categoría' }, tipoBtns)),
      h('div', { class: 'text-sm' }, h('span', {}, 'Emoji '), h('span', { class: 'text-rose-300' }, '(obligatorio)'), h('div', {}, emo), emojiPicker(emo)),
      note, err,
      h('div', { class: 'flex justify-end gap-2 pt-1' }, h('button', { type: 'button', class: BTN_GHOST, onclick: () => dlg.close() }, 'Cancelar'), save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (save.disabled) return;
      save.disabled = true; save.textContent = 'Guardando…'; err.classList.add('hidden');
      try {
        const r = await api('saveCategory', { nombre: item ? item.nombre : undefined, nuevo: name.value.trim(), emoji: emo.value.trim(), tipo: tipoSel });
        toast(r.fusionada ? `Fusionada en «${r.nombre}»` : `Guardado ${r.emoji} ${r.nombre}`);
        dlg.close();
        viewCategories(root);
      } catch (ex) {
        err.textContent = ex.code === 'EXISTS' ? 'Ya existe una categoría con ese nombre.' : ex.code === 'TIPO_MISMATCH' ? 'No se pueden fusionar categorías de distinto tipo.' : errText(ex); err.classList.remove('hidden');
        save.textContent = 'Guardar'; sync();
      }
    });
    dlg.append(form);
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal(); sync(); (isNew ? name : emo).focus();
  }

  const catUi = { filtro: 'todas' };
  function paintCategories(root, d) {
    const incompletas = d.items.filter((i) => !i.emoji || !i.tipo);
    const shown = d.items.filter((i) => catUi.filtro === 'todas' || (catUi.filtro === 'sin' ? !i.tipo : i.tipo === catUi.filtro));
    const count = (f) => d.items.filter((i) => (f === 'sin' ? !i.tipo : i.tipo === f)).length;
    const tabs = [['todas', `Todas ${d.items.length}`], ['Egreso', `Egresos ${count('Egreso')}`], ['Ingreso', `Ingresos ${count('Ingreso')}`], ...(count('sin') ? [['sin', `Sin tipo ${count('sin')}`]] : [])];
    root.replaceChildren(...[
      h('div', { class: 'mb-3 flex items-center justify-between gap-2' },
        h('h2', { class: 'text-base font-semibold' }, 'Categorías'),
        h('button', { type: 'button', class: BTN + ' !px-3 !py-1.5', onclick: () => openCatEditor(null, d, root) }, '+ Nueva')),
      incompletas.length > 0 && h('p', { class: 'mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100', role: 'status' },
        `${incompletas.length} categoría(s) incompletas (sin emoji o sin tipo). Complétalas con Editar.`),
      h('p', { class: 'mb-3 text-sm text-slate-400' }, 'Cada categoría es de Egreso o de Ingreso: en el Inbox solo se ofrecen las que corresponden al signo del movimiento. Renombrar cambia todos sus movimientos, en Débito y en Crédito por separado.'),
      h('div', { class: 'mb-3 flex flex-wrap gap-1 rounded-xl bg-slate-900 p-1', role: 'tablist', 'aria-label': 'Filtrar por tipo' }, tabs.map(([k, label]) =>
        h('button', { type: 'button', role: 'tab', 'aria-selected': catUi.filtro === k ? 'true' : 'false', onclick: () => { catUi.filtro = k; paintCategories(root, d); },
          class: 'rounded-lg px-3 py-1.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 ' + (catUi.filtro === k ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200') }, label))),
      h('ul', { class: 'grid gap-2 lg:grid-cols-2' }, shown.map((i) =>
        h('li', { class: 'flex items-center gap-3 rounded-xl border bg-slate-900 p-3 ' + (i.emoji && i.tipo ? 'border-slate-800' : 'border-amber-500/50') },
          h('span', { class: 'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-2xl', 'aria-hidden': i.emoji ? 'true' : null }, i.emoji || '❔'),
          h('div', { class: 'min-w-0 flex-1' },
            h('p', { class: 'flex items-center gap-2 truncate font-medium' }, i.nombre,
              i.tipo && h('span', { class: 'rounded px-1.5 py-0.5 text-[11px] font-normal ' + (i.tipo === 'Ingreso' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300') }, i.tipo)),
            h('p', { class: 'truncate text-xs text-slate-500' }, i.sistema ? 'Reservada del sistema' : `Débito ${i.debito} · Crédito ${i.credito}`,
              !i.emoji && h('span', { class: 'ml-2 text-amber-300' }, 'falta emoji'), !i.tipo && h('span', { class: 'ml-2 text-amber-300' }, 'falta tipo'))),
          i.sistema ? h('span', { class: 'text-xs text-slate-600', title: 'No editable' }, '🔒')
            : h('button', { type: 'button', class: BTN_GHOST + ' !px-3 !py-1.5', onclick: () => openCatEditor(i, d, root), 'aria-label': `Editar ${i.nombre}` }, 'Editar'))))
    ].filter(Boolean));
  }
  async function viewCategories(root) {
    await swr(root, 'cats', () => api('getCategoryAdmin'), (d) => paintCategories(root, d), { loadingText: 'Cargando categorías…', retry: () => viewCategories(root) });
  }

  /* ---------- vista: Calendario de cuotas ---------- */
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

  async function viewCalendar(root) {
    root.replaceChildren(loading('Cargando cuotas…'));
    let d;
    try { d = await api('getCalendar'); } catch (e) { if (e.code !== 'UNAUTHORIZED') root.replaceChildren(failure(e, () => viewCalendar(root))); return; }
    if (!d.rows.length) { root.replaceChildren(h('p', { class: 'py-10 text-center text-sm text-slate-400' }, 'No hay cuotas registradas.')); return; }

    const cur = norm(d.currentMonth);
    const curIdx = d.currentIndex != null ? d.currentIndex : d.months.findIndex((m) => norm(m) === cur);
    const cell = 'px-3 py-2 text-right tabular-nums whitespace-nowrap';
    const hi = (i) => (i === curIdx ? ' bg-emerald-500/10 border-x border-emerald-500/40' : '');
    const summary = h('p', { class: 'mb-3 text-sm text-slate-400' });
    const wrap = h('div', { class: 'overflow-x-auto rounded-xl border border-slate-800 bg-slate-900', 'aria-label': 'Calendario de cuotas' });
    let firstDraw = true;

    function draw() {
      const keep = wrap.scrollLeft;
      const totals = d.months.map((_, i) => d.rows.reduce((s, r) => s + (r.montos[i] || 0), 0));
      const pending = d.months.map((_, i) => d.rows.reduce((s, r) => s + (r.montos[i] && !r.pagadas[i] ? r.montos[i] : 0), 0));
      const thead = h('tr', {},
        h('th', { class: 'sticky left-0 z-10 min-w-[10rem] bg-slate-900 px-3 py-2 text-left font-medium text-slate-300' }, 'Compra'),
        d.months.map((m, i) => h('th', { class: 'px-3 py-2 text-right font-medium capitalize text-slate-400' + (i === curIdx ? ' bg-emerald-500 !text-slate-950' : ''), 'data-current': i === curIdx ? '1' : null }, m)));
      const body = d.rows.map((r) => h('tr', { class: 'border-t border-slate-800' },
        h('td', { class: 'sticky left-0 z-10 bg-slate-900 px-3 py-2' }, h('div', { class: 'font-medium' }, r.compra), h('div', { class: 'text-xs text-slate-500' }, r.tarjeta)),
        r.montos.map((v, i) => {
          if (v == null) return h('td', { class: cell + ' text-slate-700' + hi(i) }, '·');
          const paid = !!r.pagadas[i];
          return h('td', { class: 'p-0' + hi(i) },
            h('button', {
              type: 'button', 'aria-pressed': paid ? 'true' : 'false',
              'aria-label': `${r.compra}, ${d.months[i]}: ${paid ? 'pagada, desmarcar' : 'marcar como pagada'}`,
              class: 'block w-full ' + cell + ' focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 ' +
                (paid ? 'text-emerald-300/70 line-through' : 'text-rose-300 hover:bg-slate-800'),
              onclick: () => toggle(r, i),
            }, (paid ? '✓ ' : '') + fmtMoney(v)));
        })));
      const foot = [
        h('tr', { class: 'border-t-2 border-slate-700 text-slate-400' },
          h('td', { class: 'sticky left-0 z-10 bg-slate-900 px-3 py-2' }, 'Total del mes'),
          totals.map((v, i) => h('td', { class: cell + hi(i) }, v ? fmtMoney(v) : '·'))),
        h('tr', { class: 'font-semibold' },
          h('td', { class: 'sticky left-0 z-10 bg-slate-900 px-3 py-2' }, 'Por pagar'),
          pending.map((v, i) => h('td', { class: cell + hi(i) + (v ? '' : ' text-emerald-300') }, v ? fmtMoney(v) : '✓'))),
      ];
      wrap.replaceChildren(h('table', { class: 'w-full text-sm' }, h('thead', {}, thead), h('tbody', {}, body), h('tfoot', {}, foot)));
      wrap.scrollLeft = keep;
      if (firstDraw) {
        firstDraw = false;
        const th = wrap.querySelector('th[data-current]');
        if (th) requestAnimationFrame(() => { wrap.scrollLeft = Math.max(0, th.offsetLeft - 170); });
      }
      if (curIdx >= 0) summary.replaceChildren(`Este mes (${d.months[curIdx]}): total `, h('span', { class: 'font-semibold text-slate-200' }, fmtMoney(totals[curIdx])), ' · por pagar ', h('span', { class: 'font-semibold text-emerald-300' }, fmtMoney(pending[curIdx])));
    }

    async function toggle(r, i) {
      if (!r.id) { toast('Esta compra no tiene ID. Ejecuta fosBackfillIds() en Apps Script.', 'err'); return; }
      const next = !r.pagadas[i];
      r.pagadas[i] = next; draw();                      // optimista
      try {
        await api('toggleCuota', { id: r.id, mes: d.keys[i], pagada: next });
      } catch (e) {
        r.pagadas[i] = !next; draw();                   // se revierte si falla
        toast(errText(e), 'err');
      }
    }

    draw();
    root.replaceChildren(
      h('h2', { class: 'mb-1 text-base font-semibold' }, 'Calendario de cuotas'),
      summary,
      h('p', { class: 'mb-2 text-xs text-slate-500' }, 'Toca una cuota para marcarla como pagada.'),
      wrap);
    draw();
  }

  /* ---------- vista: Tarjetas ---------- */
  const fmtD = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');
  const when = (n) => (n < 0 ? `atrasado ${-n} d` : n === 0 ? 'HOY' : n === 1 ? 'mañana' : `en ${n} días`);
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const TONE = { ok: 'bg-emerald-400', warn: 'bg-amber-400', bad: 'bg-rose-400' };

  const cardsUi = { open: new Map() }; // recuerda qué tarjetas tienen el detalle abierto

  async function markPaid(p, box, onPaid) {
    const li = box.closest('li');
    box.disabled = true; li.classList.add('opacity-50', 'line-through');
    try {
      await api('setPagado', { id: p.id, pagado: true });
      toast(`Pagado: ${p.detalle}`);
      onPaid();
    } catch (e) {
      box.checked = false; box.disabled = false; li.classList.remove('opacity-50', 'line-through');
      toast(errText(e), 'err');
    }
  }

  function cardPanel(c, onPaid) {
    const tone = c.utilizacion <= c.meta ? 'ok' : c.utilizacion <= c.meta * 2 ? 'warn' : 'bad';
    const scale = Math.max(c.meta * 3, c.utilizacion);
    const row = (label, value, cls = '') => h('div', { class: 'flex items-baseline justify-between gap-3 py-1 text-sm' },
      h('span', { class: 'text-slate-400' }, label), h('span', { class: 'text-right tabular-nums ' + cls }, value));
    const urgent = c.cerrado.monto > 0 && c.cerrado.diasVence !== null && c.cerrado.diasVence <= 3;
    const defaultOpen = c.pagarAntesCorte > 0 || c.prestamos > 0;
    const isOpen = cardsUi.open.has(c.tarjeta) ? cardsUi.open.get(c.tarjeta) : defaultOpen;

    const details = c.pendientes.length > 0 && h('details', { class: 'mt-2', open: isOpen },
      h('summary', { class: 'cursor-pointer py-1 text-xs text-slate-400' }, `${c.pendientes.length} pendiente(s) · marca ✓ cuando los pagues`),
      h('ul', { class: 'mt-1 space-y-1' }, c.pendientes.map((p) => {
        const box = h('input', {
          type: 'checkbox', class: 'h-5 w-5 shrink-0 accent-emerald-500', disabled: !p.id,
          'aria-label': `Marcar como pagado: ${p.detalle}`,
          title: p.id ? '' : 'Sin ID: ejecuta fosBackfillIds()',
        });
        box.addEventListener('change', () => { if (box.checked) markPaid(p, box, onPaid); });
        return h('li', { class: 'flex items-center gap-3 text-xs text-slate-300' }, box,
          h('span', { class: 'min-w-0 flex-1 truncate' }, `${fmtD(p.fecha)} · ${p.detalle} · `, h('span', { class: 'text-slate-500' }, p.tipo)),
          h('span', { class: 'tabular-nums' }, fmtMoney(p.monto)));
      })));
    if (details) details.addEventListener('toggle', () => cardsUi.open.set(c.tarjeta, details.open));

    return h('section', { class: 'rounded-xl border border-slate-800 bg-slate-900 p-4' },
      h('div', { class: 'flex items-baseline justify-between' },
        h('h3', { class: 'font-semibold' }, c.tarjeta),
        h('span', { class: 'text-xs text-slate-500' }, `Límite ${fmtMoney(c.limite)}`)),
      h('div', { class: 'mt-3' },
        h('div', { class: 'flex items-baseline justify-between text-sm' },
          h('span', { class: 'text-slate-300' }, 'Utilización al corte'),
          h('span', { class: 'font-semibold tabular-nums' }, pct(c.utilizacion))),
        h('div', { class: 'relative mt-1.5 h-2 rounded-full bg-slate-800', role: 'img', 'aria-label': `Utilización ${pct(c.utilizacion)}, meta ${pct(c.meta)}` },
          h('div', { class: 'h-2 rounded-full ' + TONE[tone], style: `width:${Math.min(100, (c.utilizacion / scale) * 100)}%` }),
          h('div', { class: 'absolute -top-1 h-4 w-0.5 bg-slate-200', style: `left:${(c.meta / scale) * 100}%`, title: `Meta ${pct(c.meta)}` })),
        h('p', { class: 'mt-1 text-xs text-slate-500' }, `Meta ${pct(c.meta)} = ${fmtMoney(c.metaMonto)} · tras pagar los consumos: ${pct(c.utilizacionTrasPagar)}`)),
      h('div', { class: 'mt-3 divide-y divide-slate-800' },
        row(`Corte ${fmtD(c.corteProx)}`, when(c.diasCorte)),
        row('Pagar antes del corte', fmtMoney(c.pagarAntesCorte), c.pagarAntesCorte > 0 ? 'font-semibold text-amber-300' : 'text-emerald-300'),
        c.cerrado.monto > 0 && row(`Estado cerrado · vence ${fmtD(c.cerrado.vence)} (${when(c.cerrado.diasVence)})`, fmtMoney(c.cerrado.monto), urgent ? 'font-semibold text-rose-300' : ''),
        c.cuotaMes > 0 && row('Cuota del mes (por pagar)', fmtMoney(c.cuotaMes)),
        c.cuotaMesPagada > 0 && row('Cuotas del mes ya pagadas', fmtMoney(c.cuotaMesPagada), 'text-emerald-300'),
        c.prestamos > 0 && row('Préstamos por cobrar', fmtMoney(c.prestamos))),
      details);
  }

  async function viewCards(root, silent = false) {
    const y = window.scrollY;
    const noSheet = (e) => {
      if (e.code !== 'NO_TARJETAS') return false;
      root.replaceChildren(h('p', { class: 'rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100' }, 'Falta la hoja «Tarjetas». Ejecuta fosSetupTarjetas() en Apps Script.'));
      return true;
    };
    if (!silent) { await swr(root, 'cards', () => api('getCards'), (d) => paintCards(root, d), { loadingText: 'Calculando tarjetas…', retry: () => viewCards(root), onError: noSheet }); return; }
    let d;
    try { d = await api('getCards'); } catch (e) {
      if (!noSheet(e) && e.code !== 'UNAUTHORIZED') root.replaceChildren(failure(e, () => viewCards(root)));
      return;
    }
    cacheSet('cards', d);
    paintCards(root, d);
    window.scrollTo(0, y);
  }
  function paintCards(root, d) {
    root.replaceChildren(
      h('h2', { class: 'mb-1 text-base font-semibold' }, 'Tarjetas'),
      h('p', { class: 'mb-3 text-sm text-slate-400' }, 'Meta: al corte, solo la cuota del mes; el resto de consumos en 0.'),
      h('div', { class: 'grid gap-3 lg:grid-cols-2 lg:items-start' }, d.cards.map((c) => cardPanel(c, () => viewCards(root, true)))));
  }

  /* ---------- vista: Resumen (Débito y Crédito son visiones independientes: nunca se suman) ---------- */
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre'];
  const mesLabel = (ym) => `${MESES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
  const sumUi = { mes: null, lado: 'debito' };

  function statTile(label, value, prev, note) {
    let delta = null;
    if (prev != null && value != null) {
      const diff = Math.round((value - prev) * 100) / 100;
      delta = diff === 0 ? 'igual que el mes anterior' : `${diff > 0 ? '+' : '−'}${fmtMoney(Math.abs(diff))} vs mes anterior`;
    }
    return h('div', { class: 'rounded-xl border border-slate-800 bg-slate-900 p-3' },
      h('div', { class: 'text-xs text-slate-400' }, label),
      h('div', { class: 'mt-1 text-xl font-semibold tabular-nums text-slate-100' }, value == null ? '—' : fmtMoney(value)),
      (delta || note) && h('div', { class: 'mt-0.5 text-xs text-slate-500' }, delta || note));
  }

  // Barras horizontales ordenadas, un solo color (parte de un total). «Sin categoría» en gris.
  function rankBars(rows, labelKey, total) {
    if (!rows.length) return h('p', { class: 'text-sm text-slate-500' }, 'Sin movimientos este mes.');
    const max = Math.max(...rows.map((r) => r.monto));
    return h('ul', { class: 'space-y-2.5' }, rows.map((r) => {
      const gray = r[labelKey] === 'Sin categoría';
      return h('li', {},
        h('div', { class: 'flex items-baseline justify-between gap-3 text-sm' },
          h('span', { class: 'truncate text-slate-200' }, labelKey === 'categoria' ? catLabel(r[labelKey]) : r[labelKey]),
          h('span', { class: 'shrink-0 tabular-nums text-slate-300' }, `${fmtMoney(r.monto)} · ${total ? Math.round((r.monto / total) * 100) : 0}%`)),
        h('div', { class: 'mt-1 h-2 rounded-r bg-slate-800', role: 'presentation' },
          h('div', { class: 'h-2 rounded-r', style: `width:${Math.max(2, (r.monto / max) * 100)}%;background:${gray ? '#64748b' : '#3987e5'}` })));
    }));
  }

  function summaryDebito(d) {
    const x = d.debito;
    return [
      h('div', { class: 'grid grid-cols-2 gap-2 lg:grid-cols-3' },
        x.sobrante == null ? statTile('Sobró del mes pasado', null, null, 'sin data') : statTile('Sobró del mes pasado', x.sobrante, null, 'el cierre del mes anterior'),
        statTile('Ingresos', x.ingresos, x.prev.ingresos, 'incluye la categoría «Restante»'),
        statTile('Gastos', x.gastos, x.prev.gastos),
        statTile('Pagos de tarjeta', x.pagosTarjeta, x.prev.pagosTarjeta, 'salen de tu cuenta, no son gasto'),
        statTile('Debería quedar', x.flujo, null, 'sobró + ingresos − gastos − pagos'),
        statTile('Cierre registrado', x.cierre, null, 'pasa como «sobró» al mes siguiente')),
      h('h3', { class: 'mb-2 mt-5 text-sm font-semibold' }, 'Gastos por categoría'),
      rankBars(x.porCategoria, 'categoria', x.gastos),
    ];
  }

  function summaryCredito(d) {
    const x = d.credito;
    return [
      h('div', { class: 'grid grid-cols-2 gap-2 lg:grid-cols-4' },
        statTile('Consumos', x.consumos, x.prev.consumos, `directos ${fmtMoney(x.directos)} · en cuotas ${fmtMoney(x.enCuotas)}`),
        statTile('Pagos a tarjetas', x.pagos, x.prev.pagos),
        x.cuotasMes != null ? statTile('Cuotas del mes', x.cuotasMes, null, 'según el calendario de cuotas') : null,
        statTile('Préstamos', x.prestamos, x.prev.prestamos, 'por cobrar, no es consumo')),
      h('h3', { class: 'mb-2 mt-5 text-sm font-semibold' }, 'Consumos por categoría'),
      rankBars(x.porCategoria, 'categoria', x.consumos),
      h('h3', { class: 'mb-2 mt-5 text-sm font-semibold' }, 'Por tarjeta'),
      rankBars(x.porTarjeta.filter((t) => t.consumos > 0).map((t) => ({ tarjeta: t.tarjeta, monto: t.consumos })), 'tarjeta', x.consumos),
    ];
  }

  async function viewSummary(root) {
    await swr(root, 'sum:' + (sumUi.mes || 'actual'), () => api('getSummary', sumUi.mes ? { mes: sumUi.mes } : {}),
      (d) => paintSummary(root, d), { loadingText: 'Calculando resumen…', retry: () => viewSummary(root) });
  }
  function paintSummary(root, d) {
    sumUi.mes = d.esActual ? null : d.mes;
    const go = (mes) => { sumUi.mes = mes; viewSummary(root); };
    const navBtn = (txt, label, mes) => h('button', { type: 'button', 'aria-label': label, disabled: !mes, onclick: () => go(mes), class: 'rounded-lg border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400' }, txt);
    const tab = (key, txt) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': sumUi.lado === key ? 'true' : 'false',
      onclick: () => { sumUi.lado = key; viewSummary(root); },
      class: 'flex-1 rounded-lg px-3 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 ' +
        (sumUi.lado === key ? 'bg-slate-700 text-slate-50' : 'text-slate-400 hover:text-slate-200'),
    }, txt);
    const c = d.cuadre;
    const cuadra = c.diferencia === 0;
    root.replaceChildren(
      h('div', { class: 'mb-3 flex items-center justify-between gap-2' },
        navBtn('◀', 'Mes anterior', d.prevMes),
        h('h2', { class: 'text-base font-semibold capitalize', 'data-testid': 'mes' }, mesLabel(d.mes)),
        navBtn('▶', 'Mes siguiente', d.nextMes)),
      h('div', { role: 'tablist', class: 'mb-4 flex gap-1 rounded-xl border border-slate-800 bg-slate-900 p-1' }, tab('debito', 'Débito'), tab('credito', 'Crédito')),
      ...(sumUi.lado === 'debito' ? summaryDebito(d) : summaryCredito(d)).filter(Boolean),
      h('p', {
        class: 'mt-6 rounded-lg border px-3 py-2 text-xs ' + (cuadra ? 'border-slate-800 text-slate-500' : 'border-amber-500/40 bg-amber-500/10 text-amber-100'),
      }, cuadra
        ? `Partida doble: ✓ pagos de tarjeta cuadran (Débito ${fmtMoney(c.debito)} = Crédito ${fmtMoney(c.credito)}).`
        : `Partida doble: ⚠ no cuadra. Débito registra ${fmtMoney(c.debito)} en pagos de tarjeta y Crédito ${fmtMoney(c.credito)} (dif. ${fmtMoney(c.diferencia)}). Revisa si falta un pago en alguna hoja o la categoría «Pago Tarjeta».`),
      h('p', { class: 'mt-2 text-xs text-slate-600' }, 'Débito y Crédito son visiones independientes: no se suman.'));
  }

  /* ---------- sincronizar Yape ---------- */
  async function syncYape() {
    if (!confirm('¿Ya enviaste el correo de Yape desde la app?')) return;
    const btns = [...document.querySelectorAll('[data-act=yape]')];
    btns.forEach((b) => { b.disabled = true; const sp = b.querySelector('span'); sp && sp.classList.add('spin'); });
    try {
      const r = await api('syncYape', {}, { timeoutMs: 150000 });
      toast(r.added ? `Yape: ${r.added} movimiento(s) nuevo(s)` : 'Yape: sin movimientos nuevos');
      if (currentView() === 'inbox') viewInbox($('#view'));
    } catch (e) {
      toast(errText(e), 'err');
    } finally {
      btns.forEach((b) => { b.disabled = false; const sp = b.querySelector('span'); sp && sp.classList.remove('spin'); });
    }
  }

  /* ---------- cuadre diario (solo PC): checklist de cuentas que se reinicia cada día ----------
     Vive en este navegador (localStorage), no en el Excel. */
  const daily = (() => {
    const K = { accounts: 'fos.cuentas', done: 'fos.daily' };
    const FALLBACK = ['BCP', 'Interbank', 'Efectivo', 'Yape'];
    const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const readJson = (k, def) => { try { const v = JSON.parse(ls.get(k)); return v == null ? def : v; } catch { return def; } };
    let accounts = readJson(K.accounts, null);
    let done = readJson(K.done, { date: today(), items: [] });
    let editing = false, open = false, fetched = false;
    const save = () => { ls.set(K.accounts, JSON.stringify(accounts || [])); ls.set(K.done, JSON.stringify(done)); };
    const rollover = () => { if (done.date !== today()) { done = { date: today(), items: [] }; save(); } };

    const fab = h('button', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: 'Cuadre diario',
      class: 'fixed bottom-6 right-6 z-40 hidden items-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-4 py-3 text-sm font-medium text-slate-100 shadow-xl hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 md:flex' });
    const panel = h('div', { role: 'dialog', 'aria-label': 'Cuadre diario', class: 'hidden' });
    const PANEL = 'fixed bottom-20 right-6 z-40 w-80 rounded-2xl border border-slate-700 bg-slate-900 p-4 shadow-2xl ';

    const list = () => accounts || FALLBACK;
    const pending = () => list().filter((a) => !done.items.includes(a)).length;

    function draw() {
      rollover();
      const n = pending(), all = n === 0 && list().length > 0;
      fab.replaceChildren(h('span', { class: all ? 'text-emerald-400' : 'text-amber-300', 'aria-hidden': 'true' }, all ? '✓' : '☐'), 'Cuadre diario',
        h('span', { class: 'rounded-full px-2 py-0.5 text-xs ' + (all ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300') }, all ? 'al día' : `${n} pend.`));
      fab.setAttribute('aria-expanded', open ? 'true' : 'false');
      panel.className = open ? PANEL + 'hidden md:block' : 'hidden';
      if (!open) return;
      const d = new Date();
      const items = list().map((a) => {
        const box = h('input', { type: 'checkbox', class: 'h-5 w-5 accent-emerald-500', checked: done.items.includes(a), 'aria-label': `Cuenta cuadrada: ${a}` });
        box.addEventListener('change', () => { done.items = box.checked ? [...new Set([...done.items, a])] : done.items.filter((x) => x !== a); save(); draw(); });
        return h('li', { class: 'flex items-center gap-3 py-1.5 text-sm' },
          h('label', { class: 'flex flex-1 cursor-pointer items-center gap-3 ' + (done.items.includes(a) ? 'text-slate-500 line-through' : 'text-slate-200') }, box, a),
          editing && h('button', { type: 'button', class: 'rounded px-2 text-slate-500 hover:text-rose-300', 'aria-label': `Quitar ${a}`, onclick: () => { accounts = list().filter((x) => x !== a); save(); draw(); } }, '×'));
      });
      const add = h('input', { class: INPUT + ' !py-1.5', placeholder: 'Nueva cuenta…', maxlength: '30', 'aria-label': 'Nueva cuenta' });
      const addForm = editing && h('form', { class: 'mt-2 flex gap-2', onsubmit: (e) => {
        e.preventDefault(); const v = add.value.trim();
        if (v && !list().includes(v)) { accounts = [...list(), v]; save(); draw(); }
      } }, add, h('button', { class: BTN + ' !px-3 !py-1.5', type: 'submit' }, 'Añadir'));
      panel.replaceChildren(
        h('div', { class: 'mb-2 flex items-baseline justify-between' },
          h('h2', { class: 'text-sm font-semibold' }, 'Cuadre de hoy'),
          h('span', { class: 'text-xs text-slate-500' }, `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} · se reinicia cada día`)),
        h('p', { class: 'mb-2 text-xs text-slate-400' }, 'Marca cada cuenta cuando ya creaste sus movimientos y el saldo cuadra.'),
        h('ul', { class: 'divide-y divide-slate-800' }, items),
        addForm,
        h('div', { class: 'mt-3 flex justify-between text-xs' },
          h('button', { type: 'button', class: 'text-slate-400 underline decoration-dotted hover:text-slate-200', onclick: () => { editing = !editing; draw(); } }, editing ? 'Listo' : 'Editar cuentas'),
          h('button', { type: 'button', class: 'text-slate-400 underline decoration-dotted hover:text-slate-200', onclick: () => { done = { date: today(), items: [] }; save(); draw(); } }, 'Reiniciar hoy')));
    }

    async function seedAccounts() { // primera vez: toma tus cuentas y tarjetas del Excel
      if (accounts || fetched || !hasCreds()) return;
      fetched = true;
      try {
        const r = await api('getCategories');
        const names = [...new Set([...(r.cuentas || []), ...(r.tarjetas || [])])].filter(Boolean);
        if (names.length && !accounts) { accounts = names; save(); draw(); }
      } catch { /* se queda con la lista por defecto */ }
    }
    fab.addEventListener('click', () => { open = !open; if (open) seedAccounts(); draw(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { open = false; draw(); fab.focus(); } });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) draw(); });
    setInterval(draw, 60000); // si la app queda abierta pasada la medianoche, se reinicia sola
    return {
      mount() { document.body.append(fab, panel); draw(); },
      sync() { fab.classList.toggle('md:flex', hasCreds()); if (!hasCreds()) { open = false; panel.className = 'hidden'; } else seedAccounts(); },
    };
  })();

  /* ---------- router ---------- */
  const VIEWS = { inbox: viewInbox, tarjetas: viewCards, nuevo: (root) => { mov.drawer = true; history.replaceState(null, '', '#movimientos'); return viewHistory(root); }, calendario: viewCalendar, resumen: viewSummary, movimientos: viewHistory, categorias: viewCategories };
  const currentView = () => { const v = location.hash.slice(1); return VIEWS[v] ? v : 'inbox'; };
  function route() {
    navTok++;
    daily.sync();
    if (!hasCreds()) { openSetup(); return; }
    const v = currentView();
    document.querySelectorAll('[data-nav]').forEach((a) => {
      const on = a.dataset.nav === (v === 'nuevo' ? 'movimientos' : v);
      a.classList.toggle('text-emerald-400', on); a.classList.toggle('text-slate-400', !on);
      on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
    });
    VIEWS[v]($('#view'));
  }

  /* ---------- arranque ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    hydrateIcons();
    daily.mount();
    initSetup();
    document.querySelectorAll('[data-act=yape]').forEach((b) => b.addEventListener('click', syncYape));
    document.querySelectorAll('[data-act=logout]').forEach((b) => b.addEventListener('click', () => {
      if (!confirm('¿Cerrar sesión en este dispositivo? Se borrará el token guardado.')) return;
      ls.del(KEYS.token); cacheClear(); $('#view').replaceChildren(); openSetup();
    }));
    window.addEventListener('hashchange', route);
    route();
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* la app funciona sin SW */ });
    }
  });
})();
