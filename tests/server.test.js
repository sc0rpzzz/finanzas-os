/* FINANZAS OS · Pruebas del servidor sobre el mock de Apps Script (tests/gas-mock.js).
 * Cada prueba recibe un entorno nuevo con los datos de `fixture()`. Se ejecutan desde tests/run.html (navegador)
 * y, si existe una copia del código anterior, también se compara su comportamiento («diferencial»). */
(function (root) {
  'use strict';
  const { L } = root.GasMock;

  const FILES = ['Api.gs', 'Sheets.gs', 'Movimientos.gs', 'Historial.gs', 'Resumen.gs', 'Categorias.gs', 'Tarjetas.gs', 'Telegram.gs'];

  // "hoy" en Lima, para que los datos caigan siempre en el mes actual y en la ventana de 45 días de duplicados
  function today() { const p = root.GasMock.formatDate(new Date(), '', 'yyyy-MM-dd').split('-').map(Number); return { y: p[0], m: p[1], d: p[2] }; }
  function daysAgo(n, hh, mi) { const t = today(); const base = L(t.y, t.m, t.d, hh, mi); return new Date(base.getTime() - n * 86400000); }
  const plusMin = (d, m) => new Date(d.getTime() + m * 60000);

  const DEB_HEAD = ['Fecha', 'Tipo', 'Banco / Cuenta', 'Detalle/Comercio', 'Categoría', 'Monto', 'ID', 'Descripción'];
  const CRE_HEAD = ['Fecha', 'ID', 'Tipo', 'Estado', 'Banco / Cuenta', 'Detalle/Comercio', 'Monto', 'Pagado', 'Modalidad', 'N° Cuotas', 'Monto Cuota', 'Categoría'];

  function fixture() {
    const t1 = daysAgo(2, 10, 0), t2 = daysAgo(1, 9, 0);
    return {
      Debito: [DEB_HEAD,
        [daysAgo(3, 10, 0), 'Egreso', 'BCP', 'Wong', 'Supermercado', -50, 'BCP_DEB_1', ''],
        [daysAgo(3, 8, 0), 'Ingreso', 'BCP', 'Sueldo', 'Sueldo', 3000, 'BCP_ING_1', ''],
        [daysAgo(2, 18, 0), 'Egreso', 'BCP', 'Pago a: IO', 'Pago Tarjeta', -200, 'BCP_PAG_1', ''],
        [daysAgo(4, 12, 0), 'Egreso', 'BCP', '[YAPE] Juan*', 'Duplicado', -30, 'YAPE_A1', 'almuerzo'],
        [t1, 'Egreso', 'BCP', '[YAPE] Maria*', '', -20, 'YAPE_B1', 'plin maria'],
        [plusMin(t1, 90), 'Egreso', 'BCP', 'Consumo Debito PLIN MARIA', '', -20, 'BCP_DEB_2', ''],
        [t2, 'Egreso', 'BCP', '[YAPE] Pedro*', '', -15, 'YAPE_C1', ''],
        [plusMin(t2, 130), 'Egreso', 'BCP', 'Consumo Debito OTRO', '', -15, 'BCP_DEB_3', ''],
        [daysAgo(3, 7, 0), 'Ingreso', 'Efectivo', 'Saldo inicial', 'Restante', 100, 'MAN_20260101_0000_AAAA', ''],
      ],
      'Crédito': [CRE_HEAD,
        [daysAgo(40, 9, 0), 'IO_INI', 'Ingreso', 'Procesado', 'IO', 'Límite inicial', 1200, '', '-', '', '', ''],
        [daysAgo(2, 20, 0), 'IO_1', 'Egreso', 'Pendiente', 'IO', 'Netflix', -40, '', 'Directo', '', '', 'Suscripciones'],
        [daysAgo(2, 18, 0), 'BCP_PAG_1', 'Ingreso', 'Procesado', 'IO', 'Pago de Tarjeta IO', 200, '', '-', '', '', ''],
        [daysAgo(2, 15, 0), 'IO_DEV', 'Ingreso', 'Procesado', 'IO', 'Devolución Saga', 25, '', '-', '', '', ''],
        [daysAgo(3, 15, 0), 'IO_CUO', 'Egreso', 'Procesado', 'IO', 'Laptop', -1200, '', 'Cuotas Sin Interes', 12, '', 'Tecnología'],
        [daysAgo(1, 15, 0), 'IO_2', 'Egreso', 'Pendiente', 'IO', 'Rappi', -35, '', 'Directo', '', '', ''],
      ],
      Tarjetas: [['Tarjeta', 'Límite', 'Día de corte', 'Día de pago', 'Meta %'], ['IO', 1200, 25, 12, 0.1]],
      Categorias: [['Categoría', 'Emoji', 'Tipo'], ['Supermercado', '🛒', 'Egreso'], ['Sueldo', '💼', 'Ingreso'], ['Suscripciones', '📺', 'Egreso'], ['Tecnología', '💻', 'Egreso']],
    };
  }

  /* ---------- aserciones ---------- */
  function assert(c, msg) { if (!c) throw new Error(msg || 'falló la aserción'); }
  function eq(a, b, msg) { const A = JSON.stringify(a), B = JSON.stringify(b); if (A !== B) throw new Error((msg ? msg + ': ' : '') + `esperaba ${B} y llegó ${A}`); }
  function ok(r, msg) { if (!r.ok) throw new Error((msg ? msg + ': ' : '') + `error ${r.error} ${r.message || ''}`); return r.data; }
  function err(r, code, msg) { if (r.ok || r.error !== code) throw new Error((msg ? msg + ': ' : '') + `esperaba ${code} y llegó ${r.ok ? 'ok' : r.error}`); }
  const row = (env, sheet, id) => env.sheets[sheet].objects().find((o) => o.ID === id);
  const ids = (env, sheet) => env.sheets[sheet].objects().map((o) => o.ID);
  const mid = (n) => `MAN_20261105_10${String(n).padStart(2, '0')}_T${String(n).padStart(3, '0')}`;
  const fecha = '2026-11-05T10:00';

  /* ---------- pruebas: comportamiento nuevo ---------- */
  const NEW = [
    ['Pago en Crédito: monto bloqueado', (env) => {
      err(env.call('updateMovimiento', { hoja: 'credito', id: 'BCP_PAG_1', cambios: { monto: 150 }, expect: { monto: 200 } }), 'PAGO_LINKED');
      eq(row(env, 'Crédito', 'BCP_PAG_1').Monto, 200, 'la hoja no cambia');
    }],
    ['Pago en Crédito: fecha, detalle y categoría bloqueados', (env) => {
      err(env.call('updateMovimiento', { hoja: 'credito', id: 'BCP_PAG_1', cambios: { fecha: '2026-11-01T10:00' } }), 'PAGO_LINKED');
      err(env.call('updateMovimiento', { hoja: 'credito', id: 'BCP_PAG_1', cambios: { detalle: 'Otro' } }), 'PAGO_LINKED');
      err(env.call('updateMovimiento', { hoja: 'credito', id: 'BCP_PAG_1', cambios: { categoria: 'Sueldo' } }), 'PAGO_LINKED');
      err(env.call('updateMovimiento', { hoja: 'credito', id: 'BCP_PAG_1', cambios: { comentario: 'x', monto: 1 } }), 'PAGO_LINKED', 'mezcla con comentario');
    }],
    ['Pago en Crédito: comentario y Estado sí se editan', (env) => {
      ok(env.call('updateMovimiento', { hoja: 'credito', id: 'BCP_PAG_1', cambios: { comentario: 'pagado desde BCP' } }));
      eq(row(env, 'Crédito', 'BCP_PAG_1').Comentario, 'pagado desde BCP');
      ok(env.call('updateMovimiento', { hoja: 'credito', id: 'BCP_PAG_1', cambios: { estado: 'Pendiente' } }));
      eq(row(env, 'Crédito', 'BCP_PAG_1').Estado, 'Pendiente');
    }],
    ['Duplicado: no se cambia categoría, monto ni fecha', (env) => {
      err(env.call('updateMovimiento', { hoja: 'debito', id: 'YAPE_A1', cambios: { categoria: 'Supermercado' } }), 'DUP_LOCKED');
      err(env.call('updateMovimiento', { hoja: 'debito', id: 'YAPE_A1', cambios: { monto: -10 } }), 'DUP_LOCKED');
      err(env.call('updateMovimiento', { hoja: 'debito', id: 'YAPE_A1', cambios: { fecha: '2026-11-01T10:00' } }), 'DUP_LOCKED');
      eq(row(env, 'Debito', 'YAPE_A1')['Categoría'], 'Duplicado');
    }],
    ['Duplicado: comentario sí se edita', (env) => {
      ok(env.call('updateMovimiento', { hoja: 'debito', id: 'YAPE_A1', cambios: { comentario: 'era el del BCP' } }));
      eq(row(env, 'Debito', 'YAPE_A1').Comentario, 'era el del BCP');
    }],
    ['Débito: Descripción editable (normal, pago de tarjeta y duplicado)', (env) => {
      ok(env.call('updateMovimiento', { hoja: 'debito', id: 'BCP_DEB_1', cambios: { descripcion: 'compras semana' }, expect: { descripcion: '' } }));
      eq(row(env, 'Debito', 'BCP_DEB_1')['Descripción'], 'compras semana');
      err(env.call('updateMovimiento', { hoja: 'debito', id: 'BCP_DEB_1', cambios: { descripcion: 'otra' }, expect: { descripcion: 'vieja' } }), 'CONFLICT');
      ok(env.call('updateMovimiento', { hoja: 'debito', id: 'BCP_PAG_1', cambios: { descripcion: 'pago IO' } }));
      ok(env.call('updateMovimiento', { hoja: 'debito', id: 'YAPE_A1', cambios: { descripcion: 'almuerzo Juan' } }));
      eq(row(env, 'Debito', 'YAPE_A1')['Descripción'], 'almuerzo Juan');
      err(env.call('updateMovimiento', { hoja: 'debito', id: 'BCP_DEB_1', cambios: { descripcion: '=1+1' } }), 'BAD_DESCRIPCION');
      err(env.call('updateMovimiento', { hoja: 'credito', id: 'IO_1', cambios: { descripcion: 'x' } }), 'BAD_FIELD', 'Crédito no tiene descripción');
    }],
    ['Débito: addMovimientos guarda la Descripción', (env) => {
      ok(env.call('addMovimientos', { hoja: 'debito', cuenta: 'BCP', rows: [
        { id: mid(1), fecha, tipo: 'Egreso', monto: 10, detalle: 'Uno', descripcion: 'detalle largo' },
        { id: mid(2), fecha, tipo: 'Egreso', monto: 30, tarjeta: 'IO', descripcion: 'pago de octubre' },
      ] }));
      eq(row(env, 'Debito', mid(1))['Descripción'], 'detalle largo');
      eq(row(env, 'Debito', mid(2))['Descripción'], 'pago de octubre');
      eq(row(env, 'Crédito', mid(2)).Comentario, 'pago de octubre', 'el abono en Crédito lleva el mismo texto como comentario');
    }],
    ['Historial de Crédito trae la línea de la tarjeta (Débito no)', (env) => {
      const hc = ok(env.call('getHistory', { hoja: 'credito', cuenta: 'IO' }));
      eq(hc.limite, 1200);
      eq(hc.limite - hc.totales.saldo, 1200 - 150, 'consumido = línea − saldo disponible');
      eq(ok(env.call('getHistory', { hoja: 'debito', cuenta: 'BCP' })).limite, null);
    }],
    ['Inbox fases 2–4 traen la categoría', (env) => {
      const pend = ok(env.call('getCards')).cards[0].pendientes;
      eq(pend.find((p) => p.id === 'IO_1').categoria, 'Suscripciones'); eq(pend.find((p) => p.id === 'IO_2').categoria, '');
      eq(ok(env.call('getCalendar')).rows[0].categoria, 'Tecnología');
      eq(ok(env.call('getPendingEstado')).items.find((p) => p.id === 'IO_1').categoria, 'Suscripciones');
    }],
    ['Duplicado: no se puede poner a mano desde Movimientos', (env) => {
      err(env.call('updateMovimiento', { hoja: 'debito', id: 'BCP_DEB_1', cambios: { categoria: 'Duplicado' } }), 'BAD_CATEGORIA');
      eq(row(env, 'Debito', 'BCP_DEB_1')['Categoría'], 'Supermercado');
    }],
    ['Abono manual en Crédito rechazado (consumos sí)', (env) => {
      const r = ok(env.call('addMovimientos', { hoja: 'credito', cuenta: 'IO', rows: [
        { id: mid(1), fecha, tipo: 'Ingreso', monto: 100, detalle: '' },
        { id: mid(2), fecha, tipo: 'Egreso', monto: 30, detalle: 'Cine', modalidad: 'Directo' },
      ] }));
      eq(r.results[0].error, 'ABONO_OFF'); assert(r.results[1].ok && r.results[1].inserted, 'el consumo entra');
      assert(!ids(env, 'Crédito').includes(mid(1)), 'el abono no se escribió');
    }],
    ['Duplicados Yape↔BCP: 90 min sí, 130 min no', (env) => {
      const d = ok(env.call('getInbox')).duplicados;
      eq(d.length, 1, 'un solo par');
      eq([d[0].yape.id, d[0].banco.id, d[0].minutos], ['YAPE_B1', 'BCP_DEB_2', 90]);
    }],
    ['Cuotas: «setiembre» (no «septiembre»)', (env) => {
      const months = ok(env.call('getCalendar')).months.join(' ');
      assert(/setiembre/.test(months), 'debe aparecer setiembre: ' + months);
      assert(!/septiembre/.test(months), 'no debe aparecer septiembre');
    }],
    ['ETL escribiendo a la vez: addMovimientos no pisa sus filas', (env) => {
      const sh = env.sheets.Debito;
      let n = 0;
      sh.hooks.afterGetLastRow = (s) => { if (n < 6) { n++; s.etlAppend([daysAgo(0, 8, n), 'Egreso', 'BCP', 'ETL ' + n, '', -n, 'BCP_DEB_ETL' + n, '']); } };
      const r = ok(env.call('addMovimientos', { hoja: 'debito', cuenta: 'BCP', rows: [
        { id: mid(1), fecha, tipo: 'Egreso', monto: 10, detalle: 'Uno' },
        { id: mid(2), fecha, tipo: 'Egreso', monto: 20, detalle: 'Dos' },
        { id: mid(3), fecha, tipo: 'Egreso', monto: 30, tarjeta: 'IO' },
      ] }));
      sh.hooks = {};
      eq(r.inserted, 3);
      const all = ids(env, 'Debito');
      for (let k = 1; k <= n; k++) assert(all.includes('BCP_DEB_ETL' + k), 'se perdió la fila del ETL ' + k);
      [mid(1), mid(2), mid(3)].forEach((id) => assert(all.includes(id), 'falta ' + id));
      eq(new Set(all).size, all.length, 'sin IDs repetidos');
      assert(n > 0, 'la simulación del ETL debe haberse disparado');
    }],
    ['ETL escribiendo a la vez: cuotas con su fórmula en la fila correcta', (env) => {
      const sh = env.sheets['Crédito'];
      let n = 0;
      sh.hooks.afterGetLastRow = (s) => { if (n < 4) { n++; s.etlAppend([daysAgo(0, 8, n), 'IO_ETL' + n, 'Egreso', 'Pendiente', 'IO', 'ETL ' + n, -n, '', 'Directo', '', '', '']); } };
      ok(env.call('addMovimientos', { hoja: 'credito', cuenta: 'IO', rows: [
        { id: mid(1), fecha, tipo: 'Egreso', monto: 600, detalle: 'TV', modalidad: 'Cuotas Sin Interes', cuotas: 6 },
        { id: mid(2), fecha, tipo: 'Egreso', monto: 90, detalle: 'Zapatillas', modalidad: 'Cuotas Sin Interes', cuotas: 3 },
      ] }));
      sh.hooks = {};
      for (let k = 1; k <= n; k++) assert(ids(env, 'Crédito').includes('IO_ETL' + k), 'se perdió la fila del ETL ' + k);
      [mid(1), mid(2)].forEach((id) => {
        const r = row(env, 'Crédito', id);
        eq(sh.formulas[r.__row + ':11'], `=IF(J${r.__row}="","",G${r.__row}/J${r.__row})`, 'fórmula de ' + id);
      });
      Object.keys(sh.formulas).forEach((k) => { const rr = Number(k.split(':')[0]); const o = sh.objects().find((x) => x.__row === rr); assert(o && /^MAN_/.test(o.ID), 'fórmula en una fila ajena: ' + k); });
    }],
    ['ETL escribiendo a la vez: addManual no pisa su fila', (env) => {
      const sh = env.sheets.Debito;
      let n = 0;
      sh.hooks.afterGetLastRow = (s) => { if (n < 3) { n++; s.etlAppend([daysAgo(0, 8, n), 'Egreso', 'BCP', 'ETL ' + n, '', -n, 'BCP_DEB_ETL' + n, '']); } };
      ok(env.call('addManual', { id: mid(7), fecha, tipo: 'Egreso', monto: 12, detalle: 'Taxi', banco: 'Efectivo' }));
      sh.hooks = {};
      for (let k = 1; k <= n; k++) assert(ids(env, 'Debito').includes('BCP_DEB_ETL' + k), 'se perdió la fila del ETL ' + k);
      eq(row(env, 'Debito', mid(7)).Monto, -12);
    }],
    ['Partida doble: si falla Crédito se deshace el pago en ambas hojas', (env) => {
      const before = { d: ids(env, 'Debito'), c: ids(env, 'Crédito') };
      let k = 0;
      env.sheets['Crédito'].hooks.beforeAppend = () => { if (++k === 2) throw new Error('fallo simulado'); };
      const r = env.call('addMovimientos', { hoja: 'debito', cuenta: 'BCP', rows: [
        { id: mid(1), fecha, tipo: 'Egreso', monto: 100, tarjeta: 'IO' },
        { id: mid(2), fecha, tipo: 'Egreso', monto: 50, tarjeta: 'IO' },
      ] });
      env.sheets['Crédito'].hooks = {};
      assert(!r.ok, 'la llamada falla');
      eq(ids(env, 'Debito'), before.d, 'Débito vuelve a como estaba');
      eq(ids(env, 'Crédito'), before.c, 'Crédito vuelve a como estaba');
    }],
  ];

  /* ---------- pruebas: lo que ya funcionaba sigue igual ---------- */
  const REG = [
    ['ping y token', (env) => { ok(env.call('ping')); err(env.call('ping', {}, 'malo'), 'UNAUTHORIZED'); }],
    ['Débito: Pago Tarjeta solo comentario (como antes)', (env) => {
      err(env.call('updateMovimiento', { hoja: 'debito', id: 'BCP_PAG_1', cambios: { monto: -1 } }), 'PAGO_LINKED');
      err(env.call('updateMovimiento', { hoja: 'debito', id: 'BCP_PAG_1', cambios: { categoria: 'Supermercado' } }), 'PAGO_LINKED');
      ok(env.call('updateMovimiento', { hoja: 'debito', id: 'BCP_PAG_1', cambios: { comentario: 'ok' } }));
    }],
    ['Crédito: consumo normal editable', (env) => {
      ok(env.call('updateMovimiento', { hoja: 'credito', id: 'IO_1', cambios: { monto: 45 }, expect: { monto: -40 } }));
      eq(row(env, 'Crédito', 'IO_1').Monto, -45);
      ok(env.call('updateMovimiento', { hoja: 'credito', id: 'IO_1', cambios: { pagado: true } }));
      eq(row(env, 'Crédito', 'IO_1').Pagado, true);
    }],
    ['Crédito: ingreso que no es pago (devolución) editable', (env) => {
      ok(env.call('updateMovimiento', { hoja: 'credito', id: 'IO_DEV', cambios: { monto: 30 } }));
      eq(row(env, 'Crédito', 'IO_DEV').Monto, 30);
    }],
    ['Débito: edición normal y CONFLICT', (env) => {
      ok(env.call('updateMovimiento', { hoja: 'debito', id: 'BCP_DEB_1', cambios: { monto: -55 }, expect: { monto: -50 } }));
      eq(row(env, 'Debito', 'BCP_DEB_1').Monto, -55);
      err(env.call('updateMovimiento', { hoja: 'debito', id: 'BCP_DEB_1', cambios: { monto: -60 }, expect: { monto: -50 } }), 'CONFLICT');
      err(env.call('updateMovimiento', { hoja: 'debito', id: 'NOPE', cambios: { monto: -60 } }), 'NOT_FOUND');
    }],
    ['resolveDuplicado: marcar y descartar', (env) => {
      ok(env.call('resolveDuplicado', { accion: 'marcar', a: 'YAPE_B1', b: 'BCP_DEB_2', duplicado: 'BCP_DEB_2' }));
      eq(row(env, 'Debito', 'BCP_DEB_2')['Categoría'], 'Duplicado');
      ok(env.call('resolveDuplicado', { accion: 'descartar', a: 'YAPE_C1', b: 'BCP_DEB_3' }));
      assert(env.sheets['Duplicados Descartados'], 'crea la hoja');
    }],
    ['addMovimientos Débito: normal + pago (partida doble) e idempotencia', (env) => {
      const rows = [
        { id: mid(1), fecha, tipo: 'Egreso', monto: 10, detalle: 'Uno', categoria: 'Supermercado', comentario: 'c1' },
        { id: mid(2), fecha, tipo: 'Ingreso', monto: 20, detalle: 'Dos' },
        { id: mid(3), fecha, tipo: 'Egreso', monto: 30, tarjeta: 'IO' },
      ];
      const r = ok(env.call('addMovimientos', { hoja: 'debito', cuenta: 'BCP', rows }));
      eq(r.inserted, 3);
      eq(row(env, 'Debito', mid(1)).Monto, -10); eq(row(env, 'Debito', mid(2)).Monto, 20);
      eq(row(env, 'Debito', mid(3))['Categoría'], 'Pago Tarjeta');
      const c = row(env, 'Crédito', mid(3)); eq([c.Tipo, c.Estado, c.Monto, c['Detalle/Comercio']], ['Ingreso', 'Procesado', 30, 'Pago de Tarjeta IO']);
      assert(row(env, 'Debito', mid(1)).Fecha instanceof Date, 'fecha como Date');
      eq(env.sheets.Debito.formats[row(env, 'Debito', mid(1)).__row + ':1'], 'yyyy-mm-dd hh:mm:ss', 'formato de fecha');
      const again = ok(env.call('addMovimientos', { hoja: 'debito', cuenta: 'BCP', rows }));
      eq(again.inserted, 0); assert(again.results.every((x) => x.ok && x.duplicate), 'todo duplicado');
    }],
    ['addMovimientos: errores por fila', (env) => {
      const r = ok(env.call('addMovimientos', { hoja: 'debito', cuenta: 'BCP', rows: [
        { id: 'MALO', fecha, tipo: 'Egreso', monto: 1, detalle: 'x' },
        { id: mid(1), fecha, tipo: 'Egreso', monto: 1, detalle: 'x', categoria: 'NoExiste' },
        { id: mid(2), fecha, tipo: 'Egreso', monto: 1, detalle: '=HYPERLINK()' },
        { id: mid(3), fecha, tipo: 'Egreso', monto: 1, detalle: 'bien' },
      ] }));
      eq(r.results.map((x) => x.ok ? 'ok' : x.error), ['BAD_ID', 'UNKNOWN_CATEGORY', 'BAD_DETALLE', 'ok']);
    }],
    ['addCreditConsumo y addPagoTarjeta (appendRow de siempre)', (env) => {
      ok(env.call('addCreditConsumo', { id: mid(4), fecha, tarjeta: 'IO', monto: 120, modalidad: 'Cuotas Sin Interes', cuotas: 4, detalle: 'Bici' }));
      const r = row(env, 'Crédito', mid(4)); eq(env.sheets['Crédito'].formulas[r.__row + ':11'], `=IF(J${r.__row}="","",G${r.__row}/J${r.__row})`);
      ok(env.call('addPagoTarjeta', { id: mid(5), fecha, tarjeta: 'IO', cuenta: 'BCP', monto: 80 }));
      eq(row(env, 'Debito', mid(5)).Monto, -80); eq(row(env, 'Crédito', mid(5)).Monto, 80);
    }],
    ['categorizeBatch', (env) => {
      const r = ok(env.call('categorizeBatch', { hoja: 'debito', items: [{ id: 'YAPE_B1', categoria: 'Supermercado' }, { id: 'BCP_DEB_2', categoria: 'Comida nueva', emoji: '🍔' }, { id: 'BCP_DEB_3', categoria: 'Otra' }] }));
      eq(r.results.map((x) => x.ok ? 'ok' : x.error), ['ok', 'ok', 'EMOJI_REQUIRED']);
      eq(row(env, 'Debito', 'BCP_DEB_2')['Categoría'], 'Comida nueva');
    }],
    ['toggleCuota, setPagado, setEstado', (env) => {
      const cal = ok(env.call('getCalendar'));
      const k = cal.rows[0].montos.findIndex((m) => m != null);
      ok(env.call('toggleCuota', { id: 'IO_CUO', mes: cal.keys[k], pagada: true }));
      assert(ok(env.call('getCalendar')).rows[0].pagadas[k], 'queda pagada');
      ok(env.call('setPagado', { id: 'IO_1', pagado: true })); eq(row(env, 'Crédito', 'IO_1').Pagado, true);
      ok(env.call('setEstado', { id: 'IO_1', estado: 'Procesado' })); eq(row(env, 'Crédito', 'IO_1').Estado, 'Procesado');
    }],
    ['Lecturas: historial, resumen, tarjetas, inbox, batch', (env) => {
      const hd = ok(env.call('getHistory', { hoja: 'debito', cuenta: 'BCP' }));
      eq(hd.totales.ingresos, 3000); eq(hd.totales.egresos, 50 + 200 + 20 + 20 + 15 + 15, 'Duplicado no cuenta');
      const hc = ok(env.call('getHistory', { hoja: 'credito', cuenta: 'IO' }));
      eq(hc.totales.saldo, 1200 - 40 + 200 + 25 - 1200 - 35);
      const s = ok(env.call('getSummary'));
      eq(s.cuadre.diferencia, 0, 'pagos de tarjeta cuadran');
      const cards = ok(env.call('getCards')).cards; eq(cards[0].tarjeta, 'IO');
      const b = ok(env.call('batch', { calls: [{ action: 'getInbox' }, { action: 'getCreditInbox' }, { action: 'getPendingEstado' }, { action: 'updateMovimiento' }] }));
      eq(b.results.map((x) => x.ok), [true, true, true, false]);
    }],
  ];

  /* ---------- avisos de Telegram (con reloj simulado) ---------- */
  // cada prueba recibe make(now) -> entorno con Telegram configurado y `new Date()` fijado en `now` (función o fecha)
  const atToday = (hh, mi = 0, plusDays = 0) => new Date(daysAgo(0, hh, mi).getTime() + plusDays * 86400000);
  const money = (n) => (n < 0 ? '-' : '') + 'S/ ' + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const msgs = (env) => env.telegram.slice();
  const has = (txt, s, msg) => assert(txt.includes(s), (msg || 'falta') + ' «' + s + '» en:\n' + txt);
  const TG = [
    ['fosWatch: la 1.ª vez solo se activa; luego avisa lo nuevo una sola vez (sin filas MAN_)', (make) => {
      const env = make(atToday(10));
      env.api.fosWatch();
      eq(env.telegram.length, 1); has(env.telegram[0], 'avisos activados');
      env.api.fosWatch(); eq(env.telegram.length, 1, 'sin novedades no escribe');
      env.sheets['Crédito'].etlAppend([atToday(9), 'IO_ETL9', 'Egreso', 'Pendiente', 'IO', 'Hotel Cusco', -180, '', 'Directo', '', '', '']);
      env.sheets.Debito.etlAppend([atToday(9, 30), 'Egreso', 'BCP', 'Consumo Debito TAMBO', '', -12, 'BCP_DEB_9', '']);
      env.sheets.Debito.etlAppend([atToday(9, 40), 'Egreso', 'Efectivo', 'Menú cargado a mano', '', -9, 'MAN_20261106_0940_ZZZZ', '']);
      env.api.fosWatch();
      eq(env.telegram.length, 2, 'un solo mensaje con todo lo nuevo');
      const m = env.telegram[1];
      has(m, '2 movimientos nuevos'); has(m, 'Hotel Cusco'); has(m, 'Consumo Debito TAMBO'); has(m, '🚨', 'el gasto grande se destaca');
      has(m, 'IO: utilización'); assert(!m.includes('Menú cargado a mano'), 'lo que cargas tú no se repite');
      env.api.fosWatch(); eq(env.telegram.length, 2, 'no repite');
    }],
    ['fosWatch: en horas de silencio espera y avisa a la mañana', (make) => {
      let now = atToday(10);
      const env = make(() => now);
      env.api.fosWatch();
      env.sheets.Debito.etlAppend([atToday(22), 'Egreso', 'BCP', 'Cine noche', '', -30, 'BCP_DEB_N1', '']);
      now = atToday(23, 30); env.api.fosWatch(); eq(env.telegram.length, 1, 'silencio 23:30');
      now = atToday(6, 50, 1); env.api.fosWatch(); eq(env.telegram.length, 1, 'silencio 6:50');
      now = atToday(7, 5, 1); env.api.fosWatch(); eq(env.telegram.length, 2, 'a las 7 avisa'); has(env.telegram[1], 'Cine noche');
    }],
    ['fosWatch: un posible duplicado nuevo se avisa una sola vez', (make) => {
      const env = make(atToday(12));
      env.api.fosWatch(); // el par ya existente queda como visto
      env.sheets.Debito.etlAppend([atToday(9), 'Egreso', 'BCP', '[YAPE] Luis*', '', -33, 'YAPE_L1', 'almuerzo']);
      env.sheets.Debito.etlAppend([atToday(9, 20), 'Egreso', 'BCP', 'Consumo Debito PLIN LUIS', '', -33, 'BCP_DEB_L1', '']);
      env.api.fosWatch();
      has(env.telegram[1], 'Posible duplicado'); has(env.telegram[1], '[YAPE] Luis*'); assert(!env.telegram[1].includes('Maria'), 'el par viejo no se repite');
      env.sheets.Debito.etlAppend([atToday(11), 'Egreso', 'BCP', 'Wong', 'Supermercado', -5, 'BCP_DEB_X', '']);
      env.api.fosWatch(); assert(!env.telegram[2].includes('Posible duplicado'), 'el duplicado ya avisado no vuelve');
    }],
    ['fosNightly: liquidez real, hoy, pendientes y recordatorios de IO y Yape', (make) => {
      const env = make(atToday(21));
      env.sheets.Debito.etlAppend([atToday(13), 'Egreso', 'Efectivo', 'Taxi', '', -25, 'MAN_20261106_1300_TAXI', '']);
      env.api.fosNightly();
      eq(env.telegram.length, 1);
      const m = env.telegram[0];
      const s = ok(env.call('getSummary')), cards = ok(env.call('getCards')).cards;
      const cred = cards.reduce((a, c) => a + c.pendientes.reduce((x, p) => x + p.monto, 0) + c.cuotaMes, 0);
      has(m, 'Liquidez real: ' + money(Math.round((s.debito.cierre - cred) * 100) / 100), 'liquidez igual a la del Inbox');
      has(m, 'Taxi', 'lo cargado a mano sí sale en el resumen'); has(m, 'Cuadre de hoy pendiente'); has(m, '☐ Categorizar'); has(m, 'Yape'); has(m, 'IO: disponible S/ 150.00 · consumido S/ 1,050.00');
    }],
    ['fosNightly: los préstamos van aparte y no restan de la liquidez', (make) => {
      const env = make(atToday(21));
      const before = ok(env.call('getSummary')).debito.cierre;
      env.sheets['Crédito'].etlAppend([atToday(9), 'IO_PRE', 'Prestamo', 'Procesado', 'IO', 'Préstamo a Ana', -100, '', 'Directo', '', '', '']);
      env.api.fosNightly();
      const m = env.telegram[0];
      has(m, 'Liquidez real: ' + money(before - 75)); has(m, 'Total crédito S/ 75.00'); has(m, 'Préstamos S/ 100.00 (aparte');
    }],
    ['fosNightly: el domingo agrega la semana (y otro día no)', (make) => {
      const dow = new Date(daysAgo(0, 12, 0).getTime() - 5 * 3600000).getUTCDay();
      const toSun = (7 - dow) % 7;
      const sun = make(atToday(21, 0, toSun)); sun.api.fosNightly(); has(sun.telegram[0], 'Tu semana');
      const mon = make(atToday(21, 0, toSun + 1)); mon.api.fosNightly(); assert(!mon.telegram[0].includes('Tu semana'), 'lunes sin semana');
    }],
    ['fosNotifyCards: meta superada y, el día 1, cierre del mes anterior', (make) => {
      const t = today();
      const next1 = root.GasMock.L(t.m === 12 ? t.y + 1 : t.y, t.m === 12 ? 1 : t.m + 1, 1, 8, 0);
      const env = make(next1);
      env.api.fosNotifyCards();
      eq(env.telegram.length, 1);
      const m = env.telegram[0];
      const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre'];
      has(m, 'Cierre de ' + meses[t.m - 1]); has(m, 'sobre tu meta');
    }],
    ['fosInstallTriggers: 3 avisos y reemplaza el trigger viejo', (make) => {
      const env = make(atToday(10));
      env.triggers.push({ fn: 'fosNotifyPending', hours: 1 }, { fn: 'ejecutarETLCompleto', hours: 1 });
      env.api.fosInstallTriggers();
      eq(env.triggers.map((x) => x.fn).sort(), ['ejecutarETLCompleto', 'fosNightly', 'fosNotifyCards', 'fosNudge', 'fosWatch'], 'no toca el trigger del ETL');
      eq(env.triggers.find((x) => x.fn === 'fosNudge').hours, 1);
      eq(env.triggers.find((x) => x.fn === 'fosNightly').atHour, 21); eq(env.triggers.find((x) => x.fn === 'fosNotifyCards').atHour, 8);
    }],
    ['RPA: runEtl corre el ETL, cuenta lo nuevo y no permite dos corridas a la vez', (make) => {
      const env = make(atToday(10));
      const r = ok(env.call('runEtl'));
      eq([r.debito, r.credito], [1, 1]);
      assert(row(env, 'Debito', 'BCP_DEB_RPA') && row(env, 'Crédito', 'FAL_RPA'), 'el ETL escribió');
      env.sheets.Debito.hooks.beforeAppend = () => { const again = env.call('runEtl'); if (again.ok || again.error !== 'ETL_RUNNING') throw new Error('debía ser ETL_RUNNING'); };
      ok(env.call('runEtl'), 'la 2.ª corrida (con otra intentando entrar) termina bien'); env.sheets.Debito.hooks = {};
      ok(env.call('runEtl'), 'la bandera se libera al terminar');
      env.api.fosEtlProgramado(); // la versión para el trigger horario tampoco falla
    }],
    ['Cuadre del día: pendiente → hecho (Inbox, duplicados, app, Yape) y la racha suma', (make) => {
      const env = make(atToday(12));
      const r0 = ok(env.call('getRacha'));
      eq([r0.cuadrado, r0.racha], [false, 0]);
      eq(r0.items.find((i) => i.key === 'app').ok, true, 'usar la app cuenta');
      eq(r0.items.find((i) => i.key === 'inbox').n, 5);
      cuadrar(env);
      const r1 = ok(env.call('getRacha'));
      eq([r1.cuadrado, r1.racha, r1.hechoHoy], [true, 1, true]);
      const hoy = JSON.parse(env.props.FOS_RACHA).d[0];
      env.props.FOS_RACHA = JSON.stringify({ d: [fosDay(hoy, -5), fosDay(hoy, -3), fosDay(hoy, -2), fosDay(hoy, -1), hoy], best: 1 });
      const r2 = ok(env.call('getRacha'));
      eq([r2.racha, r2.best], [4, 4], 'se encadena con los días seguidos anteriores (un hueco corta la racha)');
    }],
    ['getCards: los pendientes traen su Estado', (make) => {
      const env = make(atToday(12));
      const p = ok(env.call('getCards')).cards[0].pendientes;
      eq(p.find((x) => x.id === 'IO_1').estado, 'Pendiente');
    }],
    ['fosNudge: insiste a sus horas, una vez por hora, y escala hasta la última llamada', (make) => {
      let now = atToday(9, 30);
      const env = make(() => now);
      env.props.FOS_RACHA = JSON.stringify({ d: [fosDay(fecha10(atToday(12)), -1)], best: 1 }); // ayer cuadró
      env.api.fosNudge(); eq(env.telegram.length, 0, '9:30 no es hora de aviso');
      now = atToday(10, 5); env.api.fosNudge(); eq(env.telegram.length, 1);
      has(env.telegram[0], 'Te falta'); has(env.telegram[0], '☐ Categorizar'); has(env.telegram[0], 'racha de <b>1 día</b> está en riesgo');
      now = atToday(10, 40); env.api.fosNudge(); eq(env.telegram.length, 1, 'no repite en la misma hora');
      now = atToday(22, 10); env.api.fosNudge(); eq(env.telegram.length, 2); has(env.telegram[1], 'vuelve a 0');
      now = atToday(23, 10); env.api.fosNudge(); eq(env.telegram.length, 2, 'silencio de noche');
    }],
    ['fosNudge: si ya cuadraste, felicita una sola vez al día', (make) => {
      let now = atToday(12);
      const env = make(() => now);
      cuadrar(env);
      const n0 = env.telegram.length; // el sync de Yape avisa por su cuenta
      now = atToday(13, 5); env.api.fosNudge(); eq(env.telegram.length, n0 + 1); has(env.telegram[n0], 'Racha de 1 día');
      now = atToday(16, 5); env.api.fosNudge(); eq(env.telegram.length, n0 + 1, 'no vuelve a escribir');
    }],
    ['fosNudge: avisa si no abres la app ni registras nada a mano hace días', (make) => {
      let now = atToday(10, 1, -5);
      const env = make(() => now);
      env.call('ping'); // usaste la app hace 5 días
      now = atToday(13, 1); env.api.fosNudge();
      has(env.telegram[0], 'Llevas <b>5 días</b> sin abrir'); has(env.telegram[0], 'no registras nada a mano');
    }],
  ];
  // deja el cuadre de hoy hecho: categoriza todo, resuelve el duplicado y sincroniza Yape
  function cuadrar(env) {
    const inb = ok(env.call('getInbox'));
    ok(env.call('resolveDuplicado', { accion: 'descartar', a: inb.duplicados[0].yape.id, b: inb.duplicados[0].banco.id }));
    ok(env.call('categorizeBatch', { hoja: 'debito', items: inb.items.map((x) => ({ id: x.id, categoria: x.monto > 0 ? 'Sueldo' : 'Supermercado' })) }));
    ok(env.call('categorizeBatch', { hoja: 'credito', items: ok(env.call('getCreditInbox')).items.map((x) => ({ id: x.id, categoria: 'Supermercado' })) }));
    ok(env.call('syncYape'));
  }
  const fecha10 = (d) => root.GasMock.formatDate(d, '', 'yyyy-MM-dd');
  const fosDay = (ymd, n) => fecha10(new Date(root.GasMock.L(+ymd.slice(0, 4), +ymd.slice(5, 7), +ymd.slice(8, 10), 12).getTime() + n * 86400000));
  // tu ETL y tu sync de Yape, simulados (solo para las pruebas con reloj)
  const STUBS = `
function ejecutarETLCompleto() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.getSheetByName('Debito').appendRow([new Date(), 'Egreso', 'BCP', 'Consumo RPA', '', -9, 'BCP_DEB_RPA', '']);
  ss.getSheetByName('Crédito').appendRow([new Date(), 'FAL_RPA', 'Egreso', 'Pendiente', 'IO', 'Tottus', -20, '', 'Directo', '', '', '']);
}
function procesarYapeDefinitivo() {}
`;

  /* ---------- diferencial: mismas operaciones contra el código anterior y el nuevo ---------- */
  const READS = [['getInbox'], ['getCreditInbox'], ['getPendingEstado'], ['getCategories'], ['getCategoryAdmin'], ['getCards'], ['getCalendar'], ['getSummary'],
    ['getHistory', { hoja: 'debito' }], ['getHistory', { hoja: 'debito', cuenta: 'Efectivo' }], ['getHistory', { hoja: 'credito', cuenta: 'IO' }]];
  // cambios esperados entre versiones: el nombre del mes y la ventana de duplicados (60 → 120 min)
  const normalize = (action, data) => {
    let s = JSON.stringify(data).replace(/septiembre/g, 'setiembre');
    if (action === 'getInbox') { const o = JSON.parse(s); delete o.duplicados; s = JSON.stringify(o); }
    return s;
  };
  const WRITES = [
    ['addMovimientos', { hoja: 'debito', cuenta: 'BCP', rows: [{ id: mid(1), fecha, tipo: 'Egreso', monto: 10, detalle: 'Uno', categoria: 'Supermercado' }, { id: mid(2), fecha, tipo: 'Egreso', monto: 30, tarjeta: 'IO', comentario: 'x' }] }],
    ['addMovimientos', { hoja: 'credito', cuenta: 'IO', rows: [{ id: mid(3), fecha, tipo: 'Egreso', monto: 300, detalle: 'TV', modalidad: 'Cuotas Sin Interes', cuotas: 3 }, { id: mid(4), fecha, tipo: 'Egreso', monto: 20, detalle: 'Cine', modalidad: 'Directo', pagado: true }] }],
    ['addManual', { id: mid(5), fecha, tipo: 'Ingreso', monto: 50, detalle: 'Venta', banco: 'Efectivo', descripcion: 'd' }],
    ['updateMovimiento', { hoja: 'debito', id: 'BCP_DEB_1', cambios: { detalle: 'Wong Benavides', comentario: 'ok' } }],
    ['updateMovimiento', { hoja: 'credito', id: 'IO_2', cambios: { categoria: 'Suscripciones', estado: 'Procesado' } }],
    ['categorize', { id: 'YAPE_C1', categoria: 'Supermercado' }],
    ['saveCategory', { nombre: 'Supermercado', nuevo: 'Mercado', emoji: '🛒', tipo: 'Egreso' }],
  ];
  const sorted = (o) => Object.keys(o).sort().map((k) => [k, o[k]]); // el orden en que se aplicaron los formatos no importa
  const dumpSheets = (env) => JSON.stringify(Object.keys(env.sheets).sort().map((n) => [n, env.sheets[n].data, sorted(env.sheets[n].formulas), sorted(env.sheets[n].formats)]));

  root.FosServerTests = { FILES, fixture, NEW, REG, TG, STUBS, READS, WRITES, normalize, dumpSheets };
})(typeof window !== 'undefined' ? window : globalThis);
