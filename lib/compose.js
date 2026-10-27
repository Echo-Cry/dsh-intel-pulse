import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { detailSpec } from './config.js'
import { detectPersona, composeInPersona } from './persona.js'

const profileDir = process.env.DSH_PROFILE_DIR
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'desktop')
let req = null
try {
  req = createRequire(join(profileDir, 'package.json'))
} catch {}

async function tryLoad(spec) {
  if (!req) return null
  try {
    return await import(pathToFileURL(req.resolve(spec)).href)
  } catch {
    return null
  }
}

function getFormattedTime() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Hong_Kong'
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date())
  } catch {
    const d = new Date()
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
}

const MARKERS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧']

// 推送里一律不带普通超链接：模板里的 URL、摘要里夹带的 URL、markdown 链接全部抹掉，
// 但严密保留用于插画/色图渲染的 Markdown 图片语法 ![img](url) 与 OneBot CQ 码。
const BARE_URL_RE = /https?:\/\/[^\s，。；、）)」】]+/gi
export function stripLinks(text) {
  const placeholders = []
  // 1. 保护 Markdown 图片语法 ![alt](url)
  let protectedText = String(text || '').replace(/!\[(.*?)\]\((https?:\/\/[^)\s]+)\)/g, (m) => {
    placeholders.push(m)
    return `@@IMG_PLACEHOLDER_${placeholders.length - 1}@@`
  })
  // 2. 保护 OneBot CQ 码 [CQ:image,...]
  protectedText = protectedText.replace(/\[CQ:image,[^\]]+\]/g, (m) => {
    placeholders.push(m)
    return `@@IMG_PLACEHOLDER_${placeholders.length - 1}@@`
  })

  // 3. 清理普通 Markdown 链接与裸 URL
  let res = protectedText
    .replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '$1')
    .replace(BARE_URL_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。；、])/g, '$1')
    .replace(/（\s*）/g, '')
    .replace(/[ \t]+$/gm, '')
    .trim()

  // 4. 恢复图片占位符
  res = res.replace(/@@IMG_PLACEHOLDER_(\d+)@@/g, (_, idx) => placeholders[Number(idx)] || '')
  return res
}

export function formatImagesMarkdown(images) {
  if (!Array.isArray(images) || images.length === 0) return ''
  const lines = []
  for (const img of images) {
    if (!img?.url) continue
    const authorText = img.author ? ` (画师: ${img.author})` : ''
    const r18Tag = img.r18 ? ' [R18]' : ''
    lines.push(`🎨 ${img.title || '二次元插画'}${authorText}${r18Tag}：\n![${img.title || '插画'}](${img.url})`)
  }
  return lines.join('\n\n')
}

// 默认模板只管「怎么排条目」，不再有「看你不在了 / 回来聊」这类固定开场收尾：
// 用户要的是直接拿到信息；需要人设语气时交给人设插件去写（composeMessage 里分派）。
export const DEFAULT_TEMPLATE = '①{a}；②{b}'

/**
 * 按详略档位拼文案（任何档位都不带链接）：
 *  低  → 一行式模板，只有标题（内置抓取也走这条，它没有摘要）
 *  中  → 每条「标题 + 一句摘要」
 *  高  → 每条「标题 + 两三句要点」
 * 模板只在「低」档生效，中/高要走结构化排版，否则摘要塞不进一句话。
 */
