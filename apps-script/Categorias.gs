/**
 * FINANZAS OS · Categorías con emoji obligatorio.
 * Las categorías siguen siendo texto libre en las hojas Debito/Crédito (columna Categoría). El emoji de cada una
 * vive en la hoja "Categorias" (columnas: Categoría | Emoji | Tipo), que se crea sola al guardar la primera.
 * Cada categoría es de Egreso o de Ingreso (Tipo): en el Inbox solo se ofrecen las que corresponden al signo del monto.
 * Renombrar actualiza TODAS las filas de ambas hojas (sin sumar ni mezclar Débito con Crédito).
 */

const FOS_SYSTEM_EMOJI = { 'pago tarjeta': '💳', 'restante': '💰', 'duplicado': '♻️' }; // reservadas: fijas, no editables
const FOS_SYSTEM_TIPO = { 'pago tarjeta': 'Egreso', 'restante': 'Ingreso', 'duplicado': 'Egreso' };

const FOS_EMOJI_RE = /^(?:\p{Extended_Pictographic}(?:️|[\u{1F3FB}-\u{1F3FF}])?(?:‍\p{Extended_Pictographic}(?:️|[\u{1F3FB}-\u{1F3FF}])?)*|\p{Regional_Indicator}{2})$/u;

/** Exactamente UN emoji (puede ser compuesto: 👨‍👩‍👧, 🇵🇪, 👍🏽). Rechaza texto, números y vacío. */
function fosValidEmoji_(v) {
  const e = String(v == null ? '' : v).trim();
  if (!e) throw new FosError('EMOJI_REQUIRED', 'Cada categoría necesita un emoji.');
  if (e.length > 16 || !FOS_EMOJI_RE.test(e)) throw new FosError('BAD_EMOJI', 'Pon un solo emoji (sin texto).');
  return e;
}

function fosValidTipo_(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t) throw new FosError('TIPO_REQUIRED', 'Indica si la categoría es de Egreso o de Ingreso.');
  if (t !== 'Egreso' && t !== 'Ingreso') throw new FosError('BAD_TIPO', 'Tipo debe ser Egreso o Ingreso.');
  return t;
}

/** Filas de la hoja Categorias: [{nombre, emoji, tipo|null}] (vacío si la hoja aún no existe). */
function fosCatSheetRows_() {
  let t;
  try { t = fosReadTable_(FOS_CFG.SHEETS.CATEGORIAS, ['Categoría', 'Emoji']); } catch (e) {
    if (e instanceof FosError && (e.code === 'SHEET_NOT_FOUND' || e.code === 'EMPTY_SHEET' || e.code === 'SCHEMA')) return [];
    throw e;
  }
  const iT = t.opt('Tipo');
  const out = [];
  t.rows.forEach(function (r) {
    const nombre = String(r[t.idx('Categoría')]).trim();
    if (!nombre) return;
    const tp = iT >= 0 ? String(r[iT]).trim() : '';
    out.push({ nombre: nombre, emoji: String(r[t.idx('Emoji')]).trim(), tipo: tp === 'Egreso' || tp === 'Ingreso' ? tp : null });
  });
  return out;
}

/** { 'nombre normalizado': emoji } */
function fosEmojiByKey_() {
  const out = {};
  fosCatSheetRows_().forEach(function (r) { if (r.emoji) out[fosNorm_(r.nombre)] = r.emoji; });
  return out;
}

/** { 'nombre normalizado': 'Egreso'|'Ingreso' } (solo las que ya tienen tipo; el resto se ofrece en ambos lados). */
function fosTipoMap_() {
  const out = {};
  fosCatSheetRows_().forEach(function (r) { if (r.tipo) out[fosNorm_(r.nombre)] = r.tipo; });
  Object.keys(FOS_SYSTEM_TIPO).forEach(function (k) { out[k] = FOS_SYSTEM_TIPO[k]; });
  return out;
}

/** { 'nombre normalizado': emoji } para el cliente (incluye las reservadas con su emoji fijo). */
function fosEmojiMap_() {
  const out = fosEmojiByKey_();
  Object.keys(FOS_SYSTEM_EMOJI).forEach(function (k) { out[k] = FOS_SYSTEM_EMOJI[k]; });
  return out;
}

