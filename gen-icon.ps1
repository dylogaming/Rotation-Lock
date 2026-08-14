# Copyright (c) 2026 DYLO Gaming LLC. All rights reserved.
Add-Type -AssemblyName System.Drawing

# Draws a padlock (open or closed): gold when locked, grey/silver when unlocked. No status dot.
function New-LockBitmap([int]$size, [string]$state) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # Dark rounded square background
    $pad = [Math]::Max(1, [int]($size * 0.05))
    $rect = New-Object System.Drawing.RectangleF $pad, $pad, ($size - 2*$pad), ($size - 2*$pad)
    $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF 0,0),
        (New-Object System.Drawing.PointF $size,$size),
        [System.Drawing.Color]::FromArgb(255, 34, 40, 58),
        [System.Drawing.Color]::FromArgb(255, 20, 24, 36))
    $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = [int]($size * 0.22)
    $bgPath.AddArc($rect.X, $rect.Y, $r, $r, 180, 90)
    $bgPath.AddArc($rect.Right - $r, $rect.Y, $r, $r, 270, 90)
    $bgPath.AddArc($rect.Right - $r, $rect.Bottom - $r, $r, $r, 0, 90)
    $bgPath.AddArc($rect.X, $rect.Bottom - $r, $r, $r, 90, 90)
    $bgPath.CloseFigure()
    $g.FillPath($bg, $bgPath)

    # Lock dimensions (centered)
    $cx = $size / 2.0
    $bodyW = $size * 0.52
    $bodyH = $size * 0.36
    $bodyX = $cx - $bodyW / 2.0
    $bodyY = $size * 0.48
    $shackleW = $bodyW * 0.62
    $shackleH = $bodyH * 0.95
    $shackleX = $cx - $shackleW / 2.0
    $shackleY = $size * 0.20
    $strokeW = [Math]::Max(2.0, $size * 0.07)

    # Body + shackle color gradient
    if ($state -eq 'locked') {
        $fillColors = @(
            [System.Drawing.Color]::FromArgb(255, 207, 154, 52),   # deep gold (#cf9a34, matches app)
            [System.Drawing.Color]::FromArgb(255, 255, 216, 106)   # bright gold (#ffd86a, matches app)
        )
    } else {
        $fillColors = @(
            [System.Drawing.Color]::FromArgb(255, 130, 138, 156),  # cool silver base
            [System.Drawing.Color]::FromArgb(255, 186, 194, 212)   # silver highlight
        )
    }
    $metal = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF $bodyX, ($bodyY + $bodyH)),
        (New-Object System.Drawing.PointF $bodyX, $bodyY),
        $fillColors[0], $fillColors[1])
    $stroke = New-Object System.Drawing.Pen $fillColors[1], $strokeW
    $stroke.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $stroke.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $stroke.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round

    # Shackle
    if ($state -eq 'locked') {
        # Closed U-shape: arc on top, legs go down into the body
        $arcRect = New-Object System.Drawing.RectangleF $shackleX, $shackleY, $shackleW, ($shackleH * 1.6)
        $g.DrawArc($stroke, $arcRect, 180, 180)
    } else {
        # Open: arc shifted up and rotated slightly; right leg detached
        # Draw a slightly-lifted, tilted U
        $state2 = $g.Save()
        $g.TranslateTransform($cx, $shackleY + $shackleH * 0.4)
        $g.RotateTransform(-18)
        $g.TranslateTransform(-$cx, -($shackleY + $shackleH * 0.4))
        $arcRect2 = New-Object System.Drawing.RectangleF $shackleX, ($shackleY - $size * 0.05), $shackleW, ($shackleH * 1.6)
        $g.DrawArc($stroke, $arcRect2, 180, 180)
        $g.Restore($state2)
    }

    # Lock body (rounded rectangle)
    $bodyPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $br = [int]($bodyH * 0.22)
    $bodyPath.AddArc($bodyX, $bodyY, $br, $br, 180, 90)
    $bodyPath.AddArc($bodyX + $bodyW - $br, $bodyY, $br, $br, 270, 90)
    $bodyPath.AddArc($bodyX + $bodyW - $br, $bodyY + $bodyH - $br, $br, $br, 0, 90)
    $bodyPath.AddArc($bodyX, $bodyY + $bodyH - $br, $br, $br, 90, 90)
    $bodyPath.CloseFigure()
    $g.FillPath($metal, $bodyPath)

    # Polish highlight along top edge
    $highlightRect = New-Object System.Drawing.RectangleF $bodyX, $bodyY, $bodyW, ($bodyH * 0.33)
    $hiBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF $bodyX, $bodyY),
        (New-Object System.Drawing.PointF $bodyX, ($bodyY + $bodyH * 0.33)),
        [System.Drawing.Color]::FromArgb(90, 255, 255, 255),
        [System.Drawing.Color]::FromArgb(0, 255, 255, 255))
    $hiPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $hiPath.AddArc($bodyX, $bodyY, $br, $br, 180, 90)
    $hiPath.AddArc($bodyX + $bodyW - $br, $bodyY, $br, $br, 270, 90)
    $hiPath.AddLine($bodyX + $bodyW, ($bodyY + $bodyH * 0.33), $bodyX, ($bodyY + $bodyH * 0.33))
    $hiPath.CloseFigure()
    $g.FillPath($hiBrush, $hiPath)

    # Keyhole (darker)
    $khR = $bodyH * 0.14
    $khX = $cx - $khR
    $khY = $bodyY + $bodyH * 0.33
    $dark = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 22, 26, 42))
    $g.FillEllipse($dark, $khX, $khY, $khR*2, $khR*2)
    $slotW = $khR * 0.7
    $slotH = $bodyH * 0.30
    $g.FillRectangle($dark, ($cx - $slotW/2), ($khY + $khR*0.6), $slotW, $slotH)

    $g.Dispose(); $bg.Dispose(); $bgPath.Dispose(); $metal.Dispose(); $stroke.Dispose()
    $hiBrush.Dispose(); $hiPath.Dispose(); $dark.Dispose(); $bodyPath.Dispose()
    return $bmp
}

