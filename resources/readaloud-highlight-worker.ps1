# Persistent worker: finds WHERE on screen the text Read Aloud is speaking sits
# in the app it was copied from, through Windows UI Automation.
#
# Managed APIs only. No P/Invoke: a script that declares user32 imports next
# to UI Automation calls gets blocked by Windows Defender AMSI as "malicious
# content" (measured 2026-09-02), while the focused element and a tree walk
# reach the same window unflagged.
#
# Protocol on stdin/stdout, one line each way:
#   <- READY                     once, at startup
#   -> anchor                    remember the focused window's document and its
#                                current selection (call right after the copy,
#                                while the selection is still in place)
#   <- OK chars=N window=<title> anchored
#   <- ERR <message>             no document with a selection under focus
#   -> find <base64 utf8 text>   locate one sentence inside the anchored
#                                selection, searching forward from the last hit
#                                first so repeated sentences resolve in order
#   <- RECTS <json array>        physical screen pixels: [{x,y,w,h},...]
#   <- NONE <reason>             sentence not in the selection, or not on screen
#   -> rects                     re-read the last hit's rectangles (the user may
#                                have scrolled)
#   <- RECTS ... | NONE ...
#   -> clear                     forget the anchor
#   <- OK
#   -> ping / <- PONG            prices the line protocol
#
# See src/helpers/readAloudHighlight.js.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$script:range = $null
$script:last = $null
$script:windowName = ""

function Get-Anchor {
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
  if (-not $focused) { throw "nothing has focus" }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $root = $focused
  while ($true) {
    $parent = $walker.GetParent($root)
    if (-not $parent -or $parent -eq [System.Windows.Automation.AutomationElement]::RootElement) { break }
    $root = $parent
  }

  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty, $true)
  $candidates = @()
  $candidates += $focused
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  # Documents first (a browser's page, an editor's body), then the rest: an
  # address bar has a TextPattern too, and usually an empty selection.
  foreach ($el in $all) { if ($el.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) { $candidates += $el } }
  foreach ($el in $all) { if ($el.Current.ControlType -ne [System.Windows.Automation.ControlType]::Document) { $candidates += $el } }

  # Chromium switches its accessibility tree on when a UIA client first asks,
  # so the first look can come back empty; a couple of short retries cover it.
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    if ($attempt -gt 0) { Start-Sleep -Milliseconds 250 }
    foreach ($el in $candidates) {
      try {
        $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
        if (-not $tp) { continue }
        $sel = $tp.GetSelection()
        if ($sel -and $sel.Count -gt 0) {
          $text = $sel[0].GetText(-1)
          if ($text.Trim().Length -gt 0) {
            $script:range = $sel[0].Clone()
            $script:last = $null
            $script:windowName = $root.Current.Name
            return $text.Length
          }
        }
      } catch {}
    }
  }
  throw "no document with a selection under the focused window"
}

function Rects-Json($r) {
  $out = @()
  $rects = $r.GetBoundingRectangles()
  foreach ($rect in $rects) {
    if ($rect.Width -le 0 -or $rect.Height -le 0) { continue }
    $out += ('{"x":' + [math]::Round($rect.X) + ',"y":' + [math]::Round($rect.Y) + ',"w":' + [math]::Round($rect.Width) + ',"h":' + [math]::Round($rect.Height) + '}')
  }
  if ($out.Count -eq 0) { return $null }
  return '[' + ($out -join ',') + ']'
}

function Find-Sentence($text) {
  if (-not $script:range) { throw "not anchored" }
  $start = [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start
  $end = [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End

  # Forward from the last hit first, so "Yes. Yes. Yes." resolves in order;
  # then the whole selection, which is where a skip backwards lands.
  $scopes = @()
  if ($script:last) {
    $after = $script:range.Clone()
    $after.MoveEndpointByRange($start, $script:last, $end)
    $scopes += $after
  }
  $scopes += $script:range

  foreach ($scope in $scopes) {
    $hit = $scope.FindText($text, $false, $true)
    if ($hit) { return $hit }
  }

  # The copied text and the on-screen text can differ in whitespace (a hard
  # line break inside a sentence, a wrapped heading). Pin the sentence by its
  # first and last words instead and span the two.
  $words = $text -split '\s+' | Where-Object { $_.Length -gt 0 }
  if ($words.Count -lt 3) { return $null }
  $head = ($words[0..([math]::Min(3, $words.Count - 1))]) -join ' '
  $tail = ($words[([math]::Max(0, $words.Count - 4))..($words.Count - 1)]) -join ' '
  foreach ($scope in $scopes) {
    $h1 = $scope.FindText($head, $false, $true)
    if (-not $h1) { continue }
    $rest = $scope.Clone()
    $rest.MoveEndpointByRange($start, $h1, $end)
    $h2 = $rest.FindText($tail, $false, $true)
    if (-not $h2) { continue }
    $span = $h1.Clone()
    $span.MoveEndpointByRange($end, $h2, $end)
    return $span
  }
  return $null
}

Write-Output "READY"
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  try {
    if ($line -eq "anchor") {
      $chars = Get-Anchor
      Write-Output ("OK chars=" + $chars + " window=" + $script:windowName)
    }
    elseif ($line.StartsWith("find ")) {
      $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring(5)))
      $hit = Find-Sentence $text
      if (-not $hit) { Write-Output "NONE not-in-selection" }
      else {
        $script:last = $hit
        $json = Rects-Json $hit
        if ($json) { Write-Output ("RECTS " + $json) } else { Write-Output "NONE off-screen" }
      }
    }
    elseif ($line -eq "rects") {
      if (-not $script:last) { Write-Output "NONE no-hit" }
      else {
        $json = Rects-Json $script:last
        if ($json) { Write-Output ("RECTS " + $json) } else { Write-Output "NONE off-screen" }
      }
    }
    elseif ($line -eq "clear") {
      $script:range = $null
      $script:last = $null
      $script:windowName = ""
      Write-Output "OK"
    }
    elseif ($line -eq "ping") {
      Write-Output "PONG"
    }
    else {
      Write-Output "ERR unknown command"
    }
  } catch {
    Write-Output ("ERR " + $_.Exception.Message.Replace("`r", " ").Replace("`n", " "))
  }
}
