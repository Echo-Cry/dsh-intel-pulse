import { loadConfig } from './lib/config.js'
import { acquireLock, releaseLock, touchLock } from './lib/store.js'
import { createIdleProbe } from './lib/idle.js'
import { createStateManager } from './lib/state.js'
import { defaultLogger } from './lib/log.js'
import { createRpcHandler } from './lib/rpc.js'
import { collect } from './lib/collect.js'
import { composeMessage } from './lib/compose.js'
import { deliver } from './lib/deliver.js'
import { recordRun } from './lib/billing.js'
import { resolveEgo, stopEgoBrowser } from './lib/ego.js'
import { executeChildCollect, cleanOldChildSessions } from './lib/child.js'
import { tryEnterRun, exitRun, isRunBusy } from './lib/run-guard.js'
import { createSessionEventListener } from './lib/listener.js'

export const name = 'dsh-intel-pulse'
export const inject = ['sessions', 'agents']

export function apply(ctx) {
  const logger = defaultLogger
  logger.info('Initializing dsh-intel-pulse plugin...')

  const lockRes = acquireLock()
  if (!lockRes.acquired) {
    logger.warn(`Another instance is running (pid ${lockRes.existingPid}), skipping background loop in this instance.`)
  } else {
    // 抢到锁就立刻挂一条卸载清理：后面任何一步（RPC 注册、inject 抛错）失败，
    // 锁也不会粘住。粘住的锁 pid 还是本进程，下次热重载会把自己当成「另一个实例」，
    // 表面上插件在跑，实际轮询再也不会启动。
    try {
      ctx.effect?.(() => () => {
        try { releaseLock() } catch {}
      })
    } catch (e) {
      logger.warn('Failed to register lock cleanup: ' + String(e?.message || e))
      try { releaseLock() } catch {}
      throw e
    }
  }

  const probe = createIdleProbe(ctx, logger)
  const stateMgr = createStateManager()

  // 临时诊断（仅在数据目录里存在 DIAG-LIST 文件时生效）：
  // 把「宿主 live registry 里有没有目标会话」和「GUI 列表接口 sessionController.list() 里有没有它」
  // 同时打进日志，用来区分「行是被 api-session/removed 摘掉的」还是「持久化列表里本来就没有」。
  if (lockRes.acquired) {
    setTimeout(async () => {
      try {
        const fsMod = await import('node:fs')
        const pathMod = await import('node:path')
        const dir = pathMod.join(process.env.USERPROFILE || '', '.dsh', 'away-notify-data')
        if (!fsMod.existsSync(pathMod.join(dir, 'DIAG-LIST'))) return
        const cfg = loadConfig()
        const ids = (Array.isArray(cfg.sessionIds) ? cfg.sessionIds : []).map(String)
        const agents = ctx.get('agents')
        const live = ids.map((id) => {
          try {
            return agents?.get?.(id) ? 'live' : 'gone'
          } catch {
            return 'err'
          }
        })
        let listInfo = 'no service'
        const sc = ctx.get('sessionController')
        if (typeof sc?.list === 'function') {
          const v = await sc.list({}, new AbortController().signal)
          const arr = Array.isArray(v)
            ? v
            : Array.isArray(v?.sessions)
              ? v.sessions
              : Array.isArray(v?.items)
                ? v.items
                : []
          const seen = ids.map((id) =>
            arr.some((s) => String(s?.id || s?.sessionId || '') === id) ? 'in-list' : 'missing'
          )
          listInfo = `count=${arr.length} ${seen.join(',')} keys=${Object.keys(v || {}).join('/')}`
        }
        logger.info(`[diag] liveTarget=${live.join(',')} list(${listInfo})`)

        // 再试一次 sessionController.resolveAgent：这是 GUI 点开会话时走的那条路，
        // 如果它能返回一个可写的 session，且不随插件卸载被销毁，投递就该改用它。
        for (const id of ids) {
          try {
            const r = await sc.resolveAgent(id)
            const keys = r && typeof r === 'object' ? Object.keys(r).join('/') : typeof r
            const hasSession = Boolean(r?.session && typeof r.session.append === 'function')
            let liveAfter = 'gone'
            try {
              liveAfter = agents?.get?.(id) ? 'live' : 'gone'
            } catch {}
            logger.info(`[diag] resolveAgent(${id}) keys=${keys} hasSession=${hasSession} liveAfter=${liveAfter}`)
          } catch (e) {
            logger.warn(`[diag] resolveAgent failed: ${e?.message || e}`)
          }
        }
      } catch (e) {
        logger.warn('[diag] failed: ' + (e?.message || e))
      }
    }, 5000)

    // 临时诊断（仅在数据目录里存在 DIAG-PERSONA 文件时生效）：
    // 把人设相关段落的名字、长度、开头打进日志，用来确认「官方 persona-prefix 段默认有没有正文」。
    setTimeout(async () => {
      try {
        const fsMod = await import('node:fs')
        const pathMod = await import('node:path')
        const dir = pathMod.join(process.env.USERPROFILE || '', '.dsh', 'away-notify-data')
        if (!fsMod.existsSync(pathMod.join(dir, 'DIAG-PERSONA'))) return
        const sp = ctx.get('systemPrompt')
        if (typeof sp?.assemble !== 'function') {
          logger.warn('[diag] persona: systemPrompt.assemble 不可用')
          return
        }
        const asm = await sp.assemble({})
        const sections = Array.isArray(asm?.sections) ? asm.sections : []
        logger.info(`[diag] persona: sections=${sections.length} names=${sections.map((s) => s.name).join(',')}`)
        for (const s of sections) {
          if (!/persona|人设|人格|character|role/i.test(String(s?.name || ''))) continue
          const text = String(s?.text || '').replace(/\s+/g, ' ').trim()
          logger.info(`[diag] persona section ${s.name} len=${text.length} head=${text.slice(0, 160)}`)
        }
      } catch (e) {
        logger.warn('[diag] persona failed: ' + (e?.message || e))
      }
    }, 5000)
  }


  // 1. 注册 RPC
  const rpcHandler = createRpcHandler(ctx, { probe, stateMgr, logger })
  const RPC_ROUTE_PATH = '/api/away-notify'

  ctx.inject(['connection'], (remoteCtx) => {
    try {
      remoteCtx.effect(() => {
        return remoteCtx.connection.fetch.register({
          path: RPC_ROUTE_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            let envelope
            try {
              envelope = await request.json()
            } catch {
              return new Response('body is not JSON', { status: 400 })
            }
            const rpcId = envelope?.rpcId
            if (envelope?.type !== 'client-request' || typeof rpcId !== 'string' || typeof envelope.payload !== 'object' || envelope.payload === null) {
              return new Response('invalid envelope', { status: 400 })
            }
            const p = envelope.payload
            const endpoint = typeof p.endpoint === 'string' ? p.endpoint : '(missing endpoint)'
            const result = await rpcHandler(endpoint, p)
            return Response.json({ type: 'server-response', rpcId, result })
          }
        })
      })
      logger.info(`RPC route registered at ${RPC_ROUTE_PATH}`)
    } catch (e) {
      logger.error('Failed to register RPC route:', e)
    }
  })

  // 2. 启动闲置探测
  if (lockRes.acquired) {
    probe.start()
  }

  // 3. 后台轮询主循环（闸门与设置页的「测试运行」共享，见 lib/run-guard.js）
  async function triggerScheduledRun() {
    if (!tryEnterRun()) return
    const startTime = Date.now()
    const cfg = loadConfig()
    // ego 直连/脚本模式要开浏览器逐条读页面，给足 5 分钟，别让它被总超时打断。
    const signal = AbortSignal.timeout(300000)

    try {
      logger.info('Triggering scheduled away notify run...')
      const collectRes = await collect(
        cfg,
        ctx,
        signal,
        (m, c, cx, sig) => executeChildCollect(m, c, cx, sig)
      )

      if (collectRes.trail?.length) {
        logger.warn('采集回退链：' + collectRes.trail
          .map(t => `${t.from} → ${t.to || '（停）'}：${String(t.reason || '').slice(0, 200)}`)
          .join(' ｜ '))
      }

      const hasContent = (collectRes.items && collectRes.items.length > 0) || (collectRes.images && collectRes.images.length > 0)
      if (!collectRes.ok || !hasContent) {
        const errorMsg = collectRes.error || '采集失败或为空'
        stateMgr.setLastError(errorMsg)
        stateMgr.recordFailure(new Date(), errorMsg)
        recordRun({
          ok: false,
          error: errorMsg,
          durationMs: Date.now() - startTime,
          method: collectRes.method || cfg.method,
          mode: cfg.mode,
          trail: collectRes.trail || [],
          sourcesNote: collectRes.sourcesNote || null,
          test: false
        })
        return
      }

      const entries = collectRes.items || []
      const images = collectRes.images || []
      const composeRes = await composeMessage(ctx, cfg, entries, signal, images)
      if (!composeRes.text) {
        const errorMsg = '生成文案为空 (emptyCompose)'
        stateMgr.setLastError(errorMsg)
        stateMgr.recordFailure(new Date(), errorMsg)
        recordRun({
          ok: false,
          error: errorMsg,
          durationMs: Date.now() - startTime,
          method: collectRes.method || cfg.method,
          mode: cfg.mode,
          trail: collectRes.trail || [],
          sourcesNote: collectRes.sourcesNote || null,
          entries,
          test: false
        })
        return
      }

      const deliverRes = await deliver(ctx, cfg, composeRes.text, { signal })
      const durationMs = Date.now() - startTime

      const usage = {
        input: (collectRes.usage?.input || 0) + (composeRes.usage?.input || 0),
        output: (collectRes.usage?.output || 0) + (composeRes.usage?.output || 0),
        cacheRead: (collectRes.usage?.cacheRead || 0) + (composeRes.usage?.cacheRead || 0),
        cacheWrite: (collectRes.usage?.cacheWrite || 0) + (composeRes.usage?.cacheWrite || 0),
        reasoning: (collectRes.usage?.reasoning || 0) + (composeRes.usage?.reasoning || 0)
      }

      recordRun({
        ok: deliverRes.ok,
        error: deliverRes.error || null,
        durationMs,
        method: collectRes.method || cfg.method,
        mode: cfg.mode,
        trail: collectRes.trail || [],
        sourcesNote: collectRes.sourcesNote || null,
        entries,
        images,
        text: composeRes.text,
        persona: composeRes.persona || null,
        targetKind: 'session',
        targetId: (deliverRes.targets || cfg.sessionIds || []).join(','),
        delivered: deliverRes.delivered || [],
        imSync: deliverRes.imSync || null,
        usage,
        childId: collectRes.childId || null,
        browserStopped: collectRes.browserStopped || false,
        test: false
      })

      if (deliverRes.ok) {
        // 部分成功也算「这轮推过了」：记录成功可以避免下一轮把同一条再灌给已经收到的那几个会话；
        // 但没投到的那些要把原因摆到界面上，不能安静地当成功。
        stateMgr.recordDeliverySuccess(new Date(), cfg.mode)
        if (deliverRes.partial) {
          stateMgr.setLastError(deliverRes.error || '部分会话没投成功')
          logger.warn('Scheduled away notify partially delivered:', deliverRes.error)
        } else {
          stateMgr.setLastError(null)
        }
        logger.info(`Scheduled away notify delivered to ${deliverRes.okCount || 0} session(s).`, {
          failed: deliverRes.failCount || 0,
          partial: Boolean(deliverRes.partial),
          imSync: deliverRes.imSync ? (deliverRes.imSync.ok ? 'sent' : deliverRes.imSync.error) : 'off'
        })
      } else {
        stateMgr.setLastError(deliverRes.error || 'deliverFailed')
        stateMgr.recordFailure(new Date(), deliverRes.error || 'deliverFailed')
        logger.warn('Scheduled away notify deliver failed:', deliverRes.error)
      }

    } catch (e) {
      stateMgr.setLastError(e.message)
      stateMgr.recordFailure(new Date(), e.message)
      recordRun({
        ok: false,
        error: e.message,
        durationMs: Date.now() - startTime,
        method: cfg.method,
        mode: cfg.mode,
        test: false
      })
      logger.error('Scheduled away notify exception:', e)
    } finally {
      exitRun()
    }
  }

  let pollTick = null
  let cleanupInterval = null
  let lastFullPoll = 0

  if (lockRes.acquired) {
    // 2s 细粒度 tick：真正轮询按当前配置的 pollSec 判定，改配置即生效（无需重启）
    pollTick = setInterval(async () => {
      try {
        const currentCfg = loadConfig()
        const pollMs = Math.max((Number(currentCfg.pollSec) || 60) * 1000, 5000)
        if (Date.now() - lastFullPoll < pollMs) return
        if (isRunBusy()) return
        lastFullPoll = Date.now()
        const snap = probe.getStatus()
        const evalRes = stateMgr.evaluate(new Date(), snap, currentCfg)
        if (evalRes.ok) {
          await triggerScheduledRun()
        } else {
          logger.info(`[poll] skipped: ${evalRes.reason}`, {
            idleSeconds: snap.idleSeconds,
            probeDown: snap.probeDown,
            failStreak: stateMgr.getRuntimeSnapshot().failStreak
          })
        }
      } catch (e) {
        logger.error('Poll evaluation error:', e)
      }
    }, 2000)

    // 清道夫循环（每 10 分钟）：顺手给锁打心跳，让别的实例看得出这锁还活着
    cleanupInterval = setInterval(async () => {
      try {
        touchLock()
        const currentCfg = loadConfig()
        await cleanOldChildSessions(ctx, currentCfg)
      } catch {}
    }, 10 * 60 * 1000)
  }

  // 监听宿主全局会话事件（实现会话状态系统弹窗通知：多通道保活）
  const sessionListener = createSessionEventListener(ctx, logger)

  // 卸载与清理
  ctx.effect(() => {
    return () => {
      logger.info('Disposing dsh-intel-pulse plugin...')
      if (sessionListener) sessionListener.stop()
      if (pollTick) clearInterval(pollTick)
      if (cleanupInterval) clearInterval(cleanupInterval)
      probe.stop()
      releaseLock()

      // 兜底关闭可能打开的 ego 浏览器
      try {
        const cfg = loadConfig()
        resolveEgo(ctx, cfg).then(ego => {
          stopEgoBrowser(ctx, ego).catch(() => {})
        }).catch(() => {})
      } catch {}
    }
  })
}
