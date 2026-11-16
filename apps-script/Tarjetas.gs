/**
 * FINANZAS OS · Tarjetas de crédito: ciclo, utilización y meta.
 * Meta del usuario: al corte, solo la CUOTA DEL MES pendiente; el resto de consumos en 0
 * (y en todo caso <= Meta % del límite, 10% por defecto).
 *
 * Qué cuenta (hoja Crédito, por tarjeta):
 *  - Consumo directo sin pagar: Tipo=Egreso, Monto<0, Modalidad distinta de cuotas, Pagado != TRUE.
 *  - Préstamo por cobrar: Tipo=Préstamo, Pagado != TRUE (es consumo de la tarjeta, pero no gasto propio).
 *  - Cuota del mes: cuotas activas del mes calendario actual que NO están marcadas como pagadas (hoja Pagos Cuotas).
 *  - Utilización al corte = (cuota del mes + directos + préstamos) / límite.
 * Un consumo con fecha <= último corte pertenece a un estado de cuenta ya cerrado (tiene fecha de pago).
 */

function fosDim_(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); } // m: 1-12
function fosMk_(y, m, d) {
  const n = m - 1;
  const Y = y + Math.floor(n / 12);
  const M = (((n % 12) + 12) % 12) + 1;
  return { y: Y, m: M, d: Math.min(d, fosDim_(Y, M)) };
}
function fosIso_(o) { return o.y + '-' + ('0' + o.m).slice(-2) + '-' + ('0' + o.d).slice(-2); }
function fosDays_(a, b) {
  const ms = function (s) { return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))); };
  return Math.round((ms(b) - ms(a)) / 86400000);
}
function fosR2_(n) { return Math.round(n * 100) / 100; }

/** Último y próximo corte respecto a hoy (si hoy es día de corte, ese es el "próximo"). */
function fosCardCycle_(today, corteDay) {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const thisCorte = fosMk_(y, m, corteDay);
  const upcoming = fosIso_(thisCorte) >= today;
  return {
    next: upcoming ? thisCorte : fosMk_(y, m + 1, corteDay),
    last: upcoming ? fosMk_(y, m - 1, corteDay) : thisCorte,
  };
}

/** Corte del estado de cuenta al que pertenece un consumo. */
function fosStatementCorte_(date10, corteDay) {
  const y = Number(date10.slice(0, 4)), m = Number(date10.slice(5, 7));
  const c = fosMk_(y, m, corteDay);
  return fosIso_(c) >= date10 ? c : fosMk_(y, m + 1, corteDay);
}

function fosIsPaid_(v) {
  return v === true || v === 1 || ['true', '1', 'si', 'verdadero', 'x'].indexOf(fosNorm_(v)) >= 0;
}

/** Tarjetas válidas: las de la hoja Tarjetas; si no existe, las que aparecen en Crédito. */
function fosCardNames_() {
  try {
    const t = fosReadTable_(FOS_CFG.SHEETS.TARJETAS, ['Tarjeta']);
    const out = t.rows.map(function (r) { return String(r[t.idx('Tarjeta')]).trim(); }).filter(Boolean);
    if (out.length) return out;
  } catch (e) { if (!(e instanceof FosError)) throw e; }
  const c = fosReadTable_(FOS_CFG.SHEETS.CREDITO, ['Banco / Cuenta']);
  const seen = {};
  return c.rows.map(function (r) { return String(r[c.idx('Banco / Cuenta')]).trim(); })
    .filter(function (n) { const k = fosNorm_(n); if (!n || seen[k]) return false; seen[k] = true; return true; });
}

function fosGetCards_() {
  return { cards: fosComputeCards_() };
}

