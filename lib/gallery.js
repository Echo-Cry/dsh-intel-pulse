// 图库采集引擎：对接 Lolicon (Pixiv)、Yande.re (Booru)、Danbooru
// 零 Token 开销，纯原生 fetch 直连公开免费图源，支持独立开关、时间范围筛选、分级过滤与标签自定义。

const DEFAULT_TIMEOUT_MS = 12000

const USER_AGENT = 'DshIntelPulse/0.9.0 (https://github.com/Echo-Cry/dsh-intel-pulse)'

/**
 * 时间范围换算辅助函数
 * @param {string} range '1y' | '2y' | '3y' | 'custom' | 'all'
 * @param {string} [customDate] 'YYYY-MM-DD'
 * @returns {{ dateStr: string|null, timestampMs: number|null, ageDays: number|null }}
 */
export function resolveTimeRange(range = 'all', customDate = '') {
  const now = new Date()
  const currentYear = now.getFullYear()

  if (range === 'custom' && customDate && /^\d{4}-\d{2}-\d{2}$/.test(customDate)) {
    try {
      const d = new Date(`${customDate}T00:00:00Z`)
      if (!isNaN(d.getTime())) {
        const diffMs = now.getTime() - d.getTime()
        const days = Math.max(1, Math.floor(diffMs / (1000 * 60 * 60 * 24)))
        return {
          dateStr: `${customDate}..`,
          timestampMs: d.getTime(),
          ageDays: days
        }
      }
    } catch {}
  }

  if (range === '1y') {
    const minYear = currentYear - 1
    const ts = new Date(`${minYear}-01-01T00:00:00Z`).getTime()
    return { dateStr: `${minYear}-01-01..`, timestampMs: ts, ageDays: 365 }
  }
  if (range === '2y') {
    const minYear = currentYear - 2
    const ts = new Date(`${minYear}-01-01T00:00:00Z`).getTime()
    return { dateStr: `${minYear}-01-01..`, timestampMs: ts, ageDays: 730 }
  }
  if (range === '3y') {
    const minYear = currentYear - 3
    const ts = new Date(`${minYear}-01-01T00:00:00Z`).getTime()
    return { dateStr: `${minYear}-01-01..`, timestampMs: ts, ageDays: 1095 }
  }
  return { dateStr: null, timestampMs: null, ageDays: null }
}

/**
 * 1. Lolicon API (Pixiv 热门/插画/色图)
 * 官方文档：https://api.lolicon.app/setu/v2
 * 支持：r18分级、dateAfter毫秒时间戳、中文/日文Tag
 */
export async function fetchLolicon(cfg = {}, signal) {
  // 分级: 'general' (全年龄0) | 'sensitive' (全年龄0) | 'explicit' (R-18=1) | 'all' (混合2)
  let r18Code = 0
  if (cfg.rating === 'explicit' || cfg.r18 === 1 || cfg.r18 === '1') {
    r18Code = 1
  } else if (cfg.rating === 'all' || cfg.r18 === 2 || cfg.r18 === '2') {
    r18Code = 2
  } else {
    r18Code = 0
  }

  const num = Math.min(Math.max(Number(cfg.num) || 1, 1), 10)
  const tags = Array.isArray(cfg.tags)
    ? cfg.tags.map(t => String(t).trim()).filter(Boolean)
    : String(cfg.tags || '').split(/[,，\s]+/).filter(Boolean)

  const url = new URL('https://api.lolicon.app/setu/v2')
  url.searchParams.set('r18', String(r18Code))
  url.searchParams.set('num', String(num))
  url.searchParams.set('size', 'regular')

  // 时间范围过滤
  const time = resolveTimeRange(cfg.timeRange || '2y', cfg.customDate)
  if (time.timestampMs) {
    url.searchParams.set('dateAfter', String(time.timestampMs))
  }

  for (const tag of tags) {
    url.searchParams.append('tag', tag)
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS)
  const onParentAbort = () => ctrl.abort()
  if (signal) signal.addEventListener('abort', onParentAbort)

  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json'
      },
      signal: ctrl.signal
    })

    if (!res.ok) {
      throw new Error(`Lolicon HTTP ${res.status}: ${res.statusText}`)
    }

    const json = await res.json()
    if (json.error) {
      throw new Error(`Lolicon 业务错误: ${json.error}`)
    }

    const items = Array.isArray(json.data) ? json.data : []
    return items.map(item => {
      const imgUrl = item.urls?.regular || item.urls?.original || ''
      const ratingLabel = item.r18 ? '完全成人向 (explicit)' : '全年龄常规 (general)'
      return {
        type: 'image',
        sourceId: 'lolicon',
        sourceName: 'Lolicon (Pixiv)',
        title: item.title || 'Pixiv 插画',
        author: item.author || '',
        url: imgUrl,
        previewUrl: item.urls?.small || imgUrl,
        r18: Boolean(item.r18),
        rating: ratingLabel,
        tags: Array.isArray(item.tags) ? item.tags : [],
        pid: item.pid,
        rawUrl: item.urls?.original || imgUrl
      }
    }).filter(x => Boolean(x.url))
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onParentAbort)
  }
}

