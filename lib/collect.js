// 统一结构：{ title, summary, url, source, score }
//
// 采集侧的两条路：
//   ① 自带热榜：配置里带 kind + expr，按老分支解析，行为保持不变；
//   ② 自定义源：界面上只让用户填网址，这里按响应内容自动识别（JSON / RSS / Atom / 网页），
//      条目不够时再顺着同源链接补几篇。纯 fetch + 解析，不经过模型 → 0 token。

import { resolveEgo, stopEgoBrowser } from './ego.js'
import { detailSpec } from './config.js'
import { collectGalleryImages } from './gallery.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const FOLLOW_PAGES = 3      // 顺链接最多再取几篇
const MIN_ENTRIES = 3       // 这一页自己出够 3 条就不跟（同详略档位 middle 的条数）
const FOLLOW_TIMEOUT_MS = 8000

// ego 跑完关浏览器：直连和脚本模式都会留下一个后台浏览器进程，按开关收掉。
async function stopEgoAfterRun(cfg, ctx) {
  if (cfg?.ego?.closeBrowserAfterRun === false) return false
  try {
    const ego = await resolveEgo(ctx, cfg)
    await stopEgoBrowser(ctx, ego)
    return true
  } catch {
    return false
  }
}

function unescapeHtml(str) {
  if (!str) return ''
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1')
    .trim()
}

// 极简 JSON 表达式求值器：支持 data.realtime[].word / data[].Title / list[0].name
export function evaluateJsonExpr(obj, expr) {
  if (!obj || !expr) return []
  const parts = expr.split('.')

  function resolvePart(curr, partIndex) {
    if (curr == null || partIndex >= parts.length) return [curr]
    const p = parts[partIndex]

    if (p.endsWith('[]')) {
      const prop = p.slice(0, -2)
      const arr = prop ? curr[prop] : curr
      if (!Array.isArray(arr)) return []
      const results = []
      for (const item of arr) {
        results.push(...resolvePart(item, partIndex + 1))
      }
      return results
    }

    const indexMatch = p.match(/^(\w*)\[(\d+)\]$/)
    if (indexMatch) {
      const prop = indexMatch[1]
      const idx = parseInt(indexMatch[2], 10)
      const container = prop ? curr[prop] : curr
      if (!Array.isArray(container) || idx >= container.length) return []
      return resolvePart(container[idx], partIndex + 1)
    }

    return resolvePart(curr[p], partIndex + 1)
  }

  const raw = resolvePart(obj, 0)
  return raw.filter(item => item != null).map(item => String(item).trim()).filter(Boolean)
}

