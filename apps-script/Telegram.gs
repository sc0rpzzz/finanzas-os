/**
 * FINANZAS OS · Telegram, alertas y utilidades de configuración
 * El token del bot y el chat_id viven SOLO en Script Properties (nunca en el frontend ni en el repo).
 */

const FosTelegram = {
  esc: function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  isConfigured: function () {
    const p = PropertiesService.getScriptProperties();
    return !!(p.getProperty('TELEGRAM_BOT_TOKEN') && p.getProperty('TELEGRAM_CHAT_ID'));
  },

  /** Envía un mensaje HTML. Nunca lanza excepción: una alerta caída no debe romper la API. */
  send: function (html) {
    const p = PropertiesService.getScriptProperties();
    const token = p.getProperty('TELEGRAM_BOT_TOKEN');
    const chat = p.getProperty('TELEGRAM_CHAT_ID');
    if (!token || !chat) return { ok: false, reason: 'NOT_CONFIGURED' };
    try {
      const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'post',
        contentType: 'application/json',
        muteHttpExceptions: true,
        payload: JSON.stringify({
          chat_id: chat,
          text: String(html).slice(0, 4000),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      const code = res.getResponseCode();
      if (code !== 200) console.error('Telegram HTTP ' + code);
      return { ok: code === 200 };
    } catch (_) {
      console.error('Telegram: fallo de red'); // no se registra el error: podría incluir la URL con el token
      return { ok: false, reason: 'NETWORK' };
    }
  },
};

/* ------------------------------- Alertas -------------------------------- */
/*
 * Solo avisos (el bot no lee mensajes). Tres triggers (instálalos con fosInstallTriggers()):
 *   fosWatch        cada hora   movimientos nuevos de Débito y Crédito, gastos grandes, utilización de la tarjeta, posibles duplicados
 *   fosNotifyCards  8 am        cortes, vencimientos/atrasos, meta de utilización, cuotas por vencer; el día 1, cierre del mes anterior
 *   fosNightly      9 pm        liquidez real, lo de hoy, pendientes del Inbox, recordatorios IO/Interbank/Yape; domingo: semana
 * Débito y Crédito se reportan siempre por separado (nunca se suman).
 */
const FOS_TG = Object.freeze({
  MORNING_HOUR: 8,
  NIGHT_HOUR: 21,
  QUIET_FROM: 23, QUIET_TO: 7,        // fosWatch no avisa en este rango: lo acumula para la mañana
  BIG_AMOUNT: 150,                    // gasto grande (S/): se destaca con 🚨
  WINDOW_DAYS: 10,                    // movimientos recientes que se vigilan (el ETL puede traer fechas de días anteriores)
  MANUAL_CARDS: /(^|\s)io(\s|$)|interbank/, // tarjetas que cargas a mano (nombre normalizado)
  MAX_LINES: 25,
  // Cuadre diario «estilo Duolingo»: fosNudge insiste a estas horas mientras el cuadre del día siga pendiente (escala el tono)
  NUDGE_HOURS: [10, 13, 16, 19, 22],
  RACHA_YAPE: true,                   // sincronizar Yape cuenta para el cuadre del día
  MANUAL_STALE_DAYS: 2,               // días sin registrar nada a mano (efectivo, IO, Interbank) antes de preguntarte
});

function fosTgMoney_(n) {
  const s = Math.abs(Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-' : '') + 'S/ ' + s;
}
function fosTgDay_(ymd, d) { // 'yyyy-MM-dd' ± d días
  const t = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) + d * 86400000;
  const x = new Date(t);
  return x.getUTCFullYear() + '-' + ('0' + (x.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + x.getUTCDate()).slice(-2);
}
function fosTgDow_(ymd) { return new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)))).getUTCDay(); }
function fosTgCat_(cat, emojis) { const c = String(cat || '').trim(); return c ? ((emojis[fosNorm_(c)] ? emojis[fosNorm_(c)] + ' ' : '') + FosTelegram.esc(c)) : '<i>sin categoría</i>'; }
function fosTgLines_(lines) { return lines.length > FOS_TG.MAX_LINES ? lines.slice(0, FOS_TG.MAX_LINES).concat(['…y ' + (lines.length - FOS_TG.MAX_LINES) + ' más']) : lines; }

