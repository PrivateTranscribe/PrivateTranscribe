# Persistent worker: waits for the trigger hotkey to be released, then sends a
# clean Ctrl+C to the foreground window.
#
# Deliberately uses only managed APIs. An earlier version P/Invoked
# keybd_event + GetAsyncKeyState and Windows Defender AMSI blocked the whole
# script as "malicious content" - those two calls are a textbook keylogger
# signature. Control::ModifierKeys and SendKeys do the same job unflagged.
#
# Protocol on stdin/stdout, one line each way:
#   <- READY               once, at startup
#   -> copy                send Ctrl+C to whatever has focus
#   <- OK waited=NNNms     copy sent, after waiting NNN ms for modifier release
#   -> ping                measure the round-trip; injects nothing, waits for
#   <- PONG                nothing - it prices the line protocol itself
#   <- ERR <message>       something threw
#
# The process is long-lived because PowerShell startup is ~300ms and the read
# hotkey has to feel instant. See src/helpers/selectionCapture.js.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms

function Send-CopyKeystroke {
  # The hotkey is still physically held when we get here. Injecting Ctrl+C now
  # makes the target app see Ctrl+Shift+Alt+C, which copies nothing.
  $waited = 0
  while (([System.Windows.Forms.Control]::ModifierKeys -ne [System.Windows.Forms.Keys]::None) -and $waited -lt 2000) {
    Start-Sleep -Milliseconds 15
    $waited += 15
  }
  Start-Sleep -Milliseconds 40
  [System.Windows.Forms.SendKeys]::SendWait('^c')
  return $waited
}

Write-Output "READY"
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq "copy") {
    try { $w = Send-CopyKeystroke; Write-Output "OK waited=${w}ms" }
    catch { Write-Output ("ERR " + $_.Exception.Message) }
  }
  elseif ($line.Trim() -eq "ping") {
    Write-Output "PONG"
  }
}
