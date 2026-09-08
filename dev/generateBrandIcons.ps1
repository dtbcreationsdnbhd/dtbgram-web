# Regenerates every favicon / app icon in `public` from `src/assets/kingdom-ascend-logo.png`.
# Usage (from the repo root):  powershell -NoProfile -ExecutionPolicy Bypass -File dev/generateBrandIcons.ps1

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $repo 'src\assets\kingdom-ascend-logo.png'

# Read through a stream so the source file itself stays writable
$bytes = [System.IO.File]::ReadAllBytes($sourcePath)
$ms = New-Object System.IO.MemoryStream($bytes, $false)
$src = [System.Drawing.Image]::FromStream($ms)

function New-Scaled {
  param([int]$Size, [string]$Background)

  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CompositingQuality = 'HighQuality'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $g.SmoothingMode = 'HighQuality'
  if ($Background) {
    $g.Clear([System.Drawing.ColorTranslator]::FromHtml($Background))
  } else {
    $g.Clear([System.Drawing.Color]::Transparent)
  }
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)))
  $g.Dispose()
  return $bmp
}

function Save-Png {
  param([int]$Size, [string]$Path, [string]$Background)

  $bmp = New-Scaled -Size $Size -Background $Background
  $bmp.Save((Join-Path $repo $Path), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("  {0,-42} {1}x{1}" -f $Path, $Size)
}

function Save-Ico {
  param([int[]]$Sizes, [string]$Path)

  $frames = @()
  foreach ($size in $Sizes) {
    $bmp = New-Scaled -Size $size
    $frameStream = New-Object System.IO.MemoryStream
    $bmp.Save($frameStream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $frames += [pscustomobject]@{ Size = $size; Bytes = $frameStream.ToArray() }
    $frameStream.Dispose()
  }

  $fs = [System.IO.File]::Create((Join-Path $repo $Path))
  $w = New-Object System.IO.BinaryWriter($fs)

  # ICONDIR: reserved, type (1 = icon), image count
  $w.Write([uint16]0)
  $w.Write([uint16]1)
  $w.Write([uint16]$frames.Count)

  # ICONDIRENTRY table, then the PNG payloads it points at
  $offset = 6 + (16 * $frames.Count)
  foreach ($frame in $frames) {
    $dim = if ($frame.Size -ge 256) { 0 } else { $frame.Size }
    $w.Write([byte]$dim)
    $w.Write([byte]$dim)
    $w.Write([byte]0)
    $w.Write([byte]0)
    $w.Write([uint16]1)
    $w.Write([uint16]32)
    $w.Write([uint32]$frame.Bytes.Length)
    $w.Write([uint32]$offset)
    $offset += $frame.Bytes.Length
  }
  foreach ($frame in $frames) { $w.Write($frame.Bytes) }

  $w.Dispose()
  $fs.Dispose()
  Write-Output ("  {0,-42} {1}" -f $Path, ($Sizes -join ','))
}

Write-Output 'PWA icons:'
foreach ($size in 192, 384, 512) {
  Save-Png -Size $size -Path "public\icon-$($size)x$($size).png"
  Save-Png -Size $size -Path "public\icon-dev-$($size)x$($size).png"
  Save-Png -Size $size -Path "public\icon-square-$($size)x$($size).png"
  Save-Png -Size $size -Path "public\icon-square-dev-$($size)x$($size).png"
}

Write-Output 'Platform icons:'
Save-Png -Size 512 -Path 'public\icon-electron-macos.png'
Save-Png -Size 150 -Path 'public\mstile-150x150.png'
# iOS composites transparency onto black, so these are flattened
Save-Png -Size 180 -Path 'public\apple-touch-icon.png' -Background '#ffffff'
Save-Png -Size 180 -Path 'public\apple-touch-icon-dev.png' -Background '#ffffff'

Write-Output 'Favicons:'
foreach ($size in 16, 32) {
  Save-Png -Size $size -Path "public\favicon-$($size)x$($size).png"
  Save-Png -Size $size -Path "public\favicon-unread-$($size)x$($size).png"
}
Save-Ico -Sizes 16, 32, 48 -Path 'public\favicon.ico'
Save-Ico -Sizes 16, 32, 48 -Path 'public\favicon-unread.ico'

$src.Dispose()
$ms.Dispose()
Write-Output 'Done.'
