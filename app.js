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
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12A9 9 0 0 1 18.5 5.8L21 8"/><path d="M21 3v5h-5"/>',
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

  const inbox = { kind: 'debito', data: null };
  const KINDS = [['debito', 'Débito'], ['credito', 'Crédito']];

  async function viewInbox(root, refetch = true) {
    if (refetch || !inbox.data) {
      root.replaceChildren(loading('Cargando movimientos…'));
      const [d, c] = await Promise.allSettled([api('getInbox'), api('getCreditInbox')]);
      if (d.status === 'rejected') {
        if (d.reason.code !== 'UNAUTHORIZED' && d.reason.code !== 'NO_CREDENTIALS') root.replaceChildren(failure(d.reason, () => viewInbox(root)));
        return;
      }
      inbox.data = { debito: d.value, credito: c.status === 'fulfilled' ? c.value : null, creditoError: c.status === 'rejected' ? c.reason : null };
      mergeCats(d.value.categories);
      if (c.status === 'fulfilled') mergeCats(c.value.categories);
    }
    renderInbox(root);
  }

  function renderInbox(root) {
    const data = inbox.data;
    const counts = {};
    const refreshCounts = () => KINDS.forEach(([k]) => { counts[k].textContent = data[k] ? data[k].items.length : '–'; });
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
    if (!cur) {
      body.append(failure(data.creditoError || new ApiError('NOT_AVAILABLE'), () => viewInbox(root)));
    } else {
      const list = h('ul', { class: 'space-y-3' });
      const empty = h('div', { class: 'rounded-xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-300' },
        h('p', { class: 'text-2xl' }, '✓'), h('p', { class: 'mt-2 text-sm' }, 'Todo categorizado. No hay movimientos pendientes.'));
      const sync = () => { empty.classList.toggle('hidden', list.children.length > 0); refreshCounts(); };
      cur.items.forEach((it) => list.append(inboxCard(it, inbox.kind, (li) => {
        cur.items = cur.items.filter((x) => x.id !== it.id);
        li.remove(); sync();
      })));
      body.append(
        cur.withoutId > 0 && h('p', { class: 'mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100' },
          `${cur.withoutId} fila(s) sin ID no aparecen aquí. Ejecuta fosBackfillIds() en Apps Script.`),
        list, empty);
      queueMicrotask(sync);
    }

    root.replaceChildren(
      h('div', { class: 'mb-3 flex items-center justify-between gap-2' },
        h('div', { class: 'grid grid-cols-2 gap-1 rounded-xl bg-slate-900 p-1', role: 'tablist' }, KINDS.map(tab)),
        h('button', { class: BTN_GHOST + ' !px-3 !py-1.5', onclick: () => viewInbox(root) }, 'Actualizar')),
      body);
    refreshCounts();
  }

  function inboxCard(it, kind, onDone) {
    const sel = h('select', { class: INPUT, 'aria-label': 'Categoría' },
      h('option', { value: '', disabled: true, selected: true }, 'Elegir categoría…'),
      state.cats.map((c) => h('option', { value: c }, c)),
      h('option', { value: NEW_CAT }, '+ Nueva categoría…'));
    const newInp = h('input', { class: INPUT + ' hidden mt-2', placeholder: 'Nombre de la categoría', maxlength: '40', 'aria-label': 'Nueva categoría' });
    const btn = h('button', { class: BTN + ' w-full sm:w-auto', disabled: true, type: 'button' }, 'Guardar');
    const payBtn = h('button', { class: 'mt-2 text-xs text-slate-400 underline decoration-dotted underline-offset-2 hover:text-slate-200', type: 'button' }, 'Es un pago de tarjeta (no es gasto)');
    const chosen = () => (sel.value === NEW_CAT ? newInp.value.trim() : sel.value);
    const sync = () => { btn.disabled = !validCat(chosen()); };
    sel.addEventListener('change', () => { newInp.classList.toggle('hidden', sel.value !== NEW_CAT); if (sel.value === NEW_CAT) newInp.focus(); sync(); });
    newInp.addEventListener('input', sync);

    const li = h('li', { class: 'rounded-xl border border-slate-800 bg-slate-900 p-4' },
      h('div', { class: 'flex items-start justify-between gap-3' },
        h('div', { class: 'min-w-0' },
          h('p', { class: 'truncate font-medium' }, it.detalle || '(sin detalle)'),
          it.descripcion && h('p', { class: 'truncate text-sm text-slate-400' }, it.descripcion),
          h('p', { class: 'mt-0.5 text-xs text-slate-500' }, `${fmtDate(it.fecha)} · ${it.banco}`, it.cuotas ? ` · ${it.cuotas} cuotas` : '')),
        h('p', { class: 'shrink-0 font-semibold tabular-nums ' + ((it.monto || 0) < 0 ? 'text-rose-300' : 'text-emerald-300') }, fmtMoney(it.monto))),
      h('div', { class: 'mt-3 flex flex-col gap-2 sm:flex-row sm:items-start' },
        h('div', { class: 'flex-1' }, sel, newInp), btn),
      kind === 'debito' && payBtn);

    payBtn.addEventListener('click', async () => {
      payBtn.disabled = true; btn.disabled = true;
      try {
        await api('categorize', { id: it.id, pagoTarjeta: true, categoria: 'Pago Tarjeta', onlyIfBlank: true, hoja: 'debito' });
        toast('Marcado como pago de tarjeta');
        onDone(li);
      } catch (e) { toast(errText(e), 'err'); payBtn.disabled = false; sync(); }
    });

    btn.addEventListener('click', async () => {
      const categoria = chosen();
      if (!validCat(categoria)) return;
      btn.disabled = true; btn.textContent = 'Guardando…';
      try {
        const r = await api('categorize', { id: it.id, categoria, onlyIfBlank: true, hoja: kind });
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

  /* ---------- vista: Nuevo (efectivo / consumo de tarjeta / pago de tarjeta) ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const nowLocalInput = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  function rand4() {
    if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase();
    const b = new Uint8Array(2); crypto.getRandomValues(b);
    return [...b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  // MAN_YYYYMMDD_HHMM_XXXX (la fecha del ID es la del movimiento)
  const manualId = (local) => `MAN_${local.slice(0, 10).replace(/-/g, '')}_${local.slice(11, 16).replace(':', '')}_${rand4()}`;

  const manual = { mode: 'efectivo' };
  const MODES = [['efectivo', 'Efectivo'], ['consumo', 'Consumo tarjeta'], ['pago', 'Pago tarjeta']];
  const field = (label, el) => h('label', { class: 'block text-sm text-slate-300' }, label, h('div', { class: 'mt-1' }, el));
  const catSelect = () => h('select', { class: INPUT }, h('option', { value: '' }, 'Sin categoría (irá al Inbox)'), state.cats.map((c) => h('option', { value: c }, c)));
  const optSelect = (list) => h('select', { class: INPUT, required: true }, list.map((x) => h('option', { value: x }, x)));

  /**
   * Arma un formulario. El ID inmutable se genera una vez por envío y se REUTILIZA en reintentos
   * (misma fecha), así un doble toque o un corte de red nunca duplica el movimiento en el Sheet.
   */
  function buildForm({ idle, action, fecha, fields, collect, done }) {
    let pending = null;
    const submit = h('button', { type: 'submit', class: BTN + ' w-full' }, idle);
    const form = h('form', { class: 'space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-4', autocomplete: 'off' }, fields, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      if (!pending || pending.fecha !== fecha.value) pending = { fecha: fecha.value, id: manualId(fecha.value) };
      submit.disabled = true; submit.textContent = 'Registrando…';
      try {
        const r = await api(action, Object.assign(collect(), { id: pending.id, fecha: fecha.value + ':00' }));
        toast(r.duplicate ? 'Ya estaba registrado (no se duplicó).' : done(r));
        pending = null; form.reset(); fecha.value = nowLocalInput();
      } catch (ex) {
        toast(errText(ex), 'err'); // se conserva `pending`: un reintento no duplica
      } finally {
        submit.disabled = false; submit.textContent = idle;
      }
    });
    return form;
  }

  function formEfectivo() {
    const fecha = h('input', { type: 'datetime-local', required: true, class: INPUT, value: nowLocalInput() });
    const tipo = h('select', { class: INPUT }, h('option', { value: 'Egreso' }, 'Egreso (gasto)'), h('option', { value: 'Ingreso' }, 'Ingreso'));
    const monto = h('input', { type: 'number', required: true, min: '0.01', max: '1000000', step: '0.01', inputmode: 'decimal', class: INPUT, placeholder: '0.00' });
    const detalle = h('input', { type: 'text', required: true, maxlength: '120', class: INPUT, placeholder: 'Ej. Menú almuerzo' });
    const desc = h('input', { type: 'text', maxlength: '200', class: INPUT, placeholder: 'Opcional' });
    const cat = catSelect();
    return buildForm({
      idle: 'Registrar en efectivo', action: 'addManual', fecha,
      fields: [field('Fecha y hora', fecha), h('div', { class: 'grid grid-cols-2 gap-3' }, field('Tipo', tipo), field('Monto (S/)', monto)),
        field('Detalle / Comercio', detalle), field('Descripción', desc), field('Categoría', cat)],
      collect: () => ({ tipo: tipo.value, banco: 'Efectivo', monto: Number(monto.value), detalle: detalle.value.trim(), descripcion: desc.value.trim(), categoria: cat.value }),
      done: (r) => `Registrado ${r.id}`,
    });
  }

  function formConsumo(opts) {
    const fecha = h('input', { type: 'datetime-local', required: true, class: INPUT, value: nowLocalInput() });
    const tarjeta = optSelect(opts.tarjetas);
    const monto = h('input', { type: 'number', required: true, min: '0.01', max: '1000000', step: '0.01', inputmode: 'decimal', class: INPUT, placeholder: '0.00' });
    const detalle = h('input', { type: 'text', required: true, maxlength: '120', class: INPUT, placeholder: 'Ej. Uber' });
    const modalidad = h('select', { class: INPUT }, h('option', { value: 'Directo' }, 'Directo'), h('option', { value: 'Cuotas Sin Interes' }, 'Cuotas sin interés'));
    const cuotas = h('input', { type: 'number', min: '2', max: '48', step: '1', inputmode: 'numeric', class: INPUT, placeholder: 'N° de cuotas' });
    const cuotasBox = h('div', { class: 'hidden' }, field('N° de cuotas', cuotas));
    const pagado = h('input', { type: 'checkbox', class: 'h-5 w-5 accent-emerald-500' });
    // contenedor aparte: así `hidden` nunca compite con `flex` en el mismo elemento
    const pagadoBox = h('div', {}, h('label', { class: 'flex items-center gap-3 text-sm text-slate-300' }, pagado, 'Ya lo pagué (consumir y matar)'));
    const cat = catSelect();
    modalidad.addEventListener('change', () => {
      const isQ = modalidad.value !== 'Directo';
      cuotasBox.classList.toggle('hidden', !isQ); pagadoBox.classList.toggle('hidden', isQ);
      cuotas.required = isQ; if (isQ) pagado.checked = false;
    });
    return buildForm({
      idle: 'Registrar consumo', action: 'addCreditConsumo', fecha,
      fields: [h('p', { class: 'text-xs text-slate-500' }, 'Para tarjetas que no envían correo. Si el consumo ya llega por correo, no lo registres aquí: se duplicaría.'),
        field('Fecha y hora', fecha), field('Tarjeta', tarjeta), h('div', { class: 'grid grid-cols-2 gap-3' }, field('Monto (S/)', monto), field('Modalidad', modalidad)),
        cuotasBox, field('Detalle / Comercio', detalle), field('Categoría', cat), pagadoBox],
      collect: () => ({ tarjeta: tarjeta.value, monto: Number(monto.value), modalidad: modalidad.value, cuotas: modalidad.value === 'Directo' ? null : Number(cuotas.value),
        detalle: detalle.value.trim(), categoria: cat.value, pagado: pagado.checked }),
      done: () => 'Consumo registrado en la tarjeta',
    });
  }

  function formPago(opts) {
    const fecha = h('input', { type: 'datetime-local', required: true, class: INPUT, value: nowLocalInput() });
    const tarjeta = optSelect(opts.tarjetas);
    const cuenta = optSelect(opts.cuentas);
    const monto = h('input', { type: 'number', required: true, min: '0.01', max: '1000000', step: '0.01', inputmode: 'decimal', class: INPUT, placeholder: '0.00' });
    return buildForm({
      idle: 'Registrar pago de tarjeta', action: 'addPagoTarjeta', fecha,
      fields: [h('p', { class: 'text-xs text-slate-500' }, 'Crea la salida en Débito y el abono en Crédito (partida doble). Si el pago ya llega por correo (BCP, iO, Falabella, Interbank), no lo registres aquí.'),
        field('Fecha y hora', fecha), field('Tarjeta que pagas', tarjeta), field('Pagado desde', cuenta), field('Monto (S/)', monto)],
      collect: () => ({ tarjeta: tarjeta.value, cuenta: cuenta.value, monto: Number(monto.value) }),
      done: () => 'Pago registrado en Débito y en Crédito',
    });
  }

  async function viewManual(root) {
    root.replaceChildren(loading('Cargando…'));
    let opts = { tarjetas: [], cuentas: ['BCP', 'Interbank', 'Efectivo'] };
    try {
      const r = await api('getCategories');
      mergeCats(r.categories);
      opts = { tarjetas: r.tarjetas || [], cuentas: r.cuentas || opts.cuentas };
    } catch (e) { if (e.code === 'UNAUTHORIZED' || e.code === 'NO_CREDENTIALS') return; /* el modo Efectivo funciona igual */ }
    renderManual(root, opts);
  }

  function renderManual(root, opts) {
    const tabs = h('div', { class: 'mb-3 grid grid-cols-3 gap-1 rounded-xl bg-slate-900 p-1', role: 'tablist' }, MODES.map(([k, label]) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': manual.mode === k ? 'true' : 'false',
      class: 'rounded-lg px-2 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 ' + (manual.mode === k ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'),
      onclick: () => { manual.mode = k; renderManual(root, opts); },
    }, label)));
    let body;
    if (manual.mode !== 'efectivo' && !opts.tarjetas.length) {
      body = h('p', { class: 'rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100' }, 'No se encontraron tarjetas. Despliega la última versión del API y ejecuta fosSetupTarjetas().');
    } else {
      body = manual.mode === 'consumo' ? formConsumo(opts) : manual.mode === 'pago' ? formPago(opts) : formEfectivo();
    }
    root.replaceChildren(h('h2', { class: 'mb-3 text-base font-semibold' }, 'Nuevo movimiento'), tabs, body);
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
    if (!silent) root.replaceChildren(loading('Calculando tarjetas…'));
    let d;
    try { d = await api('getCards'); } catch (e) {
      if (e.code === 'NO_TARJETAS') { root.replaceChildren(h('p', { class: 'rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100' }, 'Falta la hoja «Tarjetas». Ejecuta fosSetupTarjetas() en Apps Script.')); return; }
      if (e.code !== 'UNAUTHORIZED') root.replaceChildren(failure(e, () => viewCards(root)));
      return;
    }
    root.replaceChildren(
      h('h2', { class: 'mb-1 text-base font-semibold' }, 'Tarjetas'),
      h('p', { class: 'mb-3 text-sm text-slate-400' }, 'Meta: al corte, solo la cuota del mes; el resto de consumos en 0.'),
      h('div', { class: 'space-y-3' }, d.cards.map((c) => cardPanel(c, () => viewCards(root, true)))));
    if (silent) window.scrollTo(0, y);
  }

  /* ---------- vista: Resumen (Débito y Crédito son visiones independientes: nunca se suman) ---------- */
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre'];
  const mesLabel = (ym) => `${MESES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
  const sumUi = { mes: null, lado: 'debito' };

  function statTile(label, value, prev, note) {
    let delta = null;
    if (prev != null) {
      const diff = Math.round((value - prev) * 100) / 100;
      delta = diff === 0 ? 'igual que el mes anterior' : `${diff > 0 ? '+' : '−'}${fmtMoney(Math.abs(diff))} vs mes anterior`;
    }
    return h('div', { class: 'rounded-xl border border-slate-800 bg-slate-900 p-3' },
      h('div', { class: 'text-xs text-slate-400' }, label),
      h('div', { class: 'mt-1 text-xl font-semibold tabular-nums text-slate-100' }, fmtMoney(value)),
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
          h('span', { class: 'truncate text-slate-200' }, r[labelKey]),
          h('span', { class: 'shrink-0 tabular-nums text-slate-300' }, `${fmtMoney(r.monto)} · ${total ? Math.round((r.monto / total) * 100) : 0}%`)),
        h('div', { class: 'mt-1 h-2 rounded-r bg-slate-800', role: 'presentation' },
          h('div', { class: 'h-2 rounded-r', style: `width:${Math.max(2, (r.monto / max) * 100)}%;background:${gray ? '#64748b' : '#3987e5'}` })));
    }));
  }

  function summaryDebito(d) {
    const x = d.debito;
    return [
      h('div', { class: 'grid grid-cols-2 gap-2' },
        statTile('Ingresos', x.ingresos, x.prev.ingresos),
        statTile('Gastos', x.gastos, x.prev.gastos),
        statTile('Pagos de tarjeta', x.pagosTarjeta, x.prev.pagosTarjeta, 'salen de tu cuenta, no son gasto'),
        statTile('Flujo del mes', x.flujo, null, 'ingresos − gastos − pagos')),
      x.saldoRegistrado && h('p', { class: 'mt-2 text-xs text-slate-500' }, `Último saldo registrado (Restante): ${fmtMoney(x.saldoRegistrado.monto)} al ${fmtD(x.saldoRegistrado.fecha)}.`),
      h('h3', { class: 'mb-2 mt-5 text-sm font-semibold' }, 'Gastos por categoría'),
      rankBars(x.porCategoria, 'categoria', x.gastos),
    ];
  }

  function summaryCredito(d) {
    const x = d.credito;
    return [
      h('div', { class: 'grid grid-cols-2 gap-2' },
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
    root.replaceChildren(loading('Calculando resumen…'));
    let d;
    try { d = await api('getSummary', sumUi.mes ? { mes: sumUi.mes } : {}); } catch (e) {
      if (e.code !== 'UNAUTHORIZED') root.replaceChildren(failure(e, () => viewSummary(root)));
      return;
    }
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
  const VIEWS = { inbox: viewInbox, tarjetas: viewCards, nuevo: viewManual, calendario: viewCalendar, resumen: viewSummary };
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