/**
 * 2. Yande.re API (Booru 高清壁纸与插画)
 * 官方文档：https://yande.re/post.json
 * 支持：rating分级、date:YYYY-01-01..时间过滤、英文Tag
 */
export async function fetchYande(cfg = {}, signal) {
  const limit = Math.min(Math.max(Number(cfg.num) || 1, 1), 10)
  const rating = cfg.rating || 'general'
  const sort = cfg.sort || 'score' // 'score' (高赞榜) | 'fav' (高收藏榜) | 'recent' (最新发布) | 'random' (随机探索)
  const userTags = Array.isArray(cfg.tags)
    ? cfg.tags.map(t => String(t).trim()).filter(Boolean)
    : String(cfg.tags || '').split(/[,，\s]+/).filter(Boolean)

  const tags = [...userTags]

  // 1. 分级处理
  if (rating === 'general' || rating === 'safe') {
    tags.push('rating:s')
  } else if (rating === 'sensitive' || rating === 'questionable') {
    tags.push('rating:q')
  } else if (rating === 'explicit') {
    tags.push('rating:e')
  }

  // 2. 榜单与排序条件
  let orderTag = ''
  if (sort === 'score') {
    orderTag = 'order:score'
  } else if (sort === 'fav') {
    orderTag = 'order:fav'
  }

  if (orderTag && !tags.some(t => t.startsWith('order:'))) {
    tags.push(orderTag)
  }

  // 3. 时间范围过滤（解决出图过老、扫图泛黄问题）
  const time = resolveTimeRange(cfg.timeRange || '2y', cfg.customDate)
  if (time.dateStr) {
    tags.push(`date:${time.dateStr}`)
  }

  // 4. 采用随机页码获得多变性（高赞/高收藏在前 1~15 页精选池内随机抽选；最新/随机在前 1~30 页）
  let randomPage = 1
  if (sort === 'score' || sort === 'fav') {
    randomPage = Math.floor(Math.random() * 15) + 1
  } else {
    randomPage = Math.floor(Math.random() * 30) + 1
  }

  const url = new URL('https://yande.re/post.json')
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('page', String(randomPage))
  url.searchParams.set('tags', tags.join(' '))

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS)
  const onParentAbort = () => ctrl.abort()
  if (signal) signal.addEventListener('abort', onParentAbort)

  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json'
      },
      signal: ctrl.signal
    })

    if (!res.ok) {
      throw new Error(`Yande.re HTTP ${res.status}: ${res.statusText}`)
    }

    let items = await res.json()
    // 若随机页码无结果，兜底到第 1 页
    if ((!Array.isArray(items) || items.length === 0) && randomPage > 1) {
      url.searchParams.set('page', '1')
      const retryRes = await fetch(url.toString(), {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
        signal: ctrl.signal
      })
      if (retryRes.ok) {
        items = await retryRes.json()
      }
    }

    if (!Array.isArray(items)) {
      throw new Error('Yande.re 未返回列表数组')
    }

    return items.map(item => {
      const imgUrl = item.sample_url || item.file_url || item.jpeg_url || ''
      const itemTags = typeof item.tags === 'string' ? item.tags.split(/\s+/) : []
      const ratingLabel = item.rating === 's'
        ? '全年龄常规 (general)'
        : item.rating === 'e'
          ? '完全成人向 (explicit)'
          : '轻微敏感/擦边 (questionable)'

      return {
        type: 'image',
        sourceId: 'yande',
        sourceName: 'Yande.re',
        title: `Yande.re #${item.id}`,
        author: item.author || '',
        url: imgUrl,
        previewUrl: item.preview_url || imgUrl,
        r18: item.rating === 'e',
        rating: ratingLabel,
        tags: itemTags.slice(0, 10),
        postId: item.id,
        rawUrl: item.file_url || imgUrl
      }
    }).filter(x => Boolean(x.url))
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onParentAbort)
  }
}

