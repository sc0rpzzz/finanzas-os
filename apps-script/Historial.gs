/**
 * FINANZAS OS · Movimientos de UNA cuenta a la vez (Débito o Crédito), para contrastar con el aplicativo del banco.
 * Devuelve las columnas tal cual están en la hoja (por encabezado), más recientes primero, la lista de cuentas y los totales
 * de toda la historia de la cuenta (las filas marcadas «Duplicado» no cuentan):
 *   Débito:  ingresos, egresos, neto            Crédito: ingresos, egresos, saldo disponible (= suma de todos sus movimientos)
 * Si falta la columna «Comentario» se devuelve igual (vacía): se crea en la hoja la primera vez que se escribe un comentario.
 */
function fosGetHistory_(p) {
  const hoja = fosHoja_(p && p.hoja);
  const tz = fosTz_();
  const sh = fosSheet_(hoja.name);
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 1 || lastCol < 1) throw new FosError('EMPTY_SHEET', 'La hoja "' + hoja.name + '" está vacía.');
  const values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const columns = values[0].map(function (h) { return String(h).trim(); });
  const norm = columns.map(fosNorm_);
  const iFecha = norm.indexOf('fecha'), iCuenta = norm.indexOf('banco / cuenta'), iMonto = norm.indexOf('monto'), iCat = norm.indexOf('categoria');
  if (iCuenta < 0 || iMonto < 0) throw new FosError('SCHEMA', 'Faltan las columnas "Banco / Cuenta" o "Monto".');
  let iCom = norm.indexOf('comentario');
  const comentarioReal = iCom >= 0;
  if (!comentarioReal) { columns.push('Comentario'); iCom = columns.length - 1; }

  const all = values.slice(1).filter(function (r) { return r.some(function (v) { return !fosBlank_(v); }); });
  const acc = {};
  all.forEach(function (r) {
    const name = String(r[iCuenta]).trim() || '(sin cuenta)';
    const k = fosNorm_(name);
    const f = r[iFecha] instanceof Date ? fosFmtDate_(r[iFecha], tz) : '';
    const a = acc[k] || (acc[k] = { nombre: name, n: 0, ultimo: '' });
    a.n++;
    if (f > a.ultimo) a.ultimo = f;
  });
  const extra = hoja.key === 'debito' ? FOS_CFG.MANUAL_BANKS.slice() : [];
  if (hoja.key === 'credito') { try { extra.push.apply(extra, fosCardNames_()); } catch (e) { if (!(e instanceof FosError)) throw e; } }
  extra.forEach(function (n) { const k = fosNorm_(n); if (n && !acc[k]) acc[k] = { nombre: n, n: 0, ultimo: '' }; });
  const cuentas = Object.keys(acc).map(function (k) { return acc[k]; })
    .sort(function (a, b) { return b.ultimo.localeCompare(a.ultimo) || b.n - a.n; });

  let pick = null;
  if (p && p.cuenta) {
    pick = acc[fosNorm_(p.cuenta)];
    if (!pick) throw new FosError('BAD_CUENTA', 'Cuenta no reconocida.');
  } else {
    pick = cuentas.filter(function (c) { return c.n > 0; })[0] || cuentas[0] || null;
  }
  const pk = pick ? fosNorm_(pick.nombre) : null;

  let ingresos = 0, egresos = 0, n = 0;
  const rows = [];
  all.forEach(function (r) {
    if ((fosNorm_(r[iCuenta]) || fosNorm_('(sin cuenta)')) !== pk) return;
    const m = fosNum_(r[iMonto]);
    if (m !== null && !(iCat >= 0 && fosNorm_(r[iCat]) === 'duplicado')) {
      n++;
      if (m > 0) ingresos += m; else egresos += -m;
    }
    const out = r.map(function (v) {
      if (v instanceof Date) return fosFmtDate_(v, tz);
      if (typeof v === 'number' || typeof v === 'boolean') return v;
      return fosBlank_(v) ? null : String(v);
    });
    if (!comentarioReal) out.push(null);
    rows.push(out);
  });
  if (iFecha >= 0) rows.sort(function (a, b) { return String(b[iFecha] || '').localeCompare(String(a[iFecha] || '')); });
  const max = FOS_CFG.HISTORY_MAX || 3000;
  // Crédito: línea de crédito de la tarjeta (hoja Tarjetas). Consumido = línea − saldo disponible (null si no está configurada).
  let limite = null;
  if (hoja.key === 'credito' && pick) {
    try {
      const tt = fosReadTable_(FOS_CFG.SHEETS.TARJETAS, ['Tarjeta', 'Límite']);
      tt.rows.forEach(function (r) { if (fosNorm_(r[tt.idx('Tarjeta')]) === pk) { const l = fosNum_(r[tt.idx('Límite')]); if (l !== null) limite = l; } });
    } catch (e) { if (!(e instanceof FosError)) throw e; }
  }
  return {
    hoja: hoja.key, cuenta: pick ? pick.nombre : null, cuentas: cuentas,
    tarjetas: (function () { try { return fosCardNames_(); } catch (e) { if (e instanceof FosError) return []; throw e; } })(),
    categories: fosAllCategories_(), emojis: fosEmojiMap_(), tipos: fosTipoMap_(),
    columns: columns, rows: rows.slice(0, max), total: rows.length, truncated: rows.length > max,
    totales: { ingresos: fosR2_(ingresos), egresos: fosR2_(egresos), neto: fosR2_(ingresos - egresos), saldo: fosR2_(ingresos - egresos), n: n },
    limite: limite,
  };
}
