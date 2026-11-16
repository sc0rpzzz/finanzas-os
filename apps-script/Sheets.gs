/**
 * FINANZAS OS · Acceso a datos y validaciones
 * Las columnas se resuelven por NOMBRE de encabezado (sin tildes ni mayúsculas),
 * así que reordenar o insertar columnas en el Sheet no rompe la API.
 */

function fosSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function fosTz_() {
  return fosSpreadsheet_().getSpreadsheetTimeZone();
}

function fosSheet_(name) {
  const sh = fosSpreadsheet_().getSheetByName(name);
  if (!sh) throw new FosError('SHEET_NOT_FOUND', 'No existe la hoja "' + name + '".');
  return sh;
}

function fosNorm_(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function fosBlank_(v) {
  return v === '' || v === null || v === undefined;
}

/** Lee una hoja completa. Devuelve {sh, rows (sin encabezado), idx(nombre), opt(nombre)}. */
/** Memo de lecturas: solo vive durante UNA ejecución en modo batch (null = desactivado). Las escrituras nunca lo usan. */
var FOS_MEMO_ = null;

function fosReadTable_(sheetName, required) {
  let raw = FOS_MEMO_ && FOS_MEMO_[sheetName];
  if (!raw) {
    const sh = fosSheet_(sheetName);
    const lastRow = sh.getLastRow();
    const lastCol = sh.getLastColumn();
    if (lastRow < 1 || lastCol < 1) throw new FosError('EMPTY_SHEET', 'La hoja "' + sheetName + '" está vacía.');
    raw = { sh: sh, values: sh.getRange(1, 1, lastRow, lastCol).getValues() }; // getValues => fórmulas ya evaluadas
    if (FOS_MEMO_) FOS_MEMO_[sheetName] = raw;
  }
  const values = raw.values;
  const col = {};
  values[0].forEach(function (h, i) {
    const k = fosNorm_(h);
    if (k && !(k in col)) col[k] = i;
  });
  (required || []).forEach(function (h) {
    if (!(fosNorm_(h) in col)) throw new FosError('SCHEMA', 'Falta la columna "' + h + '" en "' + sheetName + '".');
  });
  return {
    sh: raw.sh,
    rows: values.slice(1),
    idx: function (name) { return col[fosNorm_(name)]; },
    opt: function (name) { const k = fosNorm_(name); return k in col ? col[k] : -1; },
  };
}

function fosFmtDate_(v, tz) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, tz, "yyyy-MM-dd'T'HH:mm:ss");
  return fosBlank_(v) ? null : String(v);
}

function fosNum_(v) {
  if (fosBlank_(v)) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return isFinite(n) ? n : null;
}

/** Fecha local "yyyy-MM-ddTHH:mm[:ss]" interpretada en la zona horaria del Sheet. */
function fosParseLocal_(s) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) throw new FosError('BAD_DATE', 'Fecha inválida.');
  const full = s.length === 16 ? s + ':00' : s;
  return Utilities.parseDate(full, fosTz_(), "yyyy-MM-dd'T'HH:mm:ss");
}

/** Texto seguro: recorta, limita largo y bloquea inyección de fórmulas (=, +, -, @). */
function fosText_(v, field, max, required) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim();
  if (required && !s) throw new FosError('BAD_' + field.toUpperCase(), 'Falta ' + field + '.');
  if (s.length > max) throw new FosError('BAD_' + field.toUpperCase(), field + ' demasiado largo.');
  if (/^[=+\-@]/.test(s)) throw new FosError('BAD_' + field.toUpperCase(), field + ' no puede empezar con = + - @.');
  return s;
}

function fosCategory_(v) {
  const c = fosText_(v, 'categoria', FOS_CFG.LIMITS.CATEGORY, true);
  const lower = fosNorm_(c);
  const reserved = FOS_CFG.SYSTEM_CATEGORIES.some(function (s) { return fosNorm_(s) === lower; });
  if (reserved) throw new FosError('BAD_CATEGORIA', 'Categoría reservada del sistema.');
  return c;
}

function fosCollectCategories_(t) {
  const reserved = FOS_CFG.SYSTEM_CATEGORIES.map(fosNorm_);
  const seen = {};
  const out = [];
  t.rows.forEach(function (r) {
    const c = String(r[t.idx('Categoría')]).trim();
    const k = fosNorm_(c);
    if (c && !seen[k] && reserved.indexOf(k) < 0) { seen[k] = true; out.push(c); }
  });
  return out.sort(function (a, b) { return a.localeCompare(b, 'es'); });
}

