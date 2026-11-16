/**
 * FINANZAS OS · API REST sobre Google Apps Script
 * ---------------------------------------------------------------------------
 * Despliegue: Implementar > Aplicación web
 *   - Ejecutar como: Yo
 *   - Quién tiene acceso: Cualquier persona   (la seguridad la da el token)
 *
 * IMPORTANTE (limitación de la plataforma):
 *   Apps Script NO expone los headers HTTP en doGet/doPost y no responde al
 *   preflight CORS (OPTIONS). Por eso el token NO puede ir en
 *   "Authorization: Bearer ...". Viaja en el cuerpo JSON ({token, action,
 *   payload}) enviado como text/plain (petición "simple", sin preflight).
 *   Siempre por HTTPS, así que es equivalente en seguridad.
 *
 * Secretos (Configuración del proyecto > Propiedades de la secuencia de comandos):
 *   API_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, (opcional) SPREADSHEET_ID
 *
 * Nota de orden de carga: Apps Script evalúa los archivos en secuencia, por eso
 * aquí no hay código de nivel superior que dependa de otros archivos.
 */

const FOS_CFG = Object.freeze({
  SHEETS: { DEBITO: 'Debito', CREDITO: 'Crédito', CALENDARIO: 'Calendario Cuotas', TARJETAS: 'Tarjetas', PAGOS_CUOTAS: 'Pagos Cuotas', CATEGORIAS: 'Categorias', DUP_OK: 'Duplicados Descartados' },
  MANUAL_BANKS: ['Efectivo', 'BCP', 'Interbank'],
  SYSTEM_CATEGORIES: ['Pago Tarjeta', 'Restante', 'Duplicado'], // no se ofrecen en el select
  MANUAL_ID_RE: /^MAN_\d{8}_\d{4}_[A-Z0-9]{4}$/,
  LIMITS: { CATEGORY: 40, DETAIL: 120, DESCRIPTION: 200, AMOUNT: 1000000 },
  LOCK_WAIT_MS: 25000,
  AUTH_ALERT_THRESHOLD: 5, // fallos de token en 10 min => alerta Telegram
});

class FosError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/* ============================== ENTRY POINTS ============================== */

/** GET: sin `action` solo responde "up" (sin datos). Con `action` exige token y solo lecturas. */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!p.action) return fosJson_({ ok: true, service: 'finanzas-os', status: 'up' });
  return fosHandle_({ token: p.token, action: p.action, payload: {} }, false);
}

/** POST: cuerpo JSON {token, action, payload}. */
function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (_) {
    return fosJson_({ ok: false, error: 'BAD_REQUEST' });
  }
  if (!req || typeof req !== 'object') return fosJson_({ ok: false, error: 'BAD_REQUEST' });
  return fosHandle_(req, true);
}

function fosHandle_(req, allowWrite) {
  // 1) Autenticación ANTES de cualquier otra cosa.
  if (!fosTokenValid_(req.token)) {
    fosRegisterAuthFailure_();
    return fosJson_({ ok: false, error: 'UNAUTHORIZED' });
  }
  // 2) Ruteo.
  fosTouchSeen_(); // «usaste la app hoy» (racha y avisos de Telegram)
  const route = fosRoute_(String(req.action || ''));
  if (!route || (route.write && !allowWrite)) {
    return fosJson_({ ok: false, error: 'BAD_ACTION' });
  }
  // 3) Ejecución (las escrituras van serializadas con LockService).
  try {
    const payload = req.payload && typeof req.payload === 'object' ? req.payload : {};
    // lock:false = la ruta se protege sola (el RPA dura minutos: no puede retener el lock de las demás escrituras)
    const data = route.write && route.lock !== false ? fosWithLock_(() => route.fn(payload)) : route.fn(payload);
    return fosJson_({ ok: true, data: data });
  } catch (err) {
    if (err instanceof FosError) {
      return fosJson_({ ok: false, error: err.code, message: err.message });
    }
    console.error('API error [' + req.action + ']: ' + (err && err.stack ? err.stack : err));
    FosTelegram.send('⚠️ <b>Error en API</b> (' + FosTelegram.esc(req.action) + '): ' +
      FosTelegram.esc(String(err && err.message).slice(0, 200)));
    return fosJson_({ ok: false, error: 'INTERNAL' }); // sin detalles al cliente
  }
}

