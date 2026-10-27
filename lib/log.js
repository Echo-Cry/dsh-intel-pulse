import { appendFileSync, existsSync, statSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const MAX_FILE_BYTES = 256 * 1024

function logFilePath() {
  try {
    const base = process.env.DSH_HOME || join(homedir(), '.dsh')
    const dir = join(base, 'away-notify-data')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return join(dir, 'plugin.log')
  } catch {
    return null
  }
}

// details 里经常直接塞 Error 对象，JSON.stringify 会把它变成 {}，排障时什么都看不到；
// 所以 Error 先摊成 name/message/stack，有循环引用的对象则退回 String()。
function safeDetails(details) {
  if (details === null || details === undefined) return undefined
  if (typeof details !== 'object') return String(details)
  if (details instanceof Error) {
    return { name: details.name, message: details.message, stack: String(details.stack || '').split('\n').slice(0, 4).join('\n') }
  }
  try {
    return JSON.parse(JSON.stringify(details))
  } catch {
    try {
      return String(details)
    } catch {
      return '[unserializable]'
    }
  }
}

export class RingLog {
  constructor(capacity = 200, { toFile = true } = {}) {
    this.capacity = capacity
    this.buffer = []
    this.toFile = toFile
    this.filePath = toFile ? logFilePath() : null
    this.fileDisabled = false
  }

  push(level, message, details = null) {
    const entry = {
      at: new Date().toISOString(),
      level,
      message: String(message),
      details: safeDetails(details)
    }
    this.buffer.push(entry)
    if (this.buffer.length > this.capacity) {
      this.buffer.shift()
    }
    this.writeToFile(entry)
    return entry
  }

  writeToFile(entry) {
    if (!this.toFile || this.fileDisabled) return
    if (!this.filePath) this.filePath = logFilePath() // 懒解析：模块可能在 DSH_HOME 设置前就导入
    if (!this.filePath) return
    try {
      // 超过上限先轮转一次，避免无限增长
      if (existsSync(this.filePath) && statSync(this.filePath).size > MAX_FILE_BYTES) {
        renameSync(this.filePath, `${this.filePath}.1`)
      }
      const line = `${entry.at} [${entry.level}] ${entry.message}${entry.details !== undefined ? ` ${JSON.stringify(entry.details)}` : ''}\n`
      appendFileSync(this.filePath, line, 'utf-8')
    } catch {
      // 写不进去就别每次重试（文件被占用时 rename/append 都失败，重试只会更卡）；
      // 停掉文件日志，内存里那 200 条还在，界面照样能看。
      this.fileDisabled = true
    }
  }

  info(msg, details) {
    return this.push('info', msg, details)
  }

  debug(msg, details) {
    return this.push('debug', msg, details)
  }

  warn(msg, details) {
    return this.push('warn', msg, details)
  }

  error(msg, details) {
    return this.push('error', msg, details)
  }

  tail(limit = 50) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), this.capacity)
    return this.buffer.slice(-n)
  }

  clear() {
    this.buffer = []
  }
}

export const defaultLogger = new RingLog(200)
