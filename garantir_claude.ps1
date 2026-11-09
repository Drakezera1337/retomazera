# Retomazera: roda pelo Agendador de Tarefas do Windows às 23:50, antes da tarefa das 00h do Claude.
# Se o app desktop do Claude não estiver aberto, abre. Se o Chrome não estiver aberto, abre os perfis
# usados pela rotina (João Luiz = WhatsApp/Facebook; Joao = OLX).
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

$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chrome)) { $chrome = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" }
if (-not (Get-Process -Name chrome -ErrorAction SilentlyContinue)) {
    if (Test-Path $chrome) {
        Start-Process $chrome '--profile-directory=Default'
        Start-Sleep -Seconds 5
        Start-Process $chrome '--profile-directory="Profile 4"'
        Log 'Chrome estava fechado: abrindo os perfis João Luiz e Joao.'
    } else {
        Log 'Chrome não encontrado.'
    }
}