/** Movimientos de las últimas WINDOW_DAYS en ambas hojas: [{hoja:'debito'|'credito', id, f, cuenta, detalle, monto, cat, tipo}] */
function fosTgRecent_(now, days) {
  const cutoff = now.getTime() - (days || FOS_TG.WINDOW_DAYS) * 86400000;
  const out = [];
  const td = fosReadTable_(FOS_CFG.SHEETS.DEBITO, ['Fecha', 'Banco / Cuenta', 'Detalle/Comercio', 'Categoría', 'Monto', 'ID']);
  td.rows.forEach(function (r) {
    const f = r[td.idx('Fecha')], id = String(r[td.idx('ID')]).trim(), m = fosNum_(r[td.idx('Monto')]);
    if (!(f instanceof Date) || f.getTime() < cutoff || !id || m === null) return;
    out.push({ hoja: 'debito', id: id, f: f, cuenta: String(r[td.idx('Banco / Cuenta')]).trim(), detalle: String(r[td.idx('Detalle/Comercio')]).trim(), monto: m, cat: String(r[td.idx('Categoría')]).trim(), tipo: '' });
  });
  const tc = fosReadTable_(FOS_CFG.SHEETS.CREDITO, ['Fecha', 'ID', 'Tipo', 'Banco / Cuenta', 'Detalle/Comercio', 'Monto']);
  const iCat = tc.opt('Categoría');
  tc.rows.forEach(function (r) {
    const f = r[tc.idx('Fecha')], id = String(r[tc.idx('ID')]).trim(), m = fosNum_(r[tc.idx('Monto')]);
    if (!(f instanceof Date) || f.getTime() < cutoff || !id || m === null) return;
    out.push({ hoja: 'credito', id: id, f: f, cuenta: String(r[tc.idx('Banco / Cuenta')]).trim(), detalle: String(r[tc.idx('Detalle/Comercio')]).trim(), monto: m, cat: iCat >= 0 ? String(r[iCat]).trim() : '', tipo: fosNorm_(r[tc.idx('Tipo')]) });
  });
  return { rows: out, td: td };
}

/**
 * Trigger cada hora: avisa lo NUEVO desde la última vez (lo que trae el ETL: débito BCP, pagos de tarjeta, Falabella, Yape sincronizado).
 * Las filas que cargas tú desde la app (ID MAN_…) no se repiten aquí: salen en el resumen de la noche.
 * Primera ejecución: solo registra lo que ya existe (no inunda el chat).
 */
function fosWatch() {
  const tz = fosTz_(), now = new Date();
  const hour = Number(Utilities.formatDate(now, tz, 'HH'));
  if (hour >= FOS_TG.QUIET_FROM || hour < FOS_TG.QUIET_TO) return; // horas de silencio: se avisa a las 7
  const props = PropertiesService.getScriptProperties();
  const seenRaw = props.getProperty('FOS_SEEN');
  FOS_MEMO_ = {};
  try {
    const rec = fosTgRecent_(now);
    const key = function (x) { return (x.hoja === 'debito' ? 'd:' : 'c:') + x.id; };
    const keys = rec.rows.map(key);
    if (seenRaw === null) {
      props.setProperty('FOS_SEEN', JSON.stringify(keys.slice(-450)));
      props.setProperty('FOS_DUP_SEEN', JSON.stringify(fosFindDuplicates_(rec.td, tz).map(function (p) { return fosDupKey_(p.yape.id, p.banco.id); })));
      FosTelegram.send('🤖 <b>Finanzas OS</b>: avisos activados. Te escribiré cuando entren movimientos nuevos, cada mañana (tarjetas) y cada noche (resumen).');
      return;
    }
    const seen = {};
    JSON.parse(seenRaw).forEach(function (k) { seen[k] = true; });
    const fresh = rec.rows.filter(function (x) { return !seen[key(x)] && !/^MAN_/.test(x.id); })
      .sort(function (a, b) { return a.f.getTime() - b.f.getTime(); });

    const dupSeen = {};
    JSON.parse(props.getProperty('FOS_DUP_SEEN') || '[]').forEach(function (k) { dupSeen[k] = true; });
    const dups = fosFindDuplicates_(rec.td, tz).filter(function (p) { return !dupSeen[fosDupKey_(p.yape.id, p.banco.id)]; });

    const emojis = fosEmojiMap_();
    const parts = [];
    const line = function (x) {
      const big = x.monto < 0 && Math.abs(x.monto) >= FOS_TG.BIG_AMOUNT && fosNorm_(x.cat) !== 'pago tarjeta';
      const cat = x.hoja === 'credito' && x.monto > 0 ? '' : ' · ' + fosTgCat_(x.cat, emojis);
      return (big ? '🚨 ' : '• ') + Utilities.formatDate(x.f, tz, 'dd/MM HH:mm') + ' · ' + FosTelegram.esc(x.cuenta) + ' · ' +
        FosTelegram.esc(x.detalle || '(sin detalle)') + ' · <b>' + fosTgMoney_(x.monto) + '</b>' + cat;
    };
    const deb = fresh.filter(function (x) { return x.hoja === 'debito'; });
    const cred = fresh.filter(function (x) { return x.hoja === 'credito'; });
    if (deb.length) parts.push('<b>Débito</b>\n' + fosTgLines_(deb.map(line)).join('\n'));
    if (cred.length) {
      const block = ['<b>Crédito</b>'].concat(fosTgLines_(cred.map(line)));
      // cómo quedó cada tarjeta tocada
      let cards = [];
      try { cards = fosComputeCards_(); } catch (e) { if (!(e instanceof FosError)) throw e; }
      const touched = {};
      cred.forEach(function (x) { touched[fosNorm_(x.cuenta)] = true; });
      cards.filter(function (c) { return touched[fosNorm_(c.tarjeta)]; }).forEach(function (c) {
        const over = c.utilizacion > c.meta;
        block.push((over ? '⚠️ ' : '💳 ') + FosTelegram.esc(c.tarjeta) + ': utilización ' + (c.utilizacion * 100).toFixed(1) + '% (meta ' + (c.meta * 100).toFixed(0) + '%)' +
          (c.pagarAntesCorte > 0 ? ' · pagar antes del corte ' + fosTgMoney_(c.pagarAntesCorte) + ' (corte ' + (c.diasCorte === 0 ? 'hoy' : 'en ' + c.diasCorte + ' d') + ')' : ''));
      });
      parts.push(block.join('\n'));
    }
    if (dups.length) {
      parts.push('<b>♻️ Posible duplicado Yape ↔ BCP</b>\n' + dups.map(function (p) {
        return '• ' + FosTelegram.esc(p.yape.detalle) + ' ' + fosTgMoney_(p.yape.monto) + ' ↔ ' + FosTelegram.esc(p.banco.detalle) + ' ' + fosTgMoney_(p.banco.monto) + ' (' + p.minutos + ' min)';
      }).join('\n') + '\nRevísalo en el Inbox.');
    }
    if (parts.length) {
      const n = fresh.length;
      const head = n ? '🔔 <b>' + n + ' movimiento' + (n === 1 ? '' : 's') + ' nuevo' + (n === 1 ? '' : 's') + '</b>' : '🔔 <b>Aviso</b>';
      if (!FosTelegram.send(head + '\n\n' + parts.join('\n\n')).ok) return; // si Telegram falla, se reintenta la próxima hora
    }
    props.setProperty('FOS_SEEN', JSON.stringify(keys.slice(-450))); // tope por el límite de 9 KB de cada propiedad
    if (dups.length) props.setProperty('FOS_DUP_SEEN', JSON.stringify(Object.keys(dupSeen).concat(dups.map(function (p) { return fosDupKey_(p.yape.id, p.banco.id); })).slice(-100)));
  } finally {
    FOS_MEMO_ = null;
  }
}

