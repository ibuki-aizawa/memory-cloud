#Requires -Version 7.0
# 各 AI クライアントの設定ファイルを書き換える関数群。setup-client.ps1 から dot-source して使います。
# どの関数も、既存ファイルを変更する前に <ファイル名>.bak を作ります。

function Backup-ConfigFile {
    param([Parameter(Mandatory)][string]$Path)
    if (Test-Path $Path) { Copy-Item $Path "$Path.bak" -Force }
}

function Set-JsonMcpServer {
    <#
      JSON の設定ファイルに MCP サーバーを 1 つ追加（同名があれば置き換え）します。
      $ContainerKey は mcpServers（Cursor / Gemini / Windsurf）か servers（VS Code）。
      ほかのサーバーや設定はそのまま残します。
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$ContainerKey,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Server
    )
    $config = [ordered]@{}
    if (Test-Path $Path) {
        $raw = Get-Content $Path -Raw
        if ($raw -and $raw.Trim()) {
            try { $config = $raw | ConvertFrom-Json -AsHashtable -Depth 50 }
            catch { throw "JSON として読めません: $Path（$($_.Exception.Message)）" }
            if ($config -isnot [System.Collections.IDictionary]) { throw "JSON のトップレベルがオブジェクトではありません: $Path" }
        }
    }
    if (-not $config.Contains($ContainerKey) -or $config[$ContainerKey] -isnot [System.Collections.IDictionary]) {
        $config[$ContainerKey] = [ordered]@{}
    }
    $config[$ContainerKey][$Name] = $Server

    Backup-ConfigFile $Path
    New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null
    $config | ConvertTo-Json -Depth 50 | Set-Content $Path -Encoding utf8
}

function Set-TomlTable {
    <#
      TOML ファイルのテーブル [$Table]（とその下位テーブル [$Table.*]）を $Lines で置き換えます。
      なければ末尾に追加します。ほかのテーブルはそのまま残します。
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Table,
        [Parameter(Mandatory)][string[]]$Lines
    )
    $existing = if (Test-Path $Path) { @(Get-Content $Path) } else { @() }
    $escaped = [regex]::Escape($Table)
    $ownHeader = "^\s*\[{1,2}\s*$escaped(\s*\]|\.)"
    $anyHeader = '^\s*\[{1,2}[^\]]+\]{1,2}\s*(#.*)?$'

    $out = [System.Collections.Generic.List[string]]::new()
    $skipping = $false
    foreach ($line in $existing) {
        if ($line -match $anyHeader) { $skipping = $line -match $ownHeader }
        if (-not $skipping) { $out.Add($line) }
    }
    while ($out.Count -and -not $out[$out.Count - 1].Trim()) { $out.RemoveAt($out.Count - 1) }
    if ($out.Count) { $out.Add('') }
    $out.Add("[$Table]")
    foreach ($l in $Lines) { $out.Add($l) }

    Backup-ConfigFile $Path
    New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null
    $out | Set-Content $Path -Encoding utf8
}

function Add-RulesBlock {
    <#
      ルールのテンプレートを Markdown ファイルの末尾に追記します。
      テンプレートの目印（<!-- memory-protocol -->）が既にあれば何もしません。
      戻り値: 追記したら $true、追記済みなら $false
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Template,
        [string]$Marker = '<!-- memory-protocol -->'
    )
    $current = if (Test-Path $Path) { Get-Content $Path -Raw } else { '' }
    if ($current -and $current.Contains($Marker)) { return $false }
    Backup-ConfigFile $Path
    New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null
    Add-Content -Path $Path -Value $Template -Encoding utf8
    return $true
}

function Get-VSCodeUserDir {
    if ($IsWindows) { return Join-Path $env:APPDATA 'Code/User' }
    if ($IsMacOS) { return Join-Path $HOME 'Library/Application Support/Code/User' }
    $base = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $HOME '.config' }
    return Join-Path $base 'Code/User'
}

function Get-InstalledAgentClients {
    # 設定フォルダかコマンドがあるものを「インストール済み」とみなします
    $found = @()
    if (Get-Command claude -ErrorAction SilentlyContinue) { $found += 'claude' }
    if ((Get-Command codex -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $HOME '.codex'))) { $found += 'codex' }
    if ((Get-Command gemini -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $HOME '.gemini'))) { $found += 'gemini' }
    if (Test-Path (Join-Path $HOME '.cursor')) { $found += 'cursor' }
    if ((Get-Command code -ErrorAction SilentlyContinue) -or (Test-Path (Get-VSCodeUserDir))) { $found += 'vscode' }
    if (Test-Path (Join-Path $HOME '.codeium/windsurf')) { $found += 'windsurf' }
    return $found
}
