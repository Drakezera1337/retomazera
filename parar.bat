@echo off
rem Para o servidor do Retomazera (que roda sem janela)
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 8797 -State Listen -ErrorAction SilentlyContinue; if ($c) { Stop-Process -Id $c.OwningProcess -Force; Write-Host 'Retomazera parado.' } else { Write-Host 'O Retomazera nao estava rodando.' }"
timeout /t 3 >nul
