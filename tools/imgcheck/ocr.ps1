# Reads the text off an image using the OCR engine built into Windows
# (Windows.Media.Ocr). Local, free, no API key and no extra install — which
# matters because this has to run over thousands of candidate bottle shots.
#
#   powershell -NoProfile -File tools/imgcheck/ocr.ps1 -Path bottle.png
#
# Prints the recognised text, one line per line found. Exit 1 if the file
# cannot be read or no OCR engine is available.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) {
  Write-Error "no such file: $Path"
  exit 1
}

# WindowsRuntimeSystemExtensions (the AsTask bridge below) lives in this
# assembly, which Windows PowerShell 5.1 does not load by default.
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# WinRT types are projected into PowerShell only once referenced this way.
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]      | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]      | Out-Null

# WinRT is async throughout and PowerShell has no await, so each IAsyncOperation
# is driven to completion through the generic AsTask + .Result.
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($op, $type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(30000) | Out-Null
  $task.Result
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) {
  Write-Error 'no OCR engine available for the current user languages'
  exit 1
}

$full = (Resolve-Path -LiteralPath $Path).Path
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

if ($Json) {
  $lines = @($result.Lines | ForEach-Object { $_.Text })
  [pscustomobject]@{ text = $result.Text; lines = $lines } | ConvertTo-Json -Compress
} else {
  $result.Lines | ForEach-Object { $_.Text }
}
