import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadConfig } from './config.js'
import { sendDesktopNotification } from './notify.js'
import { searchImagesByRequest } from './gallery.js'
import { sendOneBotMessage } from './onebot.js'

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

// 缓存会话标题，避免同一会话每次弹窗都进行文件系统 I/O
const titleCache = new Map() // sessionId -> { title: string, expireAt: number }

function isRawId(str) {
  if (typeof str !== 'string') return true
  return /^session-[0-9a-fA-F-]+$/.test(str) ||
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str)
}

/**
 * 解析会话的真实人类可读标题
 * 既支持 session 实例，也支持裸 sessionId 字符串
 * 优先从 DSH 宿主的 session_projcache 获取，杜绝将底层内部 UUID 暴露给用户
 */
function resolveSessionTitle(sessionOrId) {
  if (!sessionOrId) return '当前会话'

  let rawId = ''
  if (typeof sessionOrId === 'string') {
    rawId = sessionOrId.trim()
  } else if (typeof sessionOrId === 'object') {
    const directTitle = sessionOrId.title || sessionOrId.name
    if (typeof directTitle === 'string' && directTitle.trim() && !isRawId(directTitle.trim())) {
      return directTitle.trim()
    }
    rawId = String(sessionOrId.id || '').trim()
  }

  if (!rawId) return '当前会话'

  // 1. 查内存缓存（30 秒有效）
  const cached = titleCache.get(rawId)
  if (cached && Date.now() < cached.expireAt) {
    return cached.title
  }

  // 2. 从 DSH 宿主的 session_projcache 读取真实标题
  const cleanId = rawId.replace(/^session-/, '')
  const sessionsDir = path.join(dshHome(), 'storages', 'session_projcache', 'sessions')
  const candidates = [
    path.join(sessionsDir, `session-${cleanId}.json`),
    path.join(sessionsDir, `${cleanId}.json`)
  ]

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        const data = JSON.parse(fs.readFileSync(c, 'utf8'))
        const val = data?.record?.rows?.title?.val || data?.title
        if (typeof val === 'string' && val.trim()) {
          const res = val.trim()
          titleCache.set(rawId, { title: res, expireAt: Date.now() + 30000 })
          return res
        }
      }
    } catch {}
  }

  // 3. 若为新会话且尚未生成标题，优雅兜底，杜绝暴露生硬 UUID
  const fallback = '当前会话'
  titleCache.set(rawId, { title: fallback, expireAt: Date.now() + 5000 })
  return fallback
}

/**
 * 监听 DSH 全局会话生命周期与事件，实现原生桌面弹窗通知。
 * 覆盖场景：
 * 1. AI 完成本轮回复 (api-session/status running=false / agent/status idle / session/event turn/end)
 * 2. 需要用户操作 (tool/call ask_user_question / exit_plan_mode / 权限审批)
 * 3. 运行出错 (api-session/error / agent/error / turn/end 且 reason 为 error)
 */
