#Requires -Version 7.0
<#
.SYNOPSIS
  この PC の Claude Code を Cloudflare 上の memory-mcp に接続します。PC ごとに 1 回実行します。

.DESCRIPTION
  1. 接続テスト（initialize）
  2. ユーザー環境変数 MEMORY_URL / MEMORY_TOKEN を保存（プロジェクトの .mcp.json が参照）
  3. 旧ローカル版の memory / memory-global を削除し、memory-global（リモート）を user スコープで登録
  4. 共通ナレッジの初期データを投入（既にあればスキップ）
  5. ~/.claude/CLAUDE.md に共通メモリのルールを追記（追記済みならスキップ）

.PARAMETER Url
  Worker の URL（例: https://memory-mcp.your-name.workers.dev）

.PARAMETER Token
  MEMORY_TOKEN。省略時は環境変数、なければ入力を求めます。

.EXAMPLE
  pwsh ./client/setup-client.ps1 -Url https://memory-mcp.your-name.workers.dev
#>
param(
    [Parameter(Mandatory)][string]$Url,
    [string]$Token
)

$ErrorActionPreference = 'Stop'
$Url = $Url.TrimEnd('/')

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    throw 'claude が見つかりません。Claude Code をインストールしてください。'
}
if (-not $Token) { $Token = $env:MEMORY_TOKEN }
if (-not $Token) {
    $secure = Read-Host 'MEMORY_TOKEN を入力してください' -AsSecureString
    $Token = [System.Net.NetworkCredential]::new('', $secure).Password
}
if (-not $Token) { throw 'トークンが指定されていません。' }

function Invoke-MemoryRpc {
    param([string]$Endpoint, [string]$Method, [hashtable]$Params = @{})
    $body = [ordered]@{ jsonrpc = '2.0'; id = [guid]::NewGuid().ToString(); method = $Method; params = $Params } |
        ConvertTo-Json -Depth 20 -Compress
    $res = Invoke-RestMethod -Method Post -Uri $Endpoint `
        -Headers @{ Authorization = "Bearer $Token" } `
        -ContentType 'application/json; charset=utf-8' `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
    if ($res.error) { throw "MCP エラー: $($res.error.message)" }
    return $res.result
}

function Invoke-MemoryTool {
    param([string]$Endpoint, [string]$Name, [hashtable]$Arguments)
    $r = Invoke-MemoryRpc -Endpoint $Endpoint -Method 'tools/call' -Params @{ name = $Name; arguments = $Arguments }
    $text = $r.content[0].text
    if ($r.isError) { throw "$Name が失敗しました: $text" }
    return ($text | ConvertFrom-Json)
}

$globalEndpoint = "$Url/mcp/global"

# 1. 接続テスト
$init = Invoke-MemoryRpc -Endpoint $globalEndpoint -Method 'initialize' -Params @{
    protocolVersion = '2025-06-18'
    capabilities    = @{}
    clientInfo      = @{ name = 'setup-client'; version = '1.0.0' }
}
Write-Host "接続OK: $($init.serverInfo.name) $($init.serverInfo.version)"

# 2. 環境変数
if ($IsWindows) {
    [Environment]::SetEnvironmentVariable('MEMORY_URL', $Url, 'User')
    [Environment]::SetEnvironmentVariable('MEMORY_TOKEN', $Token, 'User')
    Write-Host 'ユーザー環境変数 MEMORY_URL / MEMORY_TOKEN を保存しました'
}
else {
    Write-Warning "Windows 以外では環境変数を自動保存しません。シェルの設定ファイルに MEMORY_URL と MEMORY_TOKEN を追加してください。"
}
$env:MEMORY_URL = $Url
$env:MEMORY_TOKEN = $Token

# 3. Claude Code への登録
foreach ($name in 'memory', 'memory-global') {
    claude mcp remove $name -s user 2>$null | Out-Null
}
claude mcp add --transport http -s user memory-global $globalEndpoint --header "Authorization: Bearer $Token"
if ($LASTEXITCODE -ne 0) { throw "claude mcp add が失敗しました（終了コード $LASTEXITCODE）" }
Write-Host 'memory-global を登録しました'

# 4. 共通ナレッジの初期データ（既存はスキップされる）
$today = Get-Date -Format 'yyyy-MM-dd'
$seed = Invoke-MemoryTool -Endpoint $globalEndpoint -Name 'create_entities' -Arguments @{
    entities = @(
        [ordered]@{
            name         = 'Person:owner'
            entityType   = 'Person'
            observations = @(
                "[$today owner] 回答・コメントは日本語を好む",
                "[$today owner] Windows + PowerShell 7 で作業する",
                "[$today owner] Claude Pro のためトークン消費を抑えたい"
            )
        }
        [ordered]@{
            name         = 'Tech:PowerShell7'
            entityType   = 'Tech'
            observations = @("[$today owner] 主に使うシェル")
        }
        [ordered]@{
            name         = 'Lesson:global/pwsh-native-args'
            entityType   = 'Lesson'
            observations = @("[$today owner] PowerShell から外部コマンドに渡すとき、先頭が @ の引数と -- は引用符で囲む")
        }
    )
}
if ($seed.created.Count) {
    Invoke-MemoryTool -Endpoint $globalEndpoint -Name 'create_relations' -Arguments @{
        relations = @(
            [ordered]@{ from = 'Lesson:global/pwsh-native-args'; to = 'Tech:PowerShell7'; relationType = 'about' }
            [ordered]@{ from = 'Person:owner'; to = 'Tech:PowerShell7'; relationType = 'uses' }
        )
    } | Out-Null
    Write-Host "共通ナレッジの初期データを作成しました: $($seed.created -join ', ')"
}
else {
    Write-Host '共通ナレッジの初期データは作成済みです'
}

# 5. ~/.claude/CLAUDE.md への追記
$claudeDir = Join-Path $HOME '.claude'
New-Item -ItemType Directory -Force $claudeDir | Out-Null
$userClaudeMd = Join-Path $claudeDir 'CLAUDE.md'
$template = Join-Path $PSScriptRoot 'templates/user-CLAUDE.md'
$current = if (Test-Path $userClaudeMd) { Get-Content $userClaudeMd -Raw } else { '' }
if ($current -and $current.Contains('<!-- memory-protocol -->')) {
    Write-Host "CLAUDE.md は追記済みです: $userClaudeMd"
}
else {
    Add-Content -Path $userClaudeMd -Value (Get-Content $template -Raw) -Encoding utf8
    Write-Host "共通メモリのルールを追記しました: $userClaudeMd"
}

Write-Host ''
Write-Host '完了しました。環境変数を反映するため、ターミナルを開き直してから Claude Code を起動し、/mcp で memory-global が connected か確認してください。'
