# Genere les icones PNG de l'extension (horloge sur fond bleu nuit + pastille turquoise).
# Usage : powershell -ExecutionPolicy Bypass -File outils\make-icons.ps1
Add-Type -AssemblyName System.Drawing

$dir = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$navy = [System.Drawing.Color]::FromArgb(255, 1, 8, 84)
$navyLight = [System.Drawing.Color]::FromArgb(255, 28, 42, 134)
$turquoise = [System.Drawing.Color]::FromArgb(255, 72, 229, 229)
$cyan = [System.Drawing.Color]::FromArgb(255, 0, 161, 224)

function New-Icon([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $s = $size / 128.0

    # Fond : carre arrondi bleu nuit en degrade
    $r = 30 * $s
    $w = $size - 1
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
    $path.AddArc($w - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
    $path.AddArc($w - 2 * $r, $w - 2 * $r, 2 * $r, 2 * $r, 0, 90)
    $path.AddArc(0, $w - 2 * $r, 2 * $r, 2 * $r, 90, 90)
    $path.CloseFigure()
    $rect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
    $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $navyLight, $navy, 55
    $g.FillPath($bg, $path)

    # Horloge : cadran blanc, aiguille des minutes turquoise
    $cx = 58 * $s; $cy = 62 * $s; $cr = 36 * $s
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([Math]::Max(1.6, 9 * $s))
    $g.DrawEllipse($pen, $cx - $cr, $cy - $cr, 2 * $cr, 2 * $cr)
    $hand = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([Math]::Max(1.6, 9 * $s))
    $hand.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $hand.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($hand, $cx, $cy, $cx, $cy - 21 * $s)
    $minute = New-Object System.Drawing.Pen $turquoise, ([Math]::Max(1.6, 9 * $s))
    $minute.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $minute.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($minute, $cx, $cy, $cx + 17 * $s, $cy + 10 * $s)

    # Pastille turquoise « + »
    $bx = 97 * $s; $by = 94 * $s; $br = 27 * $s
    $badgeRect = New-Object System.Drawing.RectangleF ($bx - $br), ($by - $br), (2 * $br), (2 * $br)
    $badge = New-Object System.Drawing.Drawing2D.LinearGradientBrush $badgeRect, $turquoise, $cyan, 45
    $g.FillEllipse($badge, $badgeRect)
    $ring = New-Object System.Drawing.Pen $navy, ([Math]::Max(1, 4 * $s))
    $g.DrawEllipse($ring, $bx - $br, $by - $br, 2 * $br, 2 * $br)
    $plus = New-Object System.Drawing.Pen $navy, ([Math]::Max(1.6, 8 * $s))
    $plus.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $plus.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($plus, $bx - 12 * $s, $by, $bx + 12 * $s, $by)
    $g.DrawLine($plus, $bx, $by - 12 * $s, $bx, $by + 12 * $s)

    $g.Dispose()
    $out = Join-Path $dir ("icon{0}.png" -f $size)
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $out
}

foreach ($size in 16, 32, 48, 128) { New-Icon $size }