/** Compatibilidad: si aún tienes el trigger viejo, hace lo mismo que fosWatch. Corre fosInstallTriggers() para dejar los nuevos. */
function fosNotifyPending() { fosWatch(); }

/** Trigger 9 pm: resumen del día y recordatorios diarios (IO, Interbank, Yape). Los domingos agrega la semana. */
function fosNightly() {
  const tz = fosTz_(), now = new Date();
  const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  FOS_MEMO_ = {};
  try {
    const parts = [];
    const emojis = fosEmojiMap_();
    // 1) liquidez real: los mismos números del Inbox (los préstamos van aparte y no restan)
    const L = fosLiquidez_();
    if (L.credito !== null) {
      parts.push((L.liquidez < 0 ? '🔴' : '💧') + ' <b>Liquidez real: ' + fosTgMoney_(L.liquidez) + '</b>\n' +
        'Restante débito ' + fosTgMoney_(L.debito) + '\n' +
        'Total crédito ' + fosTgMoney_(L.credito) + ' (por pagar ' + fosTgMoney_(L.porPagar) + ' + cuotas del mes ' + fosTgMoney_(L.cuotas) + ')' +
        (L.prestamos > 0 ? '\nPréstamos ' + fosTgMoney_(L.prestamos) + ' (aparte: no restan)' : ''));
    } else {
      parts.push('💧 <b>Restante débito: ' + fosTgMoney_(L.debito) + '</b>');
    }

    // 2) lo de hoy (Débito y Crédito por separado)
    const rec = fosTgRecent_(now, 15); // 15 días: alcanza para comparar la semana con la anterior
    const isToday = function (x) { return Utilities.formatDate(x.f, tz, 'yyyy-MM-dd') === today; };
    const hoy = rec.rows.filter(isToday);
    const dGastos = hoy.filter(function (x) { const c = fosNorm_(x.cat); return x.hoja === 'debito' && x.monto < 0 && c !== 'pago tarjeta' && c !== 'duplicado'; });
    const dIng = hoy.filter(function (x) { return x.hoja === 'debito' && x.monto > 0; });
    const dPagos = hoy.filter(function (x) { return x.hoja === 'debito' && fosNorm_(x.cat) === 'pago tarjeta'; });
    const cCons = hoy.filter(function (x) { return x.hoja === 'credito' && x.tipo === 'egreso' && x.monto < 0; });
    const tot = function (l) { return fosR2_(l.reduce(function (s, x) { return s + Math.abs(x.monto); }, 0)); };
    const hoyLines = ['🧾 <b>Hoy</b>'];
    if (!dGastos.length && !cCons.length && !dIng.length && !dPagos.length) hoyLines.push('Sin movimientos registrados.');
    if (dGastos.length) hoyLines.push('Débito: gastaste ' + fosTgMoney_(tot(dGastos)) + ' en ' + dGastos.length + ' movimiento(s)');
    if (cCons.length) hoyLines.push('Tarjetas: consumiste ' + fosTgMoney_(tot(cCons)) + ' en ' + cCons.length + ' consumo(s)');
    if (dIng.length) hoyLines.push('Ingresos: ' + fosTgMoney_(tot(dIng)));
    if (dPagos.length) hoyLines.push('Pagos de tarjeta: ' + fosTgMoney_(tot(dPagos)));
    const top = hoy.filter(function (x) { return x.monto < 0 && fosNorm_(x.cat) !== 'pago tarjeta' && fosNorm_(x.cat) !== 'duplicado'; })
      .sort(function (a, b) { return a.monto - b.monto; }).slice(0, 3);
    if (top.length) hoyLines.push('Lo más grande: ' + top.map(function (x) { return FosTelegram.esc(x.detalle) + ' ' + fosTgMoney_(Math.abs(x.monto)); }).join(' · '));
    parts.push(hoyLines.join('\n'));

    // 3) cuadre del día y racha
    const R = fosRachaEval_(now);
    parts.push(R.cuadrado
      ? '✅ <b>Cuadre de hoy hecho</b> · 🔥 racha de ' + R.racha + ' día' + (R.racha === 1 ? '' : 's') + (R.racha >= R.best && R.racha > 1 ? ' (tu récord)' : '')
      : '📥 <b>Cuadre de hoy pendiente</b>' + (R.racha > 0 ? ' · 🔥 racha de ' + R.racha + ' día' + (R.racha === 1 ? '' : 's') + ' en riesgo' : '') + '\n' + fosRachaLines_(R, tz).join('\n'));
    const pend = fosGetPendingEstado_().items.length;
    if (pend) parts.push('⏳ ' + pend + ' movimiento(s) de tarjeta siguen «Pendiente» (márcalos cuando el banco los procese).');

    // 4) recordatorios diarios: Yape y tarjetas que cargas a mano
    const reminders = ['📝 <b>Recordatorios</b>'];
    let lastYape = null;
    const td = fosReadTable_(FOS_CFG.SHEETS.DEBITO, ['Fecha', 'Detalle/Comercio']);
    td.rows.forEach(function (r) {
      const f = r[td.idx('Fecha')];
      if (f instanceof Date && /^\s*\[yape\]/i.test(String(r[td.idx('Detalle/Comercio')])) && (!lastYape || f > lastYape)) lastYape = f;
    });
    reminders.push('📲 Yape: ¿enviaste hoy el reporte desde la app y lo sincronizaste? Último Yape registrado: ' + (lastYape ? Utilities.formatDate(lastYape, tz, 'dd/MM HH:mm') : '—') + '.');
    const tc = fosReadTable_(FOS_CFG.SHEETS.CREDITO, ['Fecha', 'Banco / Cuenta', 'Monto']);
    let limits = {};
    try {
      const tt = fosReadTable_(FOS_CFG.SHEETS.TARJETAS, ['Tarjeta', 'Límite']);
      tt.rows.forEach(function (r) { limits[fosNorm_(r[tt.idx('Tarjeta')])] = fosNum_(r[tt.idx('Límite')]); });
    } catch (e) { if (!(e instanceof FosError)) throw e; limits = {}; }
    let names = [];
    try { names = fosCardNames_(); } catch (e) { if (!(e instanceof FosError)) throw e; }
    names.filter(function (n) { return FOS_TG.MANUAL_CARDS.test(fosNorm_(n)); }).forEach(function (n) {
      const k = fosNorm_(n);
      let saldo = 0, last = null;
      tc.rows.forEach(function (r) {
        if (fosNorm_(r[tc.idx('Banco / Cuenta')]) !== k) return;
        const m = fosNum_(r[tc.idx('Monto')]), f = r[tc.idx('Fecha')];
        if (m !== null) saldo += m;
        if (f instanceof Date && (!last || f > last)) last = f;
      });
      const lim = limits[k];
      reminders.push('✍️ ' + FosTelegram.esc(n) + ': disponible ' + fosTgMoney_(fosR2_(saldo)) + (lim ? ' · consumido ' + fosTgMoney_(fosR2_(lim - saldo)) : '') +
        ' · último movimiento ' + (last ? Utilities.formatDate(last, tz, 'dd/MM') : '—') + '. ¿Cargaste los gastos de hoy y cuadra con la app del banco?');
    });
    parts.push(reminders.join('\n'));

    // 5) domingo: la semana (últimos 7 días vs los 7 anteriores)
    if (fosTgDow_(today) === 0) parts.push(fosTgWeek_(rec.rows, today, tz, emojis));

    FosTelegram.send('🌙 <b>Resumen del ' + Utilities.formatDate(now, tz, 'dd/MM') + '</b>\n\n' + parts.join('\n\n'));
  } finally {
    FOS_MEMO_ = null;
  }
}

