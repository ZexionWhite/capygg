$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$destination = Join-Path $projectRoot 'assets/lol/ranks'
$latestBase = 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default'
$versionedBase = 'https://raw.communitydragon.org/16.2/plugins/rcp-fe-lol-static-assets/global/default'

New-Item -ItemType Directory -Force -Path $destination | Out-Null

$assets = @(
    @{ Name = 'iron.png'; Path = 'ranked-emblem/emblem-iron.png' },
    @{ Name = 'bronze.png'; Path = 'ranked-emblem/emblem-bronze.png' },
    @{ Name = 'silver.png'; Path = 'ranked-emblem/emblem-silver.png' },
    @{ Name = 'gold.png'; Path = 'ranked-emblem/emblem-gold.png' },
    @{ Name = 'platinum.png'; Path = 'ranked-emblem/emblem-platinum.png' },
    @{ Name = 'emerald.png'; Path = 'ranked-emblem/emblem-emerald.png' },
    @{ Name = 'diamond.png'; Path = 'ranked-emblem/emblem-diamond.png' },
    @{ Name = 'master.png'; Path = 'ranked-emblem/emblem-master.png' },
    @{ Name = 'grandmaster.png'; Path = 'ranked-emblem/emblem-grandmaster.png' },
    @{ Name = 'challenger.png'; Path = 'ranked-emblem/emblem-challenger.png' },
    @{ Name = 'unranked.png'; Path = 'images/unranked-emblem.png' }
)

function Get-Asset {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string]$OutputPath
    )

    $sources = @("$latestBase/$RelativePath", "$versionedBase/$RelativePath")
    $lastError = $null

    foreach ($source in $sources) {
        for ($attempt = 1; $attempt -le 4; $attempt++) {
            $temporaryPath = "$OutputPath.download"
            try {
                Invoke-WebRequest -Uri $source -OutFile $temporaryPath -UseBasicParsing -TimeoutSec 30
                $bytes = [System.IO.File]::ReadAllBytes($temporaryPath)
                $isPng = $bytes.Length -ge 8 -and
                    $bytes[0] -eq 137 -and $bytes[1] -eq 80 -and
                    $bytes[2] -eq 78 -and $bytes[3] -eq 71

                if (-not $isPng) {
                    throw "The response from $source is not a valid PNG file."
                }

                Move-Item -Force $temporaryPath $OutputPath
                return
            }
            catch {
                $lastError = $_
                Remove-Item -Force $temporaryPath -ErrorAction SilentlyContinue
                if ($attempt -lt 4) {
                    $delay = [Math]::Pow(2, $attempt)
                    Write-Warning "Download failed ($attempt/4): $source. Retrying in $delay seconds."
                    Start-Sleep -Seconds $delay
                }
            }
        }
    }

    throw "Could not download $RelativePath from CommunityDragon. Last error: $lastError"
}

foreach ($asset in $assets) {
    $output = Join-Path $destination $asset.Name
    Get-Asset -RelativePath $asset.Path -OutputPath $output
    Write-Host "Downloaded $($asset.Name)" -ForegroundColor Green
}

Write-Host "All rank assets synchronized in $destination" -ForegroundColor Cyan