/**
 * 3. Danbooru API (全球最大最全动漫图库)
 * 官方文档：https://danbooru.donmai.us/wiki_pages/help:api
 * 支持：严格的四级分级 (g/s/q/e)、时间/新鲜度 age 筛选、英文 Booru Tag
 */
export async function fetchDanbooru(cfg = {}, signal) {
  const limit = Math.min(Math.max(Number(cfg.num) || 1, 1), 10)
  const rating = cfg.rating || 'general'
  const sort = cfg.sort || 'rank' // 'rank' (趋势排行榜) | 'score' (高赞榜) | 'favcount' (高收藏榜) | 'recent' (最新发布) | 'random' (随机探索)
  const userTags = Array.isArray(cfg.tags)
    ? cfg.tags.map(t => String(t).trim()).filter(Boolean)
    : String(cfg.tags || '').split(/[,，\s]+/).filter(Boolean)

  const tags = []

  // 1. 分级条件 (rating:g / s / q / e)
  let ratingTag = ''
  if (rating === 'general' || rating === 'safe') {
    ratingTag = 'rating:g'
  } else if (rating === 'sensitive') {
    ratingTag = 'rating:s'
  } else if (rating === 'questionable') {
    ratingTag = 'rating:q'
  } else if (rating === 'explicit' || rating === 'r18') {
    ratingTag = 'rating:e'
  }

  // 2. 排序 / 排行榜条件
  let orderTag = ''
  if (sort === 'score') {
    orderTag = 'order:score'
  } else if (sort === 'favcount') {
    orderTag = 'order:favcount'
  } else if (sort === 'rank') {
    orderTag = 'order:rank'
  }

  // 3. 用户自定义标签注入（优先填入用户期望检索的 tag，最多保留 2 个）
  for (const ut of userTags) {
    if (tags.length < 2 && !tags.includes(ut)) {
      tags.push(ut)
    }
  }

  // 4. 补充 rating 与 orderTag 约束：
  // Danbooru 匿名规则限制：
  // - 纯 tags 数量上限 2 个；rating: 与 age: 属于系统元标签，即使存在 2 个普通 tag 也可附带 rating: 与 age:。
  // - 但是 order:* 会占用标准 tag 名额。如果已经有 2 个普通 tag，再加 order:* 会触发 422 TagLimitError。
  // 因此：如果普通 userTags 已经占满 2 个，则不追加 orderTag；若 userTags <= 1，且 tags.length < 2，则可追加 orderTag。
  if (orderTag && tags.length < 2) {
    tags.push(orderTag)
  }
  if (ratingTag) {
    tags.push(ratingTag)
  }

  // 4. 时间范围过滤 (Danbooru 支持 age:<Nd 格式，且不占匿名 2 个标签惩罚)
  const time = resolveTimeRange(cfg.timeRange || '2y', cfg.customDate)
  let ageDays = time.ageDays || 0
  // Danbooru 机制优化：若按全站高赞(order:score)或高收藏(order:favcount)排序，
  // 跨度超过 90 天会引发 Danbooru 官方数据库查询超时报 500。
  // 因此对点赞/收藏排行，安全上限约束在近 60 天内最热作品，既保证高热度又保证秒级响应。
  if ((sort === 'score' || sort === 'favcount') && (!ageDays || ageDays > 60)) {
    ageDays = 60
  }
  if (ageDays) {
    tags.push(`age:<${ageDays}d`)
  }

  // 5. 随机页码（核心解决“老是推送同一张”的问题）
  // rank / score / favcount 在前 1~15 页中随机抽选（每页 20 条，共 300 张最高品质候选）
  // recent / random 在前 1~40 页中随机抽选
  let page = 1
  if (sort === 'rank' || sort === 'score' || sort === 'favcount') {
    page = Math.floor(Math.random() * 15) + 1
  } else {
    page = Math.floor(Math.random() * 40) + 1
  }

  const url = new URL('https://danbooru.donmai.us/posts.json')
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('page', String(page))
  url.searchParams.set('tags', tags.join(' '))

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS)
  const onParentAbort = () => ctrl.abort()
  if (signal) signal.addEventListener('abort', onParentAbort)

  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json'
      },
      signal: ctrl.signal
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`Danbooru HTTP ${res.status}: ${errText.slice(0, 100) || res.statusText}`)
    }

    const items = await res.json()
    if (!Array.isArray(items)) {
      throw new Error('Danbooru 未返回列表数组')
    }

    return items.map(item => {
      const imgUrl = item.large_file_url || item.file_url || item.preview_file_url || ''
      const itemTags = typeof item.tag_string === 'string' ? item.tag_string.split(/\s+/) : []
      let ratingLabel = '全年龄常规 (general)'
      if (item.rating === 's') ratingLabel = '轻微敏感/微色 (sensitive)'
      else if (item.rating === 'q') ratingLabel = '限制级/擦边 (questionable)'
      else if (item.rating === 'e') ratingLabel = '完全成人向 (explicit)'

      return {
        type: 'image',
        sourceId: 'danbooru',
        sourceName: 'Danbooru',
        title: `Danbooru #${item.id}`,
        author: item.tag_string_artist || '',
        url: imgUrl,
        previewUrl: item.preview_file_url || imgUrl,
        r18: item.rating === 'e',
        rating: ratingLabel,
        tags: itemTags.slice(0, 10),
        postId: item.id,
        rawUrl: item.file_url || imgUrl
      }
    }).filter(x => Boolean(x.url))
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onParentAbort)
  }
}