/** Semana actual (hoy y 6 días antes) vs la anterior. Débito y Crédito por separado. */
function fosTgWeek_(rows, today, tz, emojis) {
  const from = fosTgDay_(today, -6), prevFrom = fosTgDay_(today, -13), prevTo = fosTgDay_(today, -7);
  const sum = function (hoja, a, b) {
    const cats = {}; let total = 0;
    rows.forEach(function (x) {
      const d = Utilities.formatDate(x.f, tz, 'yyyy-MM-dd'), c = fosNorm_(x.cat);
      if (d < a || d > b || x.monto >= 0 || x.hoja !== hoja || c === 'pago tarjeta' || c === 'duplicado') return;
      if (hoja === 'credito' && x.tipo !== 'egreso') return;
      total += -x.monto;
      const label = x.cat || 'Sin categoría';
      cats[label] = (cats[label] || 0) + (-x.monto);
    });
    return { total: fosR2_(total), cats: cats };
  };
  const delta = function (a, b) { if (!b) return ''; const p = Math.round(((a - b) / b) * 100); return ' (' + (p > 0 ? '+' : '') + p + '% vs semana anterior)'; };
  const out = ['📊 <b>Tu semana</b> (' + from.slice(8, 10) + '/' + from.slice(5, 7) + ' – ' + today.slice(8, 10) + '/' + today.slice(5, 7) + ')'];
  [['debito', 'Débito'], ['credito', 'Tarjetas']].forEach(function (h) {
    const cur = sum(h[0], from, today), prev = sum(h[0], prevFrom, prevTo);
    out.push(h[1] + ': ' + fosTgMoney_(cur.total) + delta(cur.total, prev.total));
    Object.keys(cur.cats).sort(function (a, b) { return cur.cats[b] - cur.cats[a]; }).slice(0, 3).forEach(function (c) {
      out.push('   ' + fosTgCat_(c === 'Sin categoría' ? '' : c, emojis) + ' ' + fosTgMoney_(fosR2_(cur.cats[c])));
    });
  });
  return out.join('\n');
}