/** Tabla de rutas. Función (y no const) para no depender del orden de carga de archivos. */
function fosRoute_(action) {
  switch (action) {
    case 'ping':          return { write: false, fn: () => ({ pong: true }) };
    case 'batch':         return { write: false, fn: fosBatch_ };
    case 'getCategoryAdmin': return { write: false, fn: fosGetCategoryAdmin_ };
    case 'saveCategory':  return { write: true,  fn: fosSaveCategory_ };
    case 'getInbox':      return { write: false, fn: fosGetInbox_ };
    case 'getCategories': return { write: false, fn: fosGetCategories_ };
    case 'getCreditInbox': return { write: false, fn: fosGetCreditInbox_ };
    case 'getHistory':    return { write: false, fn: fosGetHistory_ };
    case 'getSummary':    return { write: false, fn: fosGetSummary_ };
    case 'getCalendar':   return { write: false, fn: fosGetCalendar_ };
    case 'getCards':      return { write: false, fn: fosGetCards_ };
    case 'categorize':    return { write: true,  fn: fosCategorize_ };
    case 'getPendingEstado': return { write: false, fn: fosGetPendingEstado_ };
    case 'setEstado':     return { write: true,  fn: fosSetEstado_ };
    case 'setPagado':     return { write: true,  fn: fosSetPagado_ };
    case 'toggleCuota':   return { write: true,  fn: fosToggleCuota_ };
    case 'addManual':     return { write: true,  fn: fosAddManual_ };
    case 'addCreditConsumo': return { write: true, fn: fosAddCreditConsumo_ };
    case 'addPagoTarjeta': return { write: true, fn: fosAddPagoTarjeta_ };
    case 'updateMovimiento': return { write: true, fn: fosUpdateMovimiento_ };
    case 'addMovimientos': return { write: true, fn: fosAddMovimientos_ };
    case 'categorizeBatch': return { write: true, fn: fosCategorizeBatch_ };
    case 'resolveDuplicado': return { write: true, fn: fosResolveDuplicado_ };
    case 'syncYape':      return { write: true,  fn: fosSyncYape_ };
    case 'runEtl':        return { write: true,  lock: false, fn: fosRunEtl_ };
    case 'getRacha':      return { write: false, fn: fosGetRacha_ };
    default:              return null;
  }
}

/* ================================ SEGURIDAD =============================== */

function fosSha256Hex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); })
    .join('');
}

