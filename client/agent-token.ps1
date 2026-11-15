#Requires -Version 7.0
<#
.SYNOPSIS
  エージェントごとのトークンを発行・一覧・失効します（管理者トークン MEMORY_TOKEN が必要）。

.DESCRIPTION
  setup-client.ps1 は、この PC の AI ツールごとに自動でトークンを発行します。
  このスクリプトは、それ以外のエージェント（別の PC、CI、手で設定するツールなど）用に使います。
  発行したトークンはこのときに一度だけ表示されます。サーバーにはハッシュしか残りません。

.PARAMETER Action
  new（発行。同じ名前なら発行し直し）/ list（一覧）/ revoke（失効）

.PARAMETER Name
  エージェント名（英小文字・数字・. _ -）。new と revoke で必要です。

.EXAMPLE
  pwsh ./client/agent-token.ps1 new codex-ci
  pwsh ./client/agent-token.ps1 list
  pwsh ./client/agent-token.ps1 revoke codex-ci
#>
param(
    [Parameter(Mandatory, Position = 0)][ValidateSet('new', 'list', 'revoke')][string]$Action,
    [Parameter(Position = 1)][string]$Name,
    [string]$Url = $env:MEMORY_URL,
    [string]$Token = $env:MEMORY_TOKEN
)

$ErrorActionPreference = 'Stop'
if (-not $Url -or -not $Token) { throw '環境変数 MEMORY_URL / MEMORY_TOKEN がありません。先に setup-client.ps1 を実行してください。' }
if ($Action -ne 'list' -and -not $Name) { throw "$Action にはエージェント名が必要です。" }
$Url = $Url.TrimEnd('/')
$headers = @{ Authorization = "Bearer $Token" }

switch ($Action) {
    'new' {
        $r = Invoke-RestMethod -Method Post -Uri "$Url/admin/agents" -Headers $headers -ContentType 'application/json' `
            -Body (@{ name = $Name } | ConvertTo-Json -Compress)
        Write-Host "エージェント $($r.name) のトークンを発行しました（この画面でしか表示されません）:"
        Write-Output $r.token
    }
    'list' {
        $r = Invoke-RestMethod -Uri "$Url/admin/agents" -Headers $headers
        $r.agents | ForEach-Object {
            [pscustomobject]@{ Name = $_.name; CreatedAt = $_.createdAt; Status = if ($_.revokedAt) { "失効（$($_.revokedAt)）" } else { '有効' } }
        } | Format-Table -AutoSize
    }
    'revoke' {
        Invoke-RestMethod -Method Delete -Uri "$Url/admin/agents/$([uri]::EscapeDataString($Name))" -Headers $headers | Out-Null
        Write-Host "エージェント $Name のトークンを失効させました"
    }
}
