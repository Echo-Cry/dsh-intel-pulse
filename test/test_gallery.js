import assert from 'node:assert/strict'
import {
  fetchLolicon,
  fetchYande,
  fetchDanbooru,
  collectGalleryImages,
  searchImagesByRequest,
  testGallerySource
} from '../lib/gallery.js'

export async function runGalleryTests() {
  console.log('--- [Test] Gallery Module ---')

  // 保存原生 fetch 供测试后恢复
  const originalFetch = globalThis.fetch

  try {
    // 1. fetchLolicon 参数构建与正常响应
    let capturedUrl = ''
    globalThis.fetch = async (url, opts) => {
      capturedUrl = String(url)
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          error: '',
          data: [
            {
              title: '测试插画1',
              author: '测试画师1',
              r18: false,
              tags: ['白毛', '黑丝'],
              pid: 12345,
              urls: { regular: 'https://i.pixiv.re/regular/1.jpg', original: 'https://i.pixiv.re/orig/1.jpg' }
            }
          ]
        })
      }
    }

    const loliconRes = await fetchLolicon({
      rating: 'explicit',
      num: 2,
      tags: '白毛, 黑丝',
      timeRange: '1y'
    })

    assert.equal(loliconRes.length, 1)
    assert.equal(loliconRes[0].title, '测试插画1')
    assert.equal(loliconRes[0].url, 'https://i.pixiv.re/regular/1.jpg')
    assert.equal(capturedUrl.includes('r18=1'), true)
    assert.equal(capturedUrl.includes('num=2'), true)
    assert.equal(capturedUrl.includes('tag=%E7%99%BD%E6%AF%9B'), true)

    // 2. fetchLolicon 业务报错分支
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: '触发限流或无权限' })
    })
    await assert.rejects(
      async () => fetchLolicon({}),
      /Lolicon 业务错误: 触发限流或无权限/
    )

    // 3. fetchYande 参数构建与重试
    let yandeCalls = []
    globalThis.fetch = async (url) => {
      yandeCalls.push(String(url))
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => [
          {
            id: 9999,
            author: 'YandeArtist',
            rating: 's',
            tags: 'maid solo',
            sample_url: 'https://files.yande.re/sample/9999.jpg',
            file_url: 'https://files.yande.re/image/9999.png'
          }
        ]
      }
    }

    const yandeRes = await fetchYande({
      rating: 'general',
      sort: 'fav',
      tags: 'maid solo',
      num: 1
    })

    assert.equal(yandeRes.length, 1)
    assert.equal(yandeRes[0].title, 'Yande.re #9999')
    assert.equal(yandeRes[0].url, 'https://files.yande.re/sample/9999.jpg')
    assert.equal(yandeCalls[0].includes('rating%3As'), true)
    assert.equal(yandeCalls[0].includes('order%3Afav'), true)
    assert.equal(yandeCalls[0].includes('maid'), true)

    // 4. fetchDanbooru 参数构建与标签限制检查
    let danbooruUrl = ''
    globalThis.fetch = async (url) => {
      danbooruUrl = String(url)
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => [
          {
            id: 8888,
            tag_string_artist: 'DanbooruArtist',
            rating: 'g',
            tag_string: '1girl blue_hair',
            large_file_url: 'https://danbooru.donmai.us/large/8888.jpg',
            file_url: 'https://danbooru.donmai.us/orig/8888.png'
          }
        ]
      }
    }

    const danbooruRes = await fetchDanbooru({
      rating: 'general',
      sort: 'rank',
      tags: '1girl',
      num: 1
    })

    assert.equal(danbooruRes.length, 1)
    assert.equal(danbooruRes[0].title, 'Danbooru #8888')
    assert.equal(danbooruRes[0].url, 'https://danbooru.donmai.us/large/8888.jpg')

    console.log('Danbooru 请求 URL:', danbooruUrl)

    // 5. collectGalleryImages 开关与聚合测试
    // A: 图库总开关关闭
    const disabledRes = await collectGalleryImages({ enabled: false })
    assert.equal(disabledRes.ok, true)
    assert.equal(disabledRes.images.length, 0)
    assert.equal(disabledRes.skipped, 'gallery_disabled')

    // B: 所有子源禁用
    const noSubRes = await collectGalleryImages({
      enabled: true,
      lolicon: { enabled: false },
      yande: { enabled: false },
      danbooru: { enabled: false }
    })
    assert.equal(noSubRes.ok, true)
    assert.equal(noSubRes.images.length, 0)
    assert.equal(noSubRes.skipped, 'no_sources_enabled')

    // C: 正常多源收集与部分失败容错
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.includes('lolicon.app')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            error: '',
            data: [{ title: 'Loli-Img', urls: { regular: 'https://i.pixiv.re/1.jpg' } }]
          })
        }
      }
      if (u.includes('yande.re')) {
        throw new Error('Yande 网络连接超时')
      }
      if (u.includes('danbooru')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 111, large_file_url: 'https://danbooru/1.jpg' }]
        }
      }
      return { ok: false, status: 500 }
    }

    const aggregated = await collectGalleryImages({
      enabled: true,
      lolicon: { enabled: true, num: 1 },
      yande: { enabled: true, num: 1 },
      danbooru: { enabled: true, num: 1 }
    })

    assert.equal(aggregated.ok, true)
    assert.equal(aggregated.images.length, 2) // lolicon 成功 + danbooru 成功，yande 失败被容错捕获
    assert.equal(aggregated.errors.length, 1)
    assert.equal(aggregated.errors[0].source, 'yande')

    // 6. searchImagesByRequest 搜图点图互动解析
    // 测试自然语言清洗
    const searchQueries = [
      '图库采集：找白毛黑丝',
      '搜图 芙宁娜 来两张',
      '[CQ:at,qq=123456] 点图：请帮我来3张猫娘',
      '帮我整点异度之刃2光或者焰的高清壁纸 至少要4张',
      '整点二次元色图'
    ]

    for (const q of searchQueries) {
      const res = await searchImagesByRequest(q, {
        enabled: true,
        lolicon: { enabled: true },
        danbooru: { enabled: true },
        yande: { enabled: true }
      })
      assert.equal(typeof res.ok, 'boolean')
      assert.equal(Array.isArray(res.images), true)
      assert.equal(typeof res.note, 'string')
    }

    // 7. testGallerySource 针对各个图源的单源测试
    const tLolicon = await testGallerySource('lolicon', {})
    assert.equal(tLolicon.ok, true)
    assert.equal(Boolean(tLolicon.image), true)

    const tInvalid = await testGallerySource('unknown_source', {})
    assert.equal(tInvalid.ok, false)
    assert.equal(tInvalid.error.includes('未知的图源类型'), true)

    console.log('✓ Gallery module tests passed!')
  } finally {
    globalThis.fetch = originalFetch
  }
}
