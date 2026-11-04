param(
  [string]$ProductName = 'Agentrans'
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "$ProductName - Choose what to remove"
$form.StartPosition = 'CenterScreen'
$form.Width = 460
$form.Height = 360
$form.MinimizeBox = $false
$form.MaximizeBox = $false

$title = New-Object System.Windows.Forms.Label
$title.Text = 'Choose what to remove'
$title.Font = New-Object System.Drawing.Font($title.Font.FontFamily, 12, [System.Drawing.FontStyle]::Bold)
$title.SetBounds(20, 16, 410, 26)
$form.Controls.Add($title)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = 'The application is always removed. Other data is removed only when selected.'
$hint.SetBounds(20, 48, 410, 34)
$form.Controls.Add($hint)

function New-ScopeCheckbox([string]$text, [int]$y, [bool]$checked = $false, [bool]$enabled = $true) {
  $box = New-Object System.Windows.Forms.CheckBox
  $box.Text = $text
  $box.SetBounds(24, $y, 390, 22)
  $box.Checked = $checked
  $box.Enabled = $enabled
  $form.Controls.Add($box)
  return $box
}

$appBox = New-ScopeCheckbox 'Application' 88 $true $false
$sessionsBox = New-ScopeCheckbox 'Sessions and conversation history' 116
$settingsBox = New-ScopeCheckbox 'Settings and install metadata' 144
$modelsBox = New-ScopeCheckbox 'Model resources' 172
$runtimesBox = New-ScopeCheckbox 'Independent runtimes' 200
$exportsBox = New-ScopeCheckbox 'Exported files' 228
$dataBoxes = @($sessionsBox, $settingsBox, $modelsBox, $runtimesBox, $exportsBox)

$allButton = New-Object System.Windows.Forms.Button
$allButton.Text = 'Select all data'
$allButton.SetBounds(24, 262, 150, 28)
$allButton.Add_Click({
  foreach ($box in $dataBoxes) { $box.Checked = $true }
})
$form.Controls.Add($allButton)

$acceptButton = New-Object System.Windows.Forms.Button
$acceptButton.Text = 'Uninstall'
$acceptButton.SetBounds(190, 262, 110, 28)
$acceptButton.Add_Click({
  $scope = @{
    app = $true
    sessions = $sessionsBox.Checked
    settings = $settingsBox.Checked
    models = $modelsBox.Checked
    runtimes = $runtimesBox.Checked
    exports = $exportsBox.Checked
  }
  $allSelected = $true
  foreach ($box in $dataBoxes) {
    if (-not $box.Checked) { $allSelected = $false }
  }
  $confirmed = $false
  if ($allSelected) {
    $answer = [System.Windows.Forms.MessageBox]::Show(
      'Remove all selected data? This cannot be undone.',
      'Confirm full uninstall',
      [System.Windows.Forms.MessageBoxButtons]::YesNo,
      [System.Windows.Forms.MessageBoxIcon]::Warning
    )
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    $confirmed = $true
  }
  $script:result = @{ scope = $scope; allConfirmed = $confirmed }
  $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $form.Close()
})
$form.Controls.Add($acceptButton)

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = 'Cancel'
$cancelButton.SetBounds(312, 262, 110, 28)
$cancelButton.Add_Click({
  $form.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $form.Close()
})
$form.Controls.Add($cancelButton)

$form.AcceptButton = $acceptButton
$form.CancelButton = $cancelButton
$answer = $form.ShowDialog()
if ($answer -ne [System.Windows.Forms.DialogResult]::OK) {
  'null'
} else {
  $script:result | ConvertTo-Json -Depth 5 -Compress
}