// RSS 和 Atom 一起处理：RSS 用 <item>，Atom 用 <entry>；Atom 的链接在 href 属性上。
function parseRss(xmlText, baseUrl) {
  const items = []
  const blockRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi
  const titleRe = /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i
  const linkTextRe = /<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i
  const linkHrefRe = /<link[^>]+href=["']([^"']+)["']/i
  const descRe = /<(?:description|summary|content)[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:description|summary|content)>/i

  let match
  while ((match = blockRe.exec(xmlText)) !== null) {
    const block = match[2]
    const titleMatch = titleRe.exec(block)
    const linkMatch = linkTextRe.exec(block) || linkHrefRe.exec(block)
    const descMatch = descRe.exec(block)

    const title = unescapeHtml((titleMatch ? titleMatch[1] : '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
    const url = absoluteUrl(unescapeHtml(linkMatch ? linkMatch[1] : '').trim(), baseUrl)
    const summary = unescapeHtml((descMatch ? descMatch[1] : '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

    if (title) {
      items.push({ title, url, summary })
    }
  }
  return items
}

// 老配置里的 html 取值路径（expr）：只给高级用户手工配的源用。
function parseHtml(htmlText, expr) {
  const items = []
  const cleanExpr = String(expr || '').trim()

  if (cleanExpr === 'item>title' || cleanExpr.startsWith('a')) {
    const aRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
    let match
    while ((match = aRe.exec(htmlText)) !== null) {
      const url = match[1]
      const title = unescapeHtml(match[2].replace(/<[^>]+>/g, '').trim())
      if (title && title.length >= 4) {
        items.push({ title, url })
      }
    }
  } else {
    // 默认按正则扫描纯文本或标题标签
    const tagRe = /<(?:h\d|span|div|p)[^>]*>([\s\S]*?)<\/(?:h\d|span|div|p)>/gi
    let match
    while ((match = tagRe.exec(htmlText)) !== null) {
      const text = unescapeHtml(match[1].replace(/<[^>]+>/g, '').trim())
      if (text && text.length >= 4) {
        items.push({ title: text, url: '' })
      }
    }
  }
  return items
}

function parseRegex(text, expr) {
  const items = []
  try {
    const re = new RegExp(expr, 'g')
    let match
    while ((match = re.exec(text)) !== null) {
      const title = unescapeHtml((match[1] || match[0]).trim())
      if (title) items.push({ title, url: '' })
    }
  } catch {}
  return items
}

// ── 自动识别（自定义源只填了网址时走这里）────────────────────────────
const NOISE_RE = /^(广告|推广|福利|抽奖|置顶|热搜榜|热门|APP下载)$/i
// 纯导航词：网页里到处都有，收进来只会把推送撑成目录
const NAV_RE = /^(首页|主页|登录|注册|注销|更多|下一页|上一页|返回|搜索|菜单|导航|评论|分享|收藏|关于我们|联系我们|隐私政策|服务条款|招聘|English|Sign in|Log in|Login|Logout|Sign up|Signup|Register|Account|Profile|Settings|More|All|Front|Archive|About|Contact|Privacy|Terms|Guidelines|FAQ|API|Security|Legal|Apply|Subscribe|Newsletter|Download|Next|Prev|Previous|Home|Past|New|Comments|Ask|Show|Jobs|Submit|Threads|Favorites|Lists|RSS)$/i

const TITLE_FIELDS = ['title', 'name', 'word', 'name_cn', 'query', 'keyword']
const SUMMARY_FIELDS = ['summary', 'description', 'desc', 'excerpt', 'note', 'abstract']
const URL_FIELDS = ['url', 'link', 'href', 'weburl', 'shareurl', 'originurl', 'mobilurl', 'mobil_url']

function pickField(obj, fields) {
  if (!obj || typeof obj !== 'object') return ''
  for (const f of fields) {
    const v = obj[f]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  // 部分站点（今日头条热榜是 Title/Url）用首字母大写，按小写再兜一层
  const byLower = new Map()
  for (const key of Object.keys(obj)) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim() && !byLower.has(key.toLowerCase())) byLower.set(key.toLowerCase(), v.trim())
  }
  for (const f of fields) {
    const v = byLower.get(f)
    if (v) return v
  }
  return ''
}

// 热榜类源（微博、头条）的 JSON 里只有词条没有文章链接，按词条合成搜索链接，
// 这样推送里点得开；认不出的站点就留空，让界面只显示标题。
function searchUrlFor(baseUrl, title) {
  const host = safeHost(baseUrl)
  if (!host) return ''
  const q = encodeURIComponent(String(title || '').trim())
  if (!q) return ''
  if (host.endsWith('weibo.com')) return `https://s.weibo.com/weibo?q=${q}`
  if (host.endsWith('toutiao.com')) return `https://so.toutiao.com/search?keyword=${q}`
  return ''
}

function safeHost(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

function isUsableTitle(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  // 中文标题三个字也常见（「主标题」「国足输球」），英文四个字母以内基本都是导航词
  const min = /[\u4e00-\u9fff]/.test(t) ? 3 : 4
  if (t.length < min) return false
  if (NOISE_RE.test(t) || NAV_RE.test(t)) return false
  // 纯符号 / 纯数字 / 纯标点不算标题
  if (!/[\p{L}\p{N}]/u.test(t)) return false
  if (/^\d+$/.test(t)) return false
  return true
}

// 递归找「最大的一组同构数组」：同构 = 全是字符串，或全是带标题字段的对象。
function findBestArray(node, depth = 0) {
  if (!node || depth > 6) return null
  if (Array.isArray(node)) {
    if (node.length === 0) return null
    if (node.every((x) => typeof x === 'string' && x.trim())) return { kind: 'strings', arr: node }
    if (node.every((x) => x && typeof x === 'object' && !Array.isArray(x) && pickField(x, TITLE_FIELDS))) {
      return { kind: 'objects', arr: node }
    }
    let best = null
    for (const item of node) {
      const found = findBestArray(item, depth + 1)
      if (found && (!best || found.arr.length > best.arr.length)) best = found
    }
    return best
  }
  if (typeof node === 'object') {
    let best = null
    for (const key of Object.keys(node)) {
      const found = findBestArray(node[key], depth + 1)
      if (found && (!best || found.arr.length > best.arr.length)) best = found
    }
    return best
  }
  return null
}

function parseJsonAuto(text) {
  let json
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  const best = findBestArray(json)
  if (!best) return []
  return best.arr
    .map((item) => {
      if (typeof item === 'string') return { title: item.trim(), summary: '', url: '' }
      return {
        title: pickField(item, TITLE_FIELDS),
        summary: pickField(item, SUMMARY_FIELDS),
        url: pickField(item, URL_FIELDS)
      }
    })
    .filter((it) => it.title)
}

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl || undefined).href
  } catch {
    return String(href || '')
  }
}

function htmlToText(fragment) {
  return unescapeHtml(String(fragment || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

// 站点自己的名字（<title> 的各段 / 域名）会以导航链接的形式反复出现，不该当条目
function siteChromeTitles(htmlText, baseUrl) {
  const parts = new Set()
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(htmlText)
  if (titleTag) {
    const text = htmlToText(titleTag[1])
    if (text) {
      parts.add(text)
      for (const seg of text.split(/\s*[|·—–:：>»]\s*|\s+-\s+/)) {
        const s = seg.trim()
        if (s.length >= 2) parts.add(s)
      }
    }
  }
  try {
    const host = new URL(baseUrl).hostname.replace(/^www\./i, '')
    if (host) {
      parts.add(host)
      parts.add(host.split('.')[0])
    }
  } catch {}
  return parts
}

function parseHtmlAuto(htmlText, baseUrl) {
  const items = []
  const byTitle = new Map()
  const chrome = siteChromeTitles(htmlText, baseUrl)
  const usable = (title) => isUsableTitle(title) && !chrome.has(title)

  const headingRe = /<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi
  let m
  while ((m = headingRe.exec(htmlText)) !== null) {
    const title = htmlToText(m[2])
    if (!usable(title) || byTitle.has(title)) continue
    const item = { title, url: '', summary: '' }
    byTitle.set(title, item)
    items.push(item)
  }

  const aRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  while ((m = aRe.exec(htmlText)) !== null) {
    const title = htmlToText(m[2])
    if (!usable(title)) continue
    const url = absoluteUrl(m[1], baseUrl)
    const existing = byTitle.get(title)
    if (existing) {
      // 标题和链接都指向同一篇文章：补上链接，让推送里的条目能点开
      if (!existing.url) existing.url = url
      continue
    }
    const item = { title, url, summary: '' }
    byTitle.set(title, item)
    items.push(item)
  }

  return items
}

// 0 条时的兜底：网页的 <title> + <h1>
function htmlFallbackItems(htmlText, baseUrl, sourceName) {
  const out = []
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(htmlText)
  const h1Tag = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(htmlText)
  for (const m of [h1Tag, titleTag]) {
    if (!m) continue
    const text = htmlToText(m[1])
    // 单篇文章页的 <title> 常带「 - 站点名」尾巴，末尾那段太短就留着，不硬切
    if (!isUsableTitle(text)) continue
    if (out.some((it) => it.title === text)) continue
    out.push({ title: text, summary: metaDescription(htmlText), url: String(baseUrl || ''), source: sourceName || '' })
  }
  return out
}

function metaDescription(htmlText) {
  const re = /<meta\b[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["']/i
  const reversed = /<meta\b[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:description|og:description)["']/i
  const m = re.exec(htmlText) || reversed.exec(htmlText)
  return m ? unescapeHtml(m[1]).replace(/\s+/g, ' ').trim() : ''
}

function parseAuto(text, baseUrl) {
  const body = String(text || '').replace(/^\uFEFF/, '').trim()
  if (!body) return []

  if (/^[\[{]/.test(body)) {
    const jsonItems = parseJsonAuto(body)
    if (jsonItems && jsonItems.length > 0) return jsonItems
  }

  const head = body.slice(0, 600)
  if (/<\?xml/i.test(head) || /<rss[\s>]/i.test(head) || /<feed[\s>]/i.test(head) || /<rdf:RDF/i.test(head)) {
    const feedItems = parseRss(body, baseUrl)
    if (feedItems.length > 0) return feedItems
  }

  return parseHtmlAuto(body, baseUrl)
}

/** 自带源走老分支（kind + expr），否则自动识别。 */
function parseByKind(source, text) {
  const kind = source.kind
  const expr = String(source.expr || '')
  if (kind && expr) {
    if (kind === 'json') {
      try {
        // 老配置的 json 取值路径只给出词条文本，链接交给 fetchBuiltinSource 按站点合成
        return evaluateJsonExpr(JSON.parse(text), expr).map((t) => ({ title: t, url: '', summary: '' }))
      } catch {
        return []
      }
    }
    if (kind === 'rss') return parseRss(text, source.url)
    if (kind === 'html') return parseHtml(text, expr)
    if (kind === 'regex') return parseRegex(text, expr)
    return []
  }
  return parseAuto(text, source.url)
}

// ── 顺着链接补几篇（自定义源、条目不够时才做）─────────────────────────
function sameSiteLinks(htmlText, baseUrl, limit = FOLLOW_PAGES) {
  let base
  try {
    base = new URL(baseUrl)
  } catch {
    return []
  }
  const out = []
  const seen = new Set()
  const aRe = /<a\b[^>]*href=["']([^"']+)["']/gi
  let m
  while ((m = aRe.exec(htmlText)) !== null && out.length < limit) {
    let abs
    try {
      abs = new URL(m[1], base)
    } catch {
      continue
    }
    if (!/^https?:$/.test(abs.protocol)) continue
    if (abs.hostname !== base.hostname) continue
    if (/\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|rar|mp4|mp3|css|js|json|xml)$/i.test(abs.pathname)) continue
    const href = abs.origin + abs.pathname + abs.search
    if (href === base.origin + base.pathname + base.search) continue
    if (seen.has(href)) continue
    seen.add(href)
    out.push(href)
  }
  return out
}

// 并行请求、共享一个 8 秒超时；任何一页失败都静默跳过。
async function followSameSiteLinks(baseUrl, htmlText, sourceName) {
  const links = sameSiteLinks(htmlText, baseUrl, FOLLOW_PAGES)
  if (links.length === 0) return []
  const sig = AbortSignal.timeout(FOLLOW_TIMEOUT_MS)
  const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*' }
  const results = await Promise.all(links.map(async (url) => {
    try {
      const resp = await fetch(url, { signal: sig, headers })
      if (!resp.ok) return null
      const html = await resp.text()
      const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
      const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
      const title = htmlToText((h1 && h1[1]) || (titleTag && titleTag[1]) || '')
      if (!isUsableTitle(title)) return null
      return { title, summary: metaDescription(html), url, source: sourceName || '' }
    } catch {
      return null
    }
  }))
  return results.filter(Boolean)
}

const PLAIN_UA = 'dsh-intel-pulse/0.8 (+feed reader)'

function buildHeaders(url) {
  const headers = { 'User-Agent': UA, 'Accept': 'application/json, application/xml, text/xml, text/html, */*' }
  if (String(url).includes('weibo.com')) headers['Referer'] = 'https://weibo.com/'
  else if (String(url).includes('toutiao.com')) headers['Referer'] = 'https://www.toutiao.com/'
  return headers
}

export async function fetchBuiltinSource(source, signal) {
  const url = String(source?.url || '')
  if (!/^https?:\/\//i.test(url)) return []
  const sourceName = String(source.name || '')
  try {
    const attempt = signal || AbortSignal.timeout(8000)
    let resp = await fetch(url, { signal: attempt, headers: buildHeaders(url) })
    if (!resp.ok) {
      // 少数站点（Hacker News 的 rss）会把浏览器 UA 当爬虫回 419，换一个只说明来意的 UA 再试一次
      resp = await fetch(url, {
        signal: attempt,
        headers: { 'User-Agent': PLAIN_UA, 'Accept': 'application/rss+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8' }
      })
    }
    if (!resp.ok) return []
    const text = await resp.text()

    const parsed = parseByKind(source, text)
    const isCustom = source.builtin === false
    const items = parsed
      .map((it) => {
        const title = String(it.title || '').replace(/\s+/g, ' ').trim()
        return {
          title,
          summary: String(it.summary || '').replace(/\s+/g, ' ').trim(),
          url: String(it.url || '') || searchUrlFor(url, title),
          source: sourceName,
          custom: isCustom
        }
      })
      .filter((it) => it.title)

    const follow = ['auto', 'page', 'site'].includes(source.follow) ? source.follow : 'auto'
    if (source.builtin === false && follow !== 'page') {
      // 这一页一条都没解析出来：先按 <title> + <h1> 兜底
      if (items.length === 0) items.push(...htmlFallbackItems(text, url, sourceName))
      // 判定是确定性的：≥3 条当作列表页，不跟；1~2 条更像单篇文章，补 3 篇同站文章
      const shouldFollow = items.length > 0 && (follow === 'site' || items.length < MIN_ENTRIES)
      if (shouldFollow) {
        const extra = await followSameSiteLinks(url, text, sourceName)
        const seen = new Set(items.map((it) => it.title))
        let added = 0
        for (const it of extra) {
          if (added >= FOLLOW_PAGES) break
          if (!it.title || seen.has(it.title)) continue
          seen.add(it.title)
          items.push({ ...it, custom: true })
          added += 1
        }
      }
    }

    return items
  } catch {
    return []
  }
}

export async function collectBuiltin(cfg, signal, opts = {}) {
  // 默认（内置抓取）：自带热榜 + 自定义源一起抓，参与兴趣加权。
  // opts.customOnly：只抓 builtin:false 的自定义源，不做兴趣加权。
  const customOnly = Boolean(opts.customOnly)
  // 还没填好 URL 的自定义源（界面上刚追加、用户正在输入）直接跳过，不当成故障。
  const sources = (cfg.sources || []).filter(s => s.enabled && /^https?:\/\//i.test(String(s.url || '')) && (customOnly ? s.builtin === false : true))
  if (sources.length === 0) return []

  const promises = sources.map(s => fetchBuiltinSource(s, signal))
  const batchResults = await Promise.all(promises)
  // 逐个源轮着取一条，避免四个源里只有排在前面的那个霸屏；
  // 后面的兴趣加权是稳定排序，同分时仍保持这个轮转顺序。
  const allItems = []
  const longest = Math.max(0, ...batchResults.map((list) => list.length))
  for (let i = 0; i < longest; i += 1) {
    for (const list of batchResults) {
      if (list[i]) allItems.push(list[i])
    }
  }

  const interests = customOnly ? [] : (cfg.interests || []).map(i => i.toLowerCase())

  // 去重 & 过滤噪音
  const seen = new Set()
  const filtered = []

  for (const item of allItems) {
    const cleanTitle = (item.title || '').trim()
    if (!isUsableTitle(cleanTitle)) continue
    if (seen.has(cleanTitle)) continue
    seen.add(cleanTitle)

    let score = 0
    const lower = cleanTitle.toLowerCase()
    for (const interest of interests) {
      if (lower.includes(interest)) {
        score += 1
      }
    }
    filtered.push({
      title: cleanTitle,
      summary: item.summary || '',
      url: item.url || '',
      source: item.source || 'builtin',
      custom: Boolean(item.custom),
      score
    })
  }

  // 排序：加分高的优先，其次保持原榜单热度；自定义源模式保留原顺序
  if (!customOnly) filtered.sort((a, b) => b.score - a.score)
  return filtered.slice(0, clampCount(cfg.maxEntriesPerRun))
}

/** 合并后按「每次推送条数」截断；详略档位只管每条写多细，这里不看它。 */
function capEntries(cfg, items) {
  return items.slice(0, clampCount(cfg.maxEntriesPerRun))
}

function clampCount(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3
}

// 门面入口
export async function collect(cfg, ctx, signal, execChild = null) {
  const method = cfg.method || 'builtin'
  const fallback = Boolean(cfg.fallbackChain)
  const trail = []
  const customSources = (cfg.sources || []).filter(s => s.builtin === false && s.enabled && /^https?:\/\//i.test(String(s.url || '')))
  const hasCustom = customSources.length > 0
  // 「只用自定义源」= 用户显式选了 only，或老配置里 method 就是 custom
  const sourcesMode = (cfg.sourcesMode === 'only' || method === 'custom') ? 'only' : 'append'

  const collectEnabled = cfg.collectEnabled !== false && cfg.gallery?.mode !== 'images_only'
  const galleryEnabled = cfg.gallery?.enabled !== false && cfg.gallery?.mode !== 'article_only'

  // 辅助函数：抓取图库图片（只要图库开关开启即抓取）
  async function fetchImages() {
    if (!galleryEnabled) return []
    try {
      const gRes = await collectGalleryImages(cfg.gallery, signal)
      return Array.isArray(gRes.images) ? gRes.images : []
    } catch {
      return []
    }
  }

  // 1. 资讯采集与图库采集均关闭时：终止并提示
  if (!collectEnabled && !galleryEnabled) {
    return {
      ok: false,
      error: '资讯采集总开关与图库采集总开关均已关闭',
      method: 'disabled',
      trail,
      items: [],
      images: []
    }
  }

  // 2. 资讯采集关闭、仅图库开启时：纯推精选图库
  if (!collectEnabled && galleryEnabled) {
    const images = await fetchImages()
    if (images.length > 0) {
      return {
        ok: true,
        method: 'gallery',
        items: [],
        images,
        trail,
        sourcesNote: null,
        galleryNote: { count: images.length }
      }
    }
    return {
      ok: false,
      error: '资讯采集已关闭，图库采集未获取到可用图片',
      method: 'gallery',
      trail,
      items: [],
      images: []
    }
  }

  // 只用自定义源：不跑采集方法、不回退；空了就如实报错
  if (sourcesMode === 'only') {
    const items = await collectBuiltin(cfg, signal, { customOnly: true })
    if (items.length > 0) {
      const images = await fetchImages()
      return { ok: true, method: 'custom', items, images, trail, sourcesNote: { mode: 'only', custom: items.length } }
    }
    trail.push({ from: 'custom', to: null, reason: hasCustom ? '自定义源没有返回可用条目' : '还没填可用的自定义源网址' })
    return {
      ok: false,
      error: hasCustom ? '自定义源没有返回可用条目' : '只用自定义源，但还没填可用的网址',
      method: 'custom',
      trail,
      sourcesNote: { mode: 'only', custom: 0 },
      images: []
    }
  }

  // 追加模式：自定义源在采集方法成功之后补进来，失败不影响主结果
  const countCustom = (list) => (list || []).filter((x) => x && x.custom).length
  async function withCustom(baseItems) {
    if (!hasCustom) return { items: baseItems, sourcesNote: null }
    try {
      const extra = await collectBuiltin(cfg, signal, { customOnly: true })
      const seen = new Set(baseItems.map((x) => String(x.title || '').trim()))
      const merged = baseItems.slice()
      for (const it of extra) {
        const t = String(it.title || '').trim()
        if (!t || seen.has(t)) continue
        seen.add(t)
        merged.push({ ...it, custom: true })
      }
      const capped = capEntries(cfg, merged)
      return { items: capped, sourcesNote: { mode: 'append', custom: countCustom(capped) } }
    } catch {
      return { items: baseItems, sourcesNote: { mode: 'append', custom: 0, error: '自定义源读取失败' } }
    }
  }

  // 尝试链。custom 是用户显式指定的自有源，不作为回退目标。
  const chain = [method]
  if (fallback && method !== 'custom') {
    // 脚本模式失败时先升到「直连」（常规 ego 流程），再退到 web_search、内置抓取；
    // 直连失败则试脚本模式。这样和平时联网检索的「脚本不好用就多步读页面」一致。
    const order = method === 'egoSkill'
      ? ['egoDirect', 'web_search', 'builtin']
      : ['egoDirect', 'egoSkill', 'web_search', 'builtin']
    for (const m of order) {
      if (!chain.includes(m)) chain.push(m)
    }
  }

  let egoTouched = false

  for (let i = 0; i < chain.length; i++) {
    const currMethod = chain[i]
    try {
      if (currMethod === 'builtin' || currMethod === 'custom') {
        const items = await collectBuiltin(cfg, signal, { customOnly: currMethod === 'custom' })
        if (items.length > 0) {
          // 内置抓取本来就会顺手抓自定义源，别再抓第二遍；只报告这次有多少条来自自定义源
          const images = await fetchImages()
          return {
            ok: true,
            method: currMethod,
            items,
            images,
            trail,
            sourcesNote: hasCustom ? { mode: 'append', custom: countCustom(items) } : null
          }
        }
        throw new Error(currMethod === 'custom' ? '自定义源没有返回可用条目' : 'builtin returned empty items')
      }

      if (currMethod === 'egoDirect' || currMethod === 'egoSkill') egoTouched = true

      if ((currMethod === 'egoDirect' || currMethod === 'egoSkill' || currMethod === 'web_search') && execChild) {
        const res = await execChild(currMethod, cfg, ctx, signal)
        if (res.ok && res.items?.length > 0) {
          const browserStopped = egoTouched ? await stopEgoAfterRun(cfg, ctx) : false
          const merged = await withCustom(res.items)
          const images = await fetchImages()
          return { ok: true, method: currMethod, items: merged.items, images, trail, sourcesNote: merged.sourcesNote, usage: res.usage, childId: res.childId, browserStopped }
        }
        throw new Error(res.error || `${currMethod} child failed`)
      }

      throw new Error(`Method ${currMethod} not implemented or executor missing`)
    } catch (err) {
      const nextMethod = chain[i + 1]
      trail.push({ from: currMethod, to: nextMethod || null, reason: err.message })
      if (!nextMethod) {
        const browserStopped = egoTouched ? await stopEgoAfterRun(cfg, ctx) : false
        return { ok: false, error: err.message, trail, browserStopped, sourcesNote: null }
      }
    }
  }

  return { ok: false, error: 'all collection methods failed', trail, sourcesNote: null }
}