/** Compara digests SHA-256 con XOR acumulado (tiempo constante respecto al contenido). */
function fosTokenValid_(provided) {
  const expected = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!expected || expected.length < 24) return false; // sin token configurado => todo cerrado
  if (typeof provided !== 'string' || !provided) return false;
  const a = fosSha256Hex_(provided);
  const b = fosSha256Hex_(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Cuenta fallos en ventana de 10 min y avisa por Telegram. No bloquea (evita que un tercero te deje fuera). */
function fosRegisterAuthFailure_() {
  const cache = CacheService.getScriptCache();
  const n = (Number(cache.get('auth_fail')) || 0) + 1;
  cache.put('auth_fail', String(n), 600);
  if (n === FOS_CFG.AUTH_ALERT_THRESHOLD) {
    FosTelegram.send('🚨 <b>Finanzas OS</b>: ' + n + ' intentos con token inválido en 10 min.');
  }
}

function fosWithLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(FOS_CFG.LOCK_WAIT_MS)) throw new FosError('BUSY', 'Servidor ocupado, reintenta.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function fosJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ================================ HANDLERS ================================ */

function fosGetInbox_() {
  const tz = fosTz_();
  const t = fosReadTable_(FOS_CFG.SHEETS.DEBITO,
    ['Fecha', 'Tipo', 'Banco / Cuenta', 'Detalle/Comercio', 'Categoría', 'Monto', 'ID']);
  const iDesc = t.opt('Descripción');
  const items = [];
  let withoutId = 0;

  t.rows.forEach(function (r) {
    if (String(r[t.idx('Categoría')]).trim() !== '') return;
    if (fosBlank_(r[t.idx('Fecha')]) && fosBlank_(r[t.idx('Monto')]) && fosBlank_(r[t.idx('Detalle/Comercio')])) return;
    const id = String(r[t.idx('ID')]).trim();
    if (!id) { withoutId++; return; } // sin ID no se puede actualizar con seguridad
    items.push({
      id: id,
      fecha: fosFmtDate_(r[t.idx('Fecha')], tz),
      tipo: String(r[t.idx('Tipo')]),
      banco: String(r[t.idx('Banco / Cuenta')]),
      detalle: String(r[t.idx('Detalle/Comercio')]),
      descripcion: iDesc >= 0 ? String(r[iDesc]) : '',
      monto: fosNum_(r[t.idx('Monto')]),
    });
  });
  items.sort(function (a, b) { return (b.fecha || '').localeCompare(a.fecha || ''); });
  return { items: items, withoutId: withoutId, duplicados: fosFindDuplicates_(t, tz), categories: fosAllCategories_(), emojis: fosEmojiMap_(), tipos: fosTipoMap_() };
}

function fosGetCategories_() {
  return { categories: fosAllCategories_(), emojis: fosEmojiMap_(), tarjetas: fosCardNames_(), cuentas: FOS_CFG.MANUAL_BANKS.slice() };
}

/** Consumos de tarjeta (Egreso, monto < 0) sin categoría. Los préstamos no se categorizan. */
function fosGetCreditInbox_() {
  const tz = fosTz_();
  const t = fosReadTable_(FOS_CFG.SHEETS.CREDITO,
    ['Fecha', 'ID', 'Tipo', 'Banco / Cuenta', 'Detalle/Comercio', 'Monto', 'Categoría']);
  const iMod = t.opt('Modalidad'), iN = t.opt('N° Cuotas');
  const items = [];
  let withoutId = 0;
  t.rows.forEach(function (r) {
    if (String(r[t.idx('Categoría')]).trim() !== '') return;
    const monto = fosNum_(r[t.idx('Monto')]);
    if (monto === null || monto >= 0 || fosNorm_(r[t.idx('Tipo')]) !== 'egreso') return;
    const id = String(r[t.idx('ID')]).trim();
    if (!id) { withoutId++; return; }
    const n = iN >= 0 ? fosNum_(r[iN]) : null;
    items.push({
      id: id,
      fecha: fosFmtDate_(r[t.idx('Fecha')], tz),
      banco: String(r[t.idx('Banco / Cuenta')]),
      detalle: String(r[t.idx('Detalle/Comercio')]),
      descripcion: '',
      monto: monto,
      modalidad: iMod >= 0 ? String(r[iMod]) : '',
      cuotas: n && n > 1 ? n : null,
    });
  });
  items.sort(function (a, b) { return (b.fecha || '').localeCompare(a.fecha || ''); });
  return { items: items, withoutId: withoutId, categories: fosAllCategories_(), emojis: fosEmojiMap_(), tipos: fosTipoMap_() };
}

/**
 * Cuotas activas, derivadas de la hoja Crédito (ya no se lee "Calendario Cuotas").
 * Regla: la 1.ª cuota cae en el mes SIGUIENTE a la fecha de la compra.
 * Índice de mes = año*12 + (mes-1). Solo incluye cuotas que aún no terminaron.
 */
function fosCuotaItems_() {
  const tz = fosTz_();
  const names = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'setiembre', 'octubre', 'noviembre', 'diciembre'];
  const t = fosReadTable_(FOS_CFG.SHEETS.CREDITO,
    ['ID', 'Fecha', 'Banco / Cuenta', 'Detalle/Comercio', 'Monto', 'Modalidad', 'N° Cuotas']);
  const iCuota = t.opt('Monto Cuota');
  const iId = t.opt('ID');
  const iCat = t.opt('Categoría');
  const toIdx = function (iso) { return Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1; };
  const nowIdx = toIdx(fosFmtDate_(new Date(), tz));
  const items = [];
  let last = nowIdx;
  t.rows.forEach(function (r) {
    const f = r[t.idx('Fecha')];
    const n = fosNum_(r[t.idx('N° Cuotas')]);
    if (fosNorm_(r[t.idx('Modalidad')]).indexOf('cuota') < 0 || !n || n < 1 || !(f instanceof Date)) return;
    const monto = fosNum_(r[t.idx('Monto')]);
    let cuota = iCuota >= 0 ? fosNum_(r[iCuota]) : null;
    if (cuota === null && monto !== null) cuota = monto / n;
    if (cuota === null) return;
    const start = toIdx(fosFmtDate_(f, tz)) + 1; // mes siguiente a la compra
    const end = start + n - 1;
    if (end < nowIdx) return; // ya terminó de pagarse
    last = Math.max(last, end);
    items.push({ id: String(r[t.idx('ID')]).trim(), compra: String(r[t.idx('Detalle/Comercio')]), tarjeta: String(r[t.idx('Banco / Cuenta')]), start: start, n: n, cuota: cuota,
      categoria: iCat >= 0 ? String(r[iCat]).trim() : '' });
  });
  return { items: items, nowIdx: nowIdx, last: last, names: names, paid: fosPaidCuotas_() };
}

function fosMonthKey_(idx) { return Math.floor(idx / 12) + '-' + ('0' + ((idx % 12) + 1)).slice(-2); }

