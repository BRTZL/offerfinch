param(
  [ValidateSet('stable', 'preview')][string]$Channel = 'stable',
  [switch]$Universal
)
$ErrorActionPreference = 'Stop'
$dist = Join-Path $PSScriptRoot '../apps/desktop/dist'
$arches = @('win-unpacked')
if ($Universal) { $arches += 'win-arm64-unpacked' }
foreach ($arch in $arches) {
  $config = Get-Content (Join-Path $dist "$arch/resources/app-update.yml") -Raw
  foreach ($field in @('provider: github', 'owner: BRTZL', 'repo: offerfinch')) {
    if ($config -notmatch "(?m)^$([regex]::Escape($field))\s*$") { throw "Missing $field in $arch/app-update.yml" }
  }
  if ($config -match '(?m)^publisherName:') { throw 'Unsigned Windows updates must not require a publisher signature' }
}
$manifestName = if ($Channel -eq 'preview') { 'preview.yml' } else { 'latest.yml' }
$manifest = Get-Content (Join-Path $dist $manifestName) -Raw
$references = [regex]::Matches($manifest, '(?m)^\s*(?:-\s*)?(?:url|path):\s*(.+?)\s*$')
if ($references.Count -eq 0) { throw "No installer references in $manifestName" }
foreach ($reference in $references) {
  $file = $reference.Groups[1].Value.Trim('"', "'")
  if ([IO.Path]::GetFileName($file) -ne $file -or !(Test-Path (Join-Path $dist $file))) { throw "Missing installer: $file" }
  if (!(Test-Path (Join-Path $dist "$file.blockmap"))) { throw "Missing blockmap: $file.blockmap" }
}
if ($Universal) {
  foreach ($arch in @('x64', 'arm64')) {
    $urls = [regex]::Matches($manifest, '(?m)^\s*-?\s*url:\s*(.+?)\s*$')
    $native = @($urls | Where-Object { $_.Groups[1].Value -match "-$arch-" })
    if ($native.Count -eq 0) { throw "Missing $arch url in $manifestName" }
    foreach ($url in $native) {
      $file = $url.Groups[1].Value.Trim('"', "'")
      if (!(Test-Path (Join-Path $dist "$file.blockmap"))) { throw "Missing blockmap: $file.blockmap" }
    }
  }
  $version = [regex]::Match($manifest, '(?m)^version:\s*(.+?)\s*$').Groups[1].Value
  $combined = "OfferFinch-$version-setup.exe"
  if ($references[0].Groups[1].Value -ne $combined -or $manifest -notmatch "(?m)^path: $([regex]::Escape($combined))\s*$") {
    throw "$manifestName must list the combined x64/arm64 fallback first"
  }
}
Write-Output "Windows update metadata verified: $manifestName, all referenced installers and blockmaps exist."
