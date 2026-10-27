import { join } from 'node:path'
import { existsSync, appendFileSync, readFileSync, unlinkSync, statSync, renameSync } from 'node:fs'
import { getDataDir } from './store.js'

// runs.jsonl 一行约 1~2KB，天天推送的话一年能到几十 MB；
// 超过这个大小就把它挪成 .1（只留一份旧档），免得设置页账单越用越卡。
const MAX_RUNS_BYTES = 8 * 1024 * 1024

function getRunsLogPath() {
  return join(getDataDir(), 'runs.jsonl')
}

function rotateIfHuge(filePath) {
  try {
    if (existsSync(filePath) && statSync(filePath).size > MAX_RUNS_BYTES) {
      renameSync(filePath, filePath + '.1')
    }
  } catch {}
}

export function recordRun(runData) {
  // 记账单本身不能把一轮推送搞挂：拼 JSON 失败就只留一条错误行。
  let line
  try {
    line = JSON.stringify({
    id: runData.id || `run-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    at: runData.at || new Date().toISOString(),
    mode: runData.mode || 'continuous',
    method: runData.method || 'builtin',
    fallbackFrom: runData.fallbackFrom || null,
    // 回退链的每一步都留着：哪一步、为什么失败、接下来换了什么。
    // 只记第一个 from 的话，事后完全看不出「为什么四种方法都没成」。
    trail: (Array.isArray(runData.trail) ? runData.trail : []).map(t => ({
      from: String(t.from || ''),
      to: t.to ? String(t.to) : null,
      reason: String(t.reason || '').slice(0, 400)
    })),
    entries: (runData.entries || []).map(e => ({
      title: String(e.title || '').slice(0, 200),
      summary: String(e.summary || '').slice(0, 400),
      url: String(e.url || '').slice(0, 500),
      source: String(e.source || '')
    })),
    images: (Array.isArray(runData.images) ? runData.images : []).map(img => ({
      title: String(img.title || '').slice(0, 200),
      author: String(img.author || '').slice(0, 100),
      url: String(img.url || ''),
      previewUrl: String(img.previewUrl || img.url || ''),
      sourceName: String(img.sourceName || img.sourceId || ''),
      rating: String(img.rating || ''),
      r18: Boolean(img.r18)
    })),
    targetKind: runData.targetKind || 'session',
    targetId: runData.targetId || '',
    delivered: (Array.isArray(runData.delivered) ? runData.delivered : []).map(d => ({
      id: String(d.sessionId || d.id || ''),
      ok: Boolean(d.ok),
      how: String(d.how || ''),
      // live=本来就开着 / resolve=sessionController.resolveAgent 打开（宿主归属，可靠）/ resume=agents.resume 兜底
      via: String(d.via || ''),
      resumed: Boolean(d.resumed),
      landed: Boolean(d.landed),
      // 投递完目标会话是否仍挂在 live registry 里：false 就意味着 GUI 侧栏那一行会被摘掉
      stillLive: d.stillLive === undefined ? null : Boolean(d.stillLive),
      error: d.error ? String(d.error) : null
    })),
    ok: Boolean(runData.ok),
    error: runData.error ? String(runData.error) : null,
    imSync: runData.imSync
      ? {
        ok: Boolean(runData.imSync.ok),
        count: Number(runData.imSync.count || 0),
        sent: (Array.isArray(runData.imSync.sent) ? runData.imSync.sent : []).map(s => ({
          label: String(s.label || ''),
          ok: Boolean(s.ok),
          error: s.error ? String(s.error) : null
        })),
        error: runData.imSync.error ? String(runData.imSync.error) : null
      }
      : null,
    text: String(runData.text || '').slice(0, 4000),
    // 自定义源的参与情况：append 模式下补了几条、only 模式是不是只跑了它
    sourcesNote: runData.sourcesNote
      ? {
        mode: String(runData.sourcesNote.mode || ''),
        custom: Number(runData.sourcesNote.custom || 0),
        error: runData.sourcesNote.error ? String(runData.sourcesNote.error) : null
      }
      : null,
    // 这条文案是谁写的：template=模板直出 / rewrite=改写模型 / child=带人设的子会话
    persona: runData.persona
      ? {
        active: Boolean(runData.persona.active),
        source: String(runData.persona.source || ''),
        names: (Array.isArray(runData.persona.names) ? runData.persona.names : []).map(n => String(n)),
        reason: runData.persona.reason ? String(runData.persona.reason).slice(0, 200) : null
      }
      : null,
    durationMs: Number(runData.durationMs) || 0,
    model: runData.model || '',
    provider: runData.provider || '',
    usage: {
      // 宿主给的是 TokenUsage{inputTokens,...}，人设/改写两条路会原样透传，两种名字都认
      input: Number(runData.usage?.input ?? runData.usage?.inputTokens ?? 0),
      output: Number(runData.usage?.output ?? runData.usage?.outputTokens ?? 0),
      cacheRead: Number(runData.usage?.cacheRead ?? runData.usage?.cacheReadTokens ?? 0),
      cacheWrite: Number(runData.usage?.cacheWrite ?? runData.usage?.cacheWriteTokens ?? 0),
      reasoning: Number(runData.usage?.reasoning ?? runData.usage?.reasoningTokens ?? 0)
    },
    childId: runData.childId || null,
    browserStopped: Boolean(runData.browserStopped),
    test: Boolean(runData.test)
  })
  } catch (e) {
    try {
      appendFileSync(
        getRunsLogPath(),
        JSON.stringify({ at: new Date().toISOString(), ok: false, error: 'run-record-failed: ' + String(e?.message || e) }) + '\n',
        'utf-8'
      )
    } catch {}
    return
  }

  try {
    const filePath = getRunsLogPath()
    rotateIfHuge(filePath)
    appendFileSync(filePath, line + '\n', 'utf-8')
  } catch {}
}

export function readAllRuns() {
  const filePath = getRunsLogPath()
  if (!existsSync(filePath)) return []

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.trim().split(/\r?\n/)
    const runs = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        runs.push(JSON.parse(line))
      } catch {}
    }
    return runs
  } catch {
    return []
  }
}

export function listRuns(limit = 50) {
  const all = readAllRuns()
  return all.slice(-limit).reverse()
}

export function clearRuns() {
  const filePath = getRunsLogPath()
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath)
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

function getLocalDayStart(date = new Date()) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function getWeekStart(date = new Date()) {
  const d = new Date(date)
  const day = d.getDay() // 0 is Sunday
  const diff = d.getDate() - day + (day === 0 ? -6 : 1) // adjust when day is sunday
  d.setDate(diff)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function createEmptyBucket() {
  return {
    runs: 0,
    ok: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    totalMs: 0,
    avgMs: 0
  }
}

function addToBucket(bucket, run) {
  bucket.runs += 1
  if (run.ok) bucket.ok += 1
  bucket.tokens.input += run.usage?.input || 0
  bucket.tokens.output += run.usage?.output || 0
  bucket.tokens.cacheRead += run.usage?.cacheRead || 0
  bucket.tokens.cacheWrite += run.usage?.cacheWrite || 0
  bucket.tokens.reasoning += run.usage?.reasoning || 0
  bucket.totalMs += run.durationMs || 0
  bucket.avgMs = Math.round(bucket.totalMs / bucket.runs)
}

export function getBillingSummary() {
  const all = readAllRuns()
  // 测试运行也计入账单：手动点「测试」同样烧 token，账要对得上。
  // 只有「每日表达上限」和投递冷却不看测试运行（state.todayCount 由 state.js 单独维护）。

  const now = new Date()
  const todayStart = getLocalDayStart(now)
  const weekStart = getWeekStart(now)

  const today = createEmptyBucket()
  const week = createEmptyBucket()
  const total = createEmptyBucket()

  let testRuns = 0

  for (const r of all) {
    if (r.test) testRuns += 1
    const t = new Date(r.at).getTime()
    if (!isNaN(t)) {
      if (t >= todayStart) {
        addToBucket(today, r)
      }
      if (t >= weekStart) {
        addToBucket(week, r)
      }
    }
    addToBucket(total, r)
  }

  return { today, week, all: total, testRuns }
}