/** Cuotas marcadas como pagadas: hoja "Pagos Cuotas" (ID Compra | Mes yyyy-MM | Pagada el). */
function fosPaidCuotas_() {
  const sh = fosSpreadsheet_().getSheetByName(FOS_CFG.SHEETS.PAGOS_CUOTAS);
  const set = {};
  if (!sh || sh.getLastRow() < 2) return set;
  const tz = fosTz_();
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
    const id = String(r[0]).trim();
    const mes = r[1] instanceof Date ? fosFmtDate_(r[1], tz).slice(0, 7) : String(r[1]).trim(); // Sheets puede convertir "2026-11" en fecha
    if (id && mes) set[id + '|' + mes] = true;
  });
  return set;
}

function fosGetCalendar_() {
  const c = fosCuotaItems_();
  const months = [], keys = [];
  for (let m = c.nowIdx; m <= c.last; m++) { months.push(c.names[m % 12] + ' ' + Math.floor(m / 12)); keys.push(fosMonthKey_(m)); }
  const rows = c.items.map(function (it) {
    const montos = [], pagadas = [];
    keys.forEach(function (key, k) {
      const m = c.nowIdx + k;
      const active = m >= it.start && m < it.start + it.n;
      montos.push(active ? Math.round(it.cuota * 100) / 100 : null);
      pagadas.push(active && !!it.id && !!c.paid[it.id + '|' + key]);
    });
    return { id: it.id, compra: it.compra, tarjeta: it.tarjeta, categoria: it.categoria, montos: montos, pagadas: pagadas };
  });
  return { months: months, keys: keys, rows: rows, currentIndex: 0, currentMonth: c.names[c.nowIdx % 12] };
}

