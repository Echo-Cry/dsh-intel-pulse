import assert from 'node:assert/strict'
import {
  DEFAULTS,
  validateAndNormalize,
  normalizeWindows,
  isValidWindow,
  splitWindows,
  detailSpec,
  DETAIL_LEVELS
} from '../lib/config.js'

export async function runConfigTests() {
  console.log('--- [Test] Config Module ---')

  // 1. 默认值完备性检查
  assert.equal(typeof DEFAULTS.enabled, 'boolean')
  assert.equal(typeof DEFAULTS.collectEnabled, 'boolean')
  assert.equal(typeof DEFAULTS.gallery, 'object')
  assert.equal(DEFAULTS.gallery.enabled, true)
  assert.equal(DEFAULTS.gallery.mode, 'mixed')
  assert.equal(typeof DEFAULTS.gallery.lolicon, 'object')
  assert.equal(typeof DEFAULTS.gallery.yande, 'object')
  assert.equal(typeof DEFAULTS.gallery.danbooru, 'object')
  assert.equal(DEFAULTS.gallery.lolicon.num, 1)
  assert.equal(DEFAULTS.gallery.yande.num, 1)
  assert.equal(DEFAULTS.gallery.danbooru.num, 1)
  assert.equal(typeof DEFAULTS.onebot, 'object')
  assert.equal(DEFAULTS.onebot.enabled, true)
  assert.equal(DEFAULTS.onebot.httpUrl, 'http://127.0.0.1:3000')

  // 2. 空输入与非法类型校验
  const resEmpty = validateAndNormalize(null)
  assert.equal(resEmpty.ok, true)
  assert.equal(resEmpty.config.enabled, true)
  assert.equal(resEmpty.config.collectEnabled, true)
  assert.equal(resEmpty.config.gallery.enabled, true)

  // 3. sessionIds 规范化与旧 sessionId 迁移
  const resLegacyId = validateAndNormalize({ sessionId: 'legacy-1', sessionIds: ['s1', 's2', 's1'] })
  assert.deepEqual(resLegacyId.config.sessionIds, ['legacy-1', 's1', 's2'])
  assert.equal(resLegacyId.config.sessionId, undefined)

  // 超过 20 个会话截断测试
  const bigList = Array.from({ length: 30 }, (_, i) => `sess-${i}`)
  const resTrunc = validateAndNormalize({ sessionIds: bigList })
  assert.equal(resTrunc.config.sessionIds.length, 20)

  // 4. 时段处理
  assert.equal(isValidWindow('08:00-23:30'), true)
  assert.equal(isValidWindow('22:00-02:00'), true) // 跨午夜
  assert.equal(isValidWindow('全天'), true)
  assert.equal(isValidWindow('invalid-window'), false)
  assert.equal(isValidWindow('25:00-12:00'), false)

  const splitRes = splitWindows('08:00-12:00, 14:00-18:00; 全天')
  assert.deepEqual(splitRes, ['08:00-12:00', '14:00-18:00', '00:00-23:59'])

  const normWin = normalizeWindows(['08:00-12:00', 'bad-one', '08:00-12:00'])
  assert.deepEqual(normWin.windows, ['08:00-12:00'])
  assert.deepEqual(normWin.invalid, ['bad-one'])

  // 5. OneBot 配置清洗
  const resOb = validateAndNormalize({
    onebot: {
      httpUrl: 'http://127.0.0.1:5700///',
      accessToken: '  secret123  '
    }
  })
  assert.equal(resOb.config.onebot.httpUrl, 'http://127.0.0.1:5700')
  assert.equal(resOb.config.onebot.accessToken, 'secret123')
  assert.equal(resOb.config.onebot.enabled, true)

  // 6. 图库配置清洗与 clamp
  const resGallery = validateAndNormalize({
    gallery: {
      enabled: false,
      mode: 'images_only',
      requestTriggerEnabled: false,
      lolicon: {
        enabled: false,
        rating: 'r18', // 应映射为 explicit
        timeRange: 'custom',
        customDate: '2024-05-20',
        tags: '  genshin, honkai  ',
        num: 99 // 应 clamp 至 5
      },
      yande: {
        rating: 'safe', // 应映射为 general
        sort: 'invalid_sort', // 应 fallback 为 score
        timeRange: 'invalid_range', // fallback 为 2y
        num: -5 // clamp 至 1
      },
      danbooru: {
        rating: 'e', // 映射为 explicit
        sort: 'favcount',
        customDate: 'invalid-date', // 清空为空串
        num: 3
      }
    }
  })

  const g = resGallery.config.gallery
  assert.equal(g.enabled, false)
  assert.equal(g.mode, 'images_only')
  assert.equal(g.requestTriggerEnabled, false)
  assert.equal(g.lolicon.enabled, false)
  assert.equal(g.lolicon.rating, 'explicit')
  assert.equal(g.lolicon.customDate, '2024-05-20')
  assert.equal(g.lolicon.num, 5)

  assert.equal(g.yande.rating, 'general')
  assert.equal(g.yande.sort, 'score')
  assert.equal(g.yande.timeRange, '2y')
  assert.equal(g.yande.num, 1)

  assert.equal(g.danbooru.rating, 'explicit')
  assert.equal(g.danbooru.sort, 'favcount')
  assert.equal(g.danbooru.customDate, '')
  assert.equal(g.danbooru.num, 3)

  // 7. detailSpec 测试
  assert.equal(detailSpec('low').label, '低')
  assert.equal(detailSpec('high').label, '高')
  assert.equal(detailSpec('unknown').label, '中')

  console.log('✓ Config module tests passed!')
}
