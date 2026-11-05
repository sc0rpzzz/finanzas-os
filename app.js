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
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12A9 9 0 0 1 18.5 5.8L21 8"/><path d="M21 3v5h-5"/>',
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
    try {
      res = await fetch(url, {
        method: 'POST', redirect: 'follow', credentials: 'omit', signal: ctrl.signal,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ token, action, payload }),
      });
    } catch (e) {
      throw new ApiError(e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
    } finally {
      clearTimeout(timer);
    }
    let json;
    try { json = await res.json(); } catch { throw new ApiError('BAD_RESPONSE'); }
    if (!json || json.ok !== true) {
      const code = (json && json.error) || 'BAD_RESPONSE';
      if (code === 'UNAUTHORIZED' && !creds) { ls.del(KEYS.token); openSetup('El token ya no es válido. Ingresa el nuevo.'); }
      throw new ApiError(code, json && json.message);
    }
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
        ls.set(KEYS.url, url); ls.set(KEYS.token, token);
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
  const state = { cats: [] };
  const mergeCats = (list) => {
    const set = new Set([...state.cats, ...list]);
    state.cats = [...set].sort((a, b) => a.localeCompare(b, 'es'));
  };
  const validCat = (c) => c.length > 0 && c.length <= 40 && !/^[=+\-@]/.test(c);

  /* ---------- vista: Inbox ---------- */
  function loading(text = 'Cargando…') { return h('p', { class: 'animate-pulse py-10 text-center text-sm text-slate-400' }, text); }
  function failure(e, retry) {
    return h('div', { class: 'rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-100' },
      h('p', {}, errText(e)),
      h('button', { class: BTN_GHOST + ' mt-3', onclick: retry }, 'Reintentar'));
  }

  async function viewInbox(root) {
    root.replaceChildren(loading('Cargando movimientos…'));
    let data;
    try { data = await api('getInbox'); } catch (e) { if (e.code !== 'UNAUTHORIZED' && e.code !== 'NO_CREDENTIALS') root.replaceChildren(failure(e, () => viewInbox(root))); return; }
    mergeCats(data.categories);

    const count = h('span', { id: 'inbox-count' }, data.items.length);
    const list = h('ul', { class: 'space-y-3' });
    const empty = h('div', { class: 'rounded-xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-300' },
      h('p', { class: 'text-2xl' }, '✓'), h('p', { class: 'mt-2 text-sm' }, 'Todo categorizado. No hay movimientos pendientes.'));
    const refresh = () => {
      count.textContent = list.children.length;
      empty.classList.toggle('hidden', list.children.length > 0);
    };
    data.items.forEach((it) => list.append(inboxCard(it, (li) => { li.remove(); refresh(); })));

    root.replaceChildren(
      h('div', { class: 'mb-3 flex items-center justify-between' },
        h('h2', { class: 'text-base font-semibold' }, 'Por categorizar ', h('span', { class: 'ml-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300' }, count)),
        h('button', { class: BTN_GHOST + ' !px-3 !py-1.5', onclick: () => viewInbox(root) }, 'Actualizar')),
      data.withoutId > 0 && h('p', { class: 'mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100' },
        `${data.withoutId} fila(s) sin ID no aparecen aquí. Ejecuta fosBackfillIds() en Apps Script.`),
      list, empty);
    refresh();
  }

  function inboxCard(it, onDone) {
    const sel = h('select', { class: INPUT, 'aria-label': 'Categoría' },
      h('option', { value: '', disabled: true, selected: true }, 'Elegir categoría…'),
      state.cats.map((c) => h('option', { value: c }, c)),
      h('option', { value: NEW_CAT }, '+ Nueva categoría…'));
    const newInp = h('input', { class: INPUT + ' hidden mt-2', placeholder: 'Nombre de la categoría', maxlength: '40', 'aria-label': 'Nueva categoría' });
    const btn = h('button', { class: BTN + ' w-full sm:w-auto', disabled: true, type: 'button' }, 'Guardar');
    const chosen = () => (sel.value === NEW_CAT ? newInp.value.trim() : sel.value);
    const sync = () => { btn.disabled = !validCat(chosen()); };
    sel.addEventListener('change', () => { newInp.classList.toggle('hidden', sel.value !== NEW_CAT); if (sel.value === NEW_CAT) newInp.focus(); sync(); });
    newInp.addEventListener('input', sync);

    const li = h('li', { class: 'rounded-xl border border-slate-800 bg-slate-900 p-4' },
      h('div', { class: 'flex items-start justify-between gap-3' },
        h('div', { class: 'min-w-0' },
          h('p', { class: 'truncate font-medium' }, it.detalle || '(sin detalle)'),
          it.descripcion && h('p', { class: 'truncate text-sm text-slate-400' }, it.descripcion),
          h('p', { class: 'mt-0.5 text-xs text-slate-500' }, `${fmtDate(it.fecha)} · ${it.banco}`)),
        h('p', { class: 'shrink-0 font-semibold tabular-nums ' + ((it.monto || 0) < 0 ? 'text-rose-300' : 'text-emerald-300') }, fmtMoney(it.monto))),
      h('div', { class: 'mt-3 flex flex-col gap-2 sm:flex-row sm:items-start' },
        h('div', { class: 'flex-1' }, sel, newInp), btn));

    btn.addEventListener('click', async () => {
      const categoria = chosen();
      if (!validCat(categoria)) return;
      btn.disabled = true; btn.textContent = 'Guardando…';
      try {
        const r = await api('categorize', { id: it.id, categoria, onlyIfBlank: true });
        mergeCats([r.categoria || categoria]);
        toast(r.updated ? `Guardado en «${categoria}»` : 'Ya tenía categoría (otro dispositivo)');
        onDone(li);
      } catch (e) {
        toast(errText(e), 'err');
        btn.textContent = 'Guardar'; sync();
      }
    });
    return li;
  }

  /* ---------- vista: Ingreso manual ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const nowLocalInput = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  function rand4() {
    if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase();
    const b = new Uint8Array(2); crypto.getRandomValues(b);
    return [...b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  // MAN_YYYYMMDD_HHMM_XXXX (la fecha del ID es la del movimiento)
  const manualId = (local) => `MAN_${local.slice(0, 10).replace(/-/g, '')}_${local.slice(11, 16).replace(':', '')}_${rand4()}`;

  async function viewManual(root) {
    if (!state.cats.length) { try { mergeCats((await api('getCategories')).categories); } catch { /* el form funciona sin categorías */ } }
    let pending = null; // {fecha, id}: el mismo ID se reutiliza en reintentos => idempotente

    const fecha = h('input', { type: 'datetime-local', required: true, class: INPUT, value: nowLocalInput() });
    const tipo = h('select', { class: INPUT }, h('option', { value: 'Egreso' }, 'Egreso (gasto)'), h('option', { value: 'Ingreso' }, 'Ingreso'));
    const monto = h('input', { type: 'number', required: true, min: '0.01', max: '1000000', step: '0.01', inputmode: 'decimal', class: INPUT, placeholder: '0.00' });
    const detalle = h('input', { type: 'text', required: true, maxlength: '120', class: INPUT, placeholder: 'Ej. Menú almuerzo' });
    const desc = h('input', { type: 'text', maxlength: '200', class: INPUT, placeholder: 'Opcional' });
    const cat = h('select', { class: INPUT }, h('option', { value: '' }, 'Sin categoría (irá al Inbox)'), state.cats.map((c) => h('option', { value: c }, c)));
    const submit = h('button', { type: 'submit', class: BTN + ' w-full' }, 'Registrar gasto en efectivo');
    const field = (label, el) => h('label', { class: 'block text-sm text-slate-300' }, label, h('div', { class: 'mt-1' }, el));

    const form = h('form', { class: 'space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-4', autocomplete: 'off' },
      field('Fecha y hora', fecha),
      h('div', { class: 'grid grid-cols-2 gap-3' }, field('Tipo', tipo), field('Monto (S/)', monto)),
      field('Detalle / Comercio', detalle), field('Descripción', desc), field('Categoría', cat), submit);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      if (!pending || pending.fecha !== fecha.value) pending = { fecha: fecha.value, id: manualId(fecha.value) };
      submit.disabled = true; submit.textContent = 'Registrando…';
      try {
        const r = await api('addManual', {
          id: pending.id, fecha: fecha.value + ':00', tipo: tipo.value, banco: 'Efectivo',
          monto: Number(monto.value), detalle: detalle.value.trim(), descripcion: desc.value.trim(), categoria: cat.value,
        });
        toast(r.duplicate ? 'Ya estaba registrado (no se duplicó).' : `Registrado ${r.id}`);
        pending = null;
        form.reset(); fecha.value = nowLocalInput();
      } catch (ex) {
        toast(errText(ex), 'err'); // se conserva `pending`: un reintento no duplica
      } finally {
        submit.disabled = false; submit.textContent = 'Registrar gasto en efectivo';
      }
    });
    root.replaceChildren(h('h2', { class: 'mb-3 text-base font-semibold' }, 'Ingreso manual'), form);
  }

  /* ---------- vista: Calendario de cuotas ---------- */
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

  async function viewCalendar(root) {
    root.replaceChildren(loading('Cargando cuotas…'));
    let d;
    try { d = await api('getCalendar'); } catch (e) { if (e.code !== 'UNAUTHORIZED') root.replaceChildren(failure(e, () => viewCalendar(root))); return; }
    if (!d.rows.length) { root.replaceChildren(h('p', { class: 'py-10 text-center text-sm text-slate-400' }, 'No hay cuotas registradas.')); return; }

    const cur = norm(d.currentMonth);
    const curIdx = d.months.findIndex((m) => norm(m) === cur);
    const totals = d.months.map((_, i) => d.rows.reduce((s, r) => s + (r.montos[i] || 0), 0));
    const cell = 'px-3 py-2 text-right tabular-nums whitespace-nowrap';
    const hi = (i) => (i === curIdx ? ' bg-emerald-500/10 border-x border-emerald-500/40 text-emerald-200 font-medium' : '');

    const thead = h('tr', {},
      h('th', { class: 'sticky left-0 z-10 min-w-[10rem] bg-slate-900 px-3 py-2 text-left font-medium text-slate-300' }, 'Compra'),
      d.months.map((m, i) => h('th', { class: 'px-3 py-2 text-right font-medium capitalize text-slate-400' + (i === curIdx ? ' bg-emerald-500 !text-slate-950' : ''), 'data-current': i === curIdx ? '1' : null }, m)));
    const body = d.rows.map((r) => h('tr', { class: 'border-t border-slate-800' },
      h('td', { class: 'sticky left-0 z-10 bg-slate-900 px-3 py-2' }, h('div', { class: 'font-medium' }, r.compra), h('div', { class: 'text-xs text-slate-500' }, r.tarjeta)),
      r.montos.map((v, i) => h('td', { class: cell + (v == null ? ' text-slate-700' : ' text-rose-300') + hi(i) }, v == null ? '·' : fmtMoney(v)))));
    const foot = h('tr', { class: 'border-t-2 border-slate-700 font-semibold' },
      h('td', { class: 'sticky left-0 z-10 bg-slate-900 px-3 py-2' }, 'Total del mes'),
      totals.map((v, i) => h('td', { class: cell + hi(i) }, v ? fmtMoney(v) : '·')));

    const wrap = h('div', { class: 'overflow-x-auto rounded-xl border border-slate-800 bg-slate-900', tabindex: '0', 'aria-label': 'Calendario de cuotas' },
      h('table', { class: 'w-full text-sm' }, h('thead', {}, thead), h('tbody', {}, body), h('tfoot', {}, foot)));

    root.replaceChildren(
      h('h2', { class: 'mb-1 text-base font-semibold' }, 'Calendario de cuotas'),
      curIdx >= 0 && h('p', { class: 'mb-3 text-sm text-slate-400' }, `Este mes (${d.months[curIdx]}): `, h('span', { class: 'font-semibold text-emerald-300' }, fmtMoney(totals[curIdx]))),
      wrap);
    const th = wrap.querySelector('th[data-current]');
    if (th) requestAnimationFrame(() => { wrap.scrollLeft = Math.max(0, th.offsetLeft - 170); });
  }

  /* ---------- sincronizar Yape ---------- */
  async function syncYape() {
    if (!confirm('¿Ya enviaste el correo de Yape desde la app?')) return;
    const btn = $('#btn-yape');
    btn.disabled = true;
    const spin = btn.querySelector('span'); spin && spin.classList.add('spin');
    try {
      const r = await api('syncYape', {}, { timeoutMs: 150000 });
      toast(r.added ? `Yape: ${r.added} movimiento(s) nuevo(s)` : 'Yape: sin movimientos nuevos');
      if (currentView() === 'inbox') viewInbox($('#view'));
    } catch (e) {
      toast(errText(e), 'err');
    } finally {
      btn.disabled = false; spin && spin.classList.remove('spin');
    }
  }

  /* ---------- router ---------- */
  const VIEWS = { inbox: viewInbox, nuevo: viewManual, calendario: viewCalendar };
  const currentView = () => { const v = location.hash.slice(1); return VIEWS[v] ? v : 'inbox'; };
  function route() {
    if (!hasCreds()) { openSetup(); return; }
    const v = currentView();
    document.querySelectorAll('[data-nav]').forEach((a) => {
      const on = a.dataset.nav === v;
      a.classList.toggle('text-emerald-400', on); a.classList.toggle('text-slate-400', !on);
      on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
    });
    VIEWS[v]($('#view'));
  }

  /* ---------- arranque ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    hydrateIcons();
    initSetup();
    $('#btn-yape').addEventListener('click', syncYape);
    $('#btn-logout').addEventListener('click', () => {
      if (!confirm('¿Cerrar sesión en este dispositivo? Se borrará el token guardado.')) return;
      ls.del(KEYS.token); $('#view').replaceChildren(); openSetup();
    });
    window.addEventListener('hashchange', route);
    route();
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* la app funciona sin SW */ });
    }
  });
})();
