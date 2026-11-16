# Finanzas OS

Sistema personal de finanzas: Google Sheets como base de datos, Google Apps Script como API y una PWA en GitHub Pages.
Moneda S/ (PEN), zona horaria America/Lima, interfaz en español.

```
apps-script/   Api.gs  Sheets.gs  Movimientos.gs  Historial.gs  Resumen.gs  Categorias.gs  Tarjetas.gs  Telegram.gs
               -> se copian A MANO al proyecto de Apps Script del Sheet (+ «Nueva versión»); GitHub no los despliega
docs/          index.html  app.js  config.js  sw.js  manifest.webmanifest  icons/
               -> la PWA: GitHub Pages publica esta carpeta sola en cada push a main
tests/         pruebas del servidor (mock de Apps Script) y de la interfaz (se abren en el navegador; ver tests/README.md)
```

## Hojas
| Hoja | Uso |
|---|---|
| `Debito` | dinero líquido. `Fecha · Tipo · Banco / Cuenta · Detalle/Comercio · Categoría · Monto · ID · Descripción · Comentario` (Comentario se crea al primer uso) |
| `Crédito` | deuda en tarjetas. `Fecha · ID · Tipo · Estado · Banco / Cuenta · Detalle/Comercio · Monto · Pagado · Modalidad · N° Cuotas · Monto Cuota · Categoría · Comentario` |
| `Tarjetas` | límite, día de corte, día de pago y meta % por tarjeta (`fosSetupTarjetas()` la crea) |
| `Pagos Cuotas` | cuotas marcadas como pagadas (`ID Compra · Mes · Pagada el`), se crea sola |
| `Categorias` | `Categoría · Emoji · Tipo` (Egreso/Ingreso), se crea sola |
| `Duplicados Descartados` | pares Yape↔BCP que no son duplicados (`Clave · Fecha`), se crea sola |

Las columnas se leen por **nombre de encabezado**: no reordenes ni renombres las existentes; las nuevas van al final.
Las altas usan `appendRow` fila por fila (igual que el ETL), así una fila de la PWA nunca pisa una que el ETL agregue al mismo tiempo.

## Reglas de negocio
- Débito y Crédito son visiones independientes: **nunca se suman**. Solo se cruzan en el pago de tarjeta (partida doble: Egreso
  `Pago Tarjeta` en Débito + Ingreso `Procesado` «Pago de Tarjeta …» en Crédito, mismo ID; si falla la segunda fila se deshace la primera).
- Categorías de sistema (no se eligen ni se crean a mano): `Pago Tarjeta` 💳, `Restante` 💰 (cuenta como ingreso del mes), `Duplicado` ♻️ (no cuenta en totales).
- **Filas bloqueadas en la tabla de Movimientos** (solo admiten comentario):
  - pago de tarjeta en Débito (categoría `Pago Tarjeta`) y su otra mitad en Crédito (Ingreso cuyo detalle empieza con «Pago»; aquí también se puede cambiar el Estado);
  - filas marcadas `Duplicado` (se marcan solo desde el Inbox).
- Posible duplicado Yape↔BCP: egreso Yape + egreso no-Yape, monto ±5 % (mín. S/ 1), **a 2 horas o menos**, alguno sin categoría
  (se revisan los últimos 45 días). Nunca se borra la fila: se marca `Duplicado` o se descarta la alerta.
- El **abono manual** a una tarjeta está desactivado: los pagos llegan por el ETL o se registran como «Pago de tarjeta» desde Débito.
- Cuotas: la 1.ª cae el mes siguiente a la compra.
- Resumen Débito: `cierre = sobró del mes anterior + ingresos − gastos − pagos de tarjeta`; el cierre pasa como «sobró» al mes siguiente.

## 1. Backend (Apps Script)
1. En el proyecto del Sheet (Extensiones > Apps Script) crea los 8 archivos de `apps-script/` y pega su contenido.
2. Solo puede haber un `doGet` y un `doPost`: si tu proyecto ya tenía otros, bórralos. Tus funciones del ETL (incluida `procesarYapeDefinitivo`) no se tocan.
3. Ejecuta `fosSetup()` y autoriza permisos. Copia el **API_TOKEN** del Registro de ejecución.
4. Telegram: crea el bot con @BotFather, escríbele, abre `https://api.telegram.org/bot<TOKEN>/getUpdates` y copia `chat.id`.
   En *Configuración del proyecto > Propiedades de la secuencia de comandos* agrega `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`. Prueba con `fosTestTelegram()`.
5. (Una vez) `fosBackfillIds()` da ID a filas antiguas sin ID; `fosSetupTarjetas()` crea la hoja Tarjetas; `fosInstallTriggers()` activa los avisos
   de Telegram (ver abajo). Revisa que la zona horaria del proyecto sea America/Lima (Configuración del proyecto).
6. Implementar > Nueva implementación > Aplicación web: **Ejecutar como: Yo · Acceso: Cualquier persona**. Copia la URL `/exec`.
   Cambios futuros: Administrar implementaciones > editar > **Nueva versión** (la URL no cambia).

Recomendado: envuelve los triggers del ETL con `fosWithLock_(() => { ... })` (en especial el ordenamiento de la hoja).