export function composeTemplate(cfg, entries = [], images = []) {
  const clean = (Array.isArray(entries) ? entries : [])
    .map(e => ({
      ...e,
      title: stripLinks(e.title).trim(),
      summary: stripLinks(e.summary).trim(),
      url: String(e.url ?? '').trim()
    }))
    .filter(e => e.title.length > 0)

  const imgSuffix = formatImagesMarkdown(images)

  if (clean.length === 0) {
    if (imgSuffix) {
      return imgSuffix.trim()
    }
    return ''
  }

  const detail = ['low', 'medium', 'high'].includes(cfg.detail) ? cfg.detail : 'medium'
  const rich = detail !== 'low' && clean.some(e => e.summary)
  const max = Math.max(1, Number(cfg.maxEntriesPerRun) || 3)
  const selected = clean.slice(0, Math.min(clean.length, max))
  const time = getFormattedTime()

  let textResult = ''

  if (!rich) {
    const a = selected[0]?.title || ''
    const b = selected[1]?.title || ''
    const topic = selected[0]?.source || '实时热点'

    let tmpl = cfg.rewrite?.template || DEFAULT_TEMPLATE
    if (!tmpl.includes('{a}') && !tmpl.includes('{b}')) {
      textResult = selected.map((item, idx) => `${MARKERS[idx] || (idx + 1) + '.'} ${item.title}`).join('\n')
    } else {
      // 只有一条时把 ② 那段整段去掉，别推成「①X；②X」
      if (!b) tmpl = tmpl.replace(/[；;]?\s*②\s*\{b\}/g, '')

      let text = tmpl
        // 用函数式替换：标题里出现 $& / $` 这类字符时不会被 replace 当成特殊模式
        .replace(/\{a\}/g, () => a)
        .replace(/\{b\}/g, () => b)
        .replace(/\{time\}/g, () => time)
        .replace(/\{topic\}/g, () => topic)
        .trim()

      // 模板只有 {a}{b} 两个坑，但「条数」可以调到 3~20；多出来的按序补在后面，别静默丢掉
      const rest = selected.slice(2)
      if (rest.length) {
        const lines = rest.map((item, idx) => `${MARKERS[idx + 2] || (idx + 3) + '.'} ${item.title}`)
        text = text ? text + '\n' + lines.join('\n') : lines.join('\n')
      }
      textResult = text
    }
  } else {
    textResult = selected.map((item, idx) => {
      const marker = MARKERS[idx] || `${idx + 1}.`
      const parts = [`${marker} ${item.title}`]
      const cap = Number(detailSpec(detail).summaryMax || 0)
      let summary = item.summary
      if (summary && cap > 0 && summary.length > cap) {
        summary = summary.slice(0, cap).replace(/[，、；：\s]+$/, '') + '…'
      }
      if (summary) parts.push(summary)
      return parts.join('\n')
    }).join('\n')
  }

  if (imgSuffix) {
    return textResult ? `${textResult}\n\n${imgSuffix}` : imgSuffix.trim()
  }
  return textResult
}

const STYLE_HINT = `你是一个贴心、简洁的私人助手。用户当前离开电脑，你整理了最新看到的动态，用自然的口吻发一条离席简报。
要求：口吻轻松自然，简明扼要，不要客套堆砌，不要编造；只保留每条资讯的标题与要点，不要出现任何网址或链接。`

export async function composeRewrite(ctx, cfg, draft, signal) {
  const llm = ctx.get('llm')
  if (!llm?.stream) {
    throw new Error('llm service unavailable')
  }

  const detail = ['low', 'medium', 'high'].includes(cfg.detail) ? cfg.detail : 'medium'
  const budget = detail === 'high' ? 400 : detail === 'medium' ? 200 : 100
  const promptText = `请把下面的条目整理成一条给用户的口语化离席消息，总长不超过 ${budget} 字，保留每条标题与要点；不要写任何网址或链接：\n${draft}`

  const dshLlm = await tryLoad('@deepseek-ai/dsh-llm')
  const msg = dshLlm?.createUserMessage
    ? dshLlm.createUserMessage({
        content: [{ type: 'text', text: promptText }],
        source: { kind: 'plugin:dsh-intel-pulse' }
      })
    : {
        role: 'user',
        content: [{ type: 'text', text: promptText }],
        source: { kind: 'plugin:dsh-intel-pulse' }
      }

  let text = ''
  let usageRaw = null

  const stream = llm.stream({
    provider: cfg.rewrite.provider || undefined,
    model: cfg.rewrite.model || undefined,
    system: STYLE_HINT,
    messages: [msg],
    maxTokens: cfg.rewrite.maxTokens || 300,
    signal: signal || AbortSignal.timeout(60000)
  })

  for await (const chunk of stream) {
    const type = chunk?.type
    if (type === 'usage' && chunk.usage) {
      usageRaw = chunk.usage
    } else if (type === 'text-delta' || type === 'text') {
      // 只收正文；reasoning-delta 也带 text 字段，收进来会把整段思维链推给用户
      text += chunk.text ?? chunk.delta ?? ''
    } else if (!type && typeof chunk?.text === 'string') {
      text += chunk.text
    }
  }

  const result = text.trim()
  if (!result) {
    throw new Error('rewrite returned empty text')
  }

  // 宿主给的是 TokenUsage{inputTokens,...}，而账单侧统一用 {input,output,cacheRead,cacheWrite,reasoning}
  const usage = usageRaw
    ? {
        input: usageRaw.inputTokens ?? usageRaw.input ?? 0,
        output: usageRaw.outputTokens ?? usageRaw.output ?? 0,
        cacheRead: usageRaw.cacheReadTokens ?? usageRaw.cacheRead ?? 0,
        cacheWrite: usageRaw.cacheWriteTokens ?? usageRaw.cacheWrite ?? 0,
        reasoning: usageRaw.reasoningTokens ?? usageRaw.reasoning ?? 0
      }
    : null

  return { text: result, usage }
}