function fosComputeCards_() {
  const tz = fosTz_();
  const today = fosFmtDate_(new Date(), tz).slice(0, 10);
  let tc;
  try {
    tc = fosReadTable_(FOS_CFG.SHEETS.TARJETAS, ['Tarjeta', 'Límite', 'Día de corte', 'Día de pago']);
  } catch (e) {
    if (e instanceof FosError && e.code === 'SHEET_NOT_FOUND') {
      throw new FosError('NO_TARJETAS', 'Falta la hoja Tarjetas: ejecuta fosSetupTarjetas().');
    }
    throw e;
  }
  const cr = fosReadTable_(FOS_CFG.SHEETS.CREDITO,
    ['Fecha', 'Tipo', 'Banco / Cuenta', 'Detalle/Comercio', 'Monto', 'Pagado', 'Modalidad']);
  const crId = cr.opt('ID');
  const crCat = cr.opt('Categoría');
  const cuotas = fosCuotaItems_();
  const curKey = fosMonthKey_(cuotas.nowIdx);
  const metaI = tc.opt('Meta %');
  const out = [];

  tc.rows.forEach(function (r) {
    const name = String(r[tc.idx('Tarjeta')]).trim();
    if (!name) return;
    const limite = fosNum_(r[tc.idx('Límite')]);
    const corteDay = fosNum_(r[tc.idx('Día de corte')]);
    const pagoDay = fosNum_(r[tc.idx('Día de pago')]);
    if (!limite || !corteDay || !pagoDay) throw new FosError('SCHEMA', 'Tarjetas: datos incompletos en "' + name + '".');
    let meta = metaI >= 0 ? fosNum_(r[metaI]) : null;
    if (meta === null) meta = 0.1;
    if (meta > 1) meta = meta / 100;

    const cyc = fosCardCycle_(today, corteDay);
    const lastIso = fosIso_(cyc.last);
    const pendientes = [];
    let cerrado = 0, abierto = 0, prestamos = 0, vence = null;

    cr.rows.forEach(function (x) {
      if (fosNorm_(x[cr.idx('Banco / Cuenta')]) !== fosNorm_(name)) return;
      const monto = fosNum_(x[cr.idx('Monto')]);
      const f = x[cr.idx('Fecha')];
      if (monto === null || monto >= 0 || !(f instanceof Date) || fosIsPaid_(x[cr.idx('Pagado')])) return;
      if (fosNorm_(x[cr.idx('Modalidad')]).indexOf('cuota') >= 0) return; // lo cubre la cuota del mes
      const tipo = fosNorm_(x[cr.idx('Tipo')]);
      const date10 = fosFmtDate_(f, tz).slice(0, 10);
      const amount = Math.abs(monto);
      const isClosed = date10 <= lastIso;
      let pago = null;
      if (tipo === 'prestamo') {
        prestamos += amount;
      } else if (tipo === 'egreso') {
        if (isClosed) {
          cerrado += amount;
          pago = fosIso_(fosMk_(fosStatementCorte_(date10, corteDay).y, fosStatementCorte_(date10, corteDay).m + 1, pagoDay));
          if (vence === null || pago < vence) vence = pago;
        } else {
          abierto += amount;
        }
      } else {
        return;
      }
      pendientes.push({ id: crId >= 0 ? String(x[crId]).trim() : '', fecha: date10, detalle: String(x[cr.idx('Detalle/Comercio')]), monto: fosR2_(amount),
        tipo: tipo === 'prestamo' ? 'Préstamo' : (isClosed ? 'Estado cerrado' : 'Ciclo actual'), vence: pago,
        categoria: crCat >= 0 ? String(x[crCat]).trim() : '' });
    });
    pendientes.sort(function (a, b) { return a.fecha.localeCompare(b.fecha); });

    const nameN = fosNorm_(name);
    let cuotaMes = 0, cuotaPagada = 0;
    cuotas.items.forEach(function (it) {
      if (fosNorm_(it.tarjeta) !== nameN || cuotas.nowIdx < it.start || cuotas.nowIdx >= it.start + it.n) return;
      if (it.id && cuotas.paid[it.id + '|' + curKey]) cuotaPagada += Math.abs(it.cuota); // ya pagada: no cuenta
      else cuotaMes += Math.abs(it.cuota);
    });

    const directos = cerrado + abierto;
    const total = cuotaMes + directos + prestamos;
    const metaMonto = limite * meta;
    // próximo día de pago (para avisar las cuotas del mes)
    const ty = Number(today.slice(0, 4)), tm = Number(today.slice(5, 7));
    let pagoProx = fosIso_(fosMk_(ty, tm, pagoDay));
    if (pagoProx < today) pagoProx = fosIso_(fosMk_(ty, tm + 1, pagoDay));
    out.push({
      tarjeta: name,
      limite: limite,
      meta: meta,
      metaMonto: fosR2_(metaMonto),
      corteProx: fosIso_(cyc.next),
      diasCorte: fosDays_(today, fosIso_(cyc.next)),
      cuotaMes: fosR2_(cuotaMes),
      cuotaMesPagada: fosR2_(cuotaPagada),
      prestamos: fosR2_(prestamos),
      cerrado: { monto: fosR2_(cerrado), vence: vence, diasVence: vence ? fosDays_(today, vence) : null },
      abierto: fosR2_(abierto),
      pagarAntesCorte: fosR2_(directos),                              // objetivo: dejar los consumos directos en 0
      pagarParaMeta: fosR2_(Math.min(directos, Math.max(0, total - metaMonto))), // mínimo para quedar <= meta
      utilizacion: total / limite,
      utilizacionTrasPagar: (cuotaMes + prestamos) / limite,
      pendientes: pendientes,
      pagoProx: pagoProx, diasPago: fosDays_(today, pagoProx),
    });
  });
  return out;
}