/**
 * 聚合执行图库抓取
 * @param {object} galleryCfg 配置中的 gallery 节点
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ ok: boolean, images: Array, errors: Array }>}
 */
export async function collectGalleryImages(galleryCfg = {}, signal) {
  if (galleryCfg.enabled === false) {
    return { ok: true, images: [], errors: [], skipped: 'gallery_disabled' }
  }

  const enabledSources = []
  if (galleryCfg.lolicon?.enabled !== false) {
    const num = Math.min(Math.max(Number(galleryCfg.lolicon?.num) || 1, 1), 5)
    enabledSources.push({ id: 'lolicon', num, fn: () => fetchLolicon(galleryCfg.lolicon || {}, signal) })
  }
  if (galleryCfg.yande?.enabled !== false) {
    const num = Math.min(Math.max(Number(galleryCfg.yande?.num) || 1, 1), 5)
    enabledSources.push({ id: 'yande', num, fn: () => fetchYande(galleryCfg.yande || {}, signal) })
  }
  if (galleryCfg.danbooru?.enabled !== false) {
    const num = Math.min(Math.max(Number(galleryCfg.danbooru?.num) || 1, 1), 5)
    enabledSources.push({ id: 'danbooru', num, fn: () => fetchDanbooru(galleryCfg.danbooru || {}, signal) })
  }

  if (enabledSources.length === 0) {
    return { ok: true, images: [], errors: [], skipped: 'no_sources_enabled' }
  }

  const collected = []
  const errors = []

  // 各启用渠道分别根据自身设置的 num 独立抓取，最终结果累加聚合
  for (const src of enabledSources) {
    try {
      const items = await src.fn()
      if (Array.isArray(items) && items.length > 0) {
        const picked = items.slice(0, src.num)
        collected.push(...picked)
      }
    } catch (err) {
      errors.push({ source: src.id, error: String(err?.message || err) })
    }
  }

  return {
    ok: collected.length > 0,
    images: collected,
    errors
  }
}