/** Marca/desmarca una cuota (compra + mes) como pagada. Idempotente. */
function fosToggleCuota_(p) {
  const id = fosText_(p.id, 'id', 64, true);
  const mes = String(p.mes || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw new FosError('BAD_MONTH', 'Mes inválido.');
  const idx = Number(mes.slice(0, 4)) * 12 + Number(mes.slice(5, 7)) - 1;
  const c = fosCuotaItems_();
  if (!c.items.some(function (it) { return it.id === id && idx >= it.start && idx < it.start + it.n; })) {
    throw new FosError('NOT_FOUND', 'Esa cuota no existe.');
  }
  const ss = fosSpreadsheet_();
  let sh = ss.getSheetByName(FOS_CFG.SHEETS.PAGOS_CUOTAS);
  if (!sh) {
    sh = ss.insertSheet(FOS_CFG.SHEETS.PAGOS_CUOTAS);
    sh.getRange(1, 1, 1, 3).setValues([['ID Compra', 'Mes', 'Pagada el']]);
  }
  const tz = fosTz_();
  const last = sh.getLastRow();
  const vals = last >= 2 ? sh.getRange(2, 1, last - 1, 2).getValues() : [];
  let found = -1;
  vals.forEach(function (r, i) {
    const m = r[1] instanceof Date ? fosFmtDate_(r[1], tz).slice(0, 7) : String(r[1]).trim();
    if (String(r[0]).trim() === id && m === mes) found = i;
  });
  const pagada = p.pagada === true;
  if (pagada && found < 0) {
    const target = last + 1;
    sh.getRange(target, 2).setNumberFormat('@'); // texto: evita que Sheets convierta "2026-11" en fecha
    sh.getRange(target, 1, 1, 3).setValues([[id, mes, new Date()]]);
    sh.getRange(target, 3).setNumberFormat('yyyy-mm-dd hh:mm');
  } else if (!pagada && found >= 0) {
    sh.deleteRow(found + 2);
  }
  return { id: id, mes: mes, pagada: pagada };
}

/** Actualiza SOLO la celda Categoría de la fila cuyo ID coincide. */
function fosCategorize_(p) {
  const id = fosText_(p.id, 'id', 64, true);
  const sheetName = p.hoja === 'credito' ? FOS_CFG.SHEETS.CREDITO : FOS_CFG.SHEETS.DEBITO;
  // "Pago Tarjeta" es categoría reservada: solo se asigna con la marca explícita pagoTarjeta (botón del Inbox de Débito).
  const cat = (p.pagoTarjeta === true && sheetName === FOS_CFG.SHEETS.DEBITO) ? 'Pago Tarjeta' : fosCategory_(p.categoria);
  const t = fosReadTable_(sheetName, ['Categoría', 'ID']);
  const matches = [];
  t.rows.forEach(function (r, i) { if (String(r[t.idx('ID')]).trim() === id) matches.push(i); });
  if (matches.length === 0) throw new FosError('NOT_FOUND', 'No existe una fila con ese ID.');
  if (matches.length > 1) throw new FosError('AMBIGUOUS', 'ID duplicado en la hoja.');
  const row = t.rows[matches[0]];
  if (p.onlyIfBlank && String(row[t.idx('Categoría')]).trim() !== '') {
    return { updated: false, reason: 'ALREADY_SET', categoria: String(row[t.idx('Categoría')]) };
  }
  // El tipo de la categoría debe corresponder al signo del movimiento (Egreso < 0, Ingreso > 0).
  const iMonto = t.opt('Monto');
  const monto = iMonto >= 0 ? fosNum_(row[iMonto]) : null;
  const filaTipo = monto === null ? null : monto < 0 ? 'Egreso' : 'Ingreso';
  const known = fosEmojiByKey_();
  const tipos = fosTipoMap_();
  let emoji = null;
  if (!(p.pagoTarjeta === true && sheetName === FOS_CFG.SHEETS.DEBITO)) {
    const k = fosNorm_(cat);
    if (tipos[k] && filaTipo && tipos[k] !== filaTipo) {
      throw new FosError('TIPO_MISMATCH', 'Esta categoría es de ' + tipos[k] + ' y el movimiento es un ' + filaTipo + '.');
    }
    const existing = !!known[k] || fosAllCategories_().some(function (c) { return fosNorm_(c) === k; });
    if (p.emoji != null && String(p.emoji).trim() !== '') emoji = fosValidEmoji_(p.emoji);
    else if (!existing) throw new FosError('EMOJI_REQUIRED', 'Una categoría nueva necesita un emoji.');
  }
  t.sh.getRange(matches[0] + 2, t.idx('Categoría') + 1).setValue(cat);
  if (emoji && !known[fosNorm_(cat)]) fosUpsertCategory_(cat, emoji, filaTipo || 'Egreso', null); // categoría nueva: el tipo sale del signo del movimiento
  return { updated: true, id: id, categoria: cat };
}

/** Marca/desmarca el check "Pagado" de un consumo de Crédito (por ID). Solo toca esa celda. */
function fosSetPagado_(p) {
  const id = fosText_(p.id, 'id', 64, true);
  const t = fosReadTable_(FOS_CFG.SHEETS.CREDITO, ['ID', 'Pagado']);
  const matches = [];
  t.rows.forEach(function (r, i) { if (String(r[t.idx('ID')]).trim() === id) matches.push(i); });
  if (matches.length === 0) throw new FosError('NOT_FOUND', 'No existe un consumo con ese ID.');
  if (matches.length > 1) throw new FosError('AMBIGUOUS', 'ID duplicado en la hoja.');
  const pagado = p.pagado === true;
  t.sh.getRange(matches[0] + 2, t.idx('Pagado') + 1).setValue(pagado);
  return { id: id, pagado: pagado };
}

/**
 * Varias lecturas en UNA sola petición (un solo arranque de Apps Script, una sola autenticación y cada hoja
 * se lee una vez). payload: {calls:[{action, payload?}]}. Solo acciones de lectura. Cada resultado es
 * {ok:true,data} o {ok:false,error}, así un fallo parcial no tumba al resto.
 */
function fosBatch_(p) {
  const calls = Array.isArray(p.calls) ? p.calls : null;
  if (!calls || calls.length === 0 || calls.length > 8) throw new FosError('BAD_BATCH', 'calls debe tener entre 1 y 8 acciones.');
  FOS_MEMO_ = {};
  try {
    return {
      results: calls.map(function (c) {
        const route = c && typeof c.action === 'string' ? fosRoute_(c.action) : null;
        if (!route || route.write || c.action === 'batch') return { ok: false, error: 'BAD_ACTION' };
        try {
          return { ok: true, data: route.fn(c.payload && typeof c.payload === 'object' ? c.payload : {}) };
        } catch (err) {
          if (err instanceof FosError) return { ok: false, error: err.code, message: err.message };
          console.error('API error [batch/' + c.action + ']: ' + (err && err.stack ? err.stack : err));
          return { ok: false, error: 'INTERNAL' };
        }
      }),
    };
  } finally {
    FOS_MEMO_ = null;
  }
}

/** Movimientos de Crédito cuyo Estado sigue en "Pendiente" (aún no procesados por el banco), para revisarlos en el Inbox. */
function fosGetPendingEstado_() {
  const tz = fosTz_();
  const t = fosReadTable_(FOS_CFG.SHEETS.CREDITO, ['Fecha', 'ID', 'Tipo', 'Estado', 'Banco / Cuenta', 'Detalle/Comercio', 'Monto']);
  const iMod = t.opt('Modalidad'), iN = t.opt('N° Cuotas'), iCat = t.opt('Categoría');
  const items = [];
  let withoutId = 0;
  t.rows.forEach(function (r) {
    if (fosNorm_(r[t.idx('Estado')]) !== 'pendiente') return;
    const id = String(r[t.idx('ID')]).trim();
    if (!id) { withoutId++; return; }
    const n = iN >= 0 ? fosNum_(r[iN]) : null;
    items.push({
      id: id,
      fecha: fosFmtDate_(r[t.idx('Fecha')], tz),
      tarjeta: String(r[t.idx('Banco / Cuenta')]),
      detalle: String(r[t.idx('Detalle/Comercio')]),
      tipo: String(r[t.idx('Tipo')]),
      monto: fosNum_(r[t.idx('Monto')]),
      modalidad: iMod >= 0 ? String(r[iMod]) : '',
      cuotas: n && n > 1 ? n : null,
      categoria: iCat >= 0 ? String(r[iCat]).trim() : '',
    });
  });
  items.sort(function (a, b) { return (b.fecha || '').localeCompare(a.fecha || ''); });
  return { items: items, withoutId: withoutId };
}

/** Cambia solo la celda Estado de un movimiento de Crédito ("Procesado" o de vuelta a "Pendiente"). */
function fosSetEstado_(p) {
  const id = fosText_(p.id, 'id', 64, true);
  const estado = p.estado === 'Procesado' ? 'Procesado' : p.estado === 'Pendiente' ? 'Pendiente' : null;
  if (!estado) throw new FosError('BAD_ESTADO', 'estado debe ser "Procesado" o "Pendiente".');
  const t = fosReadTable_(FOS_CFG.SHEETS.CREDITO, ['ID', 'Estado']);
  const matches = [];
  t.rows.forEach(function (r, i) { if (String(r[t.idx('ID')]).trim() === id) matches.push(i); });
  if (matches.length === 0) throw new FosError('NOT_FOUND', 'No existe un movimiento con ese ID.');
  if (matches.length > 1) throw new FosError('AMBIGUOUS', 'ID duplicado en la hoja.');
  t.sh.getRange(matches[0] + 2, t.idx('Estado') + 1).setValue(estado);
  return { id: id, estado: estado };
}

/** Inserta un movimiento manual. Idempotente por ID (reintentos seguros). */
function fosAddManual_(p) {
  const id = String(p.id || '').trim();
  if (!FOS_CFG.MANUAL_ID_RE.test(id)) throw new FosError('BAD_ID', 'ID con formato inválido.');

  const tipo = p.tipo === 'Ingreso' ? 'Ingreso' : p.tipo === 'Egreso' ? 'Egreso' : null;
  if (!tipo) throw new FosError('BAD_TYPE', 'Tipo debe ser Egreso o Ingreso.');

  const raw = Number(p.monto);
  if (!isFinite(raw) || raw === 0 || Math.abs(raw) > FOS_CFG.LIMITS.AMOUNT) {
    throw new FosError('BAD_AMOUNT', 'Monto inválido.');
  }
  // El servidor es quien fija el signo contable: Egreso < 0, Ingreso > 0.
  const monto = Math.round((tipo === 'Egreso' ? -Math.abs(raw) : Math.abs(raw)) * 100) / 100;

  const banco = p.banco ? String(p.banco) : 'Efectivo';
  if (FOS_CFG.MANUAL_BANKS.indexOf(banco) < 0) throw new FosError('BAD_BANK', 'Cuenta no permitida.');

  const detalle = fosText_(p.detalle, 'detalle', FOS_CFG.LIMITS.DETAIL, true);
  const descripcion = fosText_(p.descripcion, 'descripcion', FOS_CFG.LIMITS.DESCRIPTION, false);
  const categoria = p.categoria ? fosCategory_(p.categoria) : '';
  const fecha = fosParseLocal_(String(p.fecha || ''));

  const t = fosReadTable_(FOS_CFG.SHEETS.DEBITO,
    ['Fecha', 'Tipo', 'Banco / Cuenta', 'Detalle/Comercio', 'Categoría', 'Monto', 'ID']);
  const iId = t.idx('ID');
  for (let i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i][iId]).trim() === id) return { inserted: false, duplicate: true, id: id };
  }

  // appendRow (atómico): no pisa una fila que el ETL agregue al mismo tiempo
  fosAppendByHeader_(t, id, {
    'Fecha': fecha, 'Tipo': tipo, 'Banco / Cuenta': banco, 'Detalle/Comercio': detalle,
    'Categoría': categoria, 'Monto': monto, 'ID': id, 'Descripción': descripcion,
  });
  return { inserted: true, duplicate: false, id: id, monto: monto };
}

