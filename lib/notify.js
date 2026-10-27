import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { platform, homedir } from 'node:os'

/**
 * 桌面原生 Toast / 通知模块
 * 跨平台支持：
 * - Windows: 优先通过 DSH 官方 AppUserModelId (electron.app.DeepSeek Harness) 发送 WinRT Toast，
 *   使弹窗归属为正规的 DeepSeek Harness 官方应用并带图标；
 *   若非标准环境则降级到 PowerShell GUID 或 System.Windows.Forms 气泡。
 * - macOS: 优先调用 osascript 原生系统通知。
 * - Linux: 优先调用 notify-send 桌面通知。
 */

/**
 * 发送一条系统原生桌面通知
 * @param {object} options
 * @param {string} options.title 标题
 * @param {string} options.body 正文内容
 * @param {boolean} [options.sound=true] 是否播放提示音
 * @returns {Promise<boolean>}
 */
export async function sendDesktopNotification({ title = 'DeepSeek Harness', body = '', sound = true }) {
  const currentOs = platform()
  const safeTitle = String(title || 'DeepSeek Harness').replace(/[\r\n\t]/g, ' ').slice(0, 80)
  const safeBody = String(body || '').replace(/[\r\n\t]/g, ' ').slice(0, 180)

  // 1. Windows 平台
  if (currentOs === 'win32') {
    return sendWindowsNotification({ safeTitle, safeBody, sound })
  }

  // 2. macOS 平台
  if (currentOs === 'darwin') {
    return sendDarwinNotification({ safeTitle, safeBody, sound })
  }

  // 3. Linux 平台
  if (currentOs === 'linux') {
    return sendLinuxNotification({ safeTitle, safeBody })
  }

  return false
}

/**
 * Windows 平台通知
 */
function sendWindowsNotification({ safeTitle, safeBody, sound }) {
  // 组装 Toast XML
  const xmlPayload = [
    '<toast>',
    '  <visual>',
    '    <binding template="ToastGeneric">',
    `      <text>${escapeXml(safeTitle)}</text>`,
    `      <text>${escapeXml(safeBody)}</text>`,
    '    </binding>',
    '  </visual>',
    sound ? '  <audio src="ms-winsoundevent:Notification.Default" />' : '  <audio silent="true" />',
    '</toast>'
  ].join('')

  const b64Xml = Buffer.from(xmlPayload, 'utf8').toString('base64')

  // PowerShell 脚本：
  // 优先使用 DeepSeek Harness 官方 AUMID (electron.app.DeepSeek Harness)；
  // 失败时依次尝试经典 PowerShell GUID -> WinForms 气泡兜底
  const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$sent = $false
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $bytes = [System.Convert]::FromBase64String('${b64Xml}')
  $rawXml = [System.Text.Encoding]::UTF8.GetString($bytes)
  $xml.LoadXml($rawXml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml

  $appIds = @(
    'electron.app.DeepSeek Harness',
    '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
  )
  foreach ($aid in $appIds) {
    try {
      $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aid)
      if ($notifier -and $notifier.Setting -eq [Windows.UI.Notifications.NotificationSetting]::Enabled) {
        $notifier.Show($toast)
        $sent = $true
        break
      }
    } catch {}
  }
} catch {}

if (-not $sent) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $balloon = New-Object System.Windows.Forms.NotifyIcon
    $balloon.Icon = [System.Drawing.SystemIcons]::Information
    $balloon.BalloonTipTitle = @'
${safeTitle}
'@
    $balloon.BalloonTipText = @'
${safeBody}
'@
    $balloon.Visible = $true
    $balloon.ShowBalloonTip(3000)
    Start-Sleep -Seconds 3
    $balloon.Dispose()
  } catch {}
}
`

  const b64 = Buffer.from(psScript, 'utf16le').toString('base64')

  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { timeout: 8000 }, (err) => {
      resolve(!err)
    })
  })
}

/**
 * macOS 平台通知 (osascript)
 */
function sendDarwinNotification({ safeTitle, safeBody, sound }) {
  const soundClause = sound ? ' sound name "default"' : ''
  const script = `display notification ${JSON.stringify(safeBody)} with title ${JSON.stringify(safeTitle)}${soundClause}`

  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 6000 }, (err) => {
      resolve(!err)
    })
  })
}

/**
 * Linux 平台通知 (notify-send)
 */
function sendLinuxNotification({ safeTitle, safeBody }) {
  return new Promise((resolve) => {
    execFile('notify-send', [safeTitle, safeBody], { timeout: 6000 }, (err) => {
      resolve(!err)
    })
  })
}

function escapeXml(unsafe) {
  return String(unsafe).replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '&': return '&amp;'
      case '\'': return '&apos;'
      case '"': return '&quot;'
      default: return c
    }
  })
}