function fosCountByCategory_(sheetName, into, field) {
  let t;
  try { t = fosReadTable_(sheetName, ['Categoría']); } catch (e) { if (e instanceof FosError) return; throw e; }
  const iM = t.opt('Monto');
  t.rows.forEach(function (r) {
    const raw = String(r[t.idx('Categoría')]).trim();
    if (!raw) return;
    const k = fosNorm_(raw);
    const e = into[k] || (into[k] = { nombre: raw, debito: 0, credito: 0, pos: 0, neg: 0, variantes: {} });
    e[field]++;
    const m = iM >= 0 ? fosNum_(r[iM]) : null;
    if (m !== null && m > 0) e.pos++; else if (m !== null && m < 0) e.neg++;
    e.variantes[raw] = (e.variantes[raw] || 0) + 1;
    if (e.variantes[raw] > (e.variantes[e.nombre] || 0)) e.nombre = raw; // el nombre más usado
  });
}

function fosGetCategoryAdmin_() {
  const by = {};
  fosCountByCategory_(FOS_CFG.SHEETS.DEBITO, by, 'debito');
  fosCountByCategory_(FOS_CFG.SHEETS.CREDITO, by, 'credito');
  const sheetRows = {};
  fosCatSheetRows_().forEach(function (r) {
    const k = fosNorm_(r.nombre);
    sheetRows[k] = r;
    if (!by[k]) by[k] = { nombre: r.nombre, debito: 0, credito: 0, pos: 0, neg: 0, variantes: {} }; // creadas pero aún sin uso
  });
  const items = Object.keys(by).map(function (k) {
    const sistema = k in FOS_SYSTEM_EMOJI, sr = sheetRows[k];
    const uso = by[k].pos && by[k].neg ? 'Mixto' : by[k].neg ? 'Egreso' : by[k].pos ? 'Ingreso' : null;
    return {
      nombre: by[k].nombre,
      emoji: sistema ? FOS_SYSTEM_EMOJI[k] : (sr && sr.emoji) || null,
      tipo: sistema ? FOS_SYSTEM_TIPO[k] : (sr && sr.tipo) || null,
      tipoUso: uso, // lo que sugieren sus movimientos (signo del monto)
      debito: by[k].debito, credito: by[k].credito, sistema: sistema,
    };
  });
  items.sort(function (a, b) {
    return ((a.emoji && a.tipo) ? 1 : 0) - ((b.emoji && b.tipo) ? 1 : 0) || a.nombre.localeCompare(b.nombre, 'es');
  });
  return {
    items: items,
    sinEmoji: items.filter(function (i) { return !i.emoji; }).length,
    sinTipo: items.filter(function (i) { return !i.tipo; }).length,
    emojis: fosEmojiMap_(), tipos: fosTipoMap_(),
  };
}

/** Crea o actualiza la fila de una categoría en la hoja Categorias (por nombre normalizado). */
function fosUpsertCategory_(nombre, emoji, tipo, oldNombre) {
  const ss = fosSpreadsheet_();
  let sh = ss.getSheetByName(FOS_CFG.SHEETS.CATEGORIAS);
  if (!sh) {
    sh = ss.insertSheet(FOS_CFG.SHEETS.CATEGORIAS);
    sh.getRange(1, 1, 1, 3).setValues([['Categoría', 'Emoji', 'Tipo']]);
  } else if (sh.getLastColumn() < 3 || String(sh.getRange(1, 3).getValue()).trim() !== 'Tipo') {
    sh.getRange(1, 3).setValue('Tipo'); // hoja creada antes de existir el Tipo
  }
  const lastRow = sh.getLastRow();
  const values = lastRow >= 2 ? sh.getRange(2, 1, lastRow - 1, 2).getValues() : [];
  const kNew = fosNorm_(nombre), kOld = oldNombre ? fosNorm_(oldNombre) : null;
  let rowNew = -1, rowOld = -1;
  values.forEach(function (r, i) {
    const k = fosNorm_(r[0]);
    if (k === kNew && rowNew < 0) rowNew = i + 2;
    if (kOld && k === kOld && rowOld < 0) rowOld = i + 2;
  });
  let target = rowNew;
  if (target < 0 && rowOld > 0) { target = rowOld; rowOld = -1; }   // renombrar: reutiliza la fila vieja
  if (target < 0) { target = lastRow + 1; sh.getRange(target, 2).setNumberFormat('@'); }
  sh.getRange(target, 1, 1, 3).setValues([[nombre, emoji, tipo]]);
  if (rowOld > 0 && rowOld !== target) sh.deleteRow(rowOld);          // fusión: la fila vieja sobra
}

