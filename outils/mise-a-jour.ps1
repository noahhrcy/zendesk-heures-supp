# Met a jour l'extension Heures supp Zendesk depuis GitHub.
# Lance par "Mettre-a-jour.bat" (dossier de l'extension). Ne touche jamais
# a config.local.json (vos reglages locaux). Rien n'est envoye nulle part.
param(
    [string]$Dossier = (Split-Path -Parent $PSScriptRoot),
    [switch]$SansPause
)
$ErrorActionPreference = 'Stop'
$Depot = 'noahhrcy/zendesk-heures-supp'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Fin([int]$code) {
    if (-not $SansPause) { [void](Read-Host 'Appuyez sur Entree pour fermer') }
    exit $code
}

try {
    $local = (Get-Content (Join-Path $Dossier 'manifest.json') -Raw | ConvertFrom-Json).version
    $distant = (Invoke-RestMethod "https://raw.githubusercontent.com/$Depot/main/manifest.json" -Headers @{ 'Cache-Control' = 'no-cache' }).version
    Write-Host "Version installee  : $local"
    Write-Host "Version sur GitHub : $distant"
    if ([version]$distant -le [version]$local) {
        Write-Host 'Deja a jour.' -ForegroundColor Green
        Fin 0
    }

    $tmp = Join-Path $env:TEMP ('heures-supp-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $zip = Join-Path $tmp 'source.zip'
    Write-Host 'Telechargement...'
    Invoke-WebRequest "https://codeload.github.com/$Depot/zip/refs/heads/main" -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $tmp
    $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
    $nouvelle = (Get-Content (Join-Path $src.FullName 'manifest.json') -Raw | ConvertFrom-Json).version
    if ($nouvelle -ne $distant) { throw "archive inattendue (version $nouvelle)" }

    robocopy $src.FullName $Dossier /E /XF config.local.json /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "copie impossible (robocopy $LASTEXITCODE)" }
    Remove-Item -Recurse -Force $tmp

    Write-Host "Mise a jour installee : $local -> $distant" -ForegroundColor Green
    Write-Host "L'extension se recharge d'elle-meme dans les minutes qui viennent"
    Write-Host "(ou : page des extensions du navigateur, bouton de rechargement sur sa carte)."
    Fin 0
}
catch {
    Write-Host "Echec de la mise a jour : $($_.Exception.Message)" -ForegroundColor Red
    Fin 1
}