// 常见二次元作品、角色与特征的中日英双向别名映射字典（大幅提升自然语言搜图精确度）
const TAG_ALIAS_MAP = {
  // 热门作品
  '异度之刃2': { booru: 'xenoblade_chronicles_2', pixiv: 'ゼノブレイド2' },
  '异度之刃': { booru: 'xenoblade_chronicles', pixiv: 'ゼノブレイド' },
  '异度神剑2': { booru: 'xenoblade_chronicles_2', pixiv: 'ゼノブレイド2' },
  '异度神剑': { booru: 'xenoblade_chronicles', pixiv: 'ゼノブレイド' },
  '原神': { booru: 'genshin_impact', pixiv: '原神' },
  '星穹铁道': { booru: 'honkai:_star_rail', pixiv: '崩壊:スターレイル' },
  '崩坏星穹铁道': { booru: 'honkai:_star_rail', pixiv: '崩壊:スターレイル' },
  '崩铁': { booru: 'honkai:_star_rail', pixiv: '崩壊:スターレイル' },
  '崩坏3': { booru: 'honkai_impact_3rd', pixiv: '崩壊3rd' },
  '碧蓝航线': { booru: 'azur_lane', pixiv: 'アズールレーン' },
  '明日方舟': { booru: 'arknights', pixiv: 'アークナイツ' },
  '碧蓝档案': { booru: 'blue_archive', pixiv: 'ブルーアーカイブ' },
  '蔚蓝档案': { booru: 'blue_archive', pixiv: 'ブルーアーカイブ' },
  '绝区零': { booru: 'zenless_zone_zero', pixiv: 'ゼンレスゾーンゼロ' },
  '鸣潮': { booru: 'wuthering_waves', pixiv: '鳴潮' },
  'fgo': { booru: 'fate/grand_order', pixiv: 'Fate/GrandOrder' },
  'fate': { booru: 'fate_(series)', pixiv: 'Fate' },
  '赛马娘': { booru: 'umamusume', pixiv: 'ウマ娘' },
  '东方project': { booru: 'touhou', pixiv: '東方' },
  '东方': { booru: 'touhou', pixiv: '東方' },

  // 经典热门角色
  '光': { booru: 'mythra_(xenoblade)', pixiv: 'ヒカリ(ゼノブレイド2)' },
  '焰': { booru: 'pyra_(xenoblade)', pixiv: 'ホムラ(ゼノブレイド2)' },
  '尼娅': { booru: 'nia_(xenoblade)', pixiv: 'ニア(ゼノブレイド2)' },
  '芙宁娜': { booru: 'furina_(genshin_impact)', pixiv: 'フリーナ' },
  '雷电将军': { booru: 'raiden_shogun', pixiv: '雷電将軍' },
  '雷神': { booru: 'raiden_shogun', pixiv: '雷電将軍' },
  '纳西妲': { booru: 'nahida_(genshin_impact)', pixiv: 'ナヒーダ' },
  '草神': { booru: 'nahida_(genshin_impact)', pixiv: 'ナヒーダ' },
  '钟离': { booru: 'zhongli_(genshin_impact)', pixiv: '鍾離' },
  '胡桃': { booru: 'hu_tao_(genshin_impact)', pixiv: '胡桃' },
  '甘雨': { booru: 'ganyu_(genshin_impact)', pixiv: '甘雨' },
  '神里绫华': { booru: 'kamisato_ayaka', pixiv: '神里綾華' },
  '刻晴': { booru: 'keqing_(genshin_impact)', pixiv: '刻晴' },
  '夜兰': { booru: 'yelan_(genshin_impact)', pixiv: '夜蘭' },
  '流萤': { booru: 'firefly_(honkai:_star_rail)', pixiv: 'ホタル(スターレイル)' },
  '黄泉': { booru: 'acheron_(honkai:_star_rail)', pixiv: '黄泉(スターレイル)' },
  '卡芙卡': { booru: 'kafka_(honkai:_star_rail)', pixiv: 'カフカ(スターレイル)' },
  '知更鸟': { booru: 'robin_(honkai:_star_rail)', pixiv: 'ロビン(スターレイル)' },
  '银狼': { booru: 'silver_wolf_(honkai:_star_rail)', pixiv: '銀狼(スターレイル)' },
  '黑天鹅': { booru: 'black_swan_(honkai:_star_rail)', pixiv: 'ブラックスワン(スターレイル)' },
  '花火': { booru: 'sparkle_(honkai:_star_rail)', pixiv: '花火(スターレイル)' },
  '三月七': { booru: 'march_7th', pixiv: '三月なのか' },
  '蕾姆': { booru: 'rem_(re:zero)', pixiv: 'レム' },
  '拉姆': { booru: 'ram_(re:zero)', pixiv: 'ラム' },
  '爱蜜莉雅': { booru: 'emilia_(re:zero)', pixiv: 'エミリア' },
  '初音未来': { booru: 'hatsune_miku', pixiv: '初音ミク' },
  '初音': { booru: 'hatsune_miku', pixiv: '初音ミク' },
  '2b': { booru: '2b_(nier:automata)', pixiv: '2B' },
  '亚丝娜': { booru: 'asuna_(sao)', pixiv: 'アスナ' },
  '蒂法': { booru: 'tifa_lockhart', pixiv: 'ティファ' },
  'saber': { booru: 'artoria_pendragon', pixiv: 'アルトリア' },

  // 特征与属性
  '白毛': { booru: 'white_hair', pixiv: '白髪' },
  '银发': { booru: 'silver_hair', pixiv: '銀髪' },
  '白发': { booru: 'white_hair', pixiv: '白髪' },
  '黑丝': { booru: 'black_pantyhose', pixiv: '黒タイツ' },
  '白丝': { booru: 'white_pantyhose', pixiv: '白タイツ' },
  '猫娘': { booru: 'catgirl', pixiv: '猫耳' },
  '猫耳': { booru: 'cat_ears', pixiv: '猫耳' },
  '兔女郎': { booru: 'bunny_girl', pixiv: 'バニーガール' },
  '女仆': { booru: 'maid', pixiv: 'メイド' },
  '泳装': { booru: 'swimsuit', pixiv: '水着' },
  '水着': { booru: 'swimsuit', pixiv: '水着' },
  '比基尼': { booru: 'bikini', pixiv: 'ビキニ' },
  'jk': { booru: 'school_uniform', pixiv: 'JK' },
  '水手服': { booru: 'sailor_suit', pixiv: 'セーラー服' },
  '双马尾': { booru: 'twintails', pixiv: 'ツインテール' },
  '短发': { booru: 'short_hair', pixiv: 'ショートヘア' },
  '长发': { booru: 'long_hair', pixiv: 'ロングヘア' },
  '裸足': { booru: 'barefoot', pixiv: '素足' },
  '兽耳': { booru: 'animal_ears', pixiv: '獣耳' },
  '兽娘': { booru: 'animal_ears', pixiv: '獣耳' }
}

