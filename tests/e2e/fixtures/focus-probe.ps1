# A small window that holds the keyboard focus while a live spec presses keys,
# so the spec can prove nothing it does lands in the focused app. It writes how
# often it was the active window and what its text box received, then closes
# when the done file appears (or after -MaxSeconds).
#
#   powershell -File focus-probe.ps1 -ResultFile r.txt -DoneFile done.txt
param(
  [Parameter(Mandatory = $true)][string]$ResultFile,
  [Parameter(Mandatory = $true)][string]$DoneFile,
  [int]$MaxSeconds = 600
)

Add-Type -AssemblyName System.Windows.Forms

$form = New-Object System.Windows.Forms.Form
$form.Text = "PrivateTranscribe focus probe"
$form.TopMost = $true
$form.ShowInTaskbar = $true
$form.StartPosition = "Manual"
$form.Left = 40
$form.Top = 40
$form.Width = 380
$form.Height = 140

$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.Dock = "Fill"
$form.Controls.Add($box)

$state = @{ active = 0; checks = 0; started = Get-Date }
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$timer.Add_Tick({
  $state.checks++
  if ([System.Windows.Forms.Form]::ActiveForm -eq $form) { $state.active++ }
  $expired = ((Get-Date) - $state.started).TotalSeconds -gt $MaxSeconds
  if ((Test-Path $DoneFile) -or $expired) {
    $timer.Stop()
    $result = [ordered]@{ active = $state.active; checks = $state.checks; text = $box.Text }
    ($result | ConvertTo-Json -Compress) | Set-Content -Path $ResultFile -Encoding UTF8
    $form.Close()
  }
})
$form.Add_Shown({
  $form.Activate()
  [void]$box.Focus()
  $timer.Start()
})
[void]$form.ShowDialog()
