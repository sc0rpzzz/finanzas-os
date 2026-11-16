# Pruebas de FINANZAS OS

No necesitan Node, Python ni desplegar nada: corren en el navegador con un mini servidor de PowerShell.
Usan los `.gs` reales sobre un mock de Apps Script (`gas-mock.js`) y datos de prueba (`server.test.js`). Nunca tocan tu API ni tu Sheet.

```bash
powershell -ExecutionPolicy Bypass -File tests\serve.ps1
```

| Abre | Qué hace |
|---|---|
| `http://localhost:8765/tests/run.html` | pruebas del servidor: comportamiento nuevo + lo que ya funcionaba (arriba: «N OK · 0 con error») |
| `http://localhost:8765/mock/` | la PWA real con un backend simulado (datos de prueba; se reinician al recargar) para probar la interfaz en PC y móvil |

**Diferencial** (antes de subir un cambio de backend): guarda una copia del proyecto anterior y arranca con
`-Orig C:\ruta\copia`; luego abre `/tests/run.html?orig=/orig/apps-script/`. Compara lecturas y escrituras de ambas
versiones con los mismos datos: si algo cambia sin querer, aparece en rojo.

Archivos: `gas-mock.js` (mock), `server.test.js` (datos y pruebas), `run.html` (ejecutor), `mock-backend.js` (backend simulado para `/mock/`), `serve.ps1` (servidor).
