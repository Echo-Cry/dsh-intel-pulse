import { readFileSync } from 'node:fs'
import { loadConfig, saveConfig, normalizeWindows } from './config.js'
import { getBillingSummary, listRuns, clearRuns, recordRun } from './billing.js'
import { listWorkspaces } from './sessions.js'
import { listChats } from './imchat.js'
import { collect } from './collect.js'
import { composeMessage } from './compose.js'
import { deliver } from './deliver.js'
import { resolveEgo, stopEgoBrowser } from './ego.js'
import { executeChildCollect } from './child.js'
import { detectPersona } from './persona.js'
import { tryEnterRun, exitRun, busyForMs } from './run-guard.js'
import { sendDesktopNotification } from './notify.js'
import { probeOneBotHttp, inspectNapCatStatus, enableNapCatHttpServer, getNapCatAutoConfig } from './onebot.js'
import { testGallerySource } from './gallery.js'

// 插件版本：设置页「现在的状态」里显示一行，来源就是插件自己的 package.json。
function readPluginVersion() {
  try {
    return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version || '')
  } catch {
    return ''
  }
}
const PLUGIN_VERSION = readPluginVersion()

function ok(value) {
  return { ok: true, value }
}

function err(code, message) {
  return { ok: false, error: { code, message: String(message) } }
}

