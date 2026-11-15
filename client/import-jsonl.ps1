#Requires -Version 7.0
<#
.SYNOPSIS
  ローカル版 server-memory の jsonl を memory-mcp（Cloudflare）に移行します。

.DESCRIPTION
  何度実行しても安全です（既存エンティティ・同じ observation・同じリレーションは重複しません）。

.PARAMETER Path
  移行元の jsonl（例: ~/.claude/memory/global.jsonl）

.PARAMETER Scope
  移行先。'global' またはプロジェクト略称（例: myapp）

.EXAMPLE
  pwsh ./client/import-jsonl.ps1 -Path "$HOME/.claude/memory/global.jsonl" -Scope global
  pwsh ./client/import-jsonl.ps1 -Path ./.claude/memory/project.jsonl -Scope myapp
#>
param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Scope,
    [string]$Url = $env:MEMORY_URL,
    [string]$Token = $env:MEMORY_TOKEN
)

$ErrorActionPreference = 'Stop'
if (-not $Url -or -not $Token) { throw '環境変数 MEMORY_URL / MEMORY_TOKEN がありません。先に setup-client.ps1 を実行してください。' }
if ($Scope -ne 'global' -and $Scope -notmatch '^[a-z0-9][a-z0-9-]*$') { throw "Scope '$Scope' が不正です。" }

$Url = $Url.TrimEnd('/')
$endpoint = if ($Scope -eq 'global') { "$Url/mcp/global" } else { "$Url/mcp/p/$Scope" }
$batchSize = 20

function Invoke-MemoryTool {
    param([string]$Name, [hashtable]$Arguments)
    $body = [ordered]@{
        jsonrpc = '2.0'; id = [guid]::NewGuid().ToString(); method = 'tools/call'
        params  = @{ name = $Name; arguments = $Arguments }
    } | ConvertTo-Json -Depth 20 -Compress
    $res = Invoke-RestMethod -Method Post -Uri $endpoint `
        -Headers @{ Authorization = "Bearer $Token" } `
        -ContentType 'application/json; charset=utf-8' `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
    if ($res.error) { throw "MCP エラー: $($res.error.message)" }
    $text = $res.result.content[0].text
    if ($res.result.isError) { throw "$Name が失敗しました: $text" }
    return ($text | ConvertFrom-Json)
}

$records = @(Get-Content $Path -Encoding utf8 | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
$entities = @($records | Where-Object type -eq 'entity')
$relations = @($records | Where-Object type -eq 'relation')
Write-Host "読み込み: エンティティ $($entities.Count) 件 / リレーション $($relations.Count) 件 → $endpoint"

# 1. エンティティ（observation は後で追加）
$created = 0
for ($i = 0; $i -lt $entities.Count; $i += $batchSize) {
    $chunk = @($entities[$i..([Math]::Min($i + $batchSize, $entities.Count) - 1)])
    $payload = @($chunk | ForEach-Object { [ordered]@{ name = $_.name; entityType = $_.entityType } })
    $r = Invoke-MemoryTool -Name 'create_entities' -Arguments @{ entities = $payload }
    $created += @($r.created).Count
}

# 2. observation（1 エンティティあたり 20 件ずつに分割）
$items = [System.Collections.Generic.List[object]]::new()
foreach ($e in $entities) {
    $obs = @($e.observations | Where-Object { $_ -and $_.Trim() } | ForEach-Object {
            if ($_.Length -gt 2000) { Write-Warning "2000 文字を超える observation を切り詰めます: $($e.name)"; $_.Substring(0, 2000) } else { $_ }
        })
    for ($j = 0; $j -lt $obs.Count; $j += $batchSize) {
        $items.Add([ordered]@{ entityName = $e.name; contents = @($obs[$j..([Math]::Min($j + $batchSize, $obs.Count) - 1)]) })
    }
}
$added = 0
for ($i = 0; $i -lt $items.Count; $i += $batchSize) {
    $chunk = @($items[$i..([Math]::Min($i + $batchSize, $items.Count) - 1)])
    $r = Invoke-MemoryTool -Name 'add_observations' -Arguments @{ observations = $chunk }
    $added += [int]$r.added
}

# 3. リレーション
$linked = 0
for ($i = 0; $i -lt $relations.Count; $i += $batchSize) {
    $chunk = @($relations[$i..([Math]::Min($i + $batchSize, $relations.Count) - 1)])
    $payload = @($chunk | ForEach-Object { [ordered]@{ from = $_.from; to = $_.to; relationType = $_.relationType } })
    $r = Invoke-MemoryTool -Name 'create_relations' -Arguments @{ relations = $payload }
    $linked += [int]$r.created
    if ($r.missing_entities) { Write-Warning "存在しないエンティティ: $($r.missing_entities -join ', ')" }
}

Write-Host "完了: エンティティ新規 $created 件 / observation 追加 $added 件 / リレーション新規 $linked 件"
