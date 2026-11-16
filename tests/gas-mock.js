/* FINANZAS OS · Mock mínimo de Google Apps Script (SpreadsheetApp, Utilities, Properties…) para probar los .gs
 * sin desplegar. Funciona en el navegador y en Node (vm). Zona horaria fija America/Lima (UTC−5, sin horario de verano).
 * Uso: const env = GasMock.load(sourcesConcatenados, { sheets: {...} }); env.call('ping') */
(function (root) {
  'use strict';
  const LIMA_OFFSET_H = -5;
  const pad = (n, w = 2) => String(n).padStart(w, '0');

  /** Fecha "de pared" en Lima -> Date real. */
  function L(y, m, d, hh = 0, mi = 0, ss = 0) { return new Date(Date.UTC(y, m - 1, d, hh - LIMA_OFFSET_H, mi, ss)); }

  function limaParts(date) {
    const x = new Date(date.getTime() + LIMA_OFFSET_H * 3600000);
    return { y: x.getUTCFullYear(), M: x.getUTCMonth() + 1, d: x.getUTCDate(), H: x.getUTCHours(), m: x.getUTCMinutes(), s: x.getUTCSeconds() };
  }

  function formatDate(date, tz, fmt) {
    const p = limaParts(date);
    return fmt.replace(/'([^']*)'|yyyy|MM|dd|HH|mm|ss/g, (t, lit) => {
      if (lit !== undefined) return lit;
      return { yyyy: pad(p.y, 4), MM: pad(p.M), dd: pad(p.d), HH: pad(p.H), mm: pad(p.m), ss: pad(p.s) }[t];
    });
  }

  function parseDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(s);
    if (!m) throw new Error('parseDate: formato no soportado en el mock: ' + s);
    return L(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
  }

  /** Hash determinista (no criptográfico): basta para comparar tokens y generar IDs en pruebas. */
  function digest(alg, s) {
    const out = [];
    let h = 2166136261 >>> 0;
    const str = String(alg) + '|' + String(s);
    for (let round = 0; round < 32; round++) {
      for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i) + round; h = Math.imul(h, 16777619) >>> 0; }
      out.push(((h & 0xff) << 24) >> 24); // bytes con signo, como Apps Script
    }
    return out;
  }

  const clone = (v) => (v instanceof Date ? new Date(v.getTime()) : v);

  class Range {
    constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
    getValues() {
      const out = [];
      for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(clone(this.sh._get(this.r + i, this.c + j))); out.push(row); }
      return out;
    }
    getValue() { return clone(this.sh._get(this.r, this.c)); }
    setValues(vals) {
      if (vals.length !== this.nr || vals.some((row) => row.length !== this.nc)) throw new Error('setValues: dimensiones no coinciden');
      vals.forEach((row, i) => row.forEach((v, j) => this.sh._set(this.r + i, this.c + j, v)));
      return this;
    }
    setValue(v) { this.sh._set(this.r, this.c, v); return this; }
    setNumberFormat(f) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sh.formats[(this.r + i) + ':' + (this.c + j)] = f; return this; }
    setFormula(f) { this.sh._set(this.r, this.c, ''); this.sh.formulas[this.r + ':' + this.c] = f; return this; }
    createTextFinder(text) {
      const range = this;
      return {
        matchEntireCell() { return this; }, matchCase() { return this; },
        replaceAllWith(nuevo) {
          let n = 0;
          for (let i = 0; i < range.nr; i++) for (let j = 0; j < range.nc; j++) {
            if (String(range.sh._get(range.r + i, range.c + j)) === text) { range.sh._set(range.r + i, range.c + j, nuevo); n++; }
          }
          return n;
        },
      };
    }
  }

  class Sheet {
    constructor(name, rows) {
      this.name = name;
      this.data = (rows || []).map((r) => r.map(clone));
      this.formats = {}; this.formulas = {};
      this.hooks = {}; // beforeAppend(row) / afterGetLastRow() para simular escrituras concurrentes del ETL
      this.calls = { appendRow: 0, setValues: 0, getLastRow: 0 };
    }
    _lastRow() { for (let i = this.data.length - 1; i >= 0; i--) if (this.data[i] && this.data[i].some((v) => v !== '' && v !== null && v !== undefined)) return i + 1; return 0; }
    _get(r, c) { const row = this.data[r - 1]; const v = row ? row[c - 1] : undefined; return v === undefined || v === null ? '' : v; }
    _set(r, c, v) { while (this.data.length < r) this.data.push([]); const row = this.data[r - 1]; while (row.length < c) row.push(''); row[c - 1] = clone(v); }
    getName() { return this.name; }
    getLastRow() {
      this.calls.getLastRow++;
      const n = this._lastRow();
      if (this.hooks.afterGetLastRow) this.hooks.afterGetLastRow(this); // el ETL escribe justo DESPUÉS de que leímos el valor
      return n;
    }
    getLastColumn() { let m = 0; this.data.forEach((r) => { for (let j = r.length - 1; j >= 0; j--) if (r[j] !== '' && r[j] != null) { m = Math.max(m, j + 1); break; } }); return m; }
    getRange(r, c, nr = 1, nc = 1) {
      if (typeof r === 'string') throw new Error('getRange A1 no soportado en el mock');
      if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error(`getRange inválido (${r},${c},${nr},${nc})`);
      return new Range(this, r, c, nr, nc);
    }
    appendRow(row) {
      this.calls.appendRow++;
      if (this.hooks.beforeAppend) this.hooks.beforeAppend(row, this);
      const r = this._lastRow() + 1;
      row.forEach((v, j) => this._set(r, j + 1, v));
      if (!row.length) this._set(r, 1, '');
      return this;
    }
    /** Lo que hace el ETL: appendRow sin pasar por la API (no respeta el lock). */
    etlAppend(row) { const h = this.hooks; this.hooks = {}; this.appendRow(row); this.hooks = h; }
    deleteRow(r) { this.data.splice(r - 1, 1); return this; }
    /** Filas como objetos {encabezado: valor} (para las aserciones). */
    objects() {
      const head = (this.data[0] || []).map(String);
      return this.data.slice(1, this._lastRow()).map((r, i) => { const o = { __row: i + 2 }; head.forEach((h, j) => { o[h] = r[j] === undefined ? '' : r[j]; }); return o; });
    }
  }

  function load(source, opts = {}) {
    const sheets = {};
    Object.keys(opts.sheets || {}).forEach((n) => { sheets[n] = new Sheet(n, opts.sheets[n]); });
    const props = Object.assign({ API_TOKEN: 'T'.repeat(40) }, opts.props || {});
    const cache = {};
    const telegram = [];
    const triggers = [];
    const ss = {
      getSheetByName: (n) => sheets[n] || null,
      insertSheet: (n) => (sheets[n] = new Sheet(n, [])),
      getSpreadsheetTimeZone: () => 'America/Lima',
    };
    const G = {
      SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss, flush: () => {} },
      PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
      CacheService: { getScriptCache: () => ({ get: (k) => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }) },
      LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
      Utilities: {
        DigestAlgorithm: { SHA_256: 'SHA_256', MD5: 'MD5' }, Charset: { UTF_8: 'UTF_8' },
        computeDigest: digest, formatDate, parseDate: (s) => parseDate(s),
        getUuid: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, () => (Math.random() * 16 | 0).toString(16)),
      },
      ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: (s) => ({ setMimeType() { return this; }, getContent: () => s }) },
      UrlFetchApp: { fetch: (url, o) => { telegram.push(JSON.parse(o.payload).text); return { getResponseCode: () => 200 }; } },
      ScriptApp: {
        getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.fn, _t: t })),
        deleteTrigger: (x) => { const i = triggers.indexOf(x._t); if (i >= 0) triggers.splice(i, 1); },
        newTrigger: (fn) => { const t = { fn }; return { timeBased() { return this; }, everyHours(n) { t.hours = n; return this; }, everyDays(n) { t.days = n; return this; }, atHour(h) { t.atHour = h; return this; }, create() { triggers.push(t); } }; },
      },
      Logger: { log: () => {} },
      console: { log: () => {}, error: (...a) => { (opts.errors || []).push(a.join(' ')); } },
    };
    // reloj simulado: con opts.now, `new Date()` y Date.now() dentro de los .gs devuelven esa hora (las fechas de la hoja siguen siendo Date reales)
    if (opts.now != null) {
      const RealDate = Date, fixed = () => (typeof opts.now === 'function' ? opts.now() : new RealDate(opts.now)).getTime();
      class FakeDate extends RealDate {
        constructor(...a) { if (a.length) super(...a); else super(fixed()); }
        static now() { return fixed(); }
        static [Symbol.hasInstance](x) { return x instanceof RealDate; }
      }
      G.Date = FakeDate;
    }
    const names = Object.keys(G);
    const exportsList = ['doPost', 'doGet', 'FOS_CFG', 'fosFindDuplicates_', 'fosReadTable_', 'fosTz_', 'fosWatch', 'fosNightly', 'fosNotifyCards', 'fosNotifyPending', 'fosInstallTriggers', 'fosNudge', 'fosEtlProgramado'];
    // eslint-disable-next-line no-new-func
    const factory = new Function(...names, source + '\n;return {' + exportsList.map((n) => `${n}: typeof ${n} !== 'undefined' ? ${n} : undefined`).join(',') + '};');
    const api = factory(...names.map((n) => G[n]));
    const env = {
      api, sheets, props, telegram, triggers,
      call(action, payload, token) {
        const out = api.doPost({ postData: { contents: JSON.stringify({ token: token === undefined ? props.API_TOKEN : token, action, payload: payload || {} }) } });
        return JSON.parse(out.getContent());
      },
    };
    return env;
  }

  const GasMock = { load, L, Sheet, formatDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = GasMock; else root.GasMock = GasMock;
})(typeof window !== 'undefined' ? window : globalThis);
