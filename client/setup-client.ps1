#Requires -Version 7.0
<#
.SYNOPSIS
  この PC の AI エージェント（Claude Code / Codex / Gemini CLI / Cursor / VS Code / Windsurf）を
  Cloudflare 上の memory-mcp に接続します。PC ごとに 1 回実行します（何度実行しても問題ありません）。

.DESCRIPTION
  1. 接続テスト（initialize）
  2. クライアントごとにエージェント用のトークンを発行（名前は <クライアント>-<PC 名>。書き手として記録される）
  3. 環境変数 MEMORY_URL / MEMORY_TOKEN（管理者用）/ MEMORY_TOKEN_<クライアント> を保存
     （Windows はユーザー環境変数、それ以外は ~/.memory-cloud.env。各クライアントの設定が参照する）
  4. 各クライアントに memory-global（リモート）をユーザー設定として登録
  5. 共通ナレッジの初期データを投入（既にあればスキップ）
  6. 各クライアントのユーザー共通ルール（~/.claude/CLAUDE.md など）に共通メモリのルールを追記（追記済みならスキップ）
  設定ファイルを書き換えるときは、元のファイルを <ファイル名>.bak に残します。

.PARAMETER Url
  Worker の URL（例: https://memory-mcp.your-name.workers.dev）

.PARAMETER Token
  管理者トークン（MEMORY_TOKEN）。省略時は環境変数、なければ入力を求めます。

.PARAMETER SharedToken
  エージェントごとのトークンを発行せず、すべてのクライアントで管理者トークンを使います（書き手は区別されません）。

.PARAMETER Clients
  設定するクライアント（claude, codex, gemini, cursor, vscode, windsurf）。
  省略時は、この PC にインストールされているものを自動で検出します。

.EXAMPLE
  pwsh ./client/setup-client.ps1 -Url https://memory-mcp.your-name.workers.dev

.EXAMPLE
  pwsh ./client/setup-client.ps1 -Url https://memory-mcp.your-name.workers.dev -Clients claude, codex
#>
param(
    [Parameter(Mandatory)][string]$Url,
    [string]$Token,
    [ValidateSet('claude', 'codex', 'gemini', 'cursor', 'vscode', 'windsurf')]
    [string[]]$Clients,
    [switch]$SharedToken
)

$ErrorActionPreference = 'Stop'
$Url = $Url.TrimEnd('/')
. (Join-Path $PSScriptRoot 'lib/agent-config.ps1')