function fosCardName_(v) {
  const n = fosNorm_(v);
  const hit = fosCardNames_().filter(function (c) { return fosNorm_(c) === n; })[0];
  if (!hit) throw new FosError('BAD_CARD', 'Tarjeta no reconocida.');
  return hit;
}

function fosMoney_(v) {
  const raw = Number(v);
  if (!isFinite(raw) || raw <= 0 || raw > FOS_CFG.LIMITS.AMOUNT) throw new FosError('BAD_AMOUNT', 'Monto inválido.');
  return Math.round(raw * 100) / 100;
}

function fosManualId_(v) {
  const id = String(v || '').trim();
  if (!FOS_CFG.MANUAL_ID_RE.test(id)) throw new FosError('BAD_ID', 'ID con formato inválido.');
  return id;
}

/**
 * Consumo con tarjeta de crédito (para tarjetas sin correo: iO, Interbank).
 * Misma forma de fila que tu ETL: Egreso | Pendiente | monto negativo. Idempotente por ID.
 */
function fosAddCreditConsumo_(p) {
  const id = fosManualId_(p.id);
  const tarjeta = fosCardName_(p.tarjeta);
  const monto = fosMoney_(p.monto);
  const modalidad = p.modalidad === 'Directo' ? 'Directo' : p.modalidad === 'Cuotas Sin Interes' ? 'Cuotas Sin Interes' : null;
  if (!modalidad) throw new FosError('BAD_MODE', 'Modalidad inválida.');
  let cuotas = '';
  if (modalidad !== 'Directo') {
    cuotas = Number(p.cuotas);
    if (!isFinite(cuotas) || cuotas % 1 !== 0 || cuotas < 2 || cuotas > 48) {
      throw new FosError('BAD_INSTALLMENTS', 'N° de cuotas inválido (2 a 48).');
    }
  }
  const detalle = fosText_(p.detalle, 'detalle', FOS_CFG.LIMITS.DETAIL, true);
  const categoria = p.categoria ? fosCategory_(p.categoria) : '';
  const fecha = fosParseLocal_(String(p.fecha || ''));

  const t = fosReadTable_(FOS_CFG.SHEETS.CREDITO,
    ['Fecha', 'ID', 'Tipo', 'Banco / Cuenta', 'Detalle/Comercio', 'Monto']);
  if (fosHasId_(t, id)) return { inserted: false, duplicate: true, id: id };

  const r = fosAppendByHeader_(t, id, {
    'Fecha': fecha, 'ID': id, 'Tipo': 'Egreso', 'Estado': 'Pendiente', 'Banco / Cuenta': tarjeta,
    'Detalle/Comercio': detalle, 'Monto': -monto,
    'Pagado': (p.pagado === true && modalidad === 'Directo') ? true : '', // "consumir y matar"
    'Modalidad': modalidad, 'N° Cuotas': cuotas, 'Categoría': categoria,
  });
  const iK = t.opt('Monto Cuota'), iJ = t.opt('N° Cuotas');
  if (r > 0 && iK >= 0 && iJ >= 0) { // misma fórmula que ya usan tus filas: Monto / N° Cuotas
    const G = fosColLetter_(t.idx('Monto')) + r, J = fosColLetter_(iJ) + r;
    t.sh.getRange(r, iK + 1).setFormula('=IF(' + J + '="","",' + G + '/' + J + ')');
  }
  return { inserted: true, duplicate: false, id: id, monto: -monto };
}

