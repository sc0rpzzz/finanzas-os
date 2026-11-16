/**
 * FINANZAS OS · Resumen mensual. Débito y Crédito se calculan POR SEPARADO (dos visiones
 * independientes, nunca se suman). Lo único que las cruza es un chequeo de cuadre: los pagos
 * de tarjeta que salen de Débito deben ser iguales a los abonos que entran en Crédito.
 *
 * Débito (liquidez):   ingresos (monto > 0), gastos (monto < 0), pagos de tarjeta (categoría
 *                      "Pago Tarjeta", aparte). La categoría "Restante" cuenta como ingreso del mes.
 *                      cierre = sobró + ingresos - gastos - pagos, y el cierre pasa al mes siguiente.
 * Crédito (deuda):     consumos (Egreso, monto < 0), pagos recibidos (Ingreso cuyo detalle empieza
 *                      con "Pago"), préstamos aparte (por cobrar) y cuotas del mes.
 */

function fosShiftMonth_(ym, d) {
  const n = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + d;
  return Math.floor(n / 12) + '-' + ('0' + ((n % 12) + 1)).slice(-2);
}

function fosGetSummary_(p) {
  const tz = fosTz_();
  const nowKey = fosFmtDate_(new Date(), tz).slice(0, 7);
  const mes = p && p.mes ? String(p.mes) : nowKey;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes) || mes > nowKey) throw new FosError('BAD_MONTH', 'Mes inválido.');
  const prev = fosShiftMonth_(mes, -1);
  const debito = fosSummaryDebito_(mes, prev, tz);
  const credito = fosSummaryCredito_(mes, prev, tz, mes === nowKey);
  return {
    mes: mes,
    emojis: fosEmojiMap_(),
    prevMes: prev,
    nextMes: mes < nowKey ? fosShiftMonth_(mes, 1) : null,
    esActual: mes === nowKey,
    debito: debito,
    credito: credito,
    cuadre: { // partida doble: lo que salió de Débito como pago de tarjeta = lo que entró a Crédito como pago
      debito: debito.pagosTarjeta,
      credito: credito.pagos,
      diferencia: fosR2_(debito.pagosTarjeta - credito.pagos),
    },
  };
}

function fosRank_(map) {
  return Object.keys(map)
    .map(function (k) { return { categoria: k, monto: fosR2_(map[k]) }; })
    .sort(function (a, b) { return b.monto - a.monto; });
}

function fosSummaryDebito_(mes, prev, tz) {
  const t = fosReadTable_(FOS_CFG.SHEETS.DEBITO, ['Fecha', 'Detalle/Comercio', 'Categoría', 'Monto']);
  const M = {}; // agregados por mes ('yyyy-MM') de TODA la hoja, para poder arrastrar el cierre de un mes al siguiente
  const get = function (ym) { return M[ym] || (M[ym] = { ingresos: 0, gastos: 0, pagos: 0, n: 0, cats: {} }); };

  t.rows.forEach(function (r) {
    const f = r[t.idx('Fecha')];
    const monto = fosNum_(r[t.idx('Monto')]);
    if (!(f instanceof Date) || monto === null) return;
    const cat = String(r[t.idx('Categoría')]).trim();
    const catN = fosNorm_(cat);
    const a = get(fosFmtDate_(f, tz).slice(0, 7));
    if (catN === 'duplicado') return; // posible duplicado Yape/BCP marcado por el usuario: no cuenta
    a.n++;
    if (catN === 'pago tarjeta') { a.pagos += Math.abs(monto); return; }
    if (catN === 'restante') { a.ingresos += monto; return; } // la categoría "Restante" se analiza como INGRESO del mes
    if (monto > 0) {
      a.ingresos += monto;
    } else if (monto < 0) {
      a.gastos += -monto;
      const label = cat || 'Sin categoría';
      a.cats[label] = (a.cats[label] || 0) + (-monto);
    }
  });

  // Arrastre: cierre(m) = sobró(m) + ingresos - gastos - pagos; sobró(m+1) = cierre(m). El primer mes con datos no tiene sobrante.
  const keys = Object.keys(M).sort();
  const cierre = {};
  if (keys.length) {
    let ym = keys[0], run = null;
    const last = keys[keys.length - 1] > mes ? keys[keys.length - 1] : mes;
    while (ym <= last) {
      const a = M[ym] || { ingresos: 0, gastos: 0, pagos: 0 };
      cierre[ym] = { sobro: run, cierre: fosR2_((run || 0) + a.ingresos - a.gastos - a.pagos) };
      run = cierre[ym].cierre;
      ym = fosShiftMonth_(ym, 1);
    }
  }
  const c = M[mes] || get(mes), q = M[prev] || get(prev);
  const cm = cierre[mes] || { sobro: null, cierre: fosR2_(c.ingresos - c.gastos - c.pagos) };
  return {
    sobrante: cm.sobro,                     // null = "sin data" (no hay mes anterior)
    ingresos: fosR2_(c.ingresos),           // incluye las filas de categoría "Restante"
    gastos: fosR2_(c.gastos),
    pagosTarjeta: fosR2_(c.pagos),
    flujo: cm.cierre,                       // debería quedar = sobró + ingresos - gastos - pagos
    cierre: cm.cierre,                      // pasa como "sobró" al mes siguiente
    movimientos: c.n,
    prev: { ingresos: fosR2_(q.ingresos), gastos: fosR2_(q.gastos), pagosTarjeta: fosR2_(q.pagos) },
    porCategoria: fosRank_(c.cats),
  };
}

