param([Parameter(Mandatory=$true)][string]$CaseJsonBase64)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$case = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($CaseJsonBase64)) | ConvertFrom-Json
$worker = Join-Path $PSScriptRoot '../../resources/readaloud-highlight-worker.ps1'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($worker,[ref]$tokens,[ref]$errors)
if($errors.Count) { throw $errors[0] }
foreach($function in $ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$false)) {
  . ([scriptblock]::Create($function.Extent.Text))
}
# Read only the test-owned window. Do not focus it or operate the desktop.
$condition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, $case.title)
$window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
  [System.Windows.Automation.TreeScope]::Children, $condition)
if(-not $window) { throw 'Test source window not exposed to UI Automation' }
$textCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty, $true)
$script:range=$null
foreach($element in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCondition)) {
  try {
    $pattern=$element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    if($pattern.DocumentRange.GetText(-1).Contains('A quiet morning')) {
      $script:range=$pattern.DocumentRange.Clone()
      break
    }
  } catch {}
}
if(-not $script:range) { throw 'Test document has no native text range' }
$script:lastSentence=$null
$script:sentences=@{}
$script:wordRanges=$null
$results=@()
foreach($item in $case.sentences) {
  $hit=Locate-Word @{index=$item.index;sentence=$item.text}
  $words=@()
  if($script:wordRanges) {
    foreach($key in $script:wordRanges.Keys) {
      $nativeWordRange=$script:wordRanges[$key]
      $words+=@{start=[int]$key;text=$nativeWordRange.GetText(-1);rectsJson=(Rects-Json $nativeWordRange)}
    }
  }
  $diagnostic=@()
  if(-not $hit) {
    foreach($word in @(Get-SourceWords $item.text)) {
      $found=$script:range.FindText($word.Value,$false,$true)
      $diagnostic+=@{requested=$word.Value;found=$(if($found) {$found.GetText(-1)} else {$null})}
    }
  }
  $results+=@{matched=($null -ne $hit);words=@($words | Sort-Object { $_.start });diagnostic=$diagnostic;source=$script:range.GetText(-1)}
}
$json = ConvertTo-Json -InputObject $results -Depth 8 -Compress
[Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
