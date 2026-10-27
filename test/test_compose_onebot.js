import assert from 'node:assert/strict'
import {
  stripLinks,
  formatImagesMarkdown,
  composeTemplate,
  DEFAULT_TEMPLATE
} from '../lib/compose.js'
import {
  formatOneBotMessage,
  prepareOneBotMessageAsync,
  probeOneBotHttp,
  sendOneBotMessage,
  detectOneBotHttpEndpoint,
  locateNapCatInstallation
} from '../lib/onebot.js'
import { evaluateJsonExpr } from '../lib/collect.js'

export async function runComposeAndOneBotTests() {
  console.log('--- [Test] Compose & OneBot Modules ---')

  // 1. stripLinks 测试
  // A. 普通链接应该被剥离
  const textWithLinks = '资讯一 http://example.com/a 资讯二 [链接](https://example.com/b) 结束'
  const stripped = stripLinks(textWithLinks)
  assert.equal(stripped.includes('http://example.com/a'), false)
  assert.equal(stripped.includes('https://example.com/b'), false)
  assert.equal(stripped.includes('资讯一'), true)
  assert.equal(stripped.includes('链接'), true)

  // B. Markdown 图片语法必须保留
  const textWithImages = '资讯一\n![Pixiv插画](https://i.pixiv.re/regular/12345.jpg)\n[普通链接](https://bad.com)'
  const strippedImg = stripLinks(textWithImages)
  assert.equal(strippedImg.includes('![Pixiv插画](https://i.pixiv.re/regular/12345.jpg)'), true)
  assert.equal(strippedImg.includes('https://bad.com'), false)

  // C. OneBot CQ 码必须保留
  const textWithCq = '前缀 [CQ:image,file=https://example.com/pic.png] 后缀'
  const strippedCq = stripLinks(textWithCq)
  assert.equal(strippedCq.includes('[CQ:image,file=https://example.com/pic.png]'), true)

  // 2. formatImagesMarkdown 测试
  const images = [
    { title: '插画A', author: '画师甲', r18: false, url: 'https://i.pixiv.re/1.jpg' },
    { title: '插画B', author: '', r18: true, url: 'https://i.pixiv.re/2.jpg' }
  ]
  const mdOutput = formatImagesMarkdown(images)
  assert.equal(mdOutput.includes('🎨 插画A (画师: 画师甲)'), true)
  assert.equal(mdOutput.includes('![插画A](https://i.pixiv.re/1.jpg)'), true)
  assert.equal(mdOutput.includes('[R18]'), true)

  // 3. composeTemplate 测试
  // A: 纯资讯
  const tmplEntries = [
    { title: '新闻1', summary: '摘要1', url: 'https://news.com/1' },
    { title: '新闻2', summary: '摘要2', url: 'https://news.com/2' }
  ]
  const tLow = composeTemplate({ detail: 'low' }, tmplEntries, [])
  assert.equal(tLow.includes('①新闻1；②新闻2'), true)

  const tMed = composeTemplate({ detail: 'medium' }, tmplEntries, [])
  assert.equal(tMed.includes('① 新闻1\n摘要1'), true)

  // B: 纯图库模式 (entries 为空，images 有内容)
  const tGalleryOnly = composeTemplate({ detail: 'medium' }, [], images)
  assert.equal(tGalleryOnly.includes('🎨 插画A'), true)
  assert.equal(tGalleryOnly.includes('🎨 插画B'), true)

  // C: 混排模式
  const tMixed = composeTemplate({ detail: 'medium' }, tmplEntries, images)
  assert.equal(tMixed.includes('新闻1'), true)
  assert.equal(tMixed.includes('🎨 插画A'), true)

  // 4. OneBot formatOneBotMessage 同步转译
  const cqConverted = formatOneBotMessage('测试消息\n![插画](https://img.com/test.jpg)')
  assert.equal(cqConverted, '测试消息\n[CQ:image,file=https://img.com/test.jpg]')

  // 5. OneBot prepareOneBotMessageAsync 异步 base64 转换与防盗链
  const origFetch = globalThis.fetch
  try {
    let capturedHeaders = {}
    globalThis.fetch = async (url, opts) => {
      capturedHeaders = opts?.headers || {}
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from('fake-image-bytes-data')
      }
    }

    const asyncConverted = await prepareOneBotMessageAsync('看图：![测试](https://danbooru.donmai.us/sample/1.jpg)')
    assert.equal(asyncConverted.includes('[CQ:image,file=base64://'), true)
    assert.equal(capturedHeaders['Referer'], 'https://danbooru.donmai.us/')

    // 6. probeOneBotHttp 服务存活探测
    globalThis.fetch = async (url) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', retcode: 0, data: { app_name: 'NapCat.Shell', version: '2.5.0' } })
      }
    }
    const probeRes = await probeOneBotHttp({ url: 'http://127.0.0.1:3000' })
    assert.equal(probeRes.ok, true)
    assert.equal(probeRes.versionInfo.app_name, 'NapCat.Shell')

    // 7. sendOneBotMessage 正常发送与 NTEvent 伪超时 (retcode 200)
    let sendBody = null
    globalThis.fetch = async (url, opts) => {
      if (url.includes('send_group_msg')) {
        sendBody = JSON.parse(opts.body)
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 123456 } })
        }
      }
      return { ok: true, arrayBuffer: async () => Buffer.from('img') }
    }

    const sendRes = await sendOneBotMessage(
      { url: 'http://127.0.0.1:3000' },
      { messageType: 'group', targetId: '987654321', text: '群通知' }
    )
    assert.equal(sendRes.ok, true)
    assert.equal(sendRes.messageId, '123456')
    assert.equal(sendBody.group_id, 987654321)

    // 测试 NapCat NTEvent 异步超时但实际成功 (retcode: 200, "result": 0)
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        retcode: 200,
        message: 'wait NTEvent timeout for msg: {"result":0,"errMsg":""}',
        data: { message_id: 654321 }
      })
    })

    const ntTimeoutRes = await sendOneBotMessage(
      { url: 'http://127.0.0.1:3000' },
      { messageType: 'private', targetId: '12345', text: '私聊图文' }
    )
    assert.equal(ntTimeoutRes.ok, true)
    assert.equal(ntTimeoutRes.note, 'NTEvent异步入队发送成功')

    // 8. evaluateJsonExpr 测试
    const testJson = {
      data: {
        realtime: [
          { word: '热搜1' },
          { word: '热搜2' }
        ]
      },
      list: [
        { title: '列表1' },
        { title: '列表2' }
      ]
    }
    const words = evaluateJsonExpr(testJson, 'data.realtime[].word')
    assert.deepEqual(words, ['热搜1', '热搜2'])

    const titles = evaluateJsonExpr(testJson, 'list[].title')
    assert.deepEqual(titles, ['列表1', '列表2'])

  } finally {
    globalThis.fetch = origFetch
  }

  console.log('✓ Compose & OneBot module tests passed!')
}
