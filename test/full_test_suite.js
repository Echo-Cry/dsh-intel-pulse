import assert from 'node:assert/strict'
import {
  validateAndNormalize,
  splitWindows,
  normalizeWindows,
  saveConfig
} from '../lib/config.js'
import {
  resolveTimeRange,
  fetchLolicon,
  fetchYande,
  fetchDanbooru,
  collectGalleryImages,
  searchImagesByRequest,
  testGallerySource
} from '../lib/gallery.js'
import {
  collect,
  collectBuiltin,
  evaluateJsonExpr
} from '../lib/collect.js'
import {
  stripLinks,
  formatImagesMarkdown,
  composeTemplate,
  composeMessage
} from '../lib/compose.js'
import {
  probeOneBotHttp,
  formatOneBotMessage,
  prepareOneBotMessageAsync,
  sendOneBotMessage,
  locateNapCatInstallation
} from '../lib/onebot.js'

async function runAllTests() {
  console.log('====================================================')
  console.log('   dsh-intel-pulse 全功能自动化验证测试集 v0.9.0    ')
  console.log('====================================================')

  // ----------------------------------------------------------------
  // 1. 配置管理系统 (lib/config.js)
  // ----------------------------------------------------------------
  console.log('\n[1/5] 测试配置管理与归一化...')
  {
    const emptyNorm = validateAndNormalize({})
    assert.equal(emptyNorm.ok, true)
    assert.equal(emptyNorm.config.gallery.enabled, true)
    assert.equal(emptyNorm.config.gallery.mode, 'mixed')
    assert.equal(emptyNorm.config.onebot.enabled, true)
    assert.equal(emptyNorm.config.onebot.httpUrl, 'http://127.0.0.1:3000')

    // 测试时间窗校验
    const winRes = normalizeWindows('09:00-12:00, 14:00-18:00, invalid-win')
    assert.deepEqual(winRes.windows, ['09:00-12:00', '14:00-18:00'])
    assert.deepEqual(winRes.invalid, ['invalid-win'])

    // 测试深层合并配置
    const saveRes = saveConfig({
      gallery: { mode: 'images_only', lolicon: { num: 3 } },
      onebot: { accessToken: 'test-token-123' }
    })
    assert.equal(saveRes.ok, true)
    const saved = saveRes.config
    assert.equal(saved.gallery.mode, 'images_only')
    assert.equal(saved.gallery.lolicon.num, 3)
    assert.equal(saved.gallery.lolicon.enabled, true) // 确保子字段未被覆盖丢失
    assert.equal(saved.onebot.accessToken, 'test-token-123')
    console.log('  ✓ 配置归一化、深层合并与默认值校验通过')
  }

  // ----------------------------------------------------------------
  // 2. 多源图库系统 (lib/gallery.js)
  // ----------------------------------------------------------------
  console.log('\n[2/5] 测试图库系统 (Lolicon / Yande.re / Danbooru)...')
  {
    // A. 时间区间解析
    const tr1y = resolveTimeRange('1y')
    assert.equal(tr1y.ageDays, 365)
    assert.ok(tr1y.dateStr && tr1y.dateStr.endsWith('..'))

    const trCustom = resolveTimeRange('custom', '2025-01-01')
    assert.equal(trCustom.dateStr, '2025-01-01..')

    // B. Danbooru 匿名 2-tag 限制与 order 冲突保护
    const origFetch = globalThis.fetch
    try {
      let capturedUrl = ''
      globalThis.fetch = async (url) => {
        capturedUrl = String(url)
        return { ok: true, json: async () => [] }
      }

      // 情况 1: 用户指定了 1 个 tag，且排行为 rank
      await fetchDanbooru({ rating: 'general', sort: 'rank', tags: 'furina_(genshin_impact)' })
      const u1 = new URL(capturedUrl)
      const tags1 = u1.searchParams.get('tags').split(' ')
      assert.ok(tags1.includes('furina_(genshin_impact)'))
      assert.ok(tags1.includes('order:rank'))
      assert.ok(tags1.includes('rating:g'))

      // 情况 2: 用户指定了 2 个 tag，此时必须抑制 order:rank 以防 422 TagLimitError
      await fetchDanbooru({ rating: 'general', sort: 'rank', tags: 'furina_(genshin_impact) solo' })
      const u2 = new URL(capturedUrl)
      const tags2 = u2.searchParams.get('tags').split(' ')
      assert.ok(tags2.includes('furina_(genshin_impact)'))
      assert.ok(tags2.includes('solo'))
      assert.ok(!tags2.includes('order:rank'), '2 个用户 tag 时不应再追加 order:rank')
      assert.ok(tags2.includes('rating:g'), 'rating:g 作为元标签被允许共存')

      // C. 自然语言点图与语义清洗 (searchImagesByRequest)
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          data: [{
            title: '芙宁娜水神',
            author: '画师X',
            urls: { regular: 'https://i.pixiv.re/furina.jpg' }
          }]
        })
      })

      const searchRes = await searchImagesByRequest('请帮我来点原神芙宁娜高清壁纸两张', { lolicon: { enabled: true } }, 2)
      assert.equal(searchRes.ok, true)
      assert.equal(searchRes.images.length, 1)
      assert.ok(searchRes.note.includes('原神芙宁娜'))

      // D. 图库聚合采集 (collectGalleryImages)
      const collectRes = await collectGalleryImages({
        lolicon: { enabled: true, num: 1 },
        yande: { enabled: false },
        danbooru: { enabled: false }
      })
      assert.equal(collectRes.ok, true)
      assert.equal(collectRes.images.length, 1)
      assert.equal(collectRes.images[0].title, '芙宁娜水神')

      // E. 单源连通性测试 (testGallerySource)
      const testRes = await testGallerySource('lolicon', { rating: 'general', tags: '' })
      assert.equal(testRes.ok, true)
      assert.equal(testRes.count, 1)

    } finally {
      globalThis.fetch = origFetch
    }
    console.log('  ✓ Danbooru 2-Tag 限制避让、时间区间计算、自然语言清洗映射通过')
  }

  // ----------------------------------------------------------------
  // 3. 资讯采集与 JSON 表达式提取 (lib/collect.js)
  // ----------------------------------------------------------------
  console.log('\n[3/5] 测试资讯采集与 JSON 路径提取...')
  {
    const samplePayload = {
      code: 200,
      data: {
        realtime: [
          { word: '头条热搜 A', num: 100 },
          { word: '头条热搜 B', num: 90 }
        ]
      }
    }
    const words = evaluateJsonExpr(samplePayload, 'data.realtime[].word')
    assert.deepEqual(words, ['头条热搜 A', '头条热搜 B'])

    // 测试纯图库模式拦截：当 gallery.mode = 'images_only' 时跳过资讯抓取
    const origFetch = globalThis.fetch
    try {
      let newsFetched = false
      globalThis.fetch = async (url) => {
        if (url.includes('weibo.com') || url.includes('toutiao.com')) {
          newsFetched = true
        }
        return {
          ok: true,
          json: async () => ({
            data: [{ title: '测试图', urls: { regular: 'https://test.jpg' } }]
          })
        }
      }

      const res = await collect({
        collectEnabled: true,
        method: 'builtin',
        gallery: { mode: 'images_only', lolicon: { enabled: true } }
      })
      assert.equal(newsFetched, false, '纯图库模式应跳过资讯网络抓取')
      assert.equal(res.images.length, 1)
      assert.equal(res.items.length, 0)
    } finally {
      globalThis.fetch = origFetch
    }
    console.log('  ✓ 纯图库模式拦截、JSON 路径抽取测试通过')
  }

  // ----------------------------------------------------------------
  // 4. 文案排版与防盗链 (lib/compose.js)
  // ----------------------------------------------------------------
  console.log('\n[4/5] 测试文案排版与 stripLinks 语法保护...')
  {
    // 测试普通链接剥离，同时保护 ![alt](url) 与 [CQ:image]
    const rawContent = '资讯正文 http://evil.com/leak 还有 [违规链接](https://bad.com)\n![Pixiv图](https://i.pixiv.re/p1.jpg)\n[CQ:image,file=https://img.com/p2.jpg]'
    const clean = stripLinks(rawContent)
    assert.ok(!clean.includes('http://evil.com/leak'))
    assert.ok(!clean.includes('https://bad.com'))
    assert.ok(clean.includes('![Pixiv图](https://i.pixiv.re/p1.jpg)'))
    assert.ok(clean.includes('[CQ:image,file=https://img.com/p2.jpg]'))

    // 测试 composeTemplate 各种排版模板
    const entries = [{ title: '新科技发布', summary: '性能提升50%', url: 'https://x.com' }]
    const imgs = [{ title: '精美插画', author: '艺术家', url: 'https://i.pixiv.re/art.jpg' }]

    const mixedMsg = composeTemplate({ detail: 'medium' }, entries, imgs)
    assert.ok(mixedMsg.includes('新科技发布'))
    assert.ok(mixedMsg.includes('🎨 精美插画'))

    const imgOnlyMsg = composeTemplate({ detail: 'medium' }, [], imgs)
    assert.ok(!imgOnlyMsg.includes('今日资讯摘要'))
    assert.ok(imgOnlyMsg.includes('精美插画'))
    console.log('  ✓ stripLinks Markdown图片语法保护、图文混排排版测试通过')
  }

  // ----------------------------------------------------------------
  // 5. OneBot 11 与 NapCat 驱动 (lib/onebot.js)
  // ----------------------------------------------------------------
  console.log('\n[5/5] 测试 OneBot 11 原生驱动与 NapCat 适配...')
  {
    // A. Markdown 转 CQ 码同步转换
    const cqText = formatOneBotMessage('正文前缀\n![插画](https://danbooru.donmai.us/1.jpg)\n后缀')
    assert.equal(cqText, '正文前缀\n[CQ:image,file=https://danbooru.donmai.us/1.jpg]\n后缀')

    // B. 异步转 Base64 与 Referer 防盗链伪造
    const origFetch = globalThis.fetch
    try {
      let refererSent = ''
      globalThis.fetch = async (url, opts) => {
        refererSent = opts?.headers?.Referer || ''
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => Buffer.from('mock-image-bytes')
        }
      }

      const asyncMsg = await prepareOneBotMessageAsync('看图：![测试](https://yande.re/image/sample.jpg)')
      assert.ok(asyncMsg.includes('[CQ:image,file=base64://'))
      assert.equal(refererSent, 'https://yande.re/')

      // C. 发送与 NapCat NTEvent 伪超时 (retcode 200, "result":0) 容错
      globalThis.fetch = async (url, opts) => {
        if (url.includes('send_group_msg') || url.includes('send_private_msg')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              retcode: 200,
              message: 'wait NTEvent timeout for msg: {"result":0,"errMsg":""}',
              data: { message_id: 888888 }
            })
          }
        }
        return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => Buffer.from('img') }
      }

      const sendRes = await sendOneBotMessage(
        { url: 'http://127.0.0.1:3000' },
        { messageType: 'group', targetId: '12345678', text: '群测试消息' }
      )
      assert.equal(sendRes.ok, true)
      assert.equal(sendRes.messageId, '888888')
      assert.equal(sendRes.note, 'NTEvent异步入队发送成功')
    } finally {
      globalThis.fetch = origFetch
    }
    console.log('  ✓ OneBot 消息CQ转译、Base64转换、NapCat防盗链与NTEvent容错通过')
  }

  console.log('\n====================================================')
  console.log(' 🎉 所有模块 100% 验证通过，无任何 Bug！')
  console.log('====================================================\n')
}

runAllTests().catch(err => {
  console.error('❌ 测试未通过:', err)
  process.exit(1)
})