/** Reemplaza el nombre de una categoría en la columna Categoría de una hoja (por TextFinder: no depende de filas ni de orden). */
function fosRenameInSheet_(sheetName, oldKey, nuevo) {
  let t;
  try { t = fosReadTable_(sheetName, ['Categoría']); } catch (e) { if (e instanceof FosError) return 0; throw e; }
  const variants = {};
  t.rows.forEach(function (r) {
    const raw = String(r[t.idx('Categoría')]);
    if (raw.trim() && fosNorm_(raw) === oldKey && raw !== nuevo) variants[raw] = true;
  });
  const n = t.rows.length;
  if (!n) return 0;
  const range = t.sh.getRange(2, t.idx('Categoría') + 1, n, 1);
  let total = 0;
  Object.keys(variants).forEach(function (v) {
    total += range.createTextFinder(v).matchEntireCell(true).matchCase(true).replaceAllWith(nuevo);
  });
  return total;
}

/**
 * Crea / edita una categoría. payload: {nombre?: actual, nuevo: nombre final, emoji: obligatorio, tipo: 'Egreso'|'Ingreso' obligatorio}.
 * Sin `nombre` crea una nueva. Si `nuevo` ya existe en otra categoría, se FUSIONAN (las filas pasan a la existente).
 */
function fosSaveCategory_(p) {
  const emoji = fosValidEmoji_(p.emoji);
  const tipo = fosValidTipo_(p.tipo);
  const nuevo = fosCategory_(p.nuevo != null ? p.nuevo : p.nombre); // rechaza reservadas y texto peligroso
  const actual = p.nombre != null && String(p.nombre).trim() !== '' ? String(p.nombre).trim() : null;
  if (actual && fosNorm_(actual) in FOS_SYSTEM_EMOJI) throw new FosError('BAD_CATEGORIA', 'Categoría reservada del sistema.');
  const admin = fosGetCategoryAdmin_();
  const byKey = {};
  admin.items.forEach(function (i) { byKey[fosNorm_(i.nombre)] = i; });
  if (actual && !byKey[fosNorm_(actual)]) throw new FosError('NOT_FOUND', 'La categoría "' + actual + '" no existe.');
  if (!actual && byKey[fosNorm_(nuevo)]) throw new FosError('EXISTS', 'Ya existe una categoría con ese nombre.');
  const clash = byKey[fosNorm_(nuevo)];
  if (actual && clash && fosNorm_(nuevo) !== fosNorm_(actual) && clash.tipo && clash.tipo !== tipo) {
    throw new FosError('TIPO_MISMATCH', 'No se puede fusionar una categoría de ' + tipo + ' con una de ' + clash.tipo + '.');
  }

  const renamed = { debito: 0, credito: 0 };
  let merged = false;
  if (actual && (actual !== nuevo)) {
    const oldKey = fosNorm_(actual);
    merged = fosNorm_(nuevo) !== oldKey && !!byKey[fosNorm_(nuevo)];
    renamed.debito = fosRenameInSheet_(FOS_CFG.SHEETS.DEBITO, oldKey, nuevo);
    renamed.credito = fosRenameInSheet_(FOS_CFG.SHEETS.CREDITO, oldKey, nuevo);
  }
  fosUpsertCategory_(nuevo, emoji, tipo, actual);
  return { nombre: nuevo, emoji: emoji, tipo: tipo, renombradas: renamed, fusionada: merged };
}
