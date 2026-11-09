# Retomazera: roda pelo Agendador de Tarefas do Windows às 06:50, antes da coleta (07:00) e da análise (07:15).
# Se o app desktop do Claude não estiver aberto, abre. Garante os perfis do Chrome usados pela coleta.
$log = Join-Path $PSScriptRoot 'garantir_claude.log'
function Log($m) { Add-Content -Path $log -Value ("{0:dd/MM/yyyy HH:mm:ss} {1}" -f (Get-Date), $m) -Encoding utf8 }
if ((Test-Path $log) -and (Get-Item $log).Length -gt 200KB) { Remove-Item $log }

# O app desktop fica em WindowsApps\Claude_*\app\Claude.exe (os claude.exe do Claude Code não contam)
$app = Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\WindowsApps\Claude_*\app\Claude.exe' }
if ($app) {
    Log 'Claude já estava aberto.'
} else {
    Start-Process explorer.exe 'shell:AppsFolder\Claude_pzs8sxrjxfjjc!Claude'
    Log 'Claude estava fechado: abrindo.'
}

# Os dois perfis precisam estar CARREGADOS às 07:00 para a extensão Retomazera Coletor de cada um rodar
# (João Luiz = WhatsApp/Facebook; Joao = OLX). --no-startup-window carrega o perfil sem abrir janela;
# se o perfil já estiver aberto, não faz nada. A própria extensão abre a janela da coleta.
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chrome)) { $chrome = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" }
if (Test-Path $chrome) {
    $estava = [bool](Get-Process -Name chrome -ErrorAction SilentlyContinue)
    Start-Process $chrome '--profile-directory=Default --no-startup-window'
    Start-Sleep -Seconds 5
    Start-Process $chrome '--profile-directory="Profile 4" --no-startup-window'
    Log ("Perfis João Luiz e Joao garantidos no Chrome (Chrome já estava aberto: {0})." -f $estava)
} else {
    Log 'Chrome não encontrado.'
}