export function createSessionEventListener(ctx, logger) {
  // 防抖记录：同一会话在短时间内避免重复弹窗
  const recentNotifies = new Map() // key: sessionId -> timestamp
  // 追踪活跃运行的会话集合，确保仅在运行转为空闲状态时触发完成弹窗
  const runningSessions = new Set()

  function shouldThrottle(key, intervalMs = 2500) {
    const now = Date.now()
    const last = recentNotifies.get(key) || 0
    if (now - last < intervalMs) return true
    recentNotifies.set(key, now)
    return false
  }

  function triggerComplete(sessionOrId) {
    try {
      const cfg = loadConfig()
      const dCfg = cfg.desktopNotify || {}
      if (!dCfg.enabled || !dCfg.onComplete) return

      const sid = typeof sessionOrId === 'string' ? sessionOrId : (sessionOrId?.id || 'unknown')
      if (shouldThrottle(`complete:${sid}`)) return

      const sessionTitle = resolveSessionTitle(sessionOrId)
      sendDesktopNotification({
        title: `✅ 回复完成 · ${sessionTitle}`,
        body: 'AI 思考与回答已生成完毕',
        sound: Boolean(dCfg.sound)
      }).catch((e) => {
        logger?.debug?.('Desktop notification error: ' + (e?.message || e))
      })
    } catch (e) {
      logger?.debug?.('triggerComplete error: ' + (e?.message || e))
    }
  }

  function triggerError(sessionOrId, errorMsg) {
    try {
      const cfg = loadConfig()
      const dCfg = cfg.desktopNotify || {}
      if (!dCfg.enabled || !dCfg.onError) return

      const sid = typeof sessionOrId === 'string' ? sessionOrId : (sessionOrId?.id || 'unknown')
      if (shouldThrottle(`error:${sid}`)) return

      const sessionTitle = resolveSessionTitle(sessionOrId)
      const bodyText = (typeof errorMsg === 'string' && errorMsg.trim())
        ? errorMsg.trim()
        : '模型运行出现异常'

      sendDesktopNotification({
        title: `⚠️ 运行出错 · ${sessionTitle}`,
        body: bodyText,
        sound: Boolean(dCfg.sound)
      }).catch((e) => {
        logger?.debug?.('Desktop notification error: ' + (e?.message || e))
      })
    } catch (e) {
      logger?.debug?.('triggerError error: ' + (e?.message || e))
    }
  }

  function triggerActionRequired(sessionOrId, detail) {
    try {
      const cfg = loadConfig()
      const dCfg = cfg.desktopNotify || {}
      if (!dCfg.enabled || !dCfg.onActionRequired) return

      const sid = typeof sessionOrId === 'string' ? sessionOrId : (sessionOrId?.id || 'unknown')
      if (shouldThrottle(`action:${sid}`)) return

      const sessionTitle = resolveSessionTitle(sessionOrId)
      sendDesktopNotification({
        title: `🔔 需要操作 · ${sessionTitle}`,
        body: detail || 'AI 正在等待您的回复或确认',
        sound: Boolean(dCfg.sound)
      }).catch((e) => {
        logger?.debug?.('Desktop notification error: ' + (e?.message || e))
      })
    } catch (e) {
      logger?.debug?.('triggerActionRequired error: ' + (e?.message || e))
    }
  }

  // -------------------------------------------------------------
  // 通道 0: internal/dispatch 终极全局分发钩子（Cordis 内核最顶层，无视任何 Scope 隔离）
  // -------------------------------------------------------------
  const disposers = []

  try {
    const offDispatch = ctx.on('internal/dispatch', (_mode, name, args, thisArg) => {
      try {
        if (!name || typeof name !== 'string') return

        // 场景 A: 会话细粒度事件 session/event
        if (name === 'session/event') {
          const session = args?.[0]
          const event = args?.[1]
          if (!session || !event) return
          const sessionId = session?.id || 'unknown'

          // 1. 需要用户操作 / 提问 / 计划退出
          if (event.type === 'tool/call') {
            const toolName = event.data?.name || ''
            if (toolName === 'ask_user_question' || toolName === 'exit_plan_mode') {
              let detail = 'AI 正在等待您的回复或确认'
              if (toolName === 'ask_user_question') {
                try {
                  const callArgs = typeof event.data.arguments === 'string'
                    ? JSON.parse(event.data.arguments)
                    : (event.data.arguments || {})
                  const q = callArgs?.questions?.[0]?.question || callArgs?.question
                  if (q) detail = `提问：${q}`
                } catch {}
              } else if (toolName === 'exit_plan_mode') {
                detail = 'AI 提出了方案，请前往查看并确认'
              }
              triggerActionRequired(session, detail)
            }
            return
          }

          // 2. 回合结束事件
          if (event.type === 'turn/end') {
            const reason = event.data?.reason
            const isError = reason?.kind === 'error' || Boolean(event.data?.error)

            if (isError) {
              const errMsg = reason?.error?.message || event.data?.error?.message || '模型运行出现异常'
              triggerError(session, errMsg)
              return
            }

            if (reason?.kind === 'cancelled' || reason?.kind === 'aborted') {
              return
            }

            // 正常完成提醒
            triggerComplete(session)
          }
          return
        }

        // 场景 B: 状态机状态广播 agent/status
        if (name === 'agent/status') {
          const payload = args?.[0]
          const agent = payload?.agent
          const status = payload?.status
          const sid = agent?.id || agent?.session?.id
          if (!sid) return
          if (status === 'running') {
            runningSessions.add(sid)
          } else if (status === 'idle') {
            triggerComplete(sid)
          }
          return
        }

        // 场景 C: 底层异常广播 agent/error
        if (name === 'agent/error') {
          const payload = args?.[0]
          const agent = payload?.agent
          const error = payload?.error
          const sid = agent?.id || agent?.session?.id
          const msg = error?.message || (typeof error === 'string' ? error : '')
          triggerError(sid, msg)
          return
        }

        // 场景 D: 全局会话状态广播 api-session/status
        if (name === 'api-session/status') {
          const sessionId = args?.[0]
          const running = args?.[1]
          if (!sessionId) return
          if (running) {
            runningSessions.add(sessionId)
          } else {
            triggerComplete(sessionId)
          }
          return
        }

        // 场景 E: 全局会话异常广播 api-session/error
        if (name === 'api-session/error') {
          const sessionId = args?.[0]
          const message = args?.[1]
          triggerError(sessionId, message)
          return
        }
      } catch (err) {
        logger?.debug?.('internal/dispatch handler error: ' + (err?.message || err))
      }
    }, { global: true, prepend: true })
    if (typeof offDispatch === 'function') disposers.push(offDispatch)
  } catch (e) {
    logger?.debug?.('Failed to bind internal/dispatch: ' + (e?.message || e))
  }

  // -------------------------------------------------------------
  // 通道 1: DSH 全局 api-session/status 广播（常规注册）
  // -------------------------------------------------------------
  try {
    const offApiStatus = ctx.on('api-session/status', (sessionId, running) => {
      if (running) {
        runningSessions.add(sessionId)
      } else {
        triggerComplete(sessionId)
      }
    }, { global: true })
    if (typeof offApiStatus === 'function') disposers.push(offApiStatus)
  } catch (e) {
    logger?.debug?.('Failed to bind api-session/status: ' + (e?.message || e))
  }

  // -------------------------------------------------------------
  // 通道 2: DSH 全局 api-session/error 广播
  // -------------------------------------------------------------
  try {
    const offApiError = ctx.on('api-session/error', (sessionId, message) => {
      triggerError(sessionId, message)
    }, { global: true })
    if (typeof offApiError === 'function') disposers.push(offApiError)
  } catch (e) {
    logger?.debug?.('Failed to bind api-session/error: ' + (e?.message || e))
  }

  // -------------------------------------------------------------
  // 通道 3: DSH 底层 agent/status 状态机广播
  // -------------------------------------------------------------
  try {
    const offAgentStatus = ctx.on('agent/status', ({ agent, status }) => {
      const sid = agent?.id || agent?.session?.id
      if (!sid) return
      if (status === 'running') {
        runningSessions.add(sid)
      } else if (status === 'idle') {
        triggerComplete(sid)
      }
    }, { global: true })
    if (typeof offAgentStatus === 'function') disposers.push(offAgentStatus)
  } catch (e) {
    logger?.debug?.('Failed to bind agent/status: ' + (e?.message || e))
  }

  // -------------------------------------------------------------
  // 通道 4: DSH 底层 agent/error 广播
  // -------------------------------------------------------------
  try {
    const offAgentError = ctx.on('agent/error', ({ agent, error }) => {
      const sid = agent?.id || agent?.session?.id
      const msg = error?.message || (typeof error === 'string' ? error : '')
      triggerError(sid, msg)
    }, { global: true })
    if (typeof offAgentError === 'function') disposers.push(offAgentError)
  } catch (e) {
    logger?.debug?.('Failed to bind agent/error: ' + (e?.message || e))
  }

  // -------------------------------------------------------------
  // 通道 5: session/event 细粒度事件
  // -------------------------------------------------------------
  try {
    const offSessionEvent = ctx.on('session/event', (session, event) => {
      try {
        if (!event || !session) return
        const sessionId = session?.id || 'unknown'

        // 1. 需要用户操作 / 提问 / 计划退出
        if (event.type === 'tool/call') {
          const toolName = event.data?.name || ''
          if (toolName === 'ask_user_question' || toolName === 'exit_plan_mode') {
            let detail = 'AI 正在等待您的回复或确认'
            if (toolName === 'ask_user_question') {
              try {
                const args = typeof event.data.arguments === 'string'
                  ? JSON.parse(event.data.arguments)
                  : (event.data.arguments || {})
                const q = args?.questions?.[0]?.question || args?.question
                if (q) detail = `提问：${q}`
              } catch {}
            } else if (toolName === 'exit_plan_mode') {
              detail = 'AI 提出了方案，请前往查看并确认'
            }
            triggerActionRequired(session, detail)
          }
          return
        }

        // 2. 回合结束事件
        if (event.type === 'turn/end') {
          const reason = event.data?.reason
          const isError = reason?.kind === 'error' || Boolean(event.data?.error)

          if (isError) {
            const errMsg = reason?.error?.message || event.data?.error?.message || '模型运行出现异常'
            triggerError(session, errMsg)
            return
          }

          if (reason?.kind === 'cancelled' || reason?.kind === 'aborted') {
            return
          }

          // 正常完成提醒
          triggerComplete(session)
        }
      } catch (inner) {
        logger?.debug?.('session/event handler error: ' + (inner?.message || inner))
      }
    }, { global: true })
    if (typeof offSessionEvent === 'function') disposers.push(offSessionEvent)
  } catch (e) {
    logger?.debug?.('Failed to bind session/event: ' + (e?.message || e))
  }

  // -------------------------------------------------------------
  // 群内“图库采集：找XXX”智能点图监听器
  // -------------------------------------------------------------
  const inboxPath = path.join(dshHome(), 'media', 'onebot', 'qq-inbox.jsonl')
  let lastFileOffset = 0
  let isCheckingInbox = false
  const handledMessageIds = new Set()

  try {
    if (fs.existsSync(inboxPath)) {
      const stat = fs.statSync(inboxPath)
      lastFileOffset = Math.max(0, stat.size - 8192)
    }
  } catch {}

  async function checkInboxForGalleryRequests() {
    if (isCheckingInbox) return
    isCheckingInbox = true

    try {
      const cfg = loadConfig()
      const gCfg = cfg.gallery || {}
      if (!gCfg.enabled || gCfg.requestTriggerEnabled === false) {
        return
      }

      if (!fs.existsSync(inboxPath)) return
      const stat = fs.statSync(inboxPath)
      if (stat.size <= lastFileOffset) {
        if (stat.size < lastFileOffset) {
          lastFileOffset = 0
        }
        return
      }

      const diffSize = stat.size - lastFileOffset
      const fd = fs.openSync(inboxPath, 'r')
      const buffer = Buffer.alloc(diffSize)
      fs.readSync(fd, buffer, 0, diffSize, lastFileOffset)
      fs.closeSync(fd)
      lastFileOffset = stat.size

      const chunkText = buffer.toString('utf8')
      const lines = chunkText.split(/\r?\n/).map(l => l.trim()).filter(Boolean)

      for (const line of lines) {
        try {
          if (!line.startsWith('{')) continue
          const entry = JSON.parse(line)
          const frame = entry?.frame || {}
          if (frame.post_type !== 'message') continue

          const messageId = String(frame.message_id || '')
          if (messageId && handledMessageIds.has(messageId)) continue
          if (messageId) handledMessageIds.add(messageId)

          if (handledMessageIds.size > 500) {
            const first = handledMessageIds.values().next().value
            handledMessageIds.delete(first)
          }

          const msgTs = Number(entry?.ts || 0)
          if (msgTs && Date.now() - msgTs > 180000) continue

          const rawMsg = String(frame.raw_message || frame.message || '').trim()
          const reqMatch = rawMsg.match(/(?:\[CQ:at,[^\]]+\]\s*)?(?:图库采集|搜图|点图|搜色图|点色图|找图|查图)[：:\s]*(?:找|搜|点|来点|来张|整点|想要|要|推)?\s*([^\n\r]+)/i)
          if (!reqMatch) continue

          let prompt = reqMatch[1].trim()
          if (!prompt) continue

          let count = 1
          const countMatch = prompt.match(/(?:至少)?(?:来|要|推|发|给)?\s*([1-5一两二三四五])\s*张/)
          if (countMatch) {
            const cnMap = { '一': 1, '两': 2, '二': 2, '三': 3, '四': 4, '五': 5 }
            count = Number(countMatch[1]) || cnMap[countMatch[1]] || 1
            prompt = prompt.replace(/(?:至少)?(?:来|要|推|发|给)?\s*[1-5一两二三四五]\s*张/g, '').trim()
          }

          const groupId = frame.group_id
          const userId = frame.user_id
          const isGroup = Boolean(groupId)
          const targetId = isGroup ? groupId : userId
          const messageType = isGroup ? 'group' : 'private'

          logger?.info?.(`[gallery-trigger] 收到点图指令: "${prompt}" (数量: ${count}) 来自 ${messageType} ${targetId}`)

          const searchRes = await searchImagesByRequest(prompt, gCfg, count)
          if (searchRes.ok && searchRes.images.length > 0) {
            const atPrefix = isGroup && userId ? `[CQ:at,qq=${userId}] ` : ''
            const imgsMarkdown = searchRes.images.map(img => `![${img.title || '插画'}](${img.url})`).join('\n')
            const replyMsg = `${atPrefix}为您找到关于「${prompt || '精选'}」的插画：\n${imgsMarkdown}`

            const obCfg = cfg.onebot || {}
            await sendOneBotMessage(
              { url: obCfg.httpUrl || 'http://127.0.0.1:3000', token: obCfg.accessToken || '' },
              { messageType, targetId: String(targetId), text: replyMsg }
            )
            logger?.info?.(`[gallery-trigger] 点图响应成功并已发送回 ${messageType} ${targetId}`)
          } else {
            const atPrefix = isGroup && userId ? `[CQ:at,qq=${userId}] ` : ''
            const failMsg = `${atPrefix}未能检索到关于「${prompt}」的插画，可尝试更换关键词或标签再试哦。`
            const obCfg = cfg.onebot || {}
            await sendOneBotMessage(
              { url: obCfg.httpUrl || 'http://127.0.0.1:3000', token: obCfg.accessToken || '' },
              { messageType, targetId: String(targetId), text: failMsg }
            )
          }
        } catch (itemErr) {
          logger?.warn?.('[gallery-trigger] 处理点图指令异常: ' + (itemErr?.message || itemErr))
        }
      }
    } catch (e) {
      logger?.debug?.('[gallery-trigger] 扫描 qq-inbox 失败: ' + (e?.message || e))
    } finally {
      isCheckingInbox = false
    }
  }

  const inboxTimer = setInterval(checkInboxForGalleryRequests, 1500)

  return {
    stop: () => {
      if (inboxTimer) clearInterval(inboxTimer)
      for (const fn of disposers) {
        if (typeof fn === 'function') {
          try { fn() } catch {}
        }
      }
      disposers.length = 0
    }
  }
}