function fosSummaryCredito_(mes, prev, tz, esActual) {
  const t = fosReadTable_(FOS_CFG.SHEETS.CREDITO, ['Fecha', 'Tipo', 'Banco / Cuenta', 'Detalle/Comercio', 'Monto']);
  const iCat = t.opt('Categoría'), iMod = t.opt('Modalidad');
  const mk = function () { return { consumos: 0, directos: 0, cuotas: 0, pagos: 0, prestamos: 0, n: 0, cats: {}, cards: {} }; };
  const A = {};
  A[mes] = mk(); A[prev] = mk();
  const card = function (a, name) { return a.cards[name] || (a.cards[name] = { consumos: 0, pagos: 0 }); };

  t.rows.forEach(function (r) {
    const f = r[t.idx('Fecha')];
    const monto = fosNum_(r[t.idx('Monto')]);
    if (!(f instanceof Date) || monto === null) return;
    const a = A[fosFmtDate_(f, tz).slice(0, 7)];
    if (!a) return;
    const tipo = fosNorm_(r[t.idx('Tipo')]);
    const tarjeta = String(r[t.idx('Banco / Cuenta')]).trim() || '(sin tarjeta)';
    if (tipo === 'egreso' && monto < 0) {
      a.n++;
      a.consumos += -monto;
      if (iMod >= 0 && fosNorm_(r[iMod]).indexOf('cuota') >= 0) a.cuotas += -monto; else a.directos += -monto;
      const label = (iCat >= 0 && String(r[iCat]).trim()) || 'Sin categoría';
      a.cats[label] = (a.cats[label] || 0) + (-monto);
      card(a, tarjeta).consumos += -monto;
    } else if (tipo === 'ingreso' && monto > 0 && fosNorm_(r[t.idx('Detalle/Comercio')]).indexOf('pago') === 0) {
      a.n++;
      a.pagos += monto;
      card(a, tarjeta).pagos += monto;
    } else if (tipo === 'prestamo' && monto < 0) {
      a.prestamos += -monto;
    }
  });

  let cuotasMes = null; // el calendario solo conoce las cuotas vigentes: se muestra para el mes actual
  if (esActual) {
    const c = fosCuotaItems_();
    cuotasMes = fosR2_(c.items.reduce(function (s, it) { return s + (c.nowIdx >= it.start && c.nowIdx < it.start + it.n ? Math.abs(it.cuota) : 0); }, 0));
  }
  const c = A[mes], q = A[prev];
  return {
    consumos: fosR2_(c.consumos),
    directos: fosR2_(c.directos),
    enCuotas: fosR2_(c.cuotas),
    pagos: fosR2_(c.pagos),
    prestamos: fosR2_(c.prestamos),
    cuotasMes: cuotasMes,
    movimientos: c.n,
    prev: { consumos: fosR2_(q.consumos), pagos: fosR2_(q.pagos), prestamos: fosR2_(q.prestamos) },
    porCategoria: fosRank_(c.cats),
    porTarjeta: Object.keys(c.cards)
      .map(function (k) { return { tarjeta: k, consumos: fosR2_(c.cards[k].consumos), pagos: fosR2_(c.cards[k].pagos) }; })
      .sort(function (a, b) { return b.consumos - a.consumos; }),
  };
}
