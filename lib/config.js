import { join } from 'node:path'
import { getDataDir, atomicWriteJson, readJsonSafe } from './store.js'

export const DEFAULTS = {
  // 总开关
  enabled: true,
  paused: false,

  // ── 投递 ──────────────────────────────────────────────
  // 独立收件箱模式：开启后仅将资讯收录进侧栏面板，不向任何会话或 IM 投递，也不强制选择会话
  inboxOnly: false,

  // 只投递到 DSH 会话，可多选：一次投给多个会话，每个会话各起一轮。
  sessionIds: [],

  // 顺便同步一份到手机（可选）。QQ / 飞书这类桥接通道是「你发一条、我回一条」的，
  // 会话里被别的插件塞进去的消息不会自动回传到手机，所以要单独发一份。
  // mode='follow' 跟着会话走（群会话发群、私聊发私聊）；mode='fixed' 固定发到选中的那个对话。
  imSync: {
    enabled: false,
    mode: 'follow',
    channel: '',
    botId: '',
    targetId: '',
    kind: '',
    route: null,
    label: ''
  },

  // ── OneBot 11 原生出站设置（用于 QQ 直发，无需会话激活）──────
  onebot: {
    enabled: true,               // 开启后，对 OneBot QQ 渠道优先调用 OneBot 11 HTTP API 直接推送
    httpUrl: 'http://127.0.0.1:3000', // NapCat / OneBot 11 HTTP 服务地址
    accessToken: ''              // OneBot access_token，未设置鉴权可留空
  },

  // ── 采集 ──────────────────────────────────────────────
  collectEnabled: true,          // 采集菜单总开关：开启时抓取新闻与网络资讯；关闭时跳过新闻抓取
  method: 'builtin',             // 'builtin' | 'web_search' | 'egoDirect' | 'egoSkill' | 'custom'
  fallbackChain: true,           // 首选失败按序降级，最后落 builtin
  // 自定义源怎么用：'append' = 采集方法出结果后再补几条；'only' = 只跑自定义源，不跑方法、不回退
  sourcesMode: 'append',
  interests: [
    'AI 模型消息', 'DSH 生态消息', 'roguelike 卡牌游戏', '独立游戏',
    '网络热梗', '日本动漫信息', '当月 galgame 新作与汉化', '3A 游戏新作',
    'PC 与手机硬件', '二次元画师推荐', '时政新闻', '二次元手游新作',
    '科学科普', '历史科普'
  ],
  queryTemplate: '{interest} 今天 最新',   // 支持 {interest} {date}
  maxEntriesPerRun: 3,           // 每次推送几条（所有采集方法共用；详略档位只管每条写多细）
  detail: 'medium',              // 投递详略：'low' | 'medium' | 'high'
  sources: [
    { id: 'weibo',   name: '微博热搜',    url: 'https://weibo.com/ajax/side/hotSearch',                          kind: 'json', expr: 'data.realtime[].word', enabled: true,  builtin: true, follow: 'auto' },
    { id: 'toutiao', name: '今日头条',    url: 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', kind: 'json', expr: 'data[].Title',        enabled: true,  builtin: true, follow: 'auto' },
    { id: 'v2ex',    name: 'V2EX',        url: 'https://www.v2ex.com/index.xml',                                 kind: 'rss',  expr: 'item>title',          enabled: true,  builtin: true, follow: 'auto' },
    { id: 'hn',      name: 'Hacker News', url: 'https://news.ycombinator.com/rss',                                kind: 'rss',  expr: 'item>title',          enabled: false, builtin: true, follow: 'auto' }
  ],
  ego: {
    closeBrowserAfterRun: true,  // 跑完 --stop（避免残留）
    timeoutSec: 90,              // graceMs
    spaceName: 'away-notify'     // 专用 task space，避免干扰用户自己的空间
  },

  // ── 图库采集（二次元/插画/色图推送） ──────────────────────
  gallery: {
    enabled: true,               // 图库采集总开关
    mode: 'mixed',               // 组合模式: 'mixed' (图文同推) | 'images_only' (仅推送图库) | 'article_only' (仅推送资讯)
    requestTriggerEnabled: true, // 点图互动功能开关：群内@“图库采集：找XXX”时自动解析Tag搜索并发图
    lolicon: {
      enabled: true,             // Lolicon (Pixiv) 独立开关
      rating: 'general',         // 'general' (全年龄) | 'explicit' (成人R18) | 'all' (全部混合)
      timeRange: '2y',           // '1y' (近一年) | '2y' (近两年) | '3y' (近三年) | 'custom' (自定义) | 'all' (不限)
      customDate: '',            // 自定义起始日期 (如 2024-06-01)
      tags: '',                  // 自定义标签（中文或日文，逗号隔开）
      num: 1                     // 每次抓取数量 (1~5)
    },
    yande: {
      enabled: true,             // Yande.re (Booru) 独立开关
      rating: 'general',         // 'general' (全年龄) | 'questionable' (轻微敏感/擦边) | 'explicit' (完全成人) | 'all' (全部)
      sort: 'score',             // 'score' (高赞榜/点赞排行) | 'fav' (高收藏榜) | 'recent' (最新发布) | 'random' (随机探索)
      timeRange: '2y',           // 时间范围
      customDate: '',            // 自定义起始日期 (如 2024-06-01)
      tags: '',                  // 英文标签（空格隔开，如 maid solo）
      num: 1                     // 每次抓取数量 (1~5)
    },
    danbooru: {
      enabled: true,             // Danbooru 独立开关 (全球最全动漫图库)
      rating: 'general',         // 'general' (全年龄常规) | 'sensitive' (轻微微色) | 'questionable' (限制级擦边) | 'explicit' (完全成人) | 'all' (全部)
      sort: 'rank',              // 'rank' (日/周趋势排行榜) | 'score' (高赞榜/点赞排行) | 'favcount' (高收藏榜) | 'recent' (最新发布) | 'random' (随机探索)
      timeRange: '2y',           // 时间范围
      customDate: '',            // 自定义起始日期 (如 2024-06-01)
      tags: '',                  // 英文标签（空格隔开，如 1girl blue_hair）
      num: 1                     // 每次抓取数量 (1~5)
    }
  },

  // ── 频率与运行 ────────────────────────────────────────
  mode: 'continuous',            // 'continuous' | 'idle-only'
  idleThresholdMin: 60,          // 离席阈值
  pollSec: 60,                   // 轮询间隔
  minGapMin: 120,                // 投递门槛：两次执行最小间隔
  maxPerDay: 6,                  // 每日表达上限（本地日）
  windows: ['08:00-23:30'],      // 可多段，空数组 = 全天
  retainChildSessions: 5,        // 子会话保留条数
  autoCleanChildren: true,

  // ── 人设语气 ──────────────────────────────────────────
  // 装了人设类插件（whale-persona、官方 dsh-persona 等，任何往 system prompt 里挂人设的都算）
  // 并且真的生效时，投递文案交给带人设的子会话按它自己的称呼/语气来写；
  // 没装或没生效时投递纯信息，不套任何问候语。
  //   'auto' = 检测到人设才用；'on' = 总是用；'off' = 关掉，永远走模板。
  persona: {
    mode: 'auto'
  },

  // ── 改写 ──────────────────────────────────────────────
  rewrite: {
    enabled: false,
    provider: '', model: '',     // 空 = 跟随宿主默认
    template: '①{a}；②{b}',
    maxTokens: 300
  },

  // ── 系统弹窗通知 ──────────────────────────────────────
  // 当 AI 回复完成或等待用户操作（提问 / 审批）时触发系统桌面弹窗
  desktopNotify: {
    enabled: false,
    onComplete: true,
    onActionRequired: true,
    onError: true,
    sound: true
  }
}

// 旧的固定开场白模板：用户配置里还留着这一串时自动升级成新的（纯信息）模板，
// 否则改了默认值也只在全新安装上生效。
export const LEGACY_TEMPLATES = [
  '看你不在了，刚扫了一眼：①{a}；②{b}。回来聊。',
  '看你不在了，刚扫了一眼：①{a}；②{b}。'
]

// 投递详略：档位只决定「每条写多细」，条数一律看 maxEntriesPerRun（界面上的「每次推送条数」）。
// 所有档位都不带链接：推送只给内容，链接一律不出现在消息里。
export const DETAIL_LEVELS = ['low', 'medium', 'high']
export const DETAIL_SPEC = {
  low: {
    label: '低',
    summaryMin: 0,
    summaryMax: 0,
    depth: 'summary 留空，只要标题一句话'
  },
  medium: {
    label: '中',
    summaryMin: 20,
    summaryMax: 70,
    depth: 'summary 一句话（30~60 字），说清发生了什么'
  },
  high: {
    label: '高',
    summaryMin: 60,
    summaryMax: 160,
    depth: 'summary 两到三句（80~140 字）：发生了什么、关键数字或时间、对读者的影响'
  }
}

export function detailSpec(detail) {
  return DETAIL_SPEC[DETAIL_LEVELS.includes(detail) ? detail : 'medium']
}

function clamp(val, min = 1, max = 10000, fallback = min) {
  const n = Number(val)
  if (isNaN(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/** 只填网址时，源的名字自动取域名（去 www）；解析失败返回空串。 */
function hostOf(url) {
  try {
    return new URL(String(url || '')).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

const WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/

/**
 * 一段时段是否合法。允许 08:00-23:30 这种普通段，也允许 22:00-02:00 这种跨午夜段。
 * 起止相同视为全天。
 */
export function isValidWindow(value) {
  const text = String(value || '').trim()
  if (!text) return false
  if (/^(全天|all)$/i.test(text)) return true
  if (!WINDOW_RE.test(text)) return false
  const [start, end] = text.split('-')
  return start !== undefined && end !== undefined
}

/** 把界面上多行 / 逗号分隔的输入拆成时段数组（只做拆分，不判断合法性）。 */
export function splitWindows(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[\n,;，、]/)
  const out = []
  for (const item of raw) {
    const text = String(item || '').trim()
    if (!text) continue
    if (/^(全天|all)$/i.test(text)) {
      out.push('00:00-23:59')
      continue
    }
    out.push(text.replace(/\s+/g, ''))
  }
  return out
}

/** 校验并整理时段数组；返回 { windows, invalid }，invalid 是用户填错的原样文本。 */
export function normalizeWindows(input) {
  const invalid = []
  const windows = []
  const seen = new Set()
  for (const item of splitWindows(input)) {
    if (!isValidWindow(item)) {
      invalid.push(item)
      continue
    }
    if (seen.has(item)) continue
    seen.add(item)
    windows.push(item)
  }
  return { windows, invalid }
}

export function validateAndNormalize(input) {
  const src = input && typeof input === 'object' ? input : {}
  const cfg = { ...DEFAULTS, ...src }

  cfg.enabled = Boolean(cfg.enabled)
  cfg.paused = Boolean(cfg.paused)
  cfg.inboxOnly = Boolean(cfg.inboxOnly)

  // 投递校验：多选会话。允许暂时为空（还没选），投递时才判 no-target。
  // 兼容旧配置：sessionId（单数）自动并进 sessionIds；IM 相关字段直接丢弃。
  const rawIds = Array.isArray(src.sessionIds) ? src.sessionIds : (cfg.sessionIds || [])
  const ids = []
  for (const item of Array.isArray(rawIds) ? rawIds : []) {
    const id = String(item || '').trim()
    if (id && !ids.includes(id)) ids.push(id)
  }
  const legacy = String(src.sessionId || '').trim()
  if (legacy && !ids.includes(legacy)) ids.unshift(legacy)
  cfg.sessionIds = ids.slice(0, 20)
  delete cfg.channel
  delete cfg.botId
  delete cfg.targetId
  delete cfg.format
  delete cfg.sessionId

  // 手机同步（可选）：只是把同一段文案再发一份到 IM 对话，不参与会话投递的成败判定。
  // mode = 'follow'：每条推送发到「这个会话对应的那个 IM 聊天」（群会话 → 群，私聊 → 私聊）
  // mode = 'fixed' ：所有推送都发到指定的那一个对话（botId + 路由或已登记的 targetId）
  const imRoute = cfg.imSync?.route && typeof cfg.imSync.route === 'object' && !Array.isArray(cfg.imSync.route)
    ? cfg.imSync.route
    : null
  const imMode = cfg.imSync?.mode === 'fixed' ? 'fixed' : 'follow'
  cfg.imSync = {
    enabled: Boolean(cfg.imSync?.enabled),
    mode: imMode,
    // 固定模式下调 privateChatFor 要按通道路由，所以 channel 必须留下来
    channel: String(cfg.imSync?.channel || '').trim(),
    botId: String(cfg.imSync?.botId || '').trim(),
    targetId: String(cfg.imSync?.targetId || '').trim(),
    kind: String(cfg.imSync?.kind || '').trim(),
    route: imRoute ? { ...imRoute } : null,
    label: String(cfg.imSync?.label || '').trim()
  }
  if (cfg.imSync.targetId) {
    // 已登记的投递目标优先，不再保留路由副本
    cfg.imSync.kind = ''
    cfg.imSync.route = null
  } else if (!cfg.imSync.kind || !cfg.imSync.route) {
    cfg.imSync.kind = ''
    cfg.imSync.route = null
  }
  if (imMode === 'follow') {
    // 跟随模式不需要指定对话：推送跟着会话走
    cfg.imSync.enabled = Boolean(cfg.imSync.enabled)
  } else {
    const imReady = Boolean(cfg.imSync.botId) && Boolean(cfg.imSync.targetId || (cfg.imSync.kind && cfg.imSync.route))
    if (!imReady) cfg.imSync.enabled = false
  }

  // OneBot 11 原生出站校验
  cfg.onebot = {
    enabled: cfg.onebot?.enabled !== false,
    httpUrl: String(cfg.onebot?.httpUrl || 'http://127.0.0.1:3000').trim().replace(/\/+$/, ''),
    accessToken: String(cfg.onebot?.accessToken || '').trim()
  }

  // 采集校验
  cfg.collectEnabled = cfg.collectEnabled !== false
  if (!['builtin', 'web_search', 'egoDirect', 'egoSkill', 'custom'].includes(cfg.method)) {
    cfg.method = 'builtin'
  }
  cfg.fallbackChain = Boolean(cfg.fallbackChain)
  // 自定义源用法：显式填了合法值就用；老配置（没有这个字段、method 是 custom）迁成 only
  const rawSourcesMode = src.sourcesMode
  const legacyCustomOnly = String(src.method || cfg.method || '') === 'custom'
  cfg.sourcesMode = ['append', 'only'].includes(rawSourcesMode)
    ? rawSourcesMode
    : (rawSourcesMode === undefined && legacyCustomOnly ? 'only' : 'append')
  cfg.interests = Array.isArray(cfg.interests) ? cfg.interests.map(s => String(s).trim()).filter(Boolean) : DEFAULTS.interests
  cfg.queryTemplate = String(cfg.queryTemplate || '{interest} 今天 最新')
  cfg.maxEntriesPerRun = clamp(cfg.maxEntriesPerRun, 1, 20, 3)
  if (!DETAIL_LEVELS.includes(cfg.detail)) cfg.detail = 'medium'

  // Sources
  if (Array.isArray(cfg.sources)) {
    cfg.sources = cfg.sources.map((s, idx) => {
      const id = String(s.id || `custom_${idx}`)
      const url = String(s.url || '').trim()
      const kind = ['json', 'rss', 'html', 'regex'].includes(s.kind) ? s.kind : 'json'
      const expr = String(s.expr || '')
      const builtin = Boolean(s.builtin)
      // 自定义源不写 enabled 时按「开着」算：只填了网址就当用户想用，不必再勾一次
      const enabled = builtin ? Boolean(s.enabled) : s.enabled !== false
      // follow 只留数据结构（auto/page/site），界面上不暴露；默认 auto 由采集侧自己判断要不要顺链接
      const follow = ['auto', 'page', 'site'].includes(s.follow) ? s.follow : 'auto'
      // 自定义源不再要求手填名称：填了网址就取域名，没有网址先留 id
      const name = String(s.name || '').trim() || hostOf(url) || id
      return { id, name, url, kind, expr, enabled, builtin, follow }
    })
      // 自带源必须有可用 URL；自定义源允许先留空（界面上刚追加、正在输入），抓取时再跳过。
      .filter(s => (s.builtin ? /^https?:\/\//i.test(s.url) : true))
  } else {
    cfg.sources = DEFAULTS.sources
  }

  // Ego
  cfg.ego = {
    closeBrowserAfterRun: cfg.ego?.closeBrowserAfterRun !== false,
    timeoutSec: clamp(cfg.ego?.timeoutSec, 5, 600, 90),
    spaceName: String(cfg.ego?.spaceName || 'away-notify').trim() || 'away-notify'
  }

  // 图库采集校验
  const g = cfg.gallery || {}
  const rawMode = String(g.mode || 'mixed').trim()
  const normalizeRating = (val, defaultVal = 'general') => {
    if (['general', 'safe'].includes(val)) return 'general'
    if (['sensitive', 'micro'].includes(val)) return 'sensitive'
    if (['questionable', 'q'].includes(val)) return 'questionable'
    if (['explicit', 'r18', 'e'].includes(val)) return 'explicit'
    if (val === 'all') return 'all'
    return defaultVal
  }
  const normalizeTimeRange = (val, defaultVal = '2y') => {
    return ['1y', '2y', '3y', 'custom', 'all'].includes(val) ? val : defaultVal
  }
  const normalizeCustomDate = (val) => {
    const s = String(val || '').trim()
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
  }

  cfg.gallery = {
    enabled: g.enabled !== false,
    mode: ['mixed', 'images_only', 'article_only'].includes(rawMode) ? rawMode : 'mixed',
    requestTriggerEnabled: g.requestTriggerEnabled !== false,
    lolicon: {
      enabled: g.lolicon?.enabled !== false,
      rating: normalizeRating(g.lolicon?.rating || (g.lolicon?.r18 === 1 ? 'explicit' : g.lolicon?.r18 === 2 ? 'all' : 'general')),
      timeRange: normalizeTimeRange(g.lolicon?.timeRange),
      customDate: normalizeCustomDate(g.lolicon?.customDate),
      tags: String(g.lolicon?.tags || '').trim(),
      num: clamp(g.lolicon?.num, 1, 5, 1)
    },
    yande: {
      enabled: g.yande?.enabled !== false,
      rating: normalizeRating(g.yande?.rating),
      sort: ['score', 'fav', 'recent', 'random'].includes(g.yande?.sort) ? g.yande.sort : 'score',
      timeRange: normalizeTimeRange(g.yande?.timeRange),
      customDate: normalizeCustomDate(g.yande?.customDate),
      tags: String(g.yande?.tags || '').trim(),
      num: clamp(g.yande?.num, 1, 5, 1)
    },
    danbooru: {
      enabled: g.danbooru?.enabled !== false,
      rating: normalizeRating(g.danbooru?.rating),
      sort: ['rank', 'score', 'favcount', 'recent', 'random'].includes(g.danbooru?.sort) ? g.danbooru.sort : 'rank',
      timeRange: normalizeTimeRange(g.danbooru?.timeRange),
      customDate: normalizeCustomDate(g.danbooru?.customDate),
      tags: String(g.danbooru?.tags || '').trim(),
      num: clamp(g.danbooru?.num, 1, 5, 1)
    }
  }

  // 频率与运行
  if (!['continuous', 'idle-only'].includes(cfg.mode)) {
    cfg.mode = 'continuous'
  }
  cfg.idleThresholdMin = clamp(cfg.idleThresholdMin, 1, 1440, 60)
  cfg.pollSec = clamp(cfg.pollSec, 5, 3600, 60)
  cfg.minGapMin = clamp(cfg.minGapMin, 1, 1440, 120)
  cfg.maxPerDay = clamp(cfg.maxPerDay, 1, 100, 6)
  
  if (Array.isArray(cfg.windows) || typeof cfg.windows === 'string') {
    cfg.windows = normalizeWindows(cfg.windows).windows
  } else {
    cfg.windows = DEFAULTS.windows
  }
  cfg.retainChildSessions = clamp(cfg.retainChildSessions, 1, 50, 5)
  cfg.autoCleanChildren = cfg.autoCleanChildren !== false

  // 人设语气
  const personaMode = cfg.persona?.mode
  cfg.persona = { mode: ['auto', 'on', 'off'].includes(personaMode) ? personaMode : 'auto' }

  // 改写
  const rawTemplate = String(cfg.rewrite?.template || '').trim()
  const template = !rawTemplate || LEGACY_TEMPLATES.includes(rawTemplate)
    ? DEFAULTS.rewrite.template
    : rawTemplate
  cfg.rewrite = {
    enabled: Boolean(cfg.rewrite?.enabled),
    provider: String(cfg.rewrite?.provider || '').trim(),
    model: String(cfg.rewrite?.model || '').trim(),
    template,
    maxTokens: clamp(cfg.rewrite?.maxTokens, 10, 2000, 300)
  }

  // 系统弹窗通知
  cfg.desktopNotify = {
    enabled: Boolean(cfg.desktopNotify?.enabled),
    onComplete: cfg.desktopNotify?.onComplete !== false,
    onActionRequired: cfg.desktopNotify?.onActionRequired !== false,
    onError: cfg.desktopNotify?.onError !== false,
    sound: cfg.desktopNotify?.sound !== false
  }

  return { ok: true, config: cfg }
}

export function getConfigPath() {
  return join(getDataDir(), 'config.json')
}

export function loadConfig() {
  const saved = readJsonSafe(getConfigPath(), null)
  if (!saved) return { ...DEFAULTS }
  const res = validateAndNormalize(saved)
  return res.ok ? res.config : { ...DEFAULTS }
}

export function saveConfig(patch) {
  const current = loadConfig()
  const merged = { ...current, ...(patch || {}) }
  if (patch?.ego) merged.ego = { ...current.ego, ...patch.ego }
  if (patch?.rewrite) merged.rewrite = { ...current.rewrite, ...patch.rewrite }
  if (patch?.imSync) merged.imSync = { ...current.imSync, ...patch.imSync }
  if (patch?.onebot) merged.onebot = { ...current.onebot, ...patch.onebot }
  if (patch?.desktopNotify) merged.desktopNotify = { ...current.desktopNotify, ...patch.desktopNotify }
  if (patch?.gallery) {
    merged.gallery = {
      ...current.gallery,
      ...patch.gallery,
      lolicon: { ...(current.gallery?.lolicon || {}), ...(patch.gallery?.lolicon || {}) },
      yande: { ...(current.gallery?.yande || {}), ...(patch.gallery?.yande || {}) },
      danbooru: { ...(current.gallery?.danbooru || {}), ...(patch.gallery?.danbooru || {}) }
    }
  }
  const res = validateAndNormalize(merged)
  if (!res.ok) return res
  atomicWriteJson(getConfigPath(), res.config)
  return { ok: true, config: res.config }
}