/**
 * Pago de tarjeta con partida doble, igual que tu ETL: salida en Debito (categoría "Pago Tarjeta")
 * y abono en Crédito, con el MISMO ID en ambas hojas. Si falla la 2.ª escritura se deshace la 1.ª.
 */
function fosAddPagoTarjeta_(p) {
  const id = fosManualId_(p.id);
  const tarjeta = fosCardName_(p.tarjeta);
  const monto = fosMoney_(p.monto);
  const cuenta = p.cuenta ? String(p.cuenta) : 'BCP';
  if (FOS_CFG.MANUAL_BANKS.indexOf(cuenta) < 0) throw new FosError('BAD_BANK', 'Cuenta no permitida.');
  const fecha = fosParseLocal_(String(p.fecha || ''));

  const td = fosReadTable_(FOS_CFG.SHEETS.DEBITO, ['Fecha', 'Tipo', 'Banco / Cuenta', 'Detalle/Comercio', 'Categoría', 'Monto', 'ID']);
  const tc = fosReadTable_(FOS_CFG.SHEETS.CREDITO, ['Fecha', 'ID', 'Tipo', 'Banco / Cuenta', 'Detalle/Comercio', 'Monto']);
  const inDeb = fosHasId_(td, id), inCred = fosHasId_(tc, id);
  if (inDeb && inCred) return { inserted: false, duplicate: true, id: id };

  let debRow = -1;
  if (!inDeb) {
    debRow = fosAppendByHeader_(td, id, {
      'Fecha': fecha, 'Tipo': 'Egreso', 'Banco / Cuenta': cuenta, 'Detalle/Comercio': 'Pago a: ' + tarjeta,
      'Categoría': 'Pago Tarjeta', 'Monto': -monto, 'ID': id,
    });
  }
  try {
    if (!inCred) {
      fosAppendByHeader_(tc, id, {
        'Fecha': fecha, 'ID': id, 'Tipo': 'Ingreso', 'Estado': 'Procesado', 'Banco / Cuenta': tarjeta,
        'Detalle/Comercio': 'Pago de Tarjeta ' + tarjeta, 'Monto': monto, 'Modalidad': '-',
      });
    }
  } catch (err) {
    if (debRow > 0) td.sh.deleteRow(debRow); // partida doble: o se escriben las dos filas o ninguna
    throw err;
  }
  return { inserted: true, duplicate: false, id: id, debito: !inDeb, credito: !inCred, monto: monto };
}