if (-not $Clients) {
    $Clients = @(Get-InstalledAgentClients)
    if (-not $Clients) {
        throw '対応クライアントが見つかりません。-Clients で指定してください（claude, codex, gemini, cursor, vscode, windsurf）。'
    }
}
$Clients = @($Clients | Select-Object -Unique)
Write-Host "設定するクライアント: $($Clients -join ', ')"
if ('claude' -in $Clients -and -not (Get-Command claude -ErrorAction SilentlyContinue)) {
    throw 'claude が見つかりません。Claude Code をインストールするか、-Clients から claude を外してください。'
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

# 2. クライアントごとのトークン（エージェントの識別）
$pcName = (([Environment]::MachineName).ToLower() -replace '[^a-z0-9-]', '-').Trim('-')
if (-not $pcName) { $pcName = 'pc' }
$tokenVars = [ordered]@{}   # 環境変数名 -> 値
$tokenVars['MEMORY_TOKEN'] = $Token
$agentTokens = @{}          # クライアント -> トークン
foreach ($client in $Clients) {
    $agentName = "$client-$pcName"
    $agentTokens[$client] = $Token
    if (-not $SharedToken) {
        try {
            $issued = Invoke-RestMethod -Method Post -Uri "$Url/admin/agents" `
                -Headers @{ Authorization = "Bearer $Token" } -ContentType 'application/json' `
                -Body (@{ name = $agentName } | ConvertTo-Json -Compress)
            $agentTokens[$client] = $issued.token
            Write-Host "  [$client] エージェント $agentName のトークンを発行しました"
        }
        catch {
            Write-Warning "[$client] エージェントのトークンを発行できませんでした（サーバーが古い可能性があります）。管理者トークンを使います: $($_.Exception.Message)"
        }
    }
    $tokenVars["MEMORY_TOKEN_$($client.ToUpper())"] = $agentTokens[$client]
}

# 3. 環境変数
$env:MEMORY_URL = $Url
foreach ($k in $tokenVars.Keys) { Set-Item "env:$k" $tokenVars[$k] }
if ($IsWindows) {
    [Environment]::SetEnvironmentVariable('MEMORY_URL', $Url, 'User')
    foreach ($k in $tokenVars.Keys) { [Environment]::SetEnvironmentVariable($k, $tokenVars[$k], 'User') }
    Write-Host "ユーザー環境変数を保存しました: MEMORY_URL, $($tokenVars.Keys -join ', ')"
}
else {
    $envFile = Join-Path $HOME '.memory-cloud.env'
    $lines = @('# memory-cloud（setup-client.ps1 が作成）', "export MEMORY_URL='$Url'")
    foreach ($k in $tokenVars.Keys) { $lines += "export $k='$($tokenVars[$k])'" }
    $lines | Set-Content $envFile -Encoding utf8
    chmod 600 $envFile
    Write-Host "環境変数を $envFile に保存しました。シェルの設定ファイル（~/.zshrc や ~/.bashrc）に次の 1 行を追加してください:"
    Write-Host '  [ -f ~/.memory-cloud.env ] && . ~/.memory-cloud.env'
}

# 4. 各クライアントへの memory-global の登録
#    Claude Code 以外はトークンを書かず、環境変数 MEMORY_TOKEN_<クライアント> を参照させる
$skipped = @()
foreach ($client in $Clients) {
    $var = "MEMORY_TOKEN_$($client.ToUpper())"
    try {
        switch ($client) {
            'claude' {
                foreach ($name in 'memory', 'memory-global') {
                    claude mcp remove $name -s user 2>$null | Out-Null
                }
                claude mcp add --transport http -s user memory-global $globalEndpoint --header "Authorization: Bearer $($agentTokens[$client])"
                if ($LASTEXITCODE -ne 0) { throw "claude mcp add が失敗しました（終了コード $LASTEXITCODE）" }
                $where = '~/.claude.json'
            }
            'codex' {
                $where = Join-Path $HOME '.codex/config.toml'
                Set-TomlTable -Path $where -Table 'mcp_servers.memory-global' -Lines @(
                    "url = ""$globalEndpoint"""
                    "bearer_token_env_var = ""$var"""
                )
            }
            'gemini' {
                $where = Join-Path $HOME '.gemini/settings.json'
                Set-JsonMcpServer -Path $where -ContainerKey 'mcpServers' -Name 'memory-global' -Server ([ordered]@{
                        httpUrl = $globalEndpoint
                        headers = [ordered]@{ Authorization = 'Bearer ${' + $var + '}' }
                    })
            }
            'cursor' {
                $where = Join-Path $HOME '.cursor/mcp.json'
                Set-JsonMcpServer -Path $where -ContainerKey 'mcpServers' -Name 'memory-global' -Server ([ordered]@{
                        url     = $globalEndpoint
                        headers = [ordered]@{ Authorization = 'Bearer ${env:' + $var + '}' }
                    })
            }
            'vscode' {
                $where = Join-Path (Get-VSCodeUserDir) 'mcp.json'
                Set-JsonMcpServer -Path $where -ContainerKey 'servers' -Name 'memory-global' -Server ([ordered]@{
                        type    = 'http'
                        url     = $globalEndpoint
                        headers = [ordered]@{ Authorization = 'Bearer ${env:' + $var + '}' }
                    })
            }
            'windsurf' {
                $where = Join-Path $HOME '.codeium/windsurf/mcp_config.json'
                Set-JsonMcpServer -Path $where -ContainerKey 'mcpServers' -Name 'memory-global' -Server ([ordered]@{
                        serverUrl = $globalEndpoint
                        headers   = [ordered]@{ Authorization = 'Bearer ${env:' + $var + '}' }
                    })
            }
        }
        Write-Host "  [$client] memory-global を登録しました: $where"
    }
    catch {
        Write-Warning "[$client] 登録できませんでした: $($_.Exception.Message)"
        $skipped += $client
    }
}

# 5. 共通ナレッジの初期データ（既存はスキップされる）
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

# 6. ユーザー共通ルールへの追記
$rulesTemplate = Join-Path $PSScriptRoot 'templates/user-memory-rules.md'
$rules = Get-Content $rulesTemplate -Raw
$rulesTargets = @{
    claude   = Join-Path $HOME '.claude/CLAUDE.md'
    codex    = Join-Path $HOME '.codex/AGENTS.md'
    gemini   = Join-Path $HOME '.gemini/GEMINI.md'
    windsurf = Join-Path $HOME '.codeium/windsurf/memories/global_rules.md'
}
foreach ($client in $Clients) {
    switch ($client) {
        'vscode' {
            # VS Code はユーザーフォルダの prompts/*.instructions.md を読み込む（このファイルはスクリプト専用なので毎回上書き）
            $path = Join-Path (Get-VSCodeUserDir) 'prompts/memory-global.instructions.md'
            New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
            "---`napplyTo: '**'`n---`n$rules" | Set-Content $path -Encoding utf8
            Write-Host "  [vscode] 共通メモリのルールを書き出しました: $path"
        }
        'cursor' {
            Write-Host '  [cursor] ユーザー共通のルールはファイルに置けません。Cursor Settings > Rules の User Rules に次のファイルの内容を貼り付けてください:'
            Write-Host "           $rulesTemplate"
        }
        default {
            $path = $rulesTargets[$client]
            if (Add-RulesBlock -Path $path -Template $rules) {
                Write-Host "  [$client] 共通メモリのルールを追記しました: $path"
            }
            else {
                Write-Host "  [$client] 共通メモリのルールは追記済みです: $path"
            }
        }
    }
}

Write-Host ''
if ($skipped) {
    Write-Warning "登録できなかったクライアント: $($skipped -join ', ')。README の「ほかのクライアントでの設定」を見て手動で設定してください。"
}
Write-Host '完了しました。環境変数を反映するため、ターミナルと各エディターを開き直してください。'
Write-Host '接続の確認: Claude Code / Codex / Gemini CLI は /mcp、Cursor / VS Code / Windsurf は MCP の設定画面で memory-global を確認'
