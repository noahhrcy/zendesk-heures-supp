# Installe l'extension Heures supp Zendesk dans %LOCALAPPDATA%\HeuresSuppZendesk,
# puis ouvre la page des extensions du navigateur (Brave ou Chrome).
#   -Source <dossier> : copie depuis ce dossier (archive deja extraite)
#   sans -Source      : telecharge la derniere version depuis GitHub
param(
    [string]$Source = '',
    [string]$Dossier = (Join-Path $env:LOCALAPPDATA 'HeuresSuppZendesk'),
    [switch]$SansPause,
    [switch]$SansNavigateur
)
$ErrorActionPreference = 'Stop'
$Depot = 'noahhrcy/zendesk-heures-supp'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Fin([int]$code) {
    if (-not $SansPause) { [void](Read-Host 'Appuyez sur Entree pour fermer') }
    exit $code
}

try {
    $tmp = $null
    if (-not $Source) {
        $tmp = Join-Path $env:TEMP ('heures-supp-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tmp | Out-Null
        $zip = Join-Path $tmp 'source.zip'
        Write-Host 'Telechargement depuis GitHub...'
        Invoke-WebRequest "https://codeload.github.com/$Depot/zip/refs/heads/main" -OutFile $zip -UseBasicParsing
        Expand-Archive -Path $zip -DestinationPath $tmp
        $Source = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
    }
    if (-not (Test-Path (Join-Path $Source 'manifest.json'))) { throw "manifest.json introuvable dans $Source" }
    $version = (Get-Content (Join-Path $Source 'manifest.json') -Raw | ConvertFrom-Json).version

    New-Item -ItemType Directory -Force -Path $Dossier | Out-Null
    robocopy $Source $Dossier /E /XF config.local.json /XD .git /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "copie impossible (robocopy $LASTEXITCODE)" }
    if ($tmp) { Remove-Item -Recurse -Force $tmp }

    # config.local.json : reglages propres a ce poste (jamais publies). On y
    # note le dossier d'installation, affiche par l'extension pour les mises a jour.
    $cfgPath = Join-Path $Dossier 'config.local.json'
    $cfg = [ordered]@{}
    if (Test-Path $cfgPath) {
        $old = Get-Content $cfgPath -Raw | ConvertFrom-Json
        foreach ($p in $old.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
    }
    $cfg['installDir'] = $Dossier
    [IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))

    Set-Clipboard -Value $Dossier
    Write-Host ''
    Write-Host "Heures supp Zendesk $version installee dans :" -ForegroundColor Green
    Write-Host "  $Dossier"
    Write-Host '(chemin copie dans le presse-papiers)'
    Write-Host ''
    Write-Host 'Dans le navigateur (page des extensions) :'
    Write-Host '  1. Activer le "Mode developpeur" (en haut a droite)'
    Write-Host '  2. Cliquer "Charger l''extension non empaquetee"'
    Write-Host '  3. Coller le chemin (Ctrl+V) puis valider'
    Write-Host ''
    Write-Host 'Ne supprimez pas ce dossier : le navigateur lit l''extension directement dedans.'

    if (-not $SansNavigateur) {
        $brave = @("$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe", "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
        $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($brave) { Start-Process -FilePath $brave -ArgumentList 'brave://extensions' }
        elseif ($chrome) { Start-Process -FilePath $chrome -ArgumentList 'chrome://extensions' }
    }
    Fin 0
}
catch {
    Write-Host "Echec de l'installation : $($_.Exception.Message)" -ForegroundColor Red
    Fin 1
}