### Avisos de Telegram (solo envía; el bot no lee mensajes)
| Trigger | Cuándo | Qué avisa |
|---|---|---|
| `fosWatch` | cada hora (silencio 23:00–7:00, se acumula para las 7) | movimientos nuevos del ETL en Débito y Crédito (no repite lo que cargas tú con ID `MAN_`), gastos ≥ S/ 150 con 🚨, utilización de la tarjeta tocada, posibles duplicados Yape↔BCP |
| `fosNotifyCards` | ~8 am | por tarjeta: estado cerrado por vencer o atrasado, corte en ≤ 3 días, cuotas del mes cerca del día de pago, utilización sobre la meta; el día 1, cierre del mes anterior |
| `fosNightly` | ~9 pm | liquidez real (los 3 números del Inbox), lo de hoy, pendientes del Inbox, recordatorio de Yape y de cada tarjeta manual (IO, Interbank) con su disponible; los domingos, la semana vs la anterior |

Horas, monto de «gasto grande» y tarjetas manuales: constante `FOS_TG` en `Telegram.gs` (luego vuelve a correr `fosInstallTriggers()` si cambias las horas).
Opcional: llama `fosWatch()` al final de tu `ejecutarETLCompleto` para que el aviso llegue apenas entra el movimiento.

## 2. Frontend (GitHub Pages)
1. Repo `sc0rpzzz/finanzas-os`, Settings › Pages: *Deploy from a branch* · `main` · carpeta **`/docs`**. Cada push a `main` publica la app (1–2 min).
2. En cada cambio del cliente sube `?v=` de `app.js` en `index.html` y `VERSION` en `sw.js` (si no, el celular puede seguir con la versión en caché).
3. Abre la URL, pega la URL `/exec` y el token (se guardan solo en ese dispositivo). Menú del navegador > «Agregar a pantalla de inicio».

## Contrato de la API
Todas las llamadas: `POST <URL /exec>`, `Content-Type: text/plain`, cuerpo `{"token","action","payload"}`.
Respuesta: `{"ok":true,"data":...}` o `{"ok":false,"error":"CODIGO","message":"…"}` (siempre HTTP 200). Las escrituras van serializadas con lock.

| action | payload | efecto |
|---|---|---|
| ping | – | valida token |
| batch | `{calls:[{action,payload?}]}` (máx. 8, solo lecturas) | varias lecturas en una petición; `{results:[{ok,data}\|{ok:false,error}]}`; cada hoja se lee una vez |
| getInbox | – | filas de Débito sin categoría + `duplicados` Yape↔BCP + categorías, emojis y tipos |
| getCreditInbox | – | consumos de Crédito (Egreso) sin categoría |
| getPendingEstado | – | movimientos de Crédito con Estado «Pendiente» |
| getCategories | – | categorías, emojis, tarjetas y cuentas manuales |
| getCategoryAdmin | – | categorías con emoji, tipo, uso en Débito/Crédito y si son de sistema |
| saveCategory | `{nombre?, nuevo, emoji, tipo}` | crea, edita, renombra (en ambas hojas) o fusiona una categoría; emoji y tipo obligatorios |
| categorize | `{id, categoria, emoji?, onlyIfBlank?, hoja?:"credito", pagoTarjeta?}` | escribe solo la celda Categoría; categoría nueva exige emoji |
| categorizeBatch | `{hoja, items:[{id,categoria,emoji?,pagoTarjeta?}]}` (≤100) | clasifica varios del Inbox (resultado por ítem) |
| resolveDuplicado | `{accion:"marcar"\|"descartar", a, b, duplicado?}` | marca una fila con «Duplicado» (no se borra) o descarta la alerta |
| getHistory | `{hoja, cuenta?}` | movimientos de UNA cuenta/tarjeta + `cuentas` + `totales` (Débito: ingresos/egresos/neto · Crédito: ingresos/egresos/saldo); «Duplicado» no cuenta |
| updateMovimiento | `{hoja, id, cambios:{fecha,detalle,categoria,monto,comentario,cuenta\|pagado,estado}, expect?}` | edita celdas sueltas por ID; `expect` distinto → `CONFLICT`; pagos de tarjeta → `PAGO_LINKED`; filas Duplicado → `DUP_LOCKED` |
| addMovimientos | `{hoja, cuenta, rows:[…≤50]}` | alta idempotente (ID `MAN_YYYYMMDD_HHMM_XXXX` por fila), resultado por fila; en Débito, filas con `tarjeta` crean la partida doble; en Crédito solo consumos (Ingreso → `ABONO_OFF`) |
| addManual | `{id, fecha, tipo, monto, detalle, categoria?, descripcion?, banco?}` | alta suelta en Débito; idempotente; el servidor fija el signo |
| addCreditConsumo | `{id, fecha, tarjeta, monto, modalidad, cuotas?, detalle, categoria?, pagado?}` | consumo de tarjeta en Crédito (idempotente) |
| addPagoTarjeta | `{id, fecha, tarjeta, cuenta, monto}` | partida doble Débito + Crédito, mismo ID; se deshace si falla la 2.ª fila |
| setPagado | `{id, pagado}` | check `Pagado` de un consumo de Crédito |
| setEstado | `{id, estado:"Procesado"\|"Pendiente"}` | celda `Estado` de un movimiento de Crédito |
| getCards | – | utilización, corte, vencimiento y montos a pagar por tarjeta |
| getCalendar | – | cuotas vigentes (desde Crédito) con su estado pagada/no |
| toggleCuota | `{id, mes:"yyyy-MM", pagada}` | marca/desmarca una cuota en `Pagos Cuotas` |
| getSummary | `{mes?:"yyyy-MM"}` | resumen mensual `debito` y `credito` por separado + `cuadre` de pagos de tarjeta |
| syncYape | – | ejecuta `procesarYapeDefinitivo()` |