/** Día 1: cierre del mes anterior (lo llama fosNotifyCards). */
function fosTgMonthClose_(tz, now) {
  const prev = fosShiftMonth_(Utilities.formatDate(now, tz, 'yyyy-MM'), -1);
  const s = fosGetSummary_({ mes: prev });
  const emojis = fosEmojiMap_();
  const names = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre'];
  const top = function (list) { return list.slice(0, 3).map(function (c) { return fosTgCat_(c.categoria === 'Sin categoría' ? '' : c.categoria, emojis) + ' ' + fosTgMoney_(c.monto); }).join(' · ') || '—'; };
  return '📅 <b>Cierre de ' + names[Number(prev.slice(5, 7)) - 1] + '</b>\n' +
    '<b>Débito</b>: ingresos ' + fosTgMoney_(s.debito.ingresos) + ' · gastos ' + fosTgMoney_(s.debito.gastos) + ' · pagos de tarjeta ' + fosTgMoney_(s.debito.pagosTarjeta) +
    '\nCerraste con <b>' + fosTgMoney_(s.debito.cierre) + '</b>\nMás gasto: ' + top(s.debito.porCategoria) +
    '\n<b>Crédito</b>: consumos ' + fosTgMoney_(s.credito.consumos) + ' · pagos ' + fosTgMoney_(s.credito.pagos) +
    '\nMás consumo: ' + top(s.credito.porCategoria) +
    (s.cuadre.diferencia !== 0 ? '\n⚠️ Los pagos de tarjeta no cuadran entre Débito y Crédito (dif. ' + fosTgMoney_(s.cuadre.diferencia) + ').' : '');
}

/** Para llamar desde tu ETL existente al terminar, p. ej.: fosEtlDone('BCP', 3, 0) */
function fosEtlDone(fuente, nuevos, errores) {
  if (!nuevos && !errores) return;
  FosTelegram.send((errores ? '⚠️' : '✅') + ' <b>ETL ' + FosTelegram.esc(fuente) + '</b>: ' +
    nuevos + ' nuevo(s)' + (errores ? ', ' + errores + ' error(es)' : '') + '.');
}


/* ------------------- Liquidez real (la misma cuenta del Inbox) ------------------- */

/**
 * restante débito (cierre del mes) − total crédito (consumos directos por pagar + cuotas del mes sin pagar).
 * Los préstamos (Tipo «Prestamo» o categoría «Préstamo») se informan aparte y NO restan. credito = null si falta la hoja Tarjetas.
 */
function fosIsLoan_(p) { return p.tipo === 'Préstamo' || /^prestamos?$/.test(fosNorm_(p.categoria)); }

