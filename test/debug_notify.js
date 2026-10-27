import { platform } from 'node:os'
import { execFile } from 'node:child_process'

const safeTitle = '测试通知标题'
const safeBody = '测试通知内容'
const sound = true

const xmlPayload = [
  '<toast>',
  '  <visual>',
  '    <binding template="ToastGeneric">',
  `      <text>${safeTitle}</text>`,
  `      <text>${safeBody}</text>`,
  '    </binding>',
  '  </visual>',
  sound ? '  <audio src="ms-winsoundevent:Notification.Default" />' : '  <audio silent="true" />',
  '</toast>'
].join('')

const b64Xml = Buffer.from(xmlPayload, 'utf8').toString('base64')

const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $bytes = [System.Convert]::FromBase64String('${b64Xml}')
  $rawXml = [System.Text.Encoding]::UTF8.GetString($bytes)
  $xml.LoadXml($rawXml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml

  $appIds = @('electron.app.DeepSeek Harness', '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe')
  foreach ($aid in $appIds) {
    try {
      $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aid)
      Write-Host "Notifier for $aid Setting: $($notifier.Setting)"
      $notifier.Show($toast)
      Write-Host "SUCCESS with AppId: $aid"
    } catch {
      Write-Host "FAILED with AppId: $aid Error: $($_.Exception.Message)"
    }
  }
} catch {
  Write-Host "OUTER FAILED: $($_.Exception.Message)"
}
`

const b64 = Buffer.from(psScript, 'utf16le').toString('base64')
execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], (err, stdout, stderr) => {
  console.log('STDOUT:\n', stdout)
  console.log('STDERR:\n', stderr)
  if (err) console.error('ERR:\n', err)
})
