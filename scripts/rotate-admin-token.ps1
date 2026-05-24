$token = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 32 | ForEach-Object { [char]$_ })

Write-Host ""
Write-Host "Generated ADMIN_TOKEN: $token" -ForegroundColor Green
Write-Host ""

$confirm = Read-Host "Set this as Cloudflare Worker secret? (y/n)"

if ($confirm -eq 'y' -or $confirm -eq 'Y') {
    $token | npx wrangler secret put ADMIN_TOKEN
    Write-Host ""
    Write-Host "ADMIN_TOKEN has been updated!" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "Skipped. You can manually set it with:" -ForegroundColor Yellow
    Write-Host "  echo '$token' | npx wrangler secret put ADMIN_TOKEN" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Also update your local .dev.vars file with:" -ForegroundColor Cyan
Write-Host "  ADMIN_TOKEN=$token" -ForegroundColor Cyan