function fosLiquidez_() {
  const deb = fosGetSummary_({}).debito.cierre;
  let cards = null;
  try { cards = fosComputeCards_(); } catch (e) { if (!(e instanceof FosError)) throw e; }
  if (!cards) return { debito: deb, porPagar: null, cuotas: null, credito: null, prestamos: null, liquidez: null };
  let porPagar = 0, prestamos = 0, cuotas = 0;
  cards.forEach(function (c) {
    c.pendientes.forEach(function (p) { if (fosIsLoan_(p)) prestamos += p.monto; else porPagar += p.monto; });
    cuotas += c.cuotaMes;
  });
  const credito = fosR2_(porPagar + cuotas);
  return { debito: deb, porPagar: fosR2_(porPagar), cuotas: fosR2_(cuotas), credito: credito, prestamos: fosR2_(prestamos), liquidez: fosR2_(deb - credito) };
}

/* ------------------- Cuadre diario y racha (estilo Duolingo) ------------------- */
/*
 * El cuadre del día está hecho cuando: el Inbox no tiene nada sin categorizar (Débito y Crédito) ni posibles duplicados,
 * abriste la app hoy y (si FOS_TG.RACHA_YAPE) sincronizaste Yape hoy. Cada día cuadrado suma a la racha.
 * Todo vive en Propiedades del script: FOS_LAST_SEEN, FOS_YAPE_SYNC (ms) y FOS_RACHA ({d:[días yyyy-MM-dd], best}).
 */

/** Marca «usaste la app» (lo llama cada petición con token válido). Escribe como mucho una vez cada 10 min. */
function fosTouchSeen_() {
  try {
    const cache = CacheService.getScriptCache();
    const k = 'fos_seen_' + Utilities.formatDate(new Date(), fosTz_(), 'yyyyMMdd');
    if (cache.get(k)) return;
    cache.put(k, '1', 600);
    PropertiesService.getScriptProperties().setProperty('FOS_LAST_SEEN', String(Date.now()));
  } catch (_) { /* nunca rompe la API */ }
}

function fosPropDate_(props, key, tz) {
  const v = Number(props.getProperty(key));
  return v ? new Date(v) : null;
}

/** Último día (yyyy-MM-dd) con algo registrado a mano: el ID MAN_YYYYMMDD_… dice cuándo lo cargaste. */
function fosLastManual_() {
  let last = '';
  [[FOS_CFG.SHEETS.DEBITO], [FOS_CFG.SHEETS.CREDITO]].forEach(function (x) {
    const t = fosReadTable_(x[0], ['ID']);
    t.rows.forEach(function (r) {
      const m = /^MAN_(\d{4})(\d{2})(\d{2})_/.exec(String(r[t.idx('ID')]).trim());
      if (m) { const d = m[1] + '-' + m[2] + '-' + m[3]; if (d > last) last = d; }
    });
  });
  return last || null;
}

/** Evalúa el cuadre de hoy, actualiza la racha (si hoy quedó cuadrado) y devuelve el estado completo. */
function fosRachaEval_(now) {
  const tz = fosTz_();
  now = now || new Date();
  const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const props = PropertiesService.getScriptProperties();
  const inb = fosGetInbox_(), cin = fosGetCreditInbox_();
  const nD = inb.items.length, nC = cin.items.length, nDup = inb.duplicados.length;
  const seen = fosPropDate_(props, 'FOS_LAST_SEEN'), yape = fosPropDate_(props, 'FOS_YAPE_SYNC');
  const day = function (d) { return d ? Utilities.formatDate(d, tz, 'yyyy-MM-dd') : null; };
  const seenDay = day(seen), yapeDay = day(yape);
  const items = [
    { key: 'inbox', ok: nD + nC === 0, n: nD + nC, debito: nD, credito: nC },
    { key: 'duplicados', ok: nDup === 0, n: nDup },
    { key: 'app', ok: seenDay === today, last: seenDay },
  ];
  if (FOS_TG.RACHA_YAPE) items.push({ key: 'yape', ok: yapeDay === today, last: yapeDay });
  const cuadrado = items.every(function (i) { return i.ok; });

  let st;
  try { st = JSON.parse(props.getProperty('FOS_RACHA') || 'null'); } catch (_) { st = null; }
  if (!st || !Array.isArray(st.d)) st = { d: [], best: 0 };
  const done = {};
  st.d.forEach(function (d) { done[d] = true; });
  let nuevo = false;
  if (cuadrado && !done[today]) { done[today] = true; nuevo = true; }
  const yesterday = fosTgDay_(today, -1);
  let racha = 0;
  for (let d = done[today] ? today : yesterday; done[d]; d = fosTgDay_(d, -1)) racha++;
  const best = Math.max(st.best || 0, racha);
  if (nuevo || best !== st.best) {
    props.setProperty('FOS_RACHA', JSON.stringify({ d: Object.keys(done).sort().slice(-120), best: best }));
  }
  const lastManual = fosLastManual_();
  return {
    hoy: today, cuadrado: cuadrado, hechoHoy: !!done[today], racha: racha, best: best, enRiesgo: !done[today] && racha > 0,
    ayer: !!done[yesterday], items: items,
    diasSinApp: seenDay ? fosDays_(seenDay, today) : null,
    ultimoManual: lastManual, diasSinManual: lastManual ? fosDays_(lastManual, today) : null,
  };
}