/**
 * 响应群内或会话中用户的搜图需求（点图服务）
 * @param {string} prompt 用户输入的找图需求（例如：“白毛黑丝”、“猫娘”、“原神 芙宁娜”、“异度之刃2 光或者焰”）
 * @param {object} galleryCfg 当前图库配置
 * @param {number} count 期望获取的图片张数（默认 1，最多 5）
 * @returns {Promise<{ ok: boolean, images: Array, note: string }>}
 */
export async function searchImagesByRequest(prompt = '', galleryCfg = {}, count = 1) {
  const rawText = String(prompt || '').trim()
  if (!rawText) {
    return { ok: false, images: [], note: '未提供找图关键词' }
  }

  const targetCount = Math.min(Math.max(Number(count) || 1, 1), 5)

  // 1. 深度清洗关键词：去除 CQ 码、前缀动词、修饰词及语气词
  const cleanKeyword = rawText
    .replace(/(?:\[CQ:at,[^\]]+\]\s*)?/gi, '')
    .replace(/(?:图库采集|搜图|点图|搜色图|点色图|找图|查图)[：:\s]*/gi, '')
    .replace(/^(?:请?帮我|麻烦帮我|麻烦|请问有|有没有)+/gi, '')
    .replace(/^(?:找|搜|点|来点|来张|整点|想要|要|推)+/gi, '')
    .replace(/(?:色图|涩图|二次元|插画|壁纸|高清图|图片|套图|高清)+$/gi, '')
    .replace(/(?:至少)?(?:来|要|推|发|给)?\s*[1-5一两二三四五]\s*张/g, '')
    .replace(/的$/g, '')
    .trim()

  const targetTag = cleanKeyword || rawText

  // 2. 分词与映射解析
  const tokens = targetTag.split(/(?:或者|或是|或|以及|和|与|、|,|，|\s)+/).filter(Boolean)
  const mappedBooruTags = []
  const mappedPixivTags = []

  // 检查是否命中全词映射或分词映射
  const lowerTarget = targetTag.toLowerCase()
  if (TAG_ALIAS_MAP[lowerTarget]) {
    mappedBooruTags.push(TAG_ALIAS_MAP[lowerTarget].booru)
    mappedPixivTags.push(TAG_ALIAS_MAP[lowerTarget].pixiv)
  }

  for (const t of tokens) {
    const lk = t.toLowerCase()
    if (TAG_ALIAS_MAP[lk]) {
      if (!mappedBooruTags.includes(TAG_ALIAS_MAP[lk].booru)) {
        mappedBooruTags.push(TAG_ALIAS_MAP[lk].booru)
      }
      if (!mappedPixivTags.includes(TAG_ALIAS_MAP[lk].pixiv)) {
        mappedPixivTags.push(TAG_ALIAS_MAP[lk].pixiv)
      }
    }
  }

  // 子串扫描匹配（例如输入“原神芙宁娜”时未直接分词，但包含“原神”和“芙宁娜”）
  for (const [key, val] of Object.entries(TAG_ALIAS_MAP)) {
    if (key.length >= 2 && lowerTarget.includes(key)) {
      if (!mappedBooruTags.includes(val.booru)) {
        mappedBooruTags.push(val.booru)
      }
      if (!mappedPixivTags.includes(val.pixiv)) {
        mappedPixivTags.push(val.pixiv)
      }
    }
  }

  const signal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  const collectedImages = []
  const seenUrls = new Set()

  function addImages(list) {
    if (!Array.isArray(list)) return
    for (const img of list) {
      if (img?.url && !seenUrls.has(img.url)) {
        seenUrls.add(img.url)
        collectedImages.push(img)
        if (collectedImages.length >= targetCount) break
      }
    }
  }

  // 3. A. Lolicon 检索（优先中文/日文标签）：依次尝试原始词、Pixiv 映射词、分词
  if (galleryCfg.lolicon?.enabled !== false && collectedImages.length < targetCount) {
    const loliconCandidates = [
      targetTag,
      ...mappedPixivTags,
      ...tokens
    ].filter(Boolean)

    for (const cand of loliconCandidates) {
      try {
        const loliconCfg = {
          ...(galleryCfg.lolicon || {}),
          tags: cand,
          num: targetCount - collectedImages.length,
          rating: 'all' // 点图搜索时允许全分级覆盖，确保命中率
        }
        const list = await fetchLolicon(loliconCfg, signal)
        addImages(list)
        if (collectedImages.length >= targetCount) {
          return { ok: true, images: collectedImages, note: `从 Pixiv 成功检索到关于「${cand}」的插画` }
        }
      } catch {}
    }
  }

  // 3. B. Danbooru 检索：优先使用映射的英文 tag，或原始英文词
  if (galleryCfg.danbooru?.enabled !== false && collectedImages.length < targetCount) {
    const danbooruCandidates = [
      ...mappedBooruTags,
      ...tokens.filter(t => /^[a-zA-Z0-9_:\-()]+$/.test(t))
    ].filter(Boolean)

    for (const cand of danbooruCandidates) {
      try {
        const danCfg = {
          ...(galleryCfg.danbooru || {}),
          tags: cand,
          num: targetCount - collectedImages.length
        }
        const list = await fetchDanbooru(danCfg, signal)
        addImages(list)
        if (collectedImages.length >= targetCount) {
          return { ok: true, images: collectedImages, note: `从 Danbooru 成功检索到关于「${cand}」的插画` }
        }
      } catch {}
    }
  }

  // 3. C. Yande.re 检索：优先使用映射的英文 tag，或原始英文词
  if (galleryCfg.yande?.enabled !== false && collectedImages.length < targetCount) {
    const yandeCandidates = [
      ...mappedBooruTags,
      ...tokens.filter(t => /^[a-zA-Z0-9_:\-()]+$/.test(t))
    ].filter(Boolean)

    for (const cand of yandeCandidates) {
      try {
        const yandeCfg = {
          ...(galleryCfg.yande || {}),
          tags: cand,
          num: targetCount - collectedImages.length
        }
        const list = await fetchYande(yandeCfg, signal)
        addImages(list)
        if (collectedImages.length >= targetCount) {
          return { ok: true, images: collectedImages, note: `从 Yande.re 成功检索到关于「${cand}」的插画` }
        }
      } catch {}
    }
  }

  if (collectedImages.length > 0) {
    return { ok: true, images: collectedImages, note: `成功检索到关于「${targetTag}」的插画` }
  }

  // 3. D. 若所有精确条件均无果，走全局随机热度插画兜底
  try {
    const fallback = await collectGalleryImages({ ...galleryCfg, maxImagesPerRun: targetCount }, signal)
    if (fallback.ok && fallback.images.length > 0) {
      return { ok: true, images: fallback.images.slice(0, targetCount), note: `未精确匹配到「${targetTag}」的特定标签，为您精选了热门插画` }
    }
  } catch {}

  return { ok: false, images: [], note: `未找到与「${targetTag}」相关的插画` }
}
export async function testGallerySource(sourceId, cfg = {}) {
  const signal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  try {
    let list = []
    if (sourceId === 'lolicon') {
      list = await fetchLolicon(cfg, signal)
    } else if (sourceId === 'yande') {
      list = await fetchYande(cfg, signal)
    } else if (sourceId === 'danbooru') {
      list = await fetchDanbooru(cfg, signal)
    } else {
      throw new Error(`未知的图源类型: ${sourceId}`)
    }

    if (list.length === 0) {
      return { ok: false, error: '接口未返回有效图片，请检查标签或参数设置' }
    }

    const sample = list[0]
    return {
      ok: true,
      image: sample,
      count: list.length,
      note: `成功获取「${sample.title}」(${sample.rating})`
    }
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || err)
    }
  }
}
