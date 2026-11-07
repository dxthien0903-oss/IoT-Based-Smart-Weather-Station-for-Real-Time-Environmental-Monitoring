# start-tunnel.ps1 — Chạy Cloudflare Tunnel cho Weather Station
#
# Cách dùng (PowerShell):
#   .\start-tunnel.ps1
#
# Link HTTPS sẽ được in ra, ví dụ:
#   https://assistance-midlands-union-plugin.trycloudflare.com
#
# Script cũng tự ghi link hiện tại vào file tunnel-url.txt (để ESP8266 tự
# lấy link — xem README mục 12B.7). Đổi link mỗi lần chạy lại cũng không sao.
#
# LƯU Ý: quick tunnel tạo URL NGẪU NHIÊN, đổi mỗi lần chạy lại.
# Muốn URL cố định → dùng named tunnel (cần domain, xem README mục 12B.2).

param(
    # Ghi link vào file này (để ESP8266 tự đọc)
    [string]$UrlFile = (Join-Path $PSScriptRoot 'tunnel-url.txt')
)

$ErrorActionPreference = 'Stop'

Write-Host "=== Cloudflare Tunnel cho IoT Weather Station ===" -ForegroundColor Cyan

# 1. Tìm cloudflared
$cf = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cf) {
    $paths = @(
        "C:\Program Files (x86)\cloudflared\cloudflared.exe",
        "C:\Program Files\cloudflared\cloudflared.exe"
    ) | Where-Object { Test-Path $_ }
    if ($paths) {
        $cf = $paths[0]
    } else {
        Write-Host "Chưa cài cloudflared. Đang cài..." -ForegroundColor Yellow
        winget install --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements
        $cf = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
    }
}
Write-Host "cloudflared: $cf" -ForegroundColor DarkGray

# 2. Kiểm tra backend đang chạy
try {
    $health = Invoke-RestMethod -Uri 'http://localhost:3000/api/health' -TimeoutSec 5
    Write-Host "Backend OK (uptime $($health.uptimeSec)s)" -ForegroundColor Green
} catch {
    Write-Host "Backend CHƯA chạy! Hãy mở terminal khác và chạy: cd Backend; npm start" -ForegroundColor Red
    exit 1
}

# 3. Khởi động tunnel
$log = Join-Path $env:TEMP 'cloudflared-tunnel.log'
Remove-Item $log -Force -ErrorAction SilentlyContinue

Write-Host "`nĐang tạo tunnel... (nhấn Ctrl+C để dừng)" -ForegroundColor Yellow
$proc = Start-Process -FilePath $cf -ArgumentList `
    'tunnel', '--url', 'http://localhost:3000', '--no-autoupdate', `
    '--logfile', $log, '--loglevel', 'info' `
    -PassThru -WindowStyle Hidden

# 4. Chờ lấy URL
$url = $null
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $log) {
        $match = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches |
            Select-Object -First 1
        if ($match) {
            $url = $match.Matches[0].Value
            break
        }
    }
}

if (-not $url) {
    Write-Host "Không lấy được URL. Xem log: $log" -ForegroundColor Red
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    exit 1
}

# 5. Ghi URL vào file (ESP8266 đọc file này để tự lấy link)
#    Dùng WriteAllText + UTF8Encoding(false) để KHÔNG ghi BOM —
#    Arduino String.trim() không loại BOM nên firmware sẽ đọc hỏng URL.
try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($UrlFile, "$url/api/sensors", $utf8NoBom)
    Write-Host "Đã lưu link vào: $UrlFile" -ForegroundColor DarkGray
} catch {
    Write-Host "Không ghi được file $UrlFile : $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "`n============================================" -ForegroundColor Cyan
Write-Host "  TUNNEL HTTPS ĐANG HOẠT ĐỘNG:" -ForegroundColor Green
Write-Host "  $url" -ForegroundColor White
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "`nMở link trên điện thoại (cùng hoặc khác mạng đều được)."
Write-Host "`nESP8266 - dung 1 trong 2 cach:"
Write-Host "  A) URL co dinh (khong phai nap lai firmware khi link doi):" -ForegroundColor Yellow
Write-Host "     #define SERVER_URL `"@https://raw.githubusercontent.com/USER/REPO/main/tunnel-url.txt`"" -ForegroundColor White
Write-Host "  B) URL cung (phai nap lai firmware moi lan doi link):" -ForegroundColor Yellow
Write-Host "     #define SERVER_URL `"$url/api/sensors`"" -ForegroundColor White
Write-Host "`nNhan Ctrl+C de dung tunnel."

try {
    while ($true) { Start-Sleep -Seconds 5 }
} finally {
    Write-Host "`nDang dung tunnel..." -ForegroundColor Yellow
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
