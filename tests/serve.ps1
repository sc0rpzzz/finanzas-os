# FINANZAS OS · servidor estático local para las pruebas (sin Node ni Python).
#   powershell -ExecutionPolicy Bypass -File tests\serve.ps1 [-Port 8765] [-Orig C:\ruta\copia-anterior]
# Rutas:
#   /tests/run.html          pruebas del servidor
#   /mock/                   la PWA real (docs/index.html) con un backend simulado (tests/mock-backend.js), sin tocar tu API
#   /orig/...                (opcional) otra copia del proyecto, para el diferencial: /tests/run.html?orig=/orig/apps-script/
param([int]$Port = 8765, [string]$Orig = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$types = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.gs'='text/plain; charset=utf-8'; '.css'='text/css';
  '.json'='application/json'; '.webmanifest'='application/manifest+json'; '.svg'='image/svg+xml'; '.png'='image/png'; '.md'='text/plain; charset=utf-8' }
$l = New-Object System.Net.HttpListener
$l.Prefixes.Add("http://localhost:$Port/")
$l.Start()
Write-Host "Sirviendo $root en http://localhost:$Port/"
while ($l.IsListening) {
  $ctx = $l.GetContext()
  $res = $ctx.Response
  try {
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    $res.Headers.Add('Cache-Control', 'no-store')
    if ($path -eq '/mock/' -or $path -eq '/mock/index.html') {
      $html = [IO.File]::ReadAllText((Join-Path $root 'docs\index.html'), [Text.Encoding]::UTF8)
      $inject = '<base href="/docs/"><script src="/tests/gas-mock.js"></script><script src="/tests/server.test.js"></script><script src="/tests/mock-backend.js"></script>'
      $html = $html.Replace('<head>', '<head>' + $inject)
      $bytes = [Text.Encoding]::UTF8.GetBytes($html); $res.ContentType = $types['.html']
    } else {
      $base = $root; $rel = $path.TrimStart('/')
      if ($Orig -and $rel.StartsWith('orig/')) { $base = $Orig; $rel = $rel.Substring(5) }
      $file = [IO.Path]::GetFullPath((Join-Path $base $rel))
      if (-not $file.StartsWith([IO.Path]::GetFullPath($base)) -or -not (Test-Path $file -PathType Leaf)) { $res.StatusCode = 404; $bytes = [Text.Encoding]::UTF8.GetBytes('404') }
      else { $bytes = [IO.File]::ReadAllBytes($file); $ext = [IO.Path]::GetExtension($file); if ($types[$ext]) { $res.ContentType = $types[$ext] } }
    }
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  } catch { $res.StatusCode = 500 } finally { $res.Close() }
}
