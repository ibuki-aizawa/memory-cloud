#Requires -Version 7.0
<#
.SYNOPSIS
  プロジェクトを memory-mcp（Cloudflare）に接続します。プロジェクトごとに 1 回だけ実行します。

.DESCRIPTION
  - CLAUDE.md / .mcp.json / .claude/agents/*.md の {{PROJECT}} をプロジェクト略称に置き換えます
  - 旧ローカル版の memory-project 登録（local スコープ）があれば削除します
  - プロジェクトのハブ（Project:<略称>）と Agent:reviewer を作成します（既にあればスキップ）
  新しい PC や新しい参加者は、このスクリプトを実行する必要はありません
  （setup-client.ps1 を実行済みなら、clone して Claude Code を起動するだけで参加できます）。

.PARAMETER Slug
  プロジェクト略称（英小文字・数字・ハイフン）。省略時はフォルダ名から作ります。

.EXAMPLE
  pwsh ./scripts/init-project.ps1 -Slug myapp
#>
param(
    [string]$Slug
)

$ErrorActionPreference = 'Stop'

$Url = $env:MEMORY_URL
$Token = $env:MEMORY_TOKEN
if (-not $Url -or -not $Token) {
    throw '環境変数 MEMORY_URL / MEMORY_TOKEN がありません。先に setup-client.ps1 を実行し、ターミナルを開き直してください。'
}
$Url = $Url.TrimEnd('/')

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Slug) {
    $Slug = ((Split-Path $root -Leaf).ToLower() -replace '[^a-z0-9-]', '-').Trim('-')
}
if ($Slug -notmatch '^[a-z0-9][a-z0-9-]{0,62}$') {
    throw "Slug '$Slug' は英小文字・数字・ハイフン（63 文字以内）で指定してください。"
}
Write-Host "プロジェクト略称: $Slug"

# 1. {{PROJECT}} の置換
$targets = @((Join-Path $root 'CLAUDE.md'), (Join-Path $root '.mcp.json'))
$agentsDir = Join-Path $root '.claude/agents'
if (Test-Path $agentsDir) {
    $targets += Get-ChildItem $agentsDir -Filter '*.md' | ForEach-Object FullName
}
foreach ($t in $targets) {
    if (-not (Test-Path $t)) { continue }
    $content = Get-Content $t -Raw
    if ($content -and $content.Contains('{{PROJECT}}')) {
        $content.Replace('{{PROJECT}}', $Slug) | Set-Content $t -Encoding utf8 -NoNewline
        Write-Host "  置換しました: $t"
    }
}

# 2. 旧ローカル版の登録を削除
if (Get-Command claude -ErrorAction SilentlyContinue) {
    Push-Location $root
    try { claude mcp remove memory-project -s local 2>$null | Out-Null } finally { Pop-Location }
}

# 3. ハブの作成
$endpoint = "$Url/mcp/p/$Slug"
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

$today = Get-Date -Format 'yyyy-MM-dd'
$r = Invoke-MemoryTool -Name 'create_entities' -Arguments @{
    entities = @(
        [ordered]@{
            name         = "Project:$Slug"
            entityType   = 'Project'
            observations = @(
                "[$today owner] 概要: (1文で目的を書く)",
                "[$today owner] 主要Component: (まだなし)"
            )
        }
        [ordered]@{
            name         = 'Agent:reviewer'
            entityType   = 'Agent'
            observations = @("[$today owner] 役割: コードレビュー。個別の学びは agent-memory に書く")
        }
    )
}
Invoke-MemoryTool -Name 'create_relations' -Arguments @{
    relations = @([ordered]@{ from = 'Agent:reviewer'; to = "Project:$Slug"; relationType = 'responsible_for' })
} | Out-Null

if (@($r.created).Count) { Write-Host "  ハブを作成しました: $($r.created -join ', ')" }
else { Write-Host '  ハブは作成済みです' }

Write-Host ''
Write-Host '完了しました。次の 2 つを行ってください:'
Write-Host "  1) Project:$Slug の「概要」を更新する（Claude Code で「Project:$Slug の概要を ○○ に直して」と頼む）"
Write-Host '  2) CLAUDE.md / .mcp.json / .claude/ を git にコミットする'
Write-Host 'Claude Code の初回起動時に .mcp.json の memory-project を使うか確認されるので、許可してください。'
