Add-Type -AssemblyName System.Drawing

function New-Icon([int]$size, [string]$out) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.TextRenderingHint = 'AntiAliasGridFit'
    # 主题蓝底
    $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 47, 111, 237))
    $g.FillRectangle($bg, 0, 0, $size, $size)
    # 田字格参考线
    $gridPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(90, 255, 255, 255)), ([single]($size * 0.012))
    $m = [int]($size * 0.08)
    $c = [int]($size / 2)
    $g.DrawLine($gridPen, $c, $m, $c, $size - $m)
    $g.DrawLine($gridPen, $m, $c, $size - $m, $c)
    # 居中"永"字
    $family = 'Microsoft YaHei'
    if ((New-Object System.Drawing.Text.InstalledFontCollection).Families | Where-Object { $_.Name -eq 'KaiTi' }) { $family = 'KaiTi' }
    $font = New-Object System.Drawing.Font($family, [single]($size * 0.56), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $white = [System.Drawing.Brushes]::White
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = 'Center'
    $fmt.LineAlignment = 'Center'
    $rect = New-Object System.Drawing.RectangleF(0, [single](-$size * 0.02), $size, $size)
    $g.DrawString([char]0x6C38, $font, $white, $rect, $fmt)
    $g.Dispose()
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "saved $out"
}

$dir = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
New-Icon 192 (Join-Path $dir 'icon-192.png')
New-Icon 512 (Join-Path $dir 'icon-512.png')
