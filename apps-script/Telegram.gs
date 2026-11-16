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
    // 1) liquidez real: los mismos 3 números del Inbox
    const sum = fosGetSummary_({});
    let cards = null;
    try { cards = fosComputeCards_(); } catch (e) { if (!(e instanceof FosError)) throw e; }
    const deb = sum.debito.cierre;
    if (cards) {
      const porPagar = fosR2_(cards.reduce(function (s, c) { return s + c.pendientes.reduce(function (a, p) { return a + p.monto; }, 0); }, 0));
      const cuotas = fosR2_(cards.reduce(function (s, c) { return s + c.cuotaMes; }, 0));
      const cred = fosR2_(porPagar + cuotas), liq = fosR2_(deb - cred);
      parts.push((liq < 0 ? '🔴' : '💧') + ' <b>Liquidez real: ' + fosTgMoney_(liq) + '</b>\nRestante débito ' + fosTgMoney_(deb) +
        ' − total crédito ' + fosTgMoney_(cred) + ' (por pagar ' + fosTgMoney_(porPagar) + ' + cuotas del mes ' + fosTgMoney_(cuotas) + ')');
    } else {
      parts.push('💧 <b>Restante débito: ' + fosTgMoney_(deb) + '</b>');
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

    // 3) pendientes del Inbox
    const inb = fosGetInbox_(), cin = fosGetCreditInbox_(), pend = fosGetPendingEstado_();
    const nD = inb.items.length, nC = cin.items.length, nP = pend.items.length, nDup = inb.duplicados.length;
    parts.push(nD + nC + nP + nDup === 0 ? '✅ <b>Inbox al día</b>' : '📥 <b>Por revisar</b>: ' + [
      nD + nC ? (nD + nC) + ' sin categoría (débito ' + nD + ' · crédito ' + nC + ')' : null,
      nP ? nP + ' por procesar' : null,
      nDup ? nDup + ' posible(s) duplicado(s)' : null,
    ].filter(Boolean).join(' · '));

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
  const ours = ['fosNotifyPending', 'fosNotifyCards', 'fosWatch', 'fosNightly'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (ours.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('fosWatch').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('fosNotifyCards').timeBased().everyDays(1).atHour(FOS_TG.MORNING_HOUR).create();
  ScriptApp.newTrigger('fosNightly').timeBased().everyDays(1).atHour(FOS_TG.NIGHT_HOUR).create();
  Logger.log('Triggers instalados: fosWatch (cada hora), fosNotifyCards (~' + FOS_TG.MORNING_HOUR + ' h) y fosNightly (~' + FOS_TG.NIGHT_HOUR +
    ' h). La hora usa la zona del proyecto (Configuración del proyecto > Zona horaria: America/Lima).');
}