/**
 * 生成投递文案。分派顺序：
 *  ①配置关掉人设（persona.mode='off'）→ 直接模板；
 *  ②装了人设类插件（或 mode='on'）→ 交给带人设的子会话按它自己的风格写；
 *  ③否则若开了改写（rewrite.enabled）→ 用改写模型整理一版；
 *  ④都不满足 → 模板（纯信息，无开场白、无收尾）。
 */
export async function composeMessage(ctx, cfg, entries = [], signal, images = []) {
  const draft = composeTemplate(cfg, entries, images)
  if (!draft) return { text: '', usage: null }

  const imgSuffix = formatImagesMarkdown(images)

  // 如果 entries 为空但有图片（纯图库模式），直接返回格式化结果，不走 LLM 改写
  if ((!Array.isArray(entries) || entries.length === 0) && imgSuffix) {
    return { text: draft, usage: null, persona: { mode: 'off', active: false, names: [], source: 'gallery' } }
  }

  const personaMode = ['auto', 'on', 'off'].includes(cfg.persona?.mode) ? cfg.persona.mode : 'auto'
  let persona = { active: false, names: [] }
  let personaFail = null

  if (personaMode !== 'off') {
    persona = await detectPersona(ctx)
    if (persona.active || personaMode === 'on') {
      try {
        const res = await composeInPersona(ctx, cfg, entries, signal)
        if (res?.text) {
          let composed = stripLinks(res.text)
          if (imgSuffix) composed = `${composed}\n\n${imgSuffix}`
          return {
            text: composed,
            usage: res.usage || null,
            persona: { mode: personaMode, active: true, names: persona.names || [], source: 'child' }
          }
        }
        personaFail = 'child-empty'
      } catch (e) {
        // 人设改写失败不阻断投递，往下走模板/改写；失败原因记进运行记录，方便事后查
        personaFail = String(e?.message || e)
      }
    }
  }
  const personaInfo = (source, reason) => ({
    mode: personaMode,
    active: source === 'child',
    names: persona.names || [],
    source,
    ...(reason || personaFail ? { reason: String(reason || personaFail).slice(0, 200) } : {})
  })

  if (cfg.rewrite?.enabled) {
    try {
      // 传递不带图片的草稿给模型，生成完再挂回图片，保护图片链接不被模型改动
      const draftWithoutImages = composeTemplate(cfg, entries, [])
      const rewritten = await composeRewrite(ctx, cfg, draftWithoutImages, signal)
      let composed = stripLinks(rewritten.text)
      if (imgSuffix) composed = `${composed}\n\n${imgSuffix}`
      return { ...rewritten, text: composed, persona: personaInfo('rewrite') }
    } catch (e) {
      // 失败降级回模板：原因写进 persona.reason，runs.jsonl 里能看出为什么没用改写
      const reason = String(e?.message || e)
      return { text: draft, usage: null, fallbackReason: reason, persona: personaInfo('template', 'rewrite-failed: ' + reason) }
    }
  }

  return { text: draft, usage: null, persona: personaInfo('template') }
}