/** Dispara tu ETL existente de Yape. Requiere que exista procesarYapeDefinitivo() en el proyecto. */
function fosSyncYape_() {
  if (typeof procesarYapeDefinitivo !== 'function') {
    throw new FosError('NOT_AVAILABLE', 'No existe procesarYapeDefinitivo() en este proyecto.');
  }
  const sh = fosSheet_(FOS_CFG.SHEETS.DEBITO);
  const before = sh.getLastRow();
  procesarYapeDefinitivo();
  SpreadsheetApp.flush();
  const added = Math.max(0, sh.getLastRow() - before);
  PropertiesService.getScriptProperties().setProperty('FOS_YAPE_SYNC', String(Date.now())); // cuenta para el cuadre del día
  FosTelegram.send('📲 <b>Sync Yape</b>: ' + added + ' movimiento(s) nuevo(s).');
  return { added: added };
}

/**
 * Ejecuta tu RPA (ejecutarETLCompleto) a pedido desde la app: lee Gmail y agrega lo nuevo a Debito/Crédito.
 * No usa fosWithLock_: dura minutos y bloquearía las demás escrituras (las filas del ETL entran con appendRow igual que siempre).
 * Una bandera en caché evita dos corridas a la vez desde la app (doble clic, PC y celular). Si quieres que tampoco choque con
 * la corrida programada de cada hora, apunta ese trigger a fosEtlProgramado() (misma bandera).
 */
function fosRunEtl_() {
  if (typeof ejecutarETLCompleto !== 'function') {
    throw new FosError('NOT_AVAILABLE', 'No existe ejecutarETLCompleto() en este proyecto.');
  }
  const deb = fosSheet_(FOS_CFG.SHEETS.DEBITO), cred = fosSheet_(FOS_CFG.SHEETS.CREDITO);
  const d0 = deb.getLastRow(), c0 = cred.getLastRow(), t0 = Date.now();
  fosEtlGuard_(function () { ejecutarETLCompleto(); SpreadsheetApp.flush(); });
  const out = { debito: Math.max(0, deb.getLastRow() - d0), credito: Math.max(0, cred.getLastRow() - c0), segundos: Math.round((Date.now() - t0) / 1000) };
  PropertiesService.getScriptProperties().setProperty('FOS_ETL_LAST', String(Date.now()));
  return out;
}

/** Corre fn con la bandera «RPA en curso» (caché, 6 min máx.). Si ya hay una corrida: ETL_RUNNING. */
function fosEtlGuard_(fn) {
  const cache = CacheService.getScriptCache();
  if (cache.get('fos_etl_run')) throw new FosError('ETL_RUNNING', 'El RPA ya se está ejecutando. Espera a que termine.');
  cache.put('fos_etl_run', '1', 360);
  try { return fn(); } finally { cache.remove('fos_etl_run'); }
}

/** Opcional: usa esta función en tu trigger horario del ETL en vez de ejecutarETLCompleto, así nunca corre a la vez que el botón. */
function fosEtlProgramado() {
  try { fosEtlGuard_(function () { ejecutarETLCompleto(); }); } catch (e) { if (!(e instanceof FosError)) throw e; } // si el botón ya lo está corriendo, esta hora se salta
}