function fosColLetter_(i) { // i: índice 0-based
  let n = i + 1, out = '';
  while (n > 0) { const m = (n - 1) % 26; out = String.fromCharCode(65 + m) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

function fosHasId_(t, id) {
  const iId = t.idx('ID');
  for (let i = 0; i < t.rows.length; i++) if (String(t.rows[i][iId]).trim() === id) return true;
  return false;
}

/**
 * Agrega una fila al final con appendRow (atómico, igual que tu ETL: así no pisa una fila
 * que el ETL agregue al mismo tiempo). Las columnas se llenan por NOMBRE de encabezado.
 * Devuelve el nº de fila donde quedó (se busca por ID) o -1.
 */
function fosAppendByHeader_(t, id, values) {
  const row = new Array(t.sh.getLastColumn()).fill('');
  Object.keys(values).forEach(function (h) { const i = t.opt(h); if (i >= 0) row[i] = values[h]; });
  t.sh.appendRow(row);
  const iId = t.idx('ID') + 1;
  const last = t.sh.getLastRow();
  for (let r = last; r >= Math.max(2, last - 30); r--) {
    if (String(t.sh.getRange(r, iId).getValue()).trim() === id) {
      t.sh.getRange(r, t.idx('Fecha') + 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
      return r;
    }
  }
  return -1;
}

/**
 * Agrega VARIAS filas, cada una con appendRow (atómico, igual que el ETL): si el ETL agrega una fila al mismo
 * tiempo, ninguna pisa a la otra (escribir en getLastRow()+1 sí podía pisarla). Columnas por NOMBRE de encabezado;
 * las claves que empiezan con "__" se ignoran. Cada valor debe traer su 'ID'.
 * Devuelve { ID: nº de fila } (las filas pueden no quedar contiguas si el ETL escribió en medio).
 */
function fosAppendRowsByHeader_(t, list) {
  const at = {};
  if (!list.length) return at;
  const width = t.sh.getLastColumn();
  list.forEach(function (v) {
    const row = new Array(width).fill('');
    Object.keys(v).forEach(function (h) { if (h.indexOf('__') === 0) return; const i = t.opt(h); if (i >= 0) row[i] = v[h]; });
    t.sh.appendRow(row);
  });
  const want = {};
  list.forEach(function (v) { want[String(v.ID)] = true; });
  const last = t.sh.getLastRow();
  const from = Math.max(2, last - list.length - 60 + 1); // margen por filas que el ETL haya agregado en medio
  const ids = t.sh.getRange(from, t.idx('ID') + 1, last - from + 1, 1).getValues();
  for (let k = ids.length - 1; k >= 0; k--) {
    const id = String(ids[k][0]).trim();
    if (want[id] && !at[id]) at[id] = from + k;
  }
  const iF = t.opt('Fecha');
  if (iF >= 0) Object.keys(at).forEach(function (id) { t.sh.getRange(at[id], iF + 1).setNumberFormat('yyyy-mm-dd hh:mm:ss'); });
  return at;
}

/** Deshace filas recién agregadas (rollback de partida doble): las busca por ID y las borra de abajo hacia arriba. */
function fosDeleteRowsById_(sheetName, ids) {
  if (!ids.length) return 0;
  const sh = fosSheet_(sheetName);
  const t = fosReadTable_(sheetName, ['ID']);
  const want = {};
  ids.forEach(function (id) { want[String(id)] = true; });
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const col = sh.getRange(2, t.idx('ID') + 1, last - 1, 1).getValues();
  const rows = [];
  col.forEach(function (r, i) { if (want[String(r[0]).trim()]) rows.push(i + 2); });
  rows.sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRow(r); });
  return rows.length;
}

/** Categorías de Debito y Crédito unidas (sin repetir, sin las del sistema). */
function fosAllCategories_() {
  const seen = {};
  const out = [];
  const add = function (c) { const k = fosNorm_(c); if (!seen[k]) { seen[k] = true; out.push(c); } };
  [FOS_CFG.SHEETS.DEBITO, FOS_CFG.SHEETS.CREDITO].forEach(function (name) {
    let t;
    try { t = fosReadTable_(name, ['Categoría']); } catch (e) { if (e instanceof FosError) return; throw e; }
    fosCollectCategories_(t).forEach(add);
  });
  // también las creadas en la pestaña Categorías que aún no tienen movimientos
  const reserved = FOS_CFG.SYSTEM_CATEGORIES.map(fosNorm_);
  fosCatSheetRows_().forEach(function (r) { if (reserved.indexOf(fosNorm_(r.nombre)) < 0) add(r.nombre); });
  return out.sort(function (a, b) { return a.localeCompare(b, 'es'); });
}

/**
 * Ejecutar UNA vez a mano desde el editor: asigna IDs estables (LEG_...) a las filas
 * de Debito y Crédito que no tienen ID (sin ID no se pueden categorizar ni deduplicar).
 * El ID es hash del contenido + contador para filas idénticas; no toca nada más.
 */
function fosBackfillIds() {
  [
    { sheet: FOS_CFG.SHEETS.DEBITO,  prefix: 'LEG_DEB', cols: ['Fecha', 'Banco / Cuenta', 'Detalle/Comercio', 'Monto'] },
    { sheet: FOS_CFG.SHEETS.CREDITO, prefix: 'LEG_CRE', cols: ['Fecha', 'Banco / Cuenta', 'Detalle/Comercio', 'Monto'] },
  ].forEach(function (cfg) {
    const t = fosReadTable_(cfg.sheet, cfg.cols.concat(['ID']));
    const tz = fosTz_();
    const seen = {};
    let filled = 0;
    t.rows.forEach(function (r, i) {
      const hasData = !fosBlank_(r[t.idx('Fecha')]) || !fosBlank_(r[t.idx('Monto')]);
      if (!hasData || String(r[t.idx('ID')]).trim() !== '') return;
      const key = cfg.cols.map(function (c) {
        const v = r[t.idx(c)];
        return fosNorm_(v instanceof Date ? fosFmtDate_(v, tz) : v);
      }).join('|');
      seen[key] = (seen[key] || 0) + 1;
      const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, key, Utilities.Charset.UTF_8)
        .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('').slice(0, 10).toUpperCase();
      const id = cfg.prefix + '_' + hash + (seen[key] > 1 ? '_' + seen[key] : '');
      t.sh.getRange(i + 2, t.idx('ID') + 1).setValue(id);
      filled++;
    });
    Logger.log(cfg.sheet + ': ' + filled + ' ID(s) asignados.');
  });
}
