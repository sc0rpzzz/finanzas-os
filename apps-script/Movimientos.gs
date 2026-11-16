/**
 * FINANZAS OS · Movimientos: edición celda a celda, alta en lote, clasificación en lote y duplicados Yape/BCP.
 * Reglas comunes: se actualiza por ID (nunca por número de fila), solo las celdas que cambian, con comprobación
 * optimista (`expect`) para no pisar un cambio hecho desde otro dispositivo o por el ETL.
 */

const FOS_BATCH_MAX = 50;
const FOS_DUP_MAX_MIN = 120; // posible duplicado Yape↔BCP: como máximo 2 horas entre los dos movimientos

function fosHoja_(h) {
  const k = String(h || '').toLowerCase();
  if (k === 'debito') return { key: 'debito', name: FOS_CFG.SHEETS.DEBITO };
  if (k === 'credito') return { key: 'credito', name: FOS_CFG.SHEETS.CREDITO };
  throw new FosError('BAD_HOJA', 'hoja debe ser "debito" o "credito".');
}

/** Devuelve la columna (1-based) con ese encabezado; si no existe la crea al final de la hoja. */
function fosEnsureColumn_(sheetName, header) {
  const sh = fosSheet_(sheetName);
  const lastCol = Math.max(1, sh.getLastColumn());
  const heads = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const n = fosNorm_(header);
  for (let i = 0; i < heads.length; i++) if (fosNorm_(heads[i]) === n) return i + 1;
  sh.getRange(1, lastCol + 1).setValue(header);
  if (FOS_MEMO_) delete FOS_MEMO_[sheetName];
  return lastCol + 1;
}

/** Cuentas válidas de una hoja = las que ya existen en ella + las fijas (Débito) o las tarjetas (Crédito). */
function fosAccounts_(hoja, t) {
  const seen = {}, out = [];
  const add = function (n) { n = String(n == null ? '' : n).trim(); const k = fosNorm_(n); if (n && !seen[k]) { seen[k] = true; out.push(n); } };
  const iC = t.idx('Banco / Cuenta');
  t.rows.forEach(function (r) { add(r[iC]); });
  if (hoja.key === 'debito') FOS_CFG.MANUAL_BANKS.forEach(add);
  else { try { fosCardNames_().forEach(add); } catch (e) { if (!(e instanceof FosError)) throw e; } }
  return out;
}

function fosPickAccount_(list, v) {
  const k = fosNorm_(v);
  const hit = list.filter(function (a) { return fosNorm_(a) === k; })[0];
  if (!hit) throw new FosError('BAD_CUENTA', 'Cuenta no reconocida.');
  return hit;
}

/** Valida una categoría de usuario para un movimiento con signo `monto` (vacía = sin categoría). */
function fosCheckCategory_(raw, monto, allowDup) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (allowDup && fosNorm_(s) === 'duplicado') return 'Duplicado';
  const cat = fosCategory_(s);
  const k = fosNorm_(cat);
  const exists = fosAllCategories_().some(function (c) { return fosNorm_(c) === k; });
  if (!exists) throw new FosError('UNKNOWN_CATEGORY', 'La categoría no existe: créala en la pestaña Categorías.');
  const tipo = fosTipoMap_()[k];
  if (tipo && monto != null && ((monto < 0 && tipo !== 'Egreso') || (monto > 0 && tipo !== 'Ingreso'))) {
    throw new FosError('TIPO_MISMATCH', 'Esta categoría es de ' + tipo + ' y el movimiento es un ' + (monto < 0 ? 'Egreso' : 'Ingreso') + '.');
  }
  return cat;
}

function fosSignedAmount_(v) {
  const raw = Number(v);
  if (!isFinite(raw) || raw === 0 || Math.abs(raw) > FOS_CFG.LIMITS.AMOUNT) throw new FosError('BAD_AMOUNT', 'Monto inválido.');
  return Math.round(raw * 100) / 100;
}

/* =============================== EDITAR UNA CELDA =============================== */