/**
 * Trigger diario (8 am): por tarjeta, pagos vencidos o por vencer, cortes próximos, utilización sobre la meta y cuotas del mes
 * por pagar cerca del día de pago. El día 1 agrega el cierre del mes anterior.
 */
function fosNotifyCards() {
  const tz = fosTz_(), now = new Date();
  const parts = [];
  const when = function (n) { return n < 0 ? 'ATRASADO ' + (-n) + ' d' : n === 0 ? 'HOY' : n === 1 ? 'mañana' : 'en ' + n + ' días'; };
  const lines = [];
  let cards = [];
  try { cards = fosComputeCards_(); } catch (e) { if (!(e instanceof FosError)) throw e; }
  cards.forEach(function (c) {
    const name = FosTelegram.esc(c.tarjeta);
    if (c.cerrado.monto > 0 && c.cerrado.diasVence !== null && c.cerrado.diasVence <= 3) {
      lines.push((c.cerrado.diasVence < 0 ? '🔴' : '💳') + ' <b>' + name + '</b>: pagar ' + fosTgMoney_(c.cerrado.monto) + ' del estado cerrado · vence ' + when(c.cerrado.diasVence) + ' (' + c.cerrado.vence + ')' +
        (c.cerrado.diasVence < 0 ? '. No veo el pago registrado.' : ''));
    }
    if (c.diasCorte >= 0 && c.diasCorte <= 3 && c.pagarAntesCorte > 0) {
      lines.push('✂️ <b>' + name + '</b>: corte ' + when(c.diasCorte) + '. Paga ' + fosTgMoney_(c.pagarAntesCorte) + ' para dejar los consumos en 0 (utilización ' + (c.utilizacion * 100).toFixed(1) + '%)');
    }
    if (c.cuotaMes > 0 && c.diasPago >= 0 && c.diasPago <= 3) {
      lines.push('📆 <b>' + name + '</b>: cuotas del mes por pagar ' + fosTgMoney_(c.cuotaMes) + ' · día de pago ' + when(c.diasPago) + ' (' + c.pagoProx + ')');
    }
    if (c.utilizacion > c.meta) {
      lines.push('⚠️ <b>' + name + '</b>: utilización ' + (c.utilizacion * 100).toFixed(1) + '%, sobre tu meta de ' + (c.meta * 100).toFixed(0) + '%' +
        (c.pagarParaMeta > 0 ? '. Pagando ' + fosTgMoney_(c.pagarParaMeta) + ' vuelves a la meta.' : '.'));
    }
  });
  if (lines.length) parts.push('<b>Tarjetas</b>\n' + lines.join('\n'));
  if (Utilities.formatDate(now, tz, 'dd') === '01') parts.push(fosTgMonthClose_(tz, now)); // día 1: cierre del mes anterior
  if (parts.length) FosTelegram.send('☀️ ' + parts.join('\n\n'));
}

/** Ejecutar UNA vez: crea la hoja Tarjetas con tus datos (si ya existe, no la toca). */
function fosSetupTarjetas() {
  const ss = fosSpreadsheet_();
  if (ss.getSheetByName(FOS_CFG.SHEETS.TARJETAS)) { Logger.log('La hoja Tarjetas ya existe; no se modificó.'); return; }
  const sh = ss.insertSheet(FOS_CFG.SHEETS.TARJETAS);
  sh.getRange(1, 1, 5, 5).setValues([
    ['Tarjeta', 'Límite', 'Día de corte', 'Día de pago', 'Meta %'],
    ['Falabella Platinum', 4500, 9, 5, 0.1],
    ['IO', 1200, 25, 12, 0.1],
    ['Interbank American Express', 800, 26, 20, 0.1],
    ['BCP Light', 1440, 25, 22, 0.1],
  ]);
  sh.getRange(2, 5, 4, 1).setNumberFormat('0%');
  Logger.log('Hoja Tarjetas creada. "Día de pago" = día del mes SIGUIENTE al corte. Verifica BCP Light (corte 25 / pago 22 supuestos).');
}