/** API: estado del cuadre y la racha para la app. */
function fosGetRacha_() {
  const r = fosRachaEval_();
  return { racha: r.racha, best: r.best, cuadrado: r.cuadrado, hechoHoy: r.hechoHoy, enRiesgo: r.enRiesgo, items: r.items,
    diasSinManual: r.diasSinManual, ultimoManual: r.ultimoManual };
}

/** Líneas de checklist (☐ / ✅) para Telegram. */
function fosRachaLines_(R, tz) {
  const fd = function (d) { return d ? d.slice(8, 10) + '/' + d.slice(5, 7) : '—'; };
  return R.items.map(function (i) {
    if (i.key === 'inbox') return i.ok ? '✅ Inbox categorizado' : '☐ Categorizar <b>' + i.n + '</b> movimiento' + (i.n === 1 ? '' : 's') + ' (débito ' + i.debito + ' · crédito ' + i.credito + ')';
    if (i.key === 'duplicados') return i.ok ? '✅ Sin duplicados por revisar' : '☐ Revisar <b>' + i.n + '</b> posible' + (i.n === 1 ? '' : 's') + ' duplicado' + (i.n === 1 ? '' : 's') + ' Yape ↔ BCP';
    if (i.key === 'app') return i.ok ? '✅ Entraste a Finanzas OS' : '☐ Abrir Finanzas OS' + (i.last ? ' (última vez ' + fd(i.last) + ')' : '');
    if (i.key === 'yape') return i.ok ? '✅ Yape sincronizado' : '☐ Enviar el reporte de Yape y sincronizarlo' + (i.last ? ' (último ' + fd(i.last) + ')' : '');
    return '';
  }).filter(Boolean);
}

// Frases por nivel de insistencia (0 = mañana … 4 = última llamada). Se rotan por día para no repetir siempre lo mismo.
const FOS_NUDGE_TEXT = [
  ['☀️ <b>Buen día.</b> Tu cuadre de hoy toma 2 minutos. Hazlo ahora y te olvidas.', '☀️ <b>Arrancamos.</b> Un vistazo al Inbox y el día queda en orden.', '☀️ <b>Hola.</b> Tus finanzas te esperan: hoy toca cuadrar.'],
  ['🦉 <b>Pssst…</b> las finanzas no se cuadran solas.', '🦉 <b>Recordatorio de mediodía:</b> el cuadre sigue pendiente.', '🦉 <b>¿Almorzando?</b> Aprovecha y cuadra en un minuto.'],
  ['⏰ <b>Ya pasó medio día</b> y tu cuadre sigue sin hacerse.', '⏰ <b>Sigo esperando.</b> Tu cuadre de hoy aún está pendiente.', '⏰ <b>Te lo vuelvo a decir:</b> el cuadre de hoy no está hecho.'],
  ['😬 <b>Esto ya es serio.</b> Se acaba el día y no has cuadrado.', '😬 <b>No me hagas insistir más…</b> tu cuadre sigue pendiente.', '😬 <b>Último aviso amable:</b> cuadra antes de dormir.'],
  ['🚨 <b>Última llamada.</b>', '🚨 <b>Ahora o nunca.</b>', '🚨 <b>Se acaba el día.</b>'],
];

/**
 * Trigger cada hora: a las horas de FOS_TG.NUDGE_HOURS, si el cuadre de hoy sigue pendiente, insiste (cada vez más fuerte).
 * Si ya cuadraste, te felicita una sola vez al día. Nunca escribe en horas de silencio.
 */