function Save-RawRgba($bmp, $path) {
    $w = $bmp.Width; $h = $bmp.Height
    $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $data.Stride
    $bytes = New-Object byte[] ($stride * $h)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
    $bmp.UnlockBits($data)
    $rgba = New-Object byte[] ($w * $h * 4)
    for ($y = 0; $y -lt $h; $y++) {
        for ($x = 0; $x -lt $w; $x++) {
            $src = $y * $stride + $x * 4
            $dst = ($y * $w + $x) * 4
            $rgba[$dst]   = $bytes[$src + 2]
            $rgba[$dst+1] = $bytes[$src + 1]
            $rgba[$dst+2] = $bytes[$src]
            $rgba[$dst+3] = $bytes[$src + 3]
        }
    }
    [System.IO.File]::WriteAllBytes($path, $rgba)
}

function Save-Png($bmp, $path) {
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function BmpToPngBytes($bmp) {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $b = $ms.ToArray()
    $ms.Dispose()
    return ,$b
}

function New-IcoFromBitmaps([hashtable]$bmps, $icoPath) {
    $sizes = ($bmps.Keys | Sort-Object)
    $pngs = @()
    foreach ($s in $sizes) { $pngs += ,(BmpToPngBytes $bmps[$s]) }
    $headerSize = 6 + ($pngs.Count * 16)
    $out = [System.Collections.Generic.List[byte]]::new()
    $out.Add(0); $out.Add(0); $out.Add(1); $out.Add(0); $out.Add($pngs.Count); $out.Add(0)
    $offset = $headerSize
    for ($i = 0; $i -lt $pngs.Count; $i++) {
        $s = $sizes[$i]; $png = $pngs[$i]
        $w = if ($s -ge 256) { 0 } else { $s }
        $h = if ($s -ge 256) { 0 } else { $s }
        $out.Add($w); $out.Add($h); $out.Add(0); $out.Add(0)
        $out.Add(1); $out.Add(0); $out.Add(32); $out.Add(0)
        $out.Add($png.Length -band 0xFF); $out.Add(($png.Length -shr 8) -band 0xFF)
        $out.Add(($png.Length -shr 16) -band 0xFF); $out.Add(($png.Length -shr 24) -band 0xFF)
        $out.Add($offset -band 0xFF); $out.Add(($offset -shr 8) -band 0xFF)
        $out.Add(($offset -shr 16) -band 0xFF); $out.Add(($offset -shr 24) -band 0xFF)
        $offset += $png.Length
    }
    foreach ($png in $pngs) { $out.AddRange([byte[]]$png) }
    [System.IO.File]::WriteAllBytes($icoPath, $out.ToArray())
}

$dir = Join-Path $PSScriptRoot 'src-tauri\icons'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# Runtime RGBA (64x64) for window and tray
$lg = New-LockBitmap 64 'unlocked'
$lr = New-LockBitmap 64 'locked'
Save-RawRgba $lg (Join-Path $dir 'lock_green_64.rgba')
Save-RawRgba $lr (Join-Path $dir 'lock_red_64.rgba')
Save-Png     $lg (Join-Path $dir 'lock_green_64.png')
Save-Png     $lr (Join-Path $dir 'lock_red_64.png')

# Multi-size ICO (default = unlocked) for exe resource
$sizes = @(16, 32, 48, 64, 128, 256)
$bmps = @{}
foreach ($s in $sizes) { $bmps[$s] = New-LockBitmap $s 'unlocked' }
New-IcoFromBitmaps $bmps (Join-Path $dir 'icon.ico')
foreach ($b in $bmps.Values) { $b.Dispose() }
$lg.Dispose(); $lr.Dispose()

Get-ChildItem $dir | Format-Table Name, Length
