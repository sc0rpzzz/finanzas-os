/* FINANZAS OS · Backend simulado para probar la PWA en el navegador sin tocar tu API ni tus datos.
 * Carga los .gs reales sobre el mock (tests/gas-mock.js) con los datos de prueba (tests/server.test.js)
 * y responde los fetch a script.google.com. Lo inyecta tests/serve.ps1 en /mock/. Los datos se reinician al recargar. */
(function () {
  'use strict';
  const T = window.FosServerTests;
  const src = T.FILES.map((f) => { const x = new XMLHttpRequest(); x.open('GET', '/apps-script/' + f, false); x.send(); return x.responseText; }).join('\n;\n');
  const env = window.GasMock.load(src + '\n;\n' + T.STUBS, { sheets: T.fixture() }); // + tu ETL y sync de Yape simulados
  window.__mockEnv = env;
  const URL = 'https://script.google.com/macros/s/MOCK_TEST_DEPLOYMENT/exec';
  try { localStorage.setItem('fos.url', URL); localStorage.setItem('fos.token', env.props.API_TOKEN); } catch (e) { /* sin storage */ }
  window.FOS_CONFIG = { API_URL: URL };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    if (String(url).indexOf('https://script.google.com/') !== 0) return realFetch(url, opts);
    const body = JSON.parse(opts.body);
    await new Promise((r) => setTimeout(r, 30));
    const out = env.call(body.action, body.payload, body.token);
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
})();
