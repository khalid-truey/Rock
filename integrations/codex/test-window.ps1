Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'POK Laya smoke test'
$form.Size = New-Object System.Drawing.Size(440, 240)
$form.StartPosition = 'CenterScreen'
$label = New-Object System.Windows.Forms.Label
$label.Text = 'READY'
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(35, 35)
$label.Font = New-Object System.Drawing.Font('Segoe UI', 14)
$button = New-Object System.Windows.Forms.Button
$button.Text = 'Verify'
$button.Font = New-Object System.Drawing.Font('Segoe UI', 16)
$button.Size = New-Object System.Drawing.Size(180, 45)
$button.Location = New-Object System.Drawing.Point(35, 90)
$button.Add_Click({ $label.Text = 'PASSED' })
$form.Controls.Add($label)
$form.Controls.Add($button)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 300000
$timer.Add_Tick({ $form.Close() })
$timer.Start()
[void]$form.ShowDialog()
$timer.Dispose()
$form.Dispose()
