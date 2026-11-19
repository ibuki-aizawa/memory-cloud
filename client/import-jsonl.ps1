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

  memory-mcp で使える種類（エンティティ 8 種類・関係 8 種類、docs/memory-model.md）に合わせて変換してから送ります。
  - 種類の大文字・小文字やよくある言い換え（person → Person、technology → Tech など）はそろえる
  - 名前が「種類:」で始まっていなければ付ける（例: John → Person:John）。関係の両端も同じように付け替える
  - 対応先がわからない種類があれば、何も書き込まずに止まる。-TypeMap / -RelationMap で対応を指定する

.PARAMETER TypeMap
  エンティティの種類の対応（例: @{ note = 'Lesson'; project_info = 'Project' }）

.PARAMETER RelationMap
  関係の種類の対応（例: @{ depends_on = 'uses'; related_to = 'about' }）

.PARAMETER DryRun
  書き込まずに、変換の結果だけを表示する

.EXAMPLE
  pwsh ./client/import-jsonl.ps1 -Path "$HOME/.claude/memory/global.jsonl" -Scope global
  pwsh ./client/import-jsonl.ps1 -Path ./.claude/memory/project.jsonl -Scope myapp
  pwsh ./client/import-jsonl.ps1 -Path ./memory.jsonl -Scope global -TypeMap @{ note = 'Lesson' } -DryRun
#>
param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Scope,
    [string]$Url = $env:MEMORY_URL,
    [string]$Token = $env:MEMORY_TOKEN,
    [hashtable]$TypeMap = @{},
    [hashtable]$RelationMap = @{},
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
if (-not $DryRun -and (-not $Url -or -not $Token)) { throw '環境変数 MEMORY_URL / MEMORY_TOKEN がありません。先に setup-client.ps1 を実行してください。' }
if ($Scope -ne 'global' -and $Scope -notmatch '^[a-z0-9][a-z0-9-]*$') { throw "Scope '$Scope' が不正です。" }

# memory-mcp で使える種類（memory-mcp-worker/src/knowledge.js と同じ）
$entityTypes = @('Project', 'Component', 'Decision', 'Convention', 'Lesson', 'Agent', 'Tech', 'Person')
$relationTypes = @('part_of', 'applies_to', 'supersedes', 'uses', 'about', 'responsible_for', 'contradicts', 'derived_from')
$entityAliases = @{
    technology = 'Tech'; tool = 'Tech'; library = 'Tech'; rule = 'Convention'; guideline = 'Convention'
    learning = 'Lesson'; insight = 'Lesson'; user = 'Person'; owner = 'Person'; module = 'Component'; feature = 'Component'; adr = 'Decision'
}
$relationAliases = @{ applied_to = 'applies_to'; apply_to = 'applies_to'; partof = 'part_of'; use = 'uses'; contradict = 'contradicts'; derives_from = 'derived_from'; supercedes = 'supersedes' }

function Resolve-Kind {
    param([string]$Value, [string[]]$Allowed, [hashtable]$Aliases, [hashtable]$Map, [string]$Separator)
    if ($Map.ContainsKey($Value)) { return [string]$Map[$Value] }
    $key = ($Value.ToLower() -replace '[\s_-]+', $Separator)
    $hit = $Allowed | Where-Object { ($_.ToLower() -replace '[\s_-]+', $Separator) -eq $key } | Select-Object -First 1
    if ($hit) { return $hit }
    if ($Aliases.ContainsKey($key)) { return $Aliases[$key] }
    return $null
}

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

# 0. 使える種類と名前の形に変換する。わからない種類があれば、書き込む前に止める
$unknownTypes = [System.Collections.Generic.SortedSet[string]]::new()
$unknownRelations = [System.Collections.Generic.SortedSet[string]]::new()
$rename = @{}
foreach ($e in $entities) {
    $type = Resolve-Kind -Value $e.entityType -Allowed $entityTypes -Aliases $entityAliases -Map $TypeMap -Separator ''
    if (-not $type -or $type -notin $entityTypes) { [void]$unknownTypes.Add([string]$e.entityType); continue }
    $name = [string]$e.name
    $prefix = ($name -split ':', 2)[0]
    if ($name -match '^[^:]+:.+$' -and $prefix -ieq $type) { $newName = "${type}:$(($name -split ':', 2)[1])" }
    elseif ($name -match '^[^:]+:.+$' -and (Resolve-Kind -Value $prefix -Allowed $entityTypes -Aliases $entityAliases -Map $TypeMap -Separator '')) { $newName = "${type}:$(($name -split ':', 2)[1])" }
    else { $newName = "${type}:$name" }
    if ($newName -ne $name) { $rename[$name] = $newName }
    $e.entityType = $type
    $e.name = $newName
}
foreach ($r in $relations) {
    $kind = Resolve-Kind -Value $r.relationType -Allowed $relationTypes -Aliases $relationAliases -Map $RelationMap -Separator '_'
    if (-not $kind -or $kind -notin $relationTypes) { [void]$unknownRelations.Add([string]$r.relationType); continue }
    $r.relationType = $kind
    if ($rename.ContainsKey($r.from)) { $r.from = $rename[$r.from] }
    if ($rename.ContainsKey($r.to)) { $r.to = $rename[$r.to] }
}
if ($unknownTypes.Count -or $unknownRelations.Count) {
    if ($unknownTypes.Count) { Write-Warning "対応先がわからないエンティティの種類: $($unknownTypes -join ', ')。使える種類: $($entityTypes -join ', ')" }
    if ($unknownRelations.Count) { Write-Warning "対応先がわからない関係の種類: $($unknownRelations -join ', ')。使える種類: $($relationTypes -join ', ')" }
    throw "何も書き込んでいません。-TypeMap @{ 元の種類 = '使える種類' } / -RelationMap @{ 元の種類 = '使える種類' } で対応を指定して、やり直してください（-DryRun で確かめられます）。"
}
if ($rename.Count) { Write-Host "名前に種類を付けます: $($rename.Count) 件（例: $(@($rename.GetEnumerator())[0].Key) → $(@($rename.GetEnumerator())[0].Value)）" }
if ($DryRun) {
    $entities | ForEach-Object { Write-Host "  $($_.name)  ($($_.entityType), observation $(@($_.observations).Count) 件)" }
    $relations | ForEach-Object { Write-Host "  $($_.from) $($_.relationType) $($_.to)" }
    Write-Host '-DryRun のため、書き込みはしていません。'
    return
}

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