function fosNudge() {
  const tz = fosTz_(), now = new Date();
  const hour = Number(Utilities.formatDate(now, tz, 'HH'));
  const level = FOS_TG.NUDGE_HOURS.indexOf(hour);
  if (level < 0 || hour >= FOS_TG.QUIET_FROM || hour < FOS_TG.QUIET_TO) return;
  const props = PropertiesService.getScriptProperties();
  const slot = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH');
  if (props.getProperty('FOS_NUDGE_LAST') === slot) return; // ya se envió en esta hora
  FOS_MEMO_ = {};
  try {
    const R = fosRachaEval_(now);
    if (R.cuadrado || R.hechoHoy) {
      if (props.getProperty('FOS_NUDGE_OK') === R.hoy) { props.setProperty('FOS_NUDGE_LAST', slot); return; }
      const msg = '🔥 <b>¡Racha de ' + R.racha + ' día' + (R.racha === 1 ? '' : 's') + '!</b>\n\n' +
        'Hoy ya cuadraste tus finanzas. ' + (R.racha >= R.best && R.racha > 1 ? 'Es tu récord: sigue así. 🏆' : R.best > R.racha ? 'Tu récord es ' + R.best + '. Vas por él.' : 'Mañana, otra vez.') +
        (R.cuadrado ? '' : '\n\nOjo: entró algo nuevo después del cuadre:\n' + fosRachaLines_(R, tz).filter(function (l) { return l.indexOf('☐') === 0; }).join('\n'));
      if (FosTelegram.send(msg).ok) { props.setProperty('FOS_NUDGE_OK', R.hoy); props.setProperty('FOS_NUDGE_LAST', slot); }
      return;
    }
    const n = Number(R.hoy.replace(/-/g, '')) % 3;
    const lvl = Math.min(level, FOS_NUDGE_TEXT.length - 1);
    const isLast = level === FOS_TG.NUDGE_HOURS.length - 1;
    const head = [FOS_NUDGE_TEXT[lvl][n]];
    if (isLast) head.push(R.racha > 0 ? 'A medianoche tu racha de <b>' + R.racha + ' día' + (R.racha === 1 ? '' : 's') + '</b> vuelve a 0. 💔' : 'Hoy puedes empezar tu racha. Mañana me lo agradeces.');
    else if (R.enRiesgo) head.push('🔥 Tu racha de <b>' + R.racha + ' día' + (R.racha === 1 ? '' : 's') + '</b> está en riesgo.');
    else if (level === 0 && !R.ayer) head.push('Ayer no cuadraste. Hoy empiezas de nuevo: día 1. 💪');
    const parts = [head.join('\n'), '<b>Te falta</b>\n' + fosRachaLines_(R, tz).join('\n')];
    const extra = [];
    if (R.diasSinApp !== null && R.diasSinApp >= 2) extra.push('👀 Llevas <b>' + R.diasSinApp + ' días</b> sin abrir Finanzas OS. ¿Todo bien?');
    if (R.diasSinManual !== null && R.diasSinManual >= FOS_TG.MANUAL_STALE_DAYS) {
      extra.push('✍️ Hace <b>' + R.diasSinManual + ' días</b> que no registras nada a mano (efectivo, IO, Interbank). ¿De verdad no gastaste?');
    }
    if (extra.length) parts.push(extra.join('\n'));
    if (FosTelegram.send(parts.join('\n\n')).ok) props.setProperty('FOS_NUDGE_LAST', slot);
  } finally {
    FOS_MEMO_ = null;
  }
}

/* ---------------------- Configuración (ejecutar a mano) ------------------ */

/** 1) Ejecuta esta función una vez: genera el API_TOKEN y lo muestra en el Registro de ejecución. */
function fosSetup() {
  const p = PropertiesService.getScriptProperties();
  let token = p.getProperty('API_TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    p.setProperty('API_TOKEN', token);
    Logger.log('API_TOKEN generado (cópialo ahora, pégalo en la PWA y no lo compartas):\n' + token);
  } else {
    Logger.log('API_TOKEN ya existe (no se vuelve a mostrar). Usa fosRotateToken() para regenerarlo.');
  }
  Logger.log('Telegram: ' + (FosTelegram.isConfigured()
    ? 'configurado.'
    : 'FALTA agregar TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID en Propiedades de la secuencia de comandos.'));
}

function fosRotateToken() {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('API_TOKEN', token);
  Logger.log('Nuevo API_TOKEN (las sesiones de la PWA quedarán invalidadas):\n' + token);
}

/** 2) Verifica la conexión con Telegram. */
function fosTestTelegram() {
  const r = FosTelegram.send('✅ <b>Finanzas OS</b> conectado a Telegram.');
  Logger.log(JSON.stringify(r));
}

/** 3) Instala los triggers de alertas (idempotente; no toca tus triggers del ETL). */
function fosInstallTriggers() {
  const ours = ['fosNotifyPending', 'fosNotifyCards', 'fosWatch', 'fosNightly', 'fosNudge'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (ours.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('fosWatch').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('fosNotifyCards').timeBased().everyDays(1).atHour(FOS_TG.MORNING_HOUR).create();
  ScriptApp.newTrigger('fosNightly').timeBased().everyDays(1).atHour(FOS_TG.NIGHT_HOUR).create();
  ScriptApp.newTrigger('fosNudge').timeBased().everyHours(1).create();
  Logger.log('Triggers instalados: fosWatch y fosNudge (cada hora; fosNudge solo escribe a las ' + FOS_TG.NUDGE_HOURS.join(', ') + ' h), fosNotifyCards (~' + FOS_TG.MORNING_HOUR + ' h) y fosNightly (~' + FOS_TG.NIGHT_HOUR +
    ' h). La hora usa la zona del proyecto (Configuración del proyecto > Zona horaria: America/Lima).');
}