function fosSameVal_(field, cur, exp, tz) {
  if (field === 'monto') { const a = fosNum_(cur), b = fosNum_(exp); return a !== null && b !== null && Math.abs(a - b) < 0.005; }
  if (field === 'pagado') return (cur === true) === (exp === true);
  if (field === 'fecha') return String(fosFmtDate_(cur, tz) || '') === String(exp == null ? '' : exp);
  return String(cur == null ? '' : cur).trim() === String(exp == null ? '' : exp).trim();
}

function fosUpdateMovimiento_(p) {
  const hoja = fosHoja_(p.hoja);
  const id = fosText_(p.id, 'id', 64, true);
  const cambios = p.cambios && typeof p.cambios === 'object' ? p.cambios : null;
  const fields = cambios ? Object.keys(cambios) : [];
  if (!fields.length) throw new FosError('BAD_CHANGES', 'No hay cambios.');
  const HEAD = { fecha: 'Fecha', detalle: 'Detalle/Comercio', categoria: 'Categoría', monto: 'Monto', comentario: 'Comentario' };
  if (hoja.key === 'debito') { HEAD.cuenta = 'Banco / Cuenta'; HEAD.descripcion = 'Descripción'; } else { HEAD.pagado = 'Pagado'; HEAD.estado = 'Estado'; }
  fields.forEach(function (f) { if (!(f in HEAD)) throw new FosError('BAD_FIELD', 'Campo no editable: ' + f); });
  const tz = fosTz_();

  if (fields.indexOf('comentario') >= 0) fosEnsureColumn_(hoja.name, 'Comentario');
  if (fields.indexOf('categoria') >= 0) fosEnsureColumn_(hoja.name, 'Categoría');
  const t = fosReadTable_(hoja.name, ['ID', 'Fecha', 'Monto']);
  const matches = [];
  t.rows.forEach(function (r, i) { if (String(r[t.idx('ID')]).trim() === id) matches.push(i); });
  if (!matches.length) throw new FosError('NOT_FOUND', 'No existe un movimiento con ese ID.');
  if (matches.length > 1) throw new FosError('AMBIGUOUS', 'ID duplicado en la hoja.');
  const row = t.rows[matches[0]], sheetRow = matches[0] + 2;
  fields.forEach(function (f) { if (t.opt(HEAD[f]) < 0) throw new FosError('SCHEMA', 'Falta la columna "' + HEAD[f] + '".'); });

  // comprobación optimista: lo que el usuario vio debe seguir igual en la hoja
  const exp = p.expect && typeof p.expect === 'object' ? p.expect : {};
  fields.forEach(function (f) {
    if (f in exp && !fosSameVal_(f, row[t.idx(HEAD[f])], exp[f], tz)) {
      throw new FosError('CONFLICT', 'Este dato cambió mientras lo editabas (' + f + '). Recarga para ver el valor actual.');
    }
  });

  const iCat = t.opt('Categoría');
  const curCat = iCat >= 0 ? String(row[iCat]).trim() : '';
  const curCatN = fosNorm_(curCat);
  const linked = curCatN === 'pago tarjeta';
  if (linked && (cambios.monto !== undefined || cambios.fecha !== undefined || cambios.cuenta !== undefined)) {
    throw new FosError('PAGO_LINKED', 'Es un pago de tarjeta con partida doble: no se edita monto, fecha ni cuenta aquí.');
  }
  const tipoCredito = hoja.key === 'credito' ? fosNorm_(row[t.opt('Tipo')]) : '';
  // Lado Crédito de un pago de tarjeta (Ingreso cuyo detalle empieza con «Pago»): solo comentario y Estado.
  const iDet = t.opt('Detalle/Comercio');
  const linkedCredito = hoja.key === 'credito' && tipoCredito === 'ingreso' && iDet >= 0 && fosNorm_(row[iDet]).indexOf('pago') === 0;
  if (linkedCredito && fields.some(function (f) { return f !== 'comentario' && f !== 'estado'; })) {
    throw new FosError('PAGO_LINKED', 'Es un pago de tarjeta con partida doble: solo se puede comentar.');
  }
  // Fila marcada «Duplicado» desde el Inbox: queda fija, solo admite comentario / descripción.
  if (curCatN === 'duplicado' && fields.some(function (f) { return f !== 'comentario' && f !== 'descripcion'; })) {
    throw new FosError('DUP_LOCKED', 'Marcado como duplicado desde el Inbox: solo se puede comentar.');
  }
  const writes = {}; // header -> valor
  let monto = fosNum_(row[t.idx('Monto')]);

  fields.forEach(function (f) {
    const v = cambios[f];
    if (f === 'fecha') writes['Fecha'] = fosParseLocal_(String(v || ''));
    else if (f === 'detalle') writes['Detalle/Comercio'] = fosText_(v, 'detalle', FOS_CFG.LIMITS.DETAIL, true);
    else if (f === 'comentario') writes['Comentario'] = fosText_(v, 'comentario', FOS_CFG.LIMITS.DESCRIPTION, false);
    else if (f === 'descripcion') writes['Descripción'] = fosText_(v, 'descripcion', FOS_CFG.LIMITS.DESCRIPTION, false);
    else if (f === 'cuenta') writes['Banco / Cuenta'] = fosPickAccount_(fosAccounts_(hoja, t), v);
    else if (f === 'pagado') writes['Pagado'] = v === true ? true : '';
    else if (f === 'estado') {
      if (v !== 'Procesado' && v !== 'Pendiente') throw new FosError('BAD_ESTADO', 'estado debe ser "Procesado" o "Pendiente".');
      writes['Estado'] = v;
    } else if (f === 'monto') {
      let m = fosSignedAmount_(v);
      if (hoja.key === 'credito') m = (tipoCredito === 'ingreso' ? 1 : -1) * Math.abs(m); // el tipo manda el signo en Crédito
      monto = m;
      writes['Monto'] = m;
      if (hoja.key === 'debito' && t.opt('Tipo') >= 0) writes['Tipo'] = m < 0 ? 'Egreso' : 'Ingreso';
    }
  });
  if (cambios.categoria !== undefined) {
    const nuevo = String(cambios.categoria == null ? '' : cambios.categoria).trim();
    if (linked && fosNorm_(nuevo) !== 'pago tarjeta') throw new FosError('PAGO_LINKED', 'Un pago de tarjeta no cambia de categoría.');
    if (!linked) {
      const sinTipo = fosNorm_(nuevo) === 'restante';
      writes['Categoría'] = sinTipo && curCatN === 'restante' ? curCat
        : fosCheckCategory_(nuevo, monto, false); // «Duplicado» solo se pone desde el Inbox (resolveDuplicado)
    }
  } else if (cambios.monto !== undefined && curCat && !linked && curCatN !== 'duplicado') {
    const tipo = fosTipoMap_()[curCatN];
    if (tipo && ((monto < 0 && tipo !== 'Egreso') || (monto > 0 && tipo !== 'Ingreso'))) {
      throw new FosError('TIPO_MISMATCH', 'La categoría «' + curCat + '» es de ' + tipo + ': cambia también la categoría.');
    }
  }

  const out = { id: id, updated: true, valores: {} };
  Object.keys(writes).forEach(function (h) {
    const c = t.idx(h) !== undefined ? t.idx(h) : t.opt(h);
    t.sh.getRange(sheetRow, c + 1).setValue(writes[h]);
    if (h === 'Fecha') t.sh.getRange(sheetRow, c + 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    out.valores[h] = writes[h] instanceof Date ? fosFmtDate_(writes[h], tz) : writes[h];
  });
  return out;
}

/* ============================ ALTA EN LOTE (varias filas) ============================ */

function fosAddMovimientos_(p) {
  const hoja = fosHoja_(p.hoja);
  const rows = Array.isArray(p.rows) ? p.rows : null;
  if (!rows || !rows.length || rows.length > FOS_BATCH_MAX) throw new FosError('BAD_BATCH', 'Envía entre 1 y ' + FOS_BATCH_MAX + ' filas.');
  const need = rows.some(function (r) { return r && String(r.comentario || '').trim(); });
  if (need) fosEnsureColumn_(hoja.name, 'Comentario');
  const t = fosReadTable_(hoja.name, ['Fecha', 'Tipo', 'Banco / Cuenta', 'Detalle/Comercio', 'Monto', 'ID']);
  const accounts = fosAccounts_(hoja, t);
  const seen = {};
  t.rows.forEach(function (r) { seen[String(r[t.idx('ID')]).trim()] = true; });
  const results = [], block = [], twin = [];
  let tc = null, seenC = null;
  const known = fosAllCategories_();
  const lastCol = t.sh.getLastColumn();

  rows.forEach(function (r, n) {
    const res = { index: n, id: r && r.id ? String(r.id) : null, ok: false };
    results.push(res);
    try {
      if (!r || typeof r !== 'object') throw new FosError('BAD_ROW', 'Fila inválida.');
      const id = fosManualId_(r.id);
      const fecha = fosParseLocal_(String(r.fecha || ''));
      const detalle = fosText_(r.detalle, 'detalle', FOS_CFG.LIMITS.DETAIL, false) ;
      const comentario = fosText_(r.comentario, 'comentario', FOS_CFG.LIMITS.DESCRIPTION, false);
      const descripcion = fosText_(r.descripcion, 'descripcion', FOS_CFG.LIMITS.DESCRIPTION, false); // solo Débito
      const tipo = r.tipo === 'Ingreso' ? 'Ingreso' : r.tipo === 'Egreso' ? 'Egreso' : null;
      if (!tipo) throw new FosError('BAD_TYPE', 'Tipo debe ser Egreso o Ingreso.');
      const mag = Math.abs(fosSignedAmount_(r.monto));
      const monto = tipo === 'Egreso' ? -mag : mag;
      const cuenta = fosPickAccount_(accounts, r.cuenta || p.cuenta || '');
      let categoria = '';
      const v = {};
      if (hoja.key === 'debito') {
        if (r.tarjeta) { // pago de tarjeta: partida doble
          if (tipo !== 'Egreso') throw new FosError('BAD_TYPE', 'Un pago de tarjeta es un egreso.');
          if (!tc) { tc = fosReadTable_(FOS_CFG.SHEETS.CREDITO, ['Fecha', 'ID', 'Tipo', 'Banco / Cuenta', 'Detalle/Comercio', 'Monto']); seenC = {}; tc.rows.forEach(function (x) { seenC[String(x[tc.idx('ID')]).trim()] = true; }); }
          const tarjeta = fosCardName_(r.tarjeta);
          if (seen[id] && seenC[id]) { res.ok = true; res.duplicate = true; return; }
          if (seen[id] || seenC[id]) throw new FosError('HALF_PAIR', 'Ese ID existe solo en una de las dos hojas.');
          seen[id] = seenC[id] = true;
          v.d = { 'Fecha': fecha, 'Tipo': 'Egreso', 'Banco / Cuenta': cuenta, 'Detalle/Comercio': 'Pago a: ' + tarjeta, 'Categoría': 'Pago Tarjeta', 'Monto': -mag, 'ID': id, 'Comentario': comentario, 'Descripción': descripcion };
          v.c = { 'Fecha': fecha, 'ID': id, 'Tipo': 'Ingreso', 'Estado': 'Procesado', 'Banco / Cuenta': tarjeta, 'Detalle/Comercio': 'Pago de Tarjeta ' + tarjeta, 'Monto': mag, 'Modalidad': '-', 'Comentario': comentario || descripcion };
          block.push(v.d); twin.push(v.c);
          res.ok = true; res.inserted = true; return;
        }
        if (!detalle) throw new FosError('BAD_DETALLE', 'Falta detalle.');
        categoria = fosCheckCategory_(r.categoria, monto, false);
        if (seen[id]) { res.ok = true; res.duplicate = true; return; }
        seen[id] = true;
        block.push({ 'Fecha': fecha, 'Tipo': tipo, 'Banco / Cuenta': cuenta, 'Detalle/Comercio': detalle, 'Categoría': categoria, 'Monto': monto, 'ID': id, 'Comentario': comentario, 'Descripción': descripcion });
        res.ok = true; res.inserted = true; return;
      }
      // Crédito (solo consumos: el abono manual está desactivado; los pagos llegan por el ETL o como pago de tarjeta desde Débito)
      if (tipo !== 'Egreso') throw new FosError('ABONO_OFF', 'El abono manual a tarjeta está desactivado: registra el pago desde Débito.');
      if (!detalle) throw new FosError('BAD_DETALLE', 'Falta detalle.');
      categoria = fosCheckCategory_(r.categoria, monto, false);
      if (seen[id]) { res.ok = true; res.duplicate = true; return; }
      let modalidad = '-', cuotas = '';
      if (tipo === 'Egreso') {
        modalidad = r.modalidad === 'Cuotas Sin Interes' ? 'Cuotas Sin Interes' : 'Directo';
        if (modalidad !== 'Directo') {
          cuotas = Number(r.cuotas);
          if (!isFinite(cuotas) || cuotas % 1 !== 0 || cuotas < 2 || cuotas > 48) throw new FosError('BAD_INSTALLMENTS', 'N° de cuotas inválido (2 a 48).');
        }
      }
      const estado = r.estado === 'Procesado' || tipo === 'Ingreso' ? 'Procesado' : 'Pendiente';
      seen[id] = true;
      block.push({
        'Fecha': fecha, 'ID': id, 'Tipo': tipo, 'Estado': estado, 'Banco / Cuenta': cuenta,
        'Detalle/Comercio': detalle || ('Pago de Tarjeta ' + cuenta), 'Monto': monto,
        'Pagado': (r.pagado === true && modalidad === 'Directo' && tipo === 'Egreso') ? true : '',
        'Modalidad': modalidad, 'N° Cuotas': cuotas, 'Categoría': categoria, 'Comentario': comentario, __cuota: cuotas !== '',
      });
      res.ok = true; res.inserted = true;
    } catch (err) {
      if (!(err instanceof FosError)) throw err;
      res.ok = false; res.error = err.code; res.message = err.message;
    }
  });

  // escritura con appendRow fila por fila (atómico frente al ETL); la fórmula de Monto Cuota va en la fila real de cada ID
  const writeBlock = function (tb, list) {
    const at = fosAppendRowsByHeader_(tb, list);
    const iK = tb.opt('Monto Cuota'), iJ = tb.opt('N° Cuotas');
    if (iK >= 0 && iJ >= 0) {
      list.forEach(function (v) {
        const rr = at[String(v.ID)];
        if (!v.__cuota || !rr) return;
        tb.sh.getRange(rr, iK + 1).setFormula('=IF(' + fosColLetter_(iJ) + rr + '="","",' + fosColLetter_(tb.idx('Monto')) + rr + '/' + fosColLetter_(iJ) + rr + ')');
      });
    }
    return at;
  };
  // releer anchos tras posibles columnas nuevas
  writeBlock(fosReadTable_(hoja.name, ['ID']), block);
  if (twin.length) {
    try {
      if (twin.some(function (v) { return v.Comentario; })) fosEnsureColumn_(FOS_CFG.SHEETS.CREDITO, 'Comentario');
      writeBlock(fosReadTable_(FOS_CFG.SHEETS.CREDITO, ['ID']), twin);
    } catch (err) {
      // partida doble: o las dos mitades o ninguna. Se deshacen los pagos (por ID) en ambas hojas.
      const ids = twin.map(function (v) { return String(v.ID); });
      try { fosDeleteRowsById_(FOS_CFG.SHEETS.CREDITO, ids); } catch (_) { /* si falló al crear, no hay nada que borrar */ }
      fosDeleteRowsById_(hoja.name, ids);
      throw err;
    }
  }
  return { results: results, inserted: results.filter(function (x) { return x.inserted; }).length };
}

/* ========================== CLASIFICAR EN LOTE (Inbox) ========================== */

function fosCategorizeBatch_(p) {
  const items = Array.isArray(p.items) ? p.items : null;
  if (!items || !items.length || items.length > 100) throw new FosError('BAD_BATCH', 'Envía entre 1 y 100 movimientos.');
  const hoja = p.hoja === 'credito' ? 'credito' : 'debito';
  const lastById = {};
  items.forEach(function (it, i) { if (it && it.id) lastById[String(it.id)] = i; });
  FOS_MEMO_ = {};
  try {
    const results = items.map(function (it, i) {
      const id = it && it.id ? String(it.id) : null;
      if (!id) return { id: null, ok: false, error: 'BAD_ID' };
      if (lastById[id] !== i) return { id: id, ok: true, updated: false, reason: 'SUPERSEDED' };
      try {
        const r = fosCategorize_({ id: id, hoja: hoja, categoria: it.categoria, emoji: it.emoji, pagoTarjeta: it.pagoTarjeta === true, onlyIfBlank: true });
        delete FOS_MEMO_[FOS_CFG.SHEETS.CATEGORIAS]; // una categoría nueva pudo crearse: que el siguiente ítem la vea
        return { id: id, ok: true, updated: r.updated, reason: r.reason, categoria: r.categoria };
      } catch (err) {
        if (!(err instanceof FosError)) throw err;
        return { id: id, ok: false, error: err.code, message: err.message };
      }
    });
    return { results: results, updated: results.filter(function (x) { return x.updated; }).length };
  } finally {
    FOS_MEMO_ = null;
  }
}

/* ===================== POSIBLES DUPLICADOS YAPE ↔ BCP (Débito) ===================== */

function fosDupKey_(a, b) { return [String(a), String(b)].sort().join('|'); }

function fosDupDismissed_() {
  const set = {};
  try {
    const t = fosReadTable_(FOS_CFG.SHEETS.DUP_OK, ['Clave']);
    t.rows.forEach(function (r) { const k = String(r[t.idx('Clave')]).trim(); if (k) set[k] = true; });
  } catch (e) { if (!(e instanceof FosError)) throw e; }
  return set;
}

function fosTokens_(s) {
  const stop = { yape: 1, plin: 1, consumo: 1, debito: 1, bcp: 1, pago: 1, pagos: 1, a: 1, de: 1, del: 1, la: 1, el: 1 };
  return fosNorm_(s).split(/[^a-z0-9]+/).filter(function (w) { return w.length >= 3 && !stop[w]; });
}

/**
 * Un Yape a una billetera externa (Plin, etc.) puede entrar dos veces: por la notificación de Yape ("[YAPE] ...") y por
 * el "Consumo Débito" del BCP. Se avisa cuando hay un egreso Yape y otro que no lo es, con monto parecido (±5 %, mín. S/ 1),
 * a 2 horas o menos y alguno aún sin categoría (se revisan los movimientos de los últimos 45 días). Empareja uno a uno; los pares descartados no vuelven a salir.
 */
function fosFindDuplicates_(t, tz) {
  const iDesc = t.opt('Descripción');
  const cutoff = new Date().getTime() - 45 * 86400000;
  const cand = [];
  t.rows.forEach(function (r) {
    const f = r[t.idx('Fecha')], monto = fosNum_(r[t.idx('Monto')]);
    if (!(f instanceof Date) || monto === null || monto >= 0 || f.getTime() < cutoff) return;
    const id = String(r[t.idx('ID')]).trim();
    if (!id) return;
    const cat = String(r[t.idx('Categoría')]).trim(), cn = fosNorm_(cat);
    if (cn === 'duplicado' || cn === 'pago tarjeta' || cn === 'restante') return;
    const detalle = String(r[t.idx('Detalle/Comercio')]), desc = iDesc >= 0 ? String(r[iDesc]) : '';
    cand.push({ id: id, t: f.getTime(), fecha: fosFmtDate_(f, tz), detalle: detalle, monto: monto, categoria: cat,
      yape: /^\s*\[yape\]/i.test(detalle), tok: fosTokens_(detalle + ' ' + desc) });
  });
  const dismissed = fosDupDismissed_();
  const pairs = [];
  cand.filter(function (c) { return c.yape; }).forEach(function (y) {
    cand.filter(function (c) { return !c.yape; }).forEach(function (b) {
      const min = Math.abs(y.t - b.t) / 60000;
      if (min > FOS_DUP_MAX_MIN) return;
      const dm = Math.abs(Math.abs(y.monto) - Math.abs(b.monto));
      if (dm > Math.max(1, 0.05 * Math.max(Math.abs(y.monto), Math.abs(b.monto)))) return;
      if (y.categoria && b.categoria) return; // ya revisados
      if (dismissed[fosDupKey_(y.id, b.id)]) return;
      const overlap = y.tok.some(function (w) { return b.tok.indexOf(w) >= 0; });
      const exact = dm < 0.005;
      pairs.push({ y: y, b: b, minutos: Math.round(min), score: (exact ? 2 : 1) + (overlap ? 2 : 0) + (min <= 15 ? 1 : 0),
        confianza: exact && (overlap || min <= 15) ? 'alta' : 'media' });
    });
  });
  pairs.sort(function (a, b) { return b.score - a.score || a.minutos - b.minutos; });
  const usedY = {}, usedB = {}, out = [];
  pairs.forEach(function (x) {
    if (usedY[x.y.id] || usedB[x.b.id]) return;
    usedY[x.y.id] = usedB[x.b.id] = true;
    const pick = function (c) { return { id: c.id, fecha: c.fecha, detalle: c.detalle, monto: c.monto, categoria: c.categoria }; };
    out.push({ yape: pick(x.y), banco: pick(x.b), minutos: x.minutos, confianza: x.confianza });
  });
  return out;
}

function fosResolveDuplicado_(p) {
  const a = fosText_(p.a, 'a', 64, true), b = fosText_(p.b, 'b', 64, true);
  if (p.accion === 'descartar') {
    const ss = fosSpreadsheet_();
    let sh = ss.getSheetByName(FOS_CFG.SHEETS.DUP_OK);
    if (!sh) { sh = ss.insertSheet(FOS_CFG.SHEETS.DUP_OK); sh.getRange(1, 1, 1, 2).setValues([['Clave', 'Fecha']]); }
    const key = fosDupKey_(a, b);
    const last = sh.getLastRow();
    const have = last >= 2 ? sh.getRange(2, 1, last - 1, 1).getValues() : [];
    if (!have.some(function (r) { return String(r[0]).trim() === key; })) {
      sh.getRange(last + 1, 1, 1, 2).setValues([[key, fosFmtDate_(new Date(), fosTz_())]]);
    }
    return { accion: 'descartar', clave: key };
  }
  if (p.accion !== 'marcar') throw new FosError('BAD_ACTION', 'accion debe ser "marcar" o "descartar".');
  const dup = fosText_(p.duplicado, 'duplicado', 64, true);
  if (dup !== a && dup !== b) throw new FosError('BAD_ID', 'El duplicado debe ser uno de los dos movimientos.');
  const t = fosReadTable_(FOS_CFG.SHEETS.DEBITO, ['Categoría', 'ID']);
  const m = [];
  t.rows.forEach(function (r, i) { if (String(r[t.idx('ID')]).trim() === dup) m.push(i); });
  if (!m.length) throw new FosError('NOT_FOUND', 'No existe un movimiento con ese ID.');
  if (m.length > 1) throw new FosError('AMBIGUOUS', 'ID duplicado en la hoja.');
  const antes = String(t.rows[m[0]][t.idx('Categoría')]).trim();
  const an = fosNorm_(antes);
  if (an === 'pago tarjeta' || an === 'restante') throw new FosError('PAGO_LINKED', 'Este movimiento es de sistema y no puede marcarse como duplicado.');
  t.sh.getRange(m[0] + 2, t.idx('Categoría') + 1).setValue('Duplicado');
  return { accion: 'marcar', id: dup, antes: antes };
}
