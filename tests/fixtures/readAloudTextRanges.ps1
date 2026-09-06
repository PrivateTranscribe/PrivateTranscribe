param([Parameter(Mandatory=$true)][string]$CaseJsonBase64)
$ErrorActionPreference = 'Stop'
# Pure in-memory provider. No windows, keyboard events or desktop automation.
Add-Type -AssemblyName UIAutomationTypes

class MemoryTextRange {
  [string]$Text
  [int]$Start
  [int]$End
  MemoryTextRange([string]$text, [int]$start, [int]$end) {
    $this.Text=$text; $this.Start=$start; $this.End=$end
  }
  [MemoryTextRange] Clone() { return [MemoryTextRange]::new($this.Text,$this.Start,$this.End) }
  [string] GetText([int]$limit) { return $this.Text.Substring($this.Start,$this.End-$this.Start) }
  [object] FindText([string]$text,[bool]$backwards,[bool]$ignoreCase) {
    $comparison=[StringComparison]::Ordinal
    if($ignoreCase) { $comparison=[StringComparison]::OrdinalIgnoreCase }
    $found=$this.GetText(-1).IndexOf($text,$comparison)
    if($found -lt 0) { return $null }
    return [MemoryTextRange]::new($this.Text,$this.Start+$found,$this.Start+$found+$text.Length)
  }
  [void] MoveEndpointByRange([object]$endpoint,[MemoryTextRange]$other,[object]$otherEndpoint) {
    $position=$other.Start
    if($otherEndpoint.ToString() -eq 'End') { $position=$other.End }
    if($endpoint.ToString() -eq 'Start') {
      $this.Start=$position
      $this.End=[Math]::Max($this.Start,$this.End)
    } else {
      $this.End=$position
      $this.Start=[Math]::Min($this.Start,$this.End)
    }
  }
}

# Load only production function definitions, not the worker's UIA bootstrap
# or stdin loop. This exercises the actual matching code against a text range.
$worker=Join-Path $PSScriptRoot '../../resources/readaloud-highlight-worker.ps1'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($worker,[ref]$tokens,[ref]$errors)
if($errors.Count) { throw $errors[0] }
$functions=$ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$false)
foreach($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }

$cases=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($CaseJsonBase64)) | ConvertFrom-Json
$results=@()
foreach($case in $cases) {
  $script:range=[MemoryTextRange]::new($case.document,0,$case.document.Length)
  $script:lastSentence=$null
  $script:sentences=@{}
  $script:wordRanges=$null
  $hit=Locate-Word @{index=0;sentence=$case.copied}
  $words=@()
  if($script:wordRanges) {
    foreach($key in $script:wordRanges.Keys) {
      $range=$script:wordRanges[$key]
      $words+=@{start=[int]$key;sourceStart=$range.Start;sourceEnd=$range.End;text=$range.GetText(-1)}
    }
  }
  $results+=@{matched=($null -ne $hit);words=@($words | Sort-Object { $_.start })}
}
ConvertTo-Json -InputObject $results -Depth 8 -Compress