export function createRpcHandler(ctx, deps) {
  const { probe, stateMgr, logger } = deps

  // 手动试跑和定时任务共用同一套采集/投递：两个同时跑会双倍 token、双份推送、
  // runs.jsonl 交错。闸门是模块级共享的（见 lib/run-guard.js），定时轮询也走它。
  async function handleTestRun() {
    if (!tryEnterRun()) {
      return err('busy', busyForMs() > 0
        ? `已经有一轮在跑（${Math.round(busyForMs() / 1000)} 秒了），等它结束再点`
        : '已经有一轮采集在跑，等它结束再点')
    }
    const startTime = Date.now()
    const cfg = loadConfig()
    // ego 直连/脚本模式要开浏览器逐条读页面，给足 5 分钟，别让它被总超时打断。
    const signal = AbortSignal.timeout(300000)

    try {
      logger.info('Starting test run...')
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
        const errorMsg = collectRes.error || '采集未获取到任何内容'
        const durationMs = Date.now() - startTime
        recordRun({
          ok: false,
          error: errorMsg,
          durationMs,
          method: collectRes.method || cfg.method,
          fallbackFrom: collectRes.trail?.[0]?.from || null,
          trail: collectRes.trail || [],
          sourcesNote: collectRes.sourcesNote || null,
          entries: [],
          test: true
        })
        return err('collect-failed', errorMsg)
      }

      const entries = collectRes.items || []
      const images = collectRes.images || []
      const composeRes = await composeMessage(ctx, cfg, entries, signal, images)
      if (!composeRes.text) {
        const errorMsg = '生成消息为空 (emptyCompose)'
        const durationMs = Date.now() - startTime
        recordRun({
          ok: false,
          error: errorMsg,
          durationMs,
          method: collectRes.method || cfg.method,
          fallbackFrom: collectRes.trail?.[0]?.from || null,
          trail: collectRes.trail || [],
          sourcesNote: collectRes.sourcesNote || null,
          entries,
          test: true
        })
        return err('empty-compose', errorMsg)
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

      const targets = deliverRes.targets || cfg.sessionIds || []

      recordRun({
        ok: deliverRes.ok,
        error: deliverRes.error || null,
        durationMs,
        method: collectRes.method || cfg.method,
        fallbackFrom: collectRes.trail?.[0]?.from || null,
        trail: collectRes.trail || [],
        entries,
        images,
        text: composeRes.text,
        persona: composeRes.persona || null,
        targetKind: 'session',
        targetId: targets.join(','),
        delivered: deliverRes.delivered || [],
        imSync: deliverRes.imSync || null,
        usage,
        childId: collectRes.childId || null,
        browserStopped: collectRes.browserStopped || false,
        sourcesNote: collectRes.sourcesNote || null,
        test: true
      })

      if (!deliverRes.ok) {
        return err('deliver-failed', deliverRes.error || '消息投递失败')
      }

      return ok({
        durationMs,
        method: collectRes.method || cfg.method,
        entries,
        usage,
        text: composeRes.text,
        targets,
        delivered: (deliverRes.delivered || []),
        deliveredCount: deliverRes.okCount ?? targets.length,
        failedCount: deliverRes.failCount || 0,
        imSync: deliverRes.imSync || null,
        sourcesNote: collectRes.sourcesNote || null
      })
    } catch (e) {
      const durationMs = Date.now() - startTime
      recordRun({
        ok: false,
        error: e.message,
        durationMs,
        test: true
      })
      return err('spawn-failed', e.message)
    } finally {
      exitRun()
    }
  }

  return async function handleRpc(endpoint, payload = {}) {
    try {
      switch (endpoint) {
        case 'state.get': {
          const cfg = loadConfig()
          const snap = probe.getStatus()
          const rtSnap = stateMgr.getRuntimeSnapshot()
          const nextEligibleAt = rtSnap.lastDeliverAt ? rtSnap.lastDeliverAt + cfg.minGapMin * 60000 : 0

          return ok({
            version: PLUGIN_VERSION,
            running: snap.active,
            enabled: cfg.enabled,
            collectEnabled: cfg.collectEnabled !== false,
            galleryEnabled: cfg.gallery?.enabled !== false,
            paused: cfg.paused,
            mode: cfg.mode,
            idleSeconds: snap.idleSeconds,
            probeDown: snap.probeDown,
            idleThresholdMin: cfg.idleThresholdMin,
            maxPerDay: cfg.maxPerDay,
            sessionCount: Array.isArray(cfg.sessionIds) ? cfg.sessionIds.length : 0,
            sessionIds: Array.isArray(cfg.sessionIds) ? cfg.sessionIds : [],
            lastDeliverAt: rtSnap.lastDeliverAt,
            todayCount: rtSnap.todayCount,
            nextEligibleAt,
            lastSkipReason: rtSnap.lastSkipReason,
            lastError: rtSnap.lastError || null
          })
        }

        case 'config.get': {
          return ok(loadConfig())
        }

        case 'config.set': {
          // 时段先单独校验一遍：填错的段原样回给界面，不静默丢弃
          const patch = { ...(payload.patch || {}) }
          let invalidWindows = []
          if (Object.hasOwn(patch, 'windows')) {
            const checked = normalizeWindows(patch.windows)
            invalidWindows = checked.invalid
            if (invalidWindows.length > 0 && checked.windows.length === 0) {
              return err('bad-request', `时段格式不对：${invalidWindows.join('、')}（应写成 08:00-23:30，多段请分多行）`)
            }
            patch.windows = checked.windows
          }
          const res = saveConfig(patch)
          if (!res.ok) return err('bad-request', res.error)
          return ok({ config: res.config, invalidWindows })
        }

        case 'pause.set': {
          const res = saveConfig({ paused: Boolean(payload.paused) })
          return ok({ paused: res.config?.paused })
        }

        case 'deps.get': {
          const connection = Boolean(ctx.get('connection'))
          const subprocess = Boolean(ctx.get('subprocess'))
          const llm = Boolean(ctx.get('llm'))
          const subagents = Boolean(ctx.get('subagents'))
          const agents = Boolean(ctx.get('agents'))
          const dshIm = Boolean(ctx.get('dshIm'))
          const webSearch = Boolean(ctx.get('webSearch')) || Boolean(ctx.get('web')?.search)

          let onebotCount = 0
          try {
            const chats = listChats()
            onebotCount = chats.filter(c => c.channel === 'onebot-qq').length
          } catch {}

          const egoInfo = await resolveEgo(ctx, loadConfig())
          const egoRuntime = egoInfo.hasRuntime
          const personaInfo = await detectPersona(ctx)

          return ok({
            version: PLUGIN_VERSION,
            connection,
            subprocess,
            llm,
            subagents,
            agents,
            dshIm,
            onebot: {
              available: onebotCount > 0,
              chatCount: onebotCount
            },
            webSearch,
            egoRuntime,
            persona: {
              active: Boolean(personaInfo.active),
              names: personaInfo.names || [],
              reason: personaInfo.reason || null
            }
          })
        }

        case 'workspaces.list': {
          let live = []
          const sessionsSvc = ctx.get('sessions')
          if (typeof sessionsSvc?.list === 'function') {
            try {
              live = await sessionsSvc.list()
            } catch {}
          }
          return ok(listWorkspaces({ live }))
        }

        case 'sessions.list': {
          const sessionsSvc = ctx.get('sessions')
          let list = []
          if (typeof sessionsSvc?.list === 'function') {
            try {
              list = await sessionsSvc.list()
            } catch {}
          }
          return ok(Array.isArray(list) ? list.map(s => ({ id: s.id, title: s.title || s.id })) : [])
        }

        case 'im.targets': {
          // 给「同步到手机」用：列出 dsh-im 与 dsh-onebot-qq 桥接过的真实聊天（私聊 / 群聊）。
          // dsh-im 对外只暴露 send / listBots / listTargets 等方法，listTargets 只列手工登记的
          // 投递目标（通常为空），所以聊天清单从它自己的状态文件里读；
          // dsh-onebot-qq 则从 media/onebot/chat-sessions.json 里读（lib/imchat.js）。
          const svc = ctx.get('dshIm')
          let chats = []
          try {
            chats = listChats()
          } catch (e) {
            return ok({ available: false, chats: [], bots: [], error: e?.message || String(e) })
          }
          const hasOneBot = chats.some(c => c.channel === 'onebot-qq')
          const available = Boolean((svc && typeof svc.send === 'function') || hasOneBot)

          const bots = []
          if (hasOneBot) {
            bots.push({ botId: 'onebot', channel: 'onebot-qq' })
          }
          try {
            if (typeof svc?.listBots === 'function') {
              const list = await svc.listBots()
              for (const item of Array.isArray(list) ? list : []) {
                const botId = String(item?.botId || item?.id || '')
                if (!botId) continue
                bots.push({ botId, channel: String(item?.channel || '') })
              }
            }
          } catch {}
          return ok({ available, chats, bots })
        }

        case 'bill.summary': {
          return ok(getBillingSummary())
        }

        case 'bill.runs': {
          const limit = Number(payload.limit) || 50
          return ok(listRuns(limit))
        }

        case 'bill.clear': {
          return ok(clearRuns())
        }

        case 'run.test': {
          return await handleTestRun()
        }

        case 'browser.cleanup': {
          const ego = await resolveEgo(ctx, loadConfig())
          const res = await stopEgoBrowser(ctx, ego)
          return ok({ stopped: res.ok })
        }

        case 'log.tail': {
          const limit = Number(payload.limit) || 50
          return ok(logger.tail(limit))
        }

        case 'notify.test': {
          const cfg = loadConfig()
          const sound = cfg.desktopNotify?.sound !== false
          const okRes = await sendDesktopNotification({
            title: '🔔 测试弹窗 · DeepSeek Harness',
            body: '这是一条会话状态系统通知测试，说明桌面通知通道正常。',
            sound
          })
          return ok({ sent: okRes })
        }

        case 'onebot.probe': {
          const cfg = loadConfig()
          const endpoint = {
            url: payload?.httpUrl || cfg?.onebot?.httpUrl,
            token: payload?.accessToken !== undefined ? payload.accessToken : cfg?.onebot?.accessToken
          }
          const res = await probeOneBotHttp(endpoint)
          return ok(res)
        }

        case 'onebot.inspect': {
          const cfg = loadConfig()
          const options = {
            url: payload?.httpUrl || cfg?.onebot?.httpUrl,
            token: payload?.accessToken !== undefined ? payload.accessToken : cfg?.onebot?.accessToken,
            customPath: payload?.customPath || ''
          }
          const res = await inspectNapCatStatus(options)
          return ok(res)
        }

        case 'onebot.enableHttp': {
          const cfg = loadConfig()
          const options = {
            customPath: payload?.customPath || '',
            port: Number(payload?.port) || 3000,
            token: payload?.accessToken !== undefined ? payload.accessToken : (cfg?.onebot?.accessToken || '')
          }
          const res = await enableNapCatHttpServer(options)
          return ok(res)
        }

        case 'onebot.autoConfig': {
          const options = {
            customPath: payload?.customPath || ''
          }
          const res = await getNapCatAutoConfig(options)
          return ok(res)
        }

        case 'gallery.test': {
          const sourceId = String(payload?.sourceId || 'lolicon')
          const cfg = payload?.cfg || {}
          const res = await testGallerySource(sourceId, cfg)
          return ok(res)
        }

        default:
          return err('bad-request', `Unknown endpoint: ${endpoint}`)
      }
    } catch (e) {
      return err('internal', e.message || String(e))
    }
  }
}
