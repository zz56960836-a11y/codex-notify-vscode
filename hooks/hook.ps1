# codex-notify hook (Windows). Copies minimal event metadata into a local spool
# that the VS Code extension reads. No network, no secrets, never blocks Codex.
$ErrorActionPreference = 'Stop'
function Clip($value, [int]$limit = 200) {
  if ($null -eq $value) { return '' }
  if ($value -is [array]) { $value = ($value | ForEach-Object { [string]$_ }) -join ' ' }
  $text = ([string]$value) -replace '\s+', ' '
  $text = $text.Trim()
  if ($text.Length -gt $limit) { $text = $text.Substring(0, $limit) }
  return $text
}
try {
  [Console]::InputEncoding = [Text.Encoding]::UTF8
  $raw = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($raw.agent_id) { exit 0 }
  $event = [string]$raw.hook_event_name
  $tool = [string]$raw.tool_name
  $toolInput = $raw.tool_input
  $summary = ''
  if ($event -eq 'Stop') {
    $kind = 'complete'; $summary = Clip $raw.last_assistant_message
  } elseif ($event -eq 'PreToolUse' -and (($tool -split '\.')[-1] -in @('request_user_input', 'request_user_input_async'))) {
    $kind = 'input'
    if ($toolInput -and $toolInput.questions) {
      $first = @($toolInput.questions)[0]
      if ($first.question) { $summary = Clip $first.question } else { $summary = Clip $first.header }
    }
  } elseif ($event -eq 'PermissionRequest') {
    $kind = 'approval'
    if ($toolInput -and $toolInput.command) { $summary = Clip $toolInput.command }
    elseif ($toolInput -and $toolInput.description) { $summary = Clip $toolInput.description }
    else { $summary = Clip $tool }
  } else { exit 0 }
  $record = [ordered]@{
    v = 1; kind = $kind; session = (Clip $raw.session_id 128); turn = (Clip $raw.turn_id 128)
    id = (Clip $raw.tool_use_id 128); cwd = (Clip $raw.cwd 512); summary = $summary
    platform = 'windows'; ts = [double]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000)
  }
  $spool = Join-Path $env:LOCALAPPDATA 'codex-notify\spool'
  # If the extension is gone (nobody consumes the spool), stop piling up files.
  if (@(Get-ChildItem -LiteralPath $spool -File).Count -ge 500) { exit 0 }
  $name = '{0}-{1}.json' -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), ([guid]::NewGuid().ToString('N').Substring(0, 12))
  $temporary = Join-Path $spool ('.' + $name + '.tmp')
  [IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination (Join-Path $spool $name)
} catch { }
exit 0
