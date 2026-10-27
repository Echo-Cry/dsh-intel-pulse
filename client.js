// dsh-away-notify client half：设置页「自主资讯推送」卡片。
//
// 结构与外观照抄 @kanadego/dsh-heartbeat 的设置卡片（同一个 settings.section 槽位）：
//   - 客户端模块由 ModuleLoader 以 factory 形式装载，factory 返回带 apply 的对象；
//   - 顶部「现在的状态」常开，其余小节用 <details> 折叠；
//   - 数据走宿主 /api/away-notify 精确 Fetch 路由：
//     ctx.get('connection').rpc.call('/api', 'away-notify', { endpoint, ...payload })。
window.__ModuleLoader__.load({
	id: 'dsh-intel-pulse',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
		const React = require('react')
		const h = React.createElement

		// ── 样式常量（逐字照抄心跳，勿改数值）────────────────────────────
		const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' }
		const labelStyle = { minWidth: 140, fontSize: 13, color: 'var(--dsw-alias-label-secondary)', flex: 'none' }
		const inputStyle = { width: 90, height: 28, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-specific-input-bg, transparent)', color: 'var(--dsw-alias-label-primary)', padding: '0 8px', fontSize: 13 }
		const buttonStyle = { height: 26, padding: '0 12px', borderRadius: 8, border: 'none', background: '#339CFF', color: '#fff', fontSize: 12, cursor: 'pointer', flex: 'none' }
		const buttonGhost = { ...buttonStyle, background: 'var(--dsw-alias-interactive-bg-hover, #444)', color: 'var(--dsw-alias-label-primary)' }
		const hintStyle = { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', margin: '4px 0' }
		const sectionStyle = { borderTop: '1px solid var(--dsw-alias-border-l2)', marginTop: 10, paddingTop: 6 }
		const summaryStyle = { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' }
		const rowList = { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }
		const tabRow = { display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0' }

		// 本地补充（不覆盖上面任何数值）
		const errStyle = { fontSize: 12, color: '#e5534b', margin: '4px 0' }
		const okStyle = { fontSize: 12, color: '#3fb950', margin: '4px 0' }
		const greyedStyle = { opacity: 0.45, pointerEvents: 'none' }
		const wrapRow = { ...rowStyle, flexWrap: 'wrap' }
		const wrapList = { ...rowList, flexWrap: 'wrap' }

		// ── 通用小件（照抄心跳 client.js:64-88）──────────────────────────
		function Section(props) {
			const [open, setOpen] = React.useState(props.open === true)
			return h('details', { open, style: sectionStyle, onToggle: (e) => setOpen(e.target.open) },
				h('summary', { style: summaryStyle }, props.title),
				open ? h('div', { style: { paddingTop: 4 } }, typeof props.children === 'function' ? props.children() : props.children) : null)
		}
		function useAsync(fetcher, deps) {
			const [s, setS] = React.useState({ loading: true, error: null, value: null })
			React.useEffect(() => {
				let alive = true
				setS({ loading: true, error: null, value: null })
				fetcher().then(
					(value) => { if (alive) setS({ loading: false, error: null, value }) },
					(error) => { if (alive) setS({ loading: false, error: String(error).slice(0, 120), value: null }) })
				return () => { alive = false }
			}, deps || [])
			return s
		}
		const fmtTime = (iso) => { try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }) } catch { return String(iso) } }
		const tabButton = (active, label, onClick) => h('button', { style: active ? buttonStyle : buttonGhost, onClick }, label)
		const toggleBtn = (on, onClick, onText = '☑ 开启', offText = '☐ 关闭') =>
			h('button', { style: on ? buttonStyle : buttonGhost, onClick }, on ? onText : offText)

		// ── 文案常量 ───────────────────────────────────────────────────
		const ALL_INTERESTS = [
			'AI 模型消息', 'DSH 生态消息', 'roguelike 卡牌游戏', '独立游戏',
			'网络热梗', '日本动漫信息', '当月 galgame 新作与汉化', '3A 游戏新作',
			'PC 与手机硬件', '二次元画师推荐', '时政新闻', '二次元手游新作',
			'科学科普', '历史科普'
		]
		const METHOD_LABEL = {
			builtin: '内置免 Token 抓取',
			custom: '自定义源',
			web_search: 'web_search',
			egoDirect: 'dsh-ego-browser 插件直连',
			egoSkill: 'dsh-ego-browser 插件脚本模式'
		}
		const SKIP_TEXT = {
			disabled: '总开关关着，什么都不做',
			paused: '已暂停，点了恢复才会继续',
			outsideWindow: '现在不在你设定的时段里，先不打扰',
			noTarget: '还没选投递目标，去「投递」里选至少一个会话',
			idleBelow: '你还在电脑前，先不打扰',
			alreadyFiredThisAbsence: '这次离席已经投过一条了',
			cooldown: '还在投递冷却里，先等一等',
			dailyCap: '今天的每日表达上限已经到了',
			probeDown: '闲置探测没跑起来，闲时运行暂时停用'
		}

		// ── 小工具 ─────────────────────────────────────────────────────
		const pad2 = (n) => String(n).padStart(2, '0')
		const fmtDayClock = (ms) => {
			try {
				const d = new Date(ms)
				const now = new Date()
				const clock = pad2(d.getHours()) + ':' + pad2(d.getMinutes())
				if (d.toDateString() === now.toDateString()) return '今天 ' + clock
				if (d.toDateString() === new Date(now.getTime() - 86400000).toDateString()) return '昨天 ' + clock
				return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + clock
			} catch { return '' }
		}
		const fmtAgo = (ms) => {
			const diff = Date.now() - ms
			if (!isFinite(diff) || diff < 0) return ''
			const min = Math.floor(diff / 60000)
			if (min < 1) return '刚刚'
			if (min < 60) return min + ' 分钟前'
			const hr = Math.floor(min / 60)
			if (hr < 24) return hr + ' 小时前'
			return Math.floor(hr / 24) + ' 天前'
		}
		const fmtStamp = (iso) => {
			try {
				const d = new Date(iso)
				return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
			} catch { return String(iso) }
		}
		const numOr = (v, fallback) => (typeof v === 'number' && isFinite(v) ? v : fallback)

		// ── 行件 ───────────────────────────────────────────────────────
		function Row(props) {
			return h('div', { style: wrapRow },
				h('span', { style: labelStyle }, props.label),
				props.control,
				props.note ? h('span', { style: hintStyle, title: props.title || undefined }, props.note) : null,
				props.tail || null)
		}

		function NumRow(props) {
			const asText = (v) => (v === undefined || v === null ? '' : String(v))
			const [text, setText] = React.useState(asText(props.value))
			React.useEffect(() => { setText(asText(props.value)) }, [props.value])
			// 边打边存会把正在输入的半截值按上下限钳掉、光标也跟着跳，所以打字只改本地，失焦或回车再落库。
			const commit = () => {
				const n = Number(text)
				if (text.trim() !== '' && isFinite(n)) props.onChange(n)
				else setText(asText(props.value))
			}
			return h(Row, {
				label: props.label,
				note: props.note,
				control: h('input', {
					type: 'number',
					style: { ...inputStyle, width: props.width || 90 },
					min: props.min,
					max: props.max,
					value: text,
					onChange: (e) => setText(e.target.value),
					onBlur: commit,
					onKeyDown: (e) => { if (e.key === 'Enter') commit() }
				})
			})
		}

		function SaveNote(props) {
			const s = props.save || { state: 'idle', msg: '' }
			if (s.state === 'error') return h('div', { style: errStyle }, s.msg)
			return h('div', { style: hintStyle }, '改动即改即生效，不需要保存按钮、不需要重启。' + (s.msg || ''))
		}

		// ── ① 现在的状态 ───────────────────────────────────────────────
		function StatusBox() {
			const initial = useAsync(() => rpc('state.get'), [])
			const [live, setLive] = React.useState(null)
			const [busy, setBusy] = React.useState(false)
			const [testLine, setTestLine] = React.useState(null)
			const [cleanLine, setCleanLine] = React.useState('')

			React.useEffect(() => {
				let alive = true
				const t = setInterval(() => {
					rpc('state.get').then((v) => { if (alive) setLive(v) }).catch(() => {})
				}, 5000)
				return () => { alive = false; clearInterval(t) }
			}, [])

			const v = live || initial.value
			if (initial.error) return h('div', { style: errStyle }, '读不到状态：' + initial.error)
			if (!v) return h('div', { style: hintStyle }, '正在读…')

			const idleSec = numOr(v.idleSeconds, 0)
			const threshold = numOr(v.idleThresholdMin, 60)
			const mins = Math.floor(idleSec / 60)
			const reached = idleSec >= threshold * 60
			const todayCount = numOr(v.todayCount, 0)
			const maxPerDay = numOr(v.maxPerDay, 0)

			const isCollectOn = v.collectEnabled !== false
			const isGalleryOn = v.galleryEnabled !== false
			let head = ''
			if (!v.enabled) {
				head = '现在：总开关已关闭'
			} else if (v.paused) {
				head = '现在：已暂停'
			} else if (!isCollectOn && !isGalleryOn) {
				head = '现在：资讯采集与图库采集均已关闭（待机中）'
			} else if (isCollectOn && isGalleryOn) {
				head = '现在：正在守着你（资讯采集 + 图库采集均已就绪）'
			} else if (isCollectOn) {
				head = '现在：正在守着你（仅资讯采集）'
			} else {
				head = '现在：正在守着你（仅图库采集）'
			}
			const idleLine = v.probeDown
				? '闲置时长：读不到（闲置探测没跑起来）'
				: '闲置时长：' + mins + ' 分钟（阈值 ' + threshold + ' 分钟，' + (reached ? '已触发' : '未触发') + '）'
			const lastLine = v.lastDeliverAt
				? '上次投递：' + fmtDayClock(v.lastDeliverAt) + '（' + fmtAgo(v.lastDeliverAt) + '）'
				: '上次投递：还没跑过'
			const countLine = '今日已投递：' + todayCount + ' / ' + maxPerDay + ' 条'
			const sessionCount = numOr(v.sessionCount, 0)
			const targetLine = sessionCount > 0
				? '投递目标：' + sessionCount + ' 个会话'
				: '投递目标：还没选（去「投递」里勾会话）'
			let nextLine
			if (maxPerDay > 0 && todayCount >= maxPerDay) nextLine = '下次可投递：明天（今天的额度用完了）'
			else if (!v.nextEligibleAt || v.nextEligibleAt <= Date.now()) nextLine = '下次可投递：随时'
			else nextLine = '下次可投递：' + fmtDayClock(v.nextEligibleAt)
			const reasonLine = v.lastSkipReason ? (SKIP_TEXT[v.lastSkipReason] || String(v.lastSkipReason)) : null

			const runTest = () => {
				setBusy(true)
				setTestLine(null)
				rpc('run.test').then((res) => {
					const tokens = (res.usage?.input || 0) + (res.usage?.output || 0)
					const n = (res.targets && res.targets.length) || 0
					const failed = numOr(res.failedCount, 0)
					const artCount = ((res.entries && res.entries.length) || 0)
					const imgCount = ((res.images && res.images.length) || 0)
					const summaryText = [
						artCount > 0 ? `${artCount} 条资讯` : null,
						imgCount > 0 ? `${imgCount} 张插画` : null
					].filter(Boolean).join(' + ') || '0 条内容'
					setTestLine({
						ok: true,
						text: '成功：' + Math.round((res.durationMs || 0) / 1000) + 's，' + summaryText + '，已投到 ' + n + ' 个会话' + (failed > 0 ? '（' + failed + ' 个失败）' : '') + '（' + tokens + ' token）'
					})
				}, (e) => {
					setTestLine({ ok: false, text: '失败：' + (e.message || '未知原因') })
				}).then(() => {
					setBusy(false)
					rpc('state.get').then((nv) => setLive(nv)).catch(() => {})
				})
			}
			const cleanBrowser = () => {
				setCleanLine('正在清理…')
				rpc('browser.cleanup').then((res) => {
					setCleanLine(res && res.stopped ? '已清理残留浏览器' : '没有需要清理的浏览器')
				}, (e) => { setCleanLine('清理失败：' + (e.message || '未知原因')) })
			}

			return h('div', null,
				h('div', { style: hintStyle }, head + (v.mode === 'idle-only' ? ' · 闲时运行' : ' · 持续运行')),
				h('div', { style: hintStyle }, idleLine),
				h('div', { style: hintStyle }, lastLine),
				h('div', { style: hintStyle }, countLine),
				h('div', { style: sessionCount > 0 ? hintStyle : errStyle }, targetLine),
				h('div', { style: hintStyle }, nextLine),
				h('div', { style: hintStyle }, '插件版本：' + (v.version || '未知')),
				reasonLine ? h('div', { style: hintStyle }, '现在没动：' + reasonLine) : null,
				v.lastError ? h('div', { style: errStyle }, '上次执行失败：' + v.lastError) : null,
				h('div', { style: wrapRow },
					h('button', { style: buttonGhost, onClick: () => { rpc('pause.set', { paused: !v.paused }).then(() => rpc('state.get').then((nv) => setLive(nv)), () => {}) } }, v.paused ? '恢复运行' : '暂停一晚'),
					h('button', { style: busy ? { ...buttonStyle, ...greyedStyle } : buttonStyle, onClick: busy ? undefined : runTest }, busy ? '正在跑…' : '马上试一次'),
					h('button', { style: buttonGhost, onClick: cleanBrowser }, '清理残留浏览器')),
				testLine ? h('div', { style: testLine.ok ? okStyle : errStyle }, '本次试跑' + testLine.text) : null,
				cleanLine ? h('div', { style: hintStyle }, cleanLine) : null)
		}

		// ── ② 投递 ─────────────────────────────────────────────────────
		// 会话选择：先挑工作区，再在里面勾会话，可以跨工作区多选
		function SessionPicker(props) {
			const { cfg, patch } = props
			const list = useAsync(() => rpc('workspaces.list'), [])
			const workspaces = Array.isArray(list.value && list.value.workspaces) ? list.value.workspaces : []
			const total = (list.value && list.value.sessionCount) || 0
			const [wsId, setWsId] = React.useState(null)

			const selected = Array.isArray(cfg.sessionIds) ? cfg.sessionIds.filter(Boolean) : []
			const selectedSet = new Set(selected)

			const flat = []
			workspaces.forEach((w) => (w.sessions || []).forEach((s) => flat.push({ ...s, workspaceId: w.id, wsTitle: w.title })))
			const labelOf = (s) => {
				const t = String((s && s.title) || '').trim()
				if (t) return t
				return '未命名会话 · ' + String((s && s.id) || '').replace(/^session-/, '').slice(0, 8)
			}

			const activeWsId = wsId || (workspaces[0] && workspaces[0].id) || ''
			const activeWs = workspaces.find((w) => w.id === activeWsId) || null
			const sessions = (activeWs && activeWs.sessions) || []

			const commit = (next) => patch({ sessionIds: next })
			const toggle = (id) => {
				commit(selectedSet.has(id) ? selected.filter((x) => x !== id) : selected.concat(id))
			}
			const idsOfWs = (ws) => ((ws && ws.sessions) || []).map((s) => s.id)
			const toggleWs = () => {
				const ids = idsOfWs(activeWs)
				if (ids.length === 0) return
				const allIn = ids.every((i) => selectedSet.has(i))
				commit(allIn ? selected.filter((i) => ids.indexOf(i) < 0) : Array.from(new Set(selected.concat(ids))))
			}

			const wsAllIn = activeWs ? idsOfWs(activeWs).every((i) => selectedSet.has(i)) : false

			const wsSelect = h('select', {
				style: { ...inputStyle, width: 220, padding: '0 6px' },
				value: activeWsId,
				onChange: (e) => setWsId(e.target.value)
			}, workspaces.length === 0 ? h('option', { value: '' }, '（没有读到工作区）') : null,
				workspaces.map((w) => h('option', { key: w.id, value: w.id },
					String(w.title || '未命名工作区') + '（' + ((w.sessions || []).length) + ' 个会话）')))

			const checkList = h('div', {
				style: {
					maxHeight: 190,
					overflowY: 'auto',
					border: '1px solid var(--dsw-alias-border-l2)',
					borderRadius: 8,
					padding: '4px 8px',
					minWidth: 340
				}
			}, sessions.length === 0
				? h('div', { style: hintStyle }, '这个工作区里没有读到会话')
				: sessions.map((s) => h('label', {
					key: s.id,
					style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, padding: '3px 0', cursor: 'pointer', color: 'var(--dsw-alias-label-primary)' }
				},
					h('input', { type: 'checkbox', checked: selectedSet.has(s.id), onChange: () => toggle(s.id) }),
					h('span', { style: { flex: '1' } }, labelOf(s)),
					s.updatedAt ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, fmtAgo(s.updatedAt)) : null)))

			const chipList = selected.length === 0 ? null : h('div', { style: { ...wrapRow, marginTop: 4 } },
				selected.map((id) => {
					const found = flat.find((s) => s.id === id) || { id }
					return h('span', {
						key: id,
						style: {
							display: 'inline-flex',
							alignItems: 'center',
							gap: 6,
							padding: '2px 8px',
							borderRadius: 999,
							fontSize: 12,
							background: 'var(--dsw-alias-interactive-bg-hover, #2b2b2b)',
							color: 'var(--dsw-alias-label-primary)'
						}
					},
						labelOf(found),
						h('span', {
							style: { cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary)' },
							onClick: () => toggle(id),
							title: '移除'
						}, '×'))
				}))

			return h('div', null,
				h(Row, {
					label: '工作区',
					control: h('div', { style: wrapList },
						wsSelect,
						h('button', { style: buttonGhost, onClick: toggleWs }, wsAllIn ? '取消本工作区' : '选中本工作区')),
					note: list.loading ? '正在读取工作区…' : (workspaces.length + ' 个工作区 · ' + total + ' 个会话')
				}),
				h(Row, {
					label: '会话',
					control: checkList,
					note: '可以勾多个、跨工作区也行；采集只跑一次，这些会话都只是接收方'
				}),
				chipList,
				h('div', { style: hintStyle }, selected.length === 0
					? '还没选会话：选完才会开始跑（没选目标时不采集、不唤醒、不烧 token）。'
					: '已选 ' + selected.length + ' 个会话。'),
				selected.length > 0
					? h('div', { style: hintStyle }, '用哪个模型采集：只跑一次采集，用的是上面排第一个、并且能打开的那个会话的模型；其余会话只是接收方，不会再各搜一遍，也不会重复花 token。')
					: null,
				list.error ? h('div', { style: hintStyle }, '工作区列表读取失败，可以直接填会话 ID（多个用逗号分隔）：' + list.error) : null,
				list.error || workspaces.length === 0
					? h('input', {
						style: { ...inputStyle, width: 420 },
						value: selected.join(','),
						placeholder: 'sessionId1, sessionId2',
						onChange: (e) => commit(e.target.value.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean))
					})
					: null)
		}

		// 手机同步（可选）：QQ / 飞书这类桥接是「你发一条、它才回一条」，
		// 会话里被别的插件塞进去的推送不会自动回传到手机，所以要用 dsh-im 的出站接口再发一份。
		// follow：推送跟着会话走（发到那个会话对应的群或私聊）；fixed：全部发到指定对话。
		function PhoneSync(props) {
			const { cfg, patch } = props
			const im = (cfg && cfg.imSync) || { enabled: false, mode: 'follow', botId: '', targetId: '', kind: '', route: null }
			const list = useAsync(() => rpc('im.targets'), [])
			const value = list.value || {}
			const chats = Array.isArray(value.chats) ? value.chats : []
			const available = Boolean(value.available)
			const mode = im.enabled ? (im.mode === 'fixed' ? 'fixed' : 'follow') : 'off'

			const keyOf = (c) => c.botId + '::' + String(c.kind || '') + '::' + JSON.stringify(c.route || {})
			const current = im.botId && im.kind && im.route ? keyOf({ botId: im.botId, kind: im.kind, route: im.route }) : ''

			const set = (next) => patch({ imSync: { ...im, ...next } })
			const setMode = (next) => {
				if (next === 'off') {
					set({ enabled: false, mode: 'follow', botId: '', targetId: '', kind: '', route: null, label: '' })
					return
				}
				if (next === 'follow') {
					set({ enabled: true, mode: 'follow', botId: '', targetId: '', kind: '', route: null, label: '' })
					return
				}
				const first = chats[0]
				if (!first) {
					set({ enabled: true, mode: 'fixed' })
					return
				}
				set({
					enabled: true,
					mode: 'fixed',
					botId: first.botId,
					channel: String(first.channel || ''),
					targetId: '',
					kind: String(first.kind || ''),
					route: first.route,
					label: first.label || ''
				})
			}

			const modeSelect = h('select', {
				style: { ...inputStyle, width: 300, padding: '0 6px' },
				value: mode,
				onChange: (e) => setMode(e.target.value)
			},
				h('option', { value: 'off' }, '不同步'),
				h('option', { value: 'follow' }, '跟着会话走（群会话发到群、私聊发到私聊）'),
				h('option', { value: 'fixed' }, '固定发到一个对话'))

			const chatSelect = mode !== 'fixed' ? null : h('select', {
				style: { ...inputStyle, width: 260, padding: '0 6px' },
				value: current,
				onChange: (e) => {
					const picked = chats.filter((c) => keyOf(c) === e.target.value)[0]
					if (!picked) return
					set({
						enabled: true,
						mode: 'fixed',
						botId: picked.botId,
						channel: String(picked.channel || ''),
						targetId: '',
						kind: String(picked.kind || ''),
						route: picked.route,
						label: picked.label || ''
					})
				}
			},
				chats.length === 0 ? h('option', { value: '' }, '（没有读到对话）') : null,
				chats.map((c) => h('option', { key: keyOf(c), value: keyOf(c) },
					String(c.label || '对话') + (c.sessionTitle ? ' · ' + c.sessionTitle : ''))))

			let note = mode === 'follow'
				? '每条推送发到它对应会话的那个 IM / QQ 聊天：群里的会话发到群，私聊发到私聊'
				: '同一段文案再发一份到这个对话；不选就只进会话'
			if (list.loading) note = '正在读取 IM / QQ 对话…'
			else if (!available) note = '宿主里没有可用的 IM 或 QQ 投递服务（没装或没连上），跳过这一项'
			else if (chats.length === 0) note = '没读到已桥接的聊天，先在 IM 插件或 dsh-onebot-qq 里把机器人连上'

			// 跟随模式下顺便告诉用户：选中的会话里有几个能对上 IM 聊天
			const chosen = Array.isArray(cfg.sessionIds) ? cfg.sessionIds.filter(Boolean) : []
			const matched = chosen.filter((sid) => chats.some((c) => String(c.sessionId || '').replace(/^session-/, '') === String(sid).replace(/^session-/, '')))
			const followNote = mode === 'follow' && chosen.length > 0 && chats.length > 0
				? h('div', { style: hintStyle }, '选中的 ' + chosen.length + ' 个会话里，' + matched.length + ' 个能对上 IM 聊天' + (matched.length < chosen.length ? '（对不上的只进 DSH，不发手机）' : ''))
				: null

			// OneBot 11 原生直连配置（全自动感应连接）
			const ob = cfg.onebot || { enabled: true, httpUrl: 'http://127.0.0.1:3000', accessToken: '' }
			const setOb = (next) => patch({ onebot: { ...ob, ...next } })

			const [probeState, setProbeState] = React.useState({ testing: false, msg: '' })
			const [inspectState, setInspectState] = React.useState({ loading: false, data: null, error: null })
			const [customPath, setCustomPath] = React.useState('')
			const [enableState, setEnableState] = React.useState({ working: false, msg: '' })
			const [showAdvanced, setShowAdvanced] = React.useState(false)

			const doInspect = React.useCallback(async (pathOverride) => {
				setInspectState((s) => ({ ...s, loading: true }))
				try {
					const res = await rpc('onebot.inspect', {
						httpUrl: ob.httpUrl,
						accessToken: ob.accessToken,
						customPath: pathOverride !== undefined ? pathOverride : customPath
					})
					setInspectState({ loading: false, data: res, error: null })
				} catch (e) {
					setInspectState({ loading: false, data: null, error: e?.message || String(e) })
				}
			}, [ob.httpUrl, ob.accessToken, customPath])

			// 自动感应并自动连接 NapCat
			React.useEffect(() => {
				if (ob.enabled !== false) {
					rpc('onebot.autoConfig', { customPath }).then((res) => {
						if (res?.ok && res.httpUrl) {
							// 若尚未配置、填了错的端口（如 6099）、或检测到实际端口不一致，自动更正并保存
							if (!ob.httpUrl || /:6099\b/.test(ob.httpUrl) || (res.running && ob.httpUrl !== res.httpUrl)) {
								setOb({ httpUrl: res.httpUrl, accessToken: res.accessToken || '' })
							}
						}
						doInspect()
					}).catch(() => {
						doInspect()
					})
				}
			}, [ob.enabled])

			const testOneBot = async () => {
				setProbeState({ testing: true, msg: '正在测试连接…' })
				try {
					const res = await rpc('onebot.probe', { httpUrl: ob.httpUrl, accessToken: ob.accessToken })
					if (res?.ok) {
						const v = res.versionInfo || {}
						setProbeState({ testing: false, msg: `✅ 连接正常 (${v.app_name || 'OneBot'} ${v.app_version || ''})` })
					} else {
						setProbeState({ testing: false, msg: `❌ 连接失败：${res?.error || '无法访问'}` })
					}
					doInspect()
				} catch (e) {
					setProbeState({ testing: false, msg: `测试异常：${e?.message || e}` })
				}
			}

			const doEnableHttp = async () => {
				setEnableState({ working: true, msg: '正在为 NapCat 写入 HTTP 配置…' })
				try {
					const targetDir = inspectState.data?.napcatDir || customPath
					const res = await rpc('onebot.enableHttp', {
						customPath: targetDir,
						port: 3000,
						accessToken: ob.accessToken
					})
					if (res?.ok) {
						setEnableState({ working: false, msg: res.message || '配置已成功写入！请重启 NapCat 生效。' })
						if (res.httpUrl) {
							setOb({ httpUrl: res.httpUrl, accessToken: res.accessToken || '' })
						}
						await doInspect()
					} else {
						setEnableState({ working: false, msg: `配置写入失败：${res?.error || '未知错误'}` })
					}
				} catch (e) {
					setEnableState({ working: false, msg: `执行异常：${e?.message || e}` })
				}
			}

			// NapCat 状态卡片渲染
			const renderNapCatStatusCard = () => {
				if (inspectState.loading) {
					return h('div', { style: hintStyle }, '正在自动检测本地 NapCat 状态…')
				}
				const d = inspectState.data
				if (!d) return null

				if (d.status === 'running') {
					const v = d.versionInfo || {}
					return h('div', { style: { padding: '8px 10px', background: 'rgba(63,185,80,0.1)', border: '1px solid #3fb95044', borderRadius: 6, fontSize: 12, margin: '6px 0' } },
						h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 } },
							h('div', null,
								h('span', { style: { color: '#3fb950', fontWeight: 600 } }, '🟢 NapCat OneBot 11 服务已自动连接：'),
								h('span', { style: { marginLeft: 4, color: 'var(--dsw-alias-label-primary)' } }, `${v.app_name || 'NapCat'} ${v.app_version || ''} (${d.httpUrl})`)
							),
							h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
								h('button', {
									style: { ...buttonStyle, height: 24, padding: '0 10px', fontSize: 11, background: '#238636' },
									disabled: probeState.testing,
									onClick: testOneBot
								}, probeState.testing ? '测试中…' : '测试连接')
							)
						),
						probeState.msg ? h('div', { style: { marginTop: 4, fontSize: 11, color: (probeState.msg.includes('正常') || probeState.msg.includes('成功')) ? '#3fb950' : '#e5534b' } }, probeState.msg) : null
					)
				}

				if (d.status === 'not_configured') {
					return h('div', { style: { padding: '8px 10px', background: 'rgba(235,170,0,0.1)', border: '1px solid rgba(235,170,0,0.3)', borderRadius: 6, fontSize: 12, margin: '6px 0' } },
						h('div', { style: { color: '#e3b341', fontWeight: 600, marginBottom: 4 } }, '🟡 检测到 NapCat 已安装，但尚未开启 HTTP 3000 服务'),
						h('div', { style: { color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } }, `安装目录：${d.napcatDir || '本地 NapCat'}`),
						h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
							h('button', {
								style: { ...buttonStyle, height: 26, padding: '0 12px', fontSize: 12, background: '#339CFF' },
								disabled: enableState.working,
								onClick: doEnableHttp
							}, enableState.working ? '正在配置…' : '⚡ 一键开启 NapCat HTTP 服务 (3000)'),
							h('button', {
								style: { ...buttonGhost, height: 26, padding: '0 10px', fontSize: 12 },
								onClick: () => doInspect()
							}, '刷新检测')
						),
						enableState.msg ? h('div', { style: { marginTop: 6, color: enableState.msg.includes('失败') ? '#e5534b' : '#3fb950' } }, enableState.msg) : null
					)
				}

				if (d.status === 'configured_need_restart') {
					return h('div', { style: { padding: '8px 10px', background: 'rgba(235,170,0,0.1)', border: '1px solid rgba(235,170,0,0.3)', borderRadius: 6, fontSize: 12, margin: '6px 0' } },
						h('div', { style: { color: '#e3b341', fontWeight: 600, marginBottom: 4 } }, '🟠 OneBot HTTP 3000 服务已写入配置，等待生效'),
						h('div', { style: { color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } }, 'NapCat 配置文件中已写入 HTTP 服务，但端口尚未响应。请启动或重启 NapCat 客户端以生效。'),
						h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
							h('button', {
								style: { ...buttonStyle, height: 26, padding: '0 12px', fontSize: 12 },
								onClick: () => doInspect()
							}, '重启后重新检测')
						)
					)
				}

				// not_found 或 no_config：提供手动指定路径
				return h('div', { style: { padding: '6px 8px', background: 'var(--dsw-alias-bg-l2)', borderRadius: 6, fontSize: 12, margin: '6px 0' } },
					h('div', { style: { color: 'var(--dsw-alias-label-tertiary)', marginBottom: 6 } }, '未在常见目录扫描到 NapCat，可输入 NapCat 根目录手动检测：'),
					h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
						h('input', {
							style: { ...inputStyle, width: 200, height: 26 },
							value: customPath,
							placeholder: '例如 D:\\NapCat.Shell',
							onChange: (e) => setCustomPath(e.target.value)
						}),
						h('button', {
							style: { ...buttonStyle, height: 26, padding: '0 10px', fontSize: 12 },
							onClick: () => doInspect(customPath)
						}, '扫描检测')
					)
				)
			}

			const oneBotSection = h('div', { style: { marginTop: 10, padding: '8px 10px', background: 'var(--dsw-alias-bg-l1)', borderRadius: 6 } },
				h(Row, {
					label: 'OneBot 直连',
					control: h('input', {
						type: 'checkbox',
						checked: ob.enabled !== false,
						onChange: (e) => setOb({ enabled: e.target.checked })
					}),
					note: '自动连接本机 NapCat OneBot 11 接口推送到 QQ，会话退役或离线也能秒发'
				}),
				ob.enabled !== false ? h('div', { style: { marginTop: 6 } },
					renderNapCatStatusCard(),
					h('div', { style: { marginTop: 4 } },
						h('a', {
							style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', textDecoration: 'underline' },
							onClick: () => setShowAdvanced(!showAdvanced)
						}, showAdvanced ? '收起自定义地址与令牌' : '⚙️ 自定义接口地址与令牌（高级）'),
						showAdvanced ? h('div', { style: { marginTop: 6, padding: '6px 8px', background: 'var(--dsw-alias-bg-l2)', borderRadius: 6 } },
							h(Row, {
								label: 'HTTP 地址',
								control: h('input', {
									style: { ...inputStyle, width: 220 },
									value: ob.httpUrl || '',
									placeholder: 'http://127.0.0.1:3000',
									onChange: (e) => setOb({ httpUrl: e.target.value })
								}),
								note: '默认为 http://127.0.0.1:3000（由插件自动侦测）'
							}),
							h(Row, {
								label: '访问令牌',
								control: h('input', {
									style: { ...inputStyle, width: 220 },
									type: 'password',
									value: ob.accessToken || '',
									placeholder: '未配置可留空',
									onChange: (e) => setOb({ accessToken: e.target.value })
								}),
								note: 'OneBot access_token（若开启了鉴权则填）'
							})
						) : null
					)
				) : null
			)

			return h('div', null,
				h(Row, { label: '同步到手机', control: modeSelect, note: note }),
				chatSelect ? h(Row, { label: '同步到', control: chatSelect }) : null,
				followNote,
				oneBotSection)
		}

		function TargetBox(props) {
			const { cfg, patch } = props
			const inboxOnly = Boolean(cfg.inboxOnly)

			return h('div', null,
				h('div', { style: { padding: '8px 12px', background: inboxOnly ? 'rgba(51, 156, 255, 0.12)' : 'var(--dsw-alias-bg-l2)', borderRadius: 8, border: '1px solid ' + (inboxOnly ? 'rgba(51, 156, 255, 0.35)' : 'var(--dsw-alias-border-l2)'), marginBottom: 12 } },
					h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
						h('input', {
							type: 'checkbox',
							checked: inboxOnly,
							onChange: (e) => patch({ inboxOnly: e.target.checked })
						}),
						'仅收录到「资讯收件箱」（不向任何会话或 IM 投递，无需选择会话）'
					),
					h('div', { style: { ...hintStyle, marginLeft: 22, marginTop: 4 } },
						inboxOnly
							? '已开启独立收件箱模式：采集到的资讯会直接排开陈列在侧栏「资讯收件箱」面板中，不向任何会话写消息、不发 QQ/手机，静默收录。'
							: '未开启：资讯将按下方配置正常投递至选中的会话及手机/QQ。'
					)
				),
				inboxOnly ? null : h('div', null,
					h(SessionPicker, { cfg, patch }),
					h(Divider, null),
					h(PhoneSync, { cfg, patch }),
					h(Divider, null),
					h('div', { style: hintStyle }, '推送会以「助手消息」的形式直接写进会话，不会触发模型回答、不消耗 token；会话正在跑别的轮次时这条留到下次。')
				)
			)
		}

		// ── 细线分隔：一张卡片里几个逻辑块之间留白，避免上一块的备注紧贴下一块标题 ──
		function Divider() {
			return h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2)', margin: '10px 0' } })
		}

		const chipStyle = (on) => ({
			padding: '5px 10px',
			marginRight: 6,
			marginBottom: 6,
			borderRadius: 999,
			border: '1px solid ' + (on ? 'var(--dsw-alias-border-l3)' : 'var(--dsw-alias-border-l2)'),
			background: on ? 'var(--dsw-alias-bg-l2)' : 'transparent',
			cursor: 'pointer',
			fontSize: 12,
			color: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)'
		})
		const cellInput = { ...inputStyle, height: 26 }

		// 自定义源只填网址时，名字就取域名（去掉 www）
		const domainOf = (url) => {
			try {
				return new URL(String(url || '')).hostname.replace(/^www\./i, '')
			} catch {
				return ''
			}
		}

		// ── ③ 采集 ─────────────────────────────────────────────────────
		function SourceBox(props) {
			const { cfg, patch } = props
			const deps = useAsync(() => rpc('deps.get'), [])

			const dv = deps.value || {}
			const sources = Array.isArray(cfg.sources) ? cfg.sources : []
			const customSources = sources.filter((s) => s.builtin === false)
			const builtinSources = sources.filter((s) => s.builtin !== false)

			const blockReason = (id) => {
				if (id === 'web_search') return dv.webSearch ? '' : '（宿主没提供搜索服务）'
				if (id === 'egoDirect' || id === 'egoSkill') return dv.egoRuntime ? '' : '（没装 dsh-ego-browser）'
				return ''
			}

			// 四种采集方法的文案照 0.8 之前那一版：备注四件事（结果 / token / 速度 / 资源），
			// 鼠标悬浮再补「这是什么方法、需要什么依赖、什么情况建议用」。
			const METHODS = [
				{ id: 'builtin', label: '内置免 Token 抓取', note: '结果：只有标题 · token：0 · 速度：最快（1~2 秒）· 资源：很低（只发几个网络请求）', title: '方法：直接抓公开热榜和自定义源（HTML / JSON / RSS）的原始榜单，不经过模型、也不开浏览器。建议：想最省 token、只想知道「今天有什么新事」时用它；它没有摘要，所以投递详略档位对它不起作用。' },
				{ id: 'web_search', label: 'web_search', note: '结果：标题 + 摘要 · token：较低 · 速度：快（约 20~30 秒）· 资源：低（一个子会话 + 一次搜索）', title: '方法：由子会话调用宿主接好的 web_search 搜索服务。官方 DeepSeek 模型自带搜索额度、不另收费；只有走第三方渠道（例如 CPA 反代的订阅模型）或换成第三方搜索 API 时，搜索才另外计费。建议：用官方模型、或已经配好搜索服务时优先选这个。' },
				{ id: 'egoDirect', label: 'dsh-ego-browser 插件直连', note: '结果：最详细（会点进正文）· token：最高 · 速度：慢（约 1~2 分钟）· 资源：高（真开浏览器、逐条读页面）', title: '方法：子会话按常规 ego 流程开浏览器，一步步读搜索结果页的快照，必要时点进正文补要点。需要先装 dsh-ego-browser 插件。建议：用第三方模型、调不了 web_search 时用它——例如 CPA 反代 Antigravity 渠道的 Gemini 订阅模型，走这条路不用再付搜索费；需要详细内容的场景也适合。' },
				{ id: 'egoSkill', label: 'dsh-ego-browser 插件脚本模式', note: '结果：标题 + 摘要 · token：中（脚本一次跑通时更低）· 速度：较慢（约 1~2 分钟）· 资源：中（开浏览器，但不逐页读）', title: '方法：子会话只跑一段 ego_script 单脚本，一次从搜索结果页取回列表；脚本随插件自带，不依赖注入。需要先装 dsh-ego-browser 插件。建议：场景和「插件直连」相同，脚本能一次跑通时更省 token；取回的内容不够细时会自动升级到直连。' }
			]
			// 详略档位只管「每条写多细」，条数一律看「每次推送条数」。任何档位都不带链接。
			const DETAIL_OPTIONS = [
				{ value: 'low', label: '低', note: '只有标题' },
				{ value: 'medium', label: '中', note: '标题 + 一句摘要' },
				{ value: 'high', label: '高', note: '标题 + 两三句要点' }
			]

			const methodRows = METHODS.map((m) => {
				const on = cfg.method === m.id
				const reason = blockReason(m.id)
				return h('div', {
					key: m.id,
					style: {
						padding: '8px 10px',
						marginBottom: 6,
						borderRadius: 6,
						border: '1px solid ' + (on ? '#339CFF' : 'var(--dsw-alias-border-l2)'),
						background: on ? 'rgba(51, 156, 255, 0.12)' : 'transparent',
						boxShadow: on ? 'inset 0 0 0 1px rgba(51, 156, 255, 0.35)' : 'none',
						cursor: reason ? 'default' : 'pointer',
						opacity: reason ? 0.5 : 1
					},
					title: m.title,
					onClick: reason ? undefined : () => patch({ method: m.id })
				},
					h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
						h('span', { style: { fontSize: 13, fontWeight: on ? 600 : 400, color: on ? '#339CFF' : 'var(--dsw-alias-label-primary)' } }, m.label),
						on ? h('span', { style: { fontSize: 11, lineHeight: '16px', padding: '0 6px', borderRadius: 999, background: '#339CFF', color: '#fff' } }, '已选') : null,
						reason ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, reason) : null),
					h('div', { style: { ...hintStyle, marginTop: 2 } }, m.note))
			})

			const replaceSources = (next) => patch({ sources: next })
			const updateSource = (id, obj) => replaceSources(sources.map((s) => (s.id === id ? { ...s, ...obj } : s)))
			const removeSource = (id) => replaceSources(sources.filter((s) => s.id !== id))
			const toggleSource = (id) => replaceSources(sources.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)))
			const addSource = () => replaceSources(sources.concat([{
				id: 'custom-' + Date.now() + '-' + Math.random().toString(16).slice(2, 6),
				name: '',
				url: '',
				follow: 'auto',
				enabled: true,
				builtin: false
			}]))

			// 自定义源二选一；点「追加」时顺手把老配置的 method='custom' 迁回采集中枢，否则点了界面没反应
			const sourcesMode = (cfg.sourcesMode === 'only' || cfg.method === 'custom') ? 'only' : 'append'
			const setSourcesMode = (mode) => {
				if (mode === 'append' && cfg.method === 'custom') patch({ sourcesMode: 'append', method: 'builtin' })
				else patch({ sourcesMode: mode })
			}

			return h('div', null,
				h(Row, {
					label: '资讯采集总开关',
					control: toggleBtn(cfg.collectEnabled !== false, () => patch({ collectEnabled: !(cfg.collectEnabled !== false) }), '☑ 开启', '☐ 关闭'),
					note: '控制是否主动检索网络新闻与自定义源；关闭后仅推送图库或休眠'
				}),
				h(Divider, null),
				h('div', { style: rowStyle }, h('span', { style: labelStyle }, '采集方法')),
				h('div', { style: { paddingLeft: 4 } }, methodRows),
				h(Divider, null),

				h('div', { style: rowStyle }, h('span', { style: labelStyle }, '投递详略程度')),
				h('div', { style: wrapRow },
					DETAIL_OPTIONS.map((o) => {
						const on = (cfg.detail || 'medium') === o.value
						return h('button', { key: o.value, style: on ? buttonStyle : buttonGhost, onClick: () => patch({ detail: o.value }) }, o.label + ' · ' + o.note)
					})),
				h('div', { style: hintStyle },
					'这三档只决定每条写多细，不决定条数；条数一律看下面的「每次推送条数」。三档都不带链接。',
					h('br'),
					'内置免 Token 抓取 / 自定义源：抓来的热榜本身只有标题，只有顺链接补来的文章带摘要，摘要按档位长短裁剪。',
					h('br'),
					'web_search / 插件脚本模式：只改摘要长短，搜索次数不变；插件直连影响最大——高档会点进正文补要点，token 最高。'),
				h(Divider, null),

				h(NumRow, {
					label: '每次推送条数',
					value: numOr(cfg.maxEntriesPerRun, 3),
					min: 1,
					max: 20,
					note: '所有采集方法都按这个条数推送，1~20 条',
					onChange: (n) => patch({ maxEntriesPerRun: n })
				}),
				h('div', { style: rowStyle }, h('span', { style: labelStyle }, '自带热榜')),
				h('div', { style: wrapList }, builtinSources.map((s) => h('label', { key: s.id, style: chipStyle(s.enabled) },
					h('input', { type: 'checkbox', checked: Boolean(s.enabled), onChange: () => toggleSource(s.id) }),
					s.name))),
				h('div', { style: rowStyle }, h('span', { style: labelStyle }, '自定义源')),
				h('div', { style: wrapRow },
					tabButton(sourcesMode === 'append', '追加到搜索', () => setSourcesMode('append')),
					tabButton(sourcesMode === 'only', '只用自定义源', () => setSourcesMode('only')),
					h('span', { style: hintStyle }, sourcesMode === 'append'
						? '采集方法出结果后，再把自定义源里的新条目补进去'
						: '只跑下面这些网址，不跑采集方法、失败也不回退')),
				customSources.length === 0
					? h('div', { style: hintStyle }, '还没填自定义源；不填就只用自带热榜。')
					: customSources.map((s) => h('div', { key: s.id, style: wrapRow },
						h('span', { style: { minWidth: 120, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, domainOf(s.url) || '（网址待填）'),
						h('input', {
							style: { ...cellInput, width: 320 },
							value: s.url || '',
							placeholder: 'https://example.com/feed 或文章页',
							onChange: (e) => updateSource(s.id, { url: e.target.value })
						}),
						h('button', { style: buttonGhost, onClick: () => removeSource(s.id) }, '删除'))),
				h('div', { style: wrapRow },
					h('button', { style: buttonGhost, onClick: addSource }, '＋ 添加网址'),
					h('span', { style: hintStyle }, '自动识别网页格式（JSON / RSS / 网页都行），不用填取值路径；条目不够时会自动补几篇同站文章。')),
				h(Divider, null),

				h(Row, {
					label: '回退链',
					control: toggleBtn(cfg.fallbackChain !== false, () => patch({ fallbackChain: !(cfg.fallbackChain !== false) }), '☑ 开', '☐ 关'),
					note: '首选失败按序降级：直连 → 脚本模式 → web_search → 内置（不会回退到自定义源）'
				}),
				h(Row, {
					label: 'ego 跑完关闭浏览器',
					control: toggleBtn(cfg.ego?.closeBrowserAfterRun !== false, () => patch({ ego: { ...(cfg.ego || {}), closeBrowserAfterRun: !(cfg.ego?.closeBrowserAfterRun !== false) } }), '☑ 关', '☐ 不关'),
					note: '走直连或脚本模式时，收尾把后台浏览器关掉'
				}),
				h(NumRow, {
					label: 'ego 超时（秒）',
					value: numOr(cfg.ego?.timeoutSec, 90),
					min: 10,
					max: 600,
					note: '超过这个时长就中止这次运行',
					onChange: (n) => patch({ ego: { ...(cfg.ego || {}), timeoutSec: n } })
				}))
		}

		// ── ③-2 图库采集子菜单 ──────────────────────────────────────────
		function GalleryBox(props) {
			const { cfg, patch } = props
			const gCfg = cfg.gallery || {
				enabled: true,
				maxImagesPerRun: 1,
				mode: 'mixed',
				requestTriggerEnabled: true,
				lolicon: { enabled: true, rating: 'general', timeRange: '2y', customDate: '', tags: '', num: 1 },
				yande: { enabled: true, rating: 'general', sort: 'score', timeRange: '2y', customDate: '', tags: '', num: 1 },
				danbooru: { enabled: true, rating: 'general', sort: 'rank', timeRange: '2y', customDate: '', tags: '', num: 1 }
			}

			const [testStates, setTestStates] = React.useState({})
			const [previewImg, setPreviewImg] = React.useState(null)

			const setG = (next) => patch({ gallery: { ...gCfg, ...next } })
			const setSub = (key, next) => setG({ [key]: { ...(gCfg[key] || {}), ...next } })

			const doTest = async (sourceId) => {
				setTestStates(prev => ({ ...prev, [sourceId]: { testing: true, msg: '正在请求测试图片…' } }))
				try {
					const res = await rpc('gallery.test', { sourceId, cfg: gCfg[sourceId] || {} })
					if (res && res.ok && res.image) {
						setTestStates(prev => ({ ...prev, [sourceId]: { testing: false, msg: `✅ ${res.note || '测试成功'}` } }))
						setPreviewImg(res.image)
					} else {
						setTestStates(prev => ({ ...prev, [sourceId]: { testing: false, msg: `⚠️ ${res?.error || '未返回图片'}` } }))
					}
				} catch (e) {
					setTestStates(prev => ({ ...prev, [sourceId]: { testing: false, msg: `❌ 失败: ${e.message || '未知错误'}` } }))
				}
				setTimeout(() => {
					setTestStates(prev => ({ ...prev, [sourceId]: { ...(prev[sourceId] || {}), msg: '' } }))
				}, 6000)
			}

			// 中文分级选项
			const CHINESE_RATINGS = [
				{ id: 'general', label: '全年龄常规 (Safe/General)' },
				{ id: 'sensitive', label: '轻微敏感/微色 (Sensitive)' },
				{ id: 'questionable', label: '限制级/擦边 (Questionable)' },
				{ id: 'explicit', label: '完全成人向 (Explicit/R-18)' },
				{ id: 'all', label: '全部随机 (All)' }
			]

			// 下拉式时间筛选选项
			const TIME_RANGE_SELECT_OPTIONS = [
				{ id: '1y', label: '近 1 年 (2025~2026 最新推荐)' },
				{ id: '2y', label: '近 2 年 (2024~2026 丰富优质)' },
				{ id: '3y', label: '近 3 年 (2023~2026 经典兼备)' },
				{ id: 'custom', label: '自定义起始日期 (精确筛选)' },
				{ id: 'all', label: '全部历史 (不限发布时间)' }
			]

			// Yande.re 榜单/排序选项
			const YANDE_SORT_OPTIONS = [
				{ id: 'score', label: '⭐ 高赞榜 (Score/得分排行)' },
				{ id: 'fav', label: '💖 高收藏榜 (Fav/收藏排行)' },
				{ id: 'recent', label: '⏱️ 最新发布 (Recent/随机翻页)' },
				{ id: 'random', label: '🎲 随机探索 (Random/完全随机)' }
			]

			// Danbooru 榜单/排序选项
			const DANBOORU_SORT_OPTIONS = [
				{ id: 'rank', label: '🔥 热门趋势榜 (Rank/日周榜推荐)' },
				{ id: 'score', label: '⭐ 高赞榜 (Score/点赞排序)' },
				{ id: 'favcount', label: '💖 高收藏榜 (Favcount/收藏排序)' },
				{ id: 'recent', label: '⏱️ 最新发布 (Recent/随机翻页)' },
				{ id: 'random', label: '🎲 随机探索 (Random/完全随机)' }
			]

			// 计算各渠道开启时的图片累加总数
			const totalImages = [
				gCfg.lolicon?.enabled !== false ? (Number(gCfg.lolicon?.num) || 1) : 0,
				gCfg.yande?.enabled !== false ? (Number(gCfg.yande?.num) || 1) : 0,
				gCfg.danbooru?.enabled !== false ? (Number(gCfg.danbooru?.num) || 1) : 0
			].reduce((a, b) => a + b, 0)

			// 时间筛选下拉渲染辅助
			const renderTimeSelector = (sourceKey, currentVal, customDateVal) => {
				const isCustom = (currentVal || '2y') === 'custom'
				return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
					h('select', {
						style: { ...inputStyle, width: 220, padding: '0 8px' },
						value: currentVal || '2y',
						onChange: (e) => setSub(sourceKey, { timeRange: e.target.value })
					}, TIME_RANGE_SELECT_OPTIONS.map(opt => h('option', { key: opt.id, value: opt.id }, opt.label))),
					isCustom ? h('input', {
						type: 'date',
						style: { ...inputStyle, width: 150, padding: '0 6px' },
						value: customDateVal || '2024-01-01',
						onChange: (e) => setSub(sourceKey, { customDate: e.target.value })
					}) : null
				)
			}

			return h('div', null,
				h(Row, {
					label: '图库采集总开关',
					control: toggleBtn(gCfg.enabled !== false, () => setG({ enabled: !(gCfg.enabled !== false) }), '☑ 开启', '☐ 关闭'),
					note: '一键启用/停用二次元动漫插画与色图抓取推送'
				}),
				h('div', {
					style: {
						margin: '6px 0 10px 0',
						padding: '8px 12px',
						borderRadius: 6,
						background: 'rgba(235, 144, 58, 0.1)',
						border: '1px solid rgba(235, 144, 58, 0.3)',
						fontSize: 12,
						lineHeight: 1.5,
						color: '#eb903a'
					}
				}, '⚠️ 注意：如果是连接 QQ 机器人投递或者 NapCatQQ 投递，频繁发图或发送色图可能会触发 QQ 官方风控，请谨慎开启或合理控制频率。'),
				h(Row, {
					label: '群内搜图/点图互动',
					control: toggleBtn(gCfg.requestTriggerEnabled !== false, () => setG({ requestTriggerEnabled: !(gCfg.requestTriggerEnabled !== false) }), '☑ 启用', '☐ 停用'),
					note: '群友在 QQ 群发送「图库采集：找XXX」或「点图：找XXX」时，机器人自动识别并推图回复'
				}),
				h(Divider, null),

				h(Row, {
					label: '当前推送图片总计',
					control: h('span', { style: { fontWeight: 600, color: '#3fb950', fontSize: 13 } }, `${totalImages} 张图片 / 次`),
					note: '由下方各启用图源设置的「出图张数」自动累加求和'
				}),
				h(Divider, null),

				// 1. Lolicon (Pixiv)
				h('div', {
					style: {
						padding: '10px 12px',
						marginBottom: 10,
						borderRadius: 8,
						border: '1px solid var(--dsw-alias-border-l2)',
						background: 'var(--dsw-alias-bg-l2, rgba(255,255,255,0.03))'
					}
				},
					h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 } },
						h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
							h('span', { style: { fontWeight: 600, fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, '🌸 Lolicon API (Pixiv 热门/色图)'),
							h('span', { style: { fontSize: 11, padding: '1px 6px', borderRadius: 4, background: '#3fb950', color: '#fff' } }, 'Pixiv直连反代')
						),
						h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
							h('button', {
								style: { ...buttonGhost, height: 24, fontSize: 11, padding: '0 8px' },
								onClick: () => doTest('lolicon'),
								disabled: testStates.lolicon?.testing
							}, testStates.lolicon?.testing ? '测试中…' : '🧪 测试拉取'),
							toggleBtn(gCfg.lolicon?.enabled !== false, () => setSub('lolicon', { enabled: !(gCfg.lolicon?.enabled !== false) }), '☑ 启用', '☐ 禁用')
						)
					),
					testStates.lolicon?.msg ? h('div', { style: { ...hintStyle, color: testStates.lolicon.msg.startsWith('✅') ? '#3fb950' : '#e5534b' } }, testStates.lolicon.msg) : null,
					h(NumRow, {
						label: '本源出图张数',
						value: numOr(gCfg.lolicon?.num, 1),
						min: 1,
						max: 5,
						note: '该渠道每次采集抽选张数（1~5 张）',
						onChange: (n) => setSub('lolicon', { num: n })
					}),
					h(Row, {
						label: '内容分级',
						control: h('div', { style: wrapRow },
							[
								{ id: 'general', label: '全年龄常规 (Safe)' },
								{ id: 'explicit', label: '完全成人向 (R-18)' },
								{ id: 'all', label: '全部混合 (All)' }
							].map(opt => tabButton(
								(gCfg.lolicon?.rating || 'general') === opt.id,
								opt.label,
								() => setSub('lolicon', { rating: opt.id })
							))),
						note: '按 Pixiv 官方标记分级，纯色图选 R-18，安全插画选全年龄'
					}),
					h(Row, {
						label: '时间筛选 (下拉式)',
						control: renderTimeSelector('lolicon', gCfg.lolicon?.timeRange, gCfg.lolicon?.customDate),
						note: '限定作品上传时间，支持下拉选择或直接指定起始年月日'
					}),
					h(Row, {
						label: '标签筛选 (Tags)',
						control: h('input', {
							style: { ...inputStyle, width: 280 },
							value: gCfg.lolicon?.tags || '',
							placeholder: '例如: 白毛, 黑丝, 崩坏星穹铁道, 碧蓝档案',
							onChange: (e) => setSub('lolicon', { tags: e.target.value })
						}),
						note: '【标签格式】：支持中文或日文标签，多个标签用逗号隔开；留空表示全库随机'
					})
				),

				// 2. Yande.re (Booru)
				h('div', {
					style: {
						padding: '10px 12px',
						marginBottom: 10,
						borderRadius: 8,
						border: '1px solid var(--dsw-alias-border-l2)',
						background: 'var(--dsw-alias-bg-l2, rgba(255,255,255,0.03))'
					}
				},
					h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 } },
						h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
							h('span', { style: { fontWeight: 600, fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, '⚡ Yande.re API (Booru 高清二次元插画)'),
							h('span', { style: { fontSize: 11, padding: '1px 6px', borderRadius: 4, background: '#3fb950', color: '#fff' } }, '超高清大图')
						),
						h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
							h('button', {
								style: { ...buttonGhost, height: 24, fontSize: 11, padding: '0 8px' },
								onClick: () => doTest('yande'),
								disabled: testStates.yande?.testing
							}, testStates.yande?.testing ? '测试中…' : '🧪 测试拉取'),
							toggleBtn(gCfg.yande?.enabled !== false, () => setSub('yande', { enabled: !(gCfg.yande?.enabled !== false) }), '☑ 启用', '☐ 禁用')
						)
					),
					testStates.yande?.msg ? h('div', { style: { ...hintStyle, color: testStates.yande.msg.startsWith('✅') ? '#3fb950' : '#e5534b' } }, testStates.yande.msg) : null,
					h(NumRow, {
						label: '本源出图张数',
						value: numOr(gCfg.yande?.num, 1),
						min: 1,
						max: 5,
						note: '该渠道每次采集抽选张数（1~5 张）',
						onChange: (n) => setSub('yande', { num: n })
					}),
					h(Row, {
						label: '榜单与排序',
						control: h('select', {
							style: { ...inputStyle, width: 260, padding: '0 8px' },
							value: gCfg.yande?.sort || 'score',
							onChange: (e) => setSub('yande', { sort: e.target.value })
						}, YANDE_SORT_OPTIONS.map(opt => h('option', { key: opt.id, value: opt.id }, opt.label))),
						note: '支持高赞评分榜(Score)、高收藏榜(Fav)与最新发布，配合时间筛选获取近年最热门高品质画作'
					}),
					h(Row, {
						label: '内容分级',
						control: h('div', { style: wrapRow },
							[
								{ id: 'general', label: '全年龄常规 (Safe)' },
								{ id: 'questionable', label: '限制级/擦边 (Questionable)' },
								{ id: 'explicit', label: '完全成人向 (Explicit)' },
								{ id: 'all', label: '全部随机 (All)' }
							].map(opt => tabButton(
								(gCfg.yande?.rating || 'general') === opt.id,
								opt.label,
								() => setSub('yande', { rating: opt.id })
							))),
						note: 'Safe 为壁纸向；Questionable 略带性感擦边；Explicit 为纯色图'
					}),
					h(Row, {
						label: '时间筛选 (下拉式)',
						control: renderTimeSelector('yande', gCfg.yande?.timeRange, gCfg.yande?.customDate),
						note: '【过滤老图】：推荐选择近 1~2 年，彻底告别十年前的泛黄扫图'
					}),
					h(Row, {
						label: '标签筛选 (Tags)',
						control: h('input', {
							style: { ...inputStyle, width: 280 },
							value: gCfg.yande?.tags || '',
							placeholder: '例如: maid thighhighs solo blue_archive',
							onChange: (e) => setSub('yande', { tags: e.target.value })
						}),
						note: '【标签格式】：Booru 规范英文标签（小写、单词用下划线 _，多个用空格隔开）'
					})
				),

				// 3. Danbooru
				h('div', {
					style: {
						padding: '10px 12px',
						marginBottom: 10,
						borderRadius: 8,
						border: '1px solid var(--dsw-alias-border-l2)',
						background: 'var(--dsw-alias-bg-l2, rgba(255,255,255,0.03))'
					}
				},
					h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 } },
						h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
							h('span', { style: { fontWeight: 600, fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, '🌐 Danbooru API (全球最大动漫图库)'),
							h('span', { style: { fontSize: 11, padding: '1px 6px', borderRadius: 4, background: '#3fb950', color: '#fff' } }, '更新最频繁')
						),
						h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
							h('button', {
								style: { ...buttonGhost, height: 24, fontSize: 11, padding: '0 8px' },
								onClick: () => doTest('danbooru'),
								disabled: testStates.danbooru?.testing
							}, testStates.danbooru?.testing ? '测试中…' : '🧪 测试拉取'),
							toggleBtn(gCfg.danbooru?.enabled !== false, () => setSub('danbooru', { enabled: !(gCfg.danbooru?.enabled !== false) }), '☑ 启用', '☐ 禁用')
						)
					),
					testStates.danbooru?.msg ? h('div', { style: { ...hintStyle, color: testStates.danbooru.msg.startsWith('✅') ? '#3fb950' : '#e5534b' } }, testStates.danbooru.msg) : null,
					h(NumRow, {
						label: '本源出图张数',
						value: numOr(gCfg.danbooru?.num, 1),
						min: 1,
						max: 5,
						note: '该渠道每次采集抽选张数（1~5 张）',
						onChange: (n) => setSub('danbooru', { num: n })
					}),
					h(Row, {
						label: '榜单与排序',
						control: h('select', {
							style: { ...inputStyle, width: 260, padding: '0 8px' },
							value: gCfg.danbooru?.sort || 'rank',
							onChange: (e) => setSub('danbooru', { sort: e.target.value })
						}, DANBOORU_SORT_OPTIONS.map(opt => h('option', { key: opt.id, value: opt.id }, opt.label))),
						note: '支持日/周趋势排行榜(Rank)、高赞榜(Score)、高收藏榜(Favcount)等，在精选池内随机翻页抽选，彻底避免重复'
					}),
					h(Row, {
						label: '内容分级',
						control: h('div', { style: wrapRow },
							CHINESE_RATINGS.map(opt => tabButton(
								(gCfg.danbooru?.rating || 'general') === opt.id,
								opt.label,
								() => setSub('danbooru', { rating: opt.id })
							))),
						note: 'Danbooru 官方精确四级分级：常规 / 轻微敏感(微色) / 限制级擦边 / 完全成人向'
					}),
					h(Row, {
						label: '时间筛选 (下拉式)',
						control: renderTimeSelector('danbooru', gCfg.danbooru?.timeRange, gCfg.danbooru?.customDate),
						note: '按投稿时间筛选，支持下拉范围或指定年月日起始'
					}),
					h(Row, {
						label: '标签筛选 (Tags)',
						control: h('input', {
							style: { ...inputStyle, width: 280 },
							value: gCfg.danbooru?.tags || '',
							placeholder: '例如: 1girl blue_hair highres',
							onChange: (e) => setSub('danbooru', { tags: e.target.value })
						}),
						note: '【标签格式】：Booru 规范英文标签（小写下划线，空格隔开；建议 1~2 个关键 Tag 如 1girl）'
					})
				),

				// 实时测试预览卡片
				previewImg ? h('div', {
					style: {
						marginTop: 12,
						padding: 12,
						borderRadius: 8,
						border: '1px solid #339CFF',
						background: 'rgba(51, 156, 255, 0.08)'
					}
				},
					h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 } },
						h('span', { style: { fontWeight: 600, fontSize: 13, color: '#339CFF' } }, `🖼️ 采样预览 · ${previewImg.sourceName} - ${previewImg.title}`),
						h('button', { style: { ...buttonGhost, height: 22, padding: '0 6px', fontSize: 11 }, onClick: () => setPreviewImg(null) }, '关闭预览')
					),
					h('div', { style: { textAlign: 'center', maxHeight: 300, overflow: 'hidden', borderRadius: 6, background: '#000' } },
						h('img', {
							src: previewImg.previewUrl || previewImg.url,
							alt: previewImg.title,
							style: { maxWidth: '100%', maxHeight: 290, objectFit: 'contain' }
						})
					),
					h('div', { style: { ...hintStyle, marginTop: 6, display: 'flex', justifyContent: 'space-between' } },
						h('span', null, `分级: ${previewImg.rating} | 画师: ${previewImg.author || '未知'}`),
						h('a', { href: previewImg.url, target: '_blank', rel: 'noreferrer', style: { color: '#339CFF', textDecoration: 'none' } }, '查看高清原图 ↗')
					)
				) : null
			)
		}

		// ── ④ 推送风格 ─────────────────────────────────────────────────
		function StyleBox(props) {
			const { cfg, patch } = props
			const deps = useAsync(() => rpc('deps.get'), [])
			const dv = deps.value || {}

			const interests = Array.isArray(cfg.interests) ? cfg.interests : []
			const extraInterests = interests.filter((i) => ALL_INTERESTS.indexOf(i) < 0)
			const chips = ALL_INTERESTS.concat(extraInterests)
			const [newInterest, setNewInterest] = React.useState('')

			const toggleInterest = (item) => {
				const next = interests.slice()
				const idx = next.indexOf(item)
				if (idx >= 0) next.splice(idx, 1)
				else next.push(item)
				patch({ interests: next })
			}
			const addInterest = () => {
				const v = newInterest.trim()
				if (!v) return
				if (interests.indexOf(v) < 0) patch({ interests: interests.concat([v]) })
				setNewInterest('')
			}

			const personaMode = ['auto', 'on', 'off'].includes(cfg.persona?.mode) ? cfg.persona.mode : 'auto'
			// 三档的说明就是用户自己写的那三句，不扩写成大段
			const PERSONA_OPTIONS = [
				{ id: 'auto', label: '自动', note: 'ai 带人设时根据人设输出，否则直接输出内容。' },
				{ id: 'on', label: '总是', note: '按照当前会话人设输出，如无人设则交由 ai 自由发挥。' },
				{ id: 'off', label: '关闭', note: '直接输出内容。' }
			]
			const personaNames = (dv.persona && Array.isArray(dv.persona.names) ? dv.persona.names : []).join(' / ')

			return h('div', null,
				h('div', { style: rowStyle }, h('span', { style: labelStyle }, '人设语气')),
				h('div', { style: wrapRow }, PERSONA_OPTIONS.map((o) => tabButton(personaMode === o.id, o.label, () => patch({ persona: { ...(cfg.persona || {}), mode: o.id } })))),
				h('div', { style: hintStyle }, PERSONA_OPTIONS.map((o, i) => h(React.Fragment, { key: o.id }, i > 0 ? h('br') : null, o.label + '：' + o.note))),
				h('div', { style: hintStyle }, personaNames
					? '现在：检测到人设（' + personaNames + '），选「自动」时这条推送由它来写。'
					: '现在：没检测到人设，选「自动」时投纯信息。'),
				h(Divider, null),

				h('div', { style: rowStyle }, h('span', { style: labelStyle }, '兴趣范围')),
				h('div', { style: wrapList }, chips.map((item) => {
					const on = interests.indexOf(item) >= 0
					return h('label', { key: item, style: chipStyle(on) },
						h('input', { type: 'checkbox', checked: on, onChange: () => toggleInterest(item) }),
						'{' + item + '}')
				})),
				h('div', { style: wrapRow },
					h('input', {
						style: { ...cellInput, width: 160 },
						value: newInterest,
						placeholder: '自定义兴趣',
						onChange: (e) => setNewInterest(e.target.value),
						onKeyDown: (e) => { if (e.key === 'Enter') addInterest() }
					}),
					h('button', { style: buttonGhost, onClick: addInterest }, '添加'),
					h('span', { style: hintStyle }, '勾选的兴趣会拼进查询词，也参与结果排序。')),
				h(Divider, null),

				h(Row, {
					label: '查询词模板',
					control: h('input', {
						style: { ...inputStyle, width: 320 },
						value: cfg.queryTemplate || '',
						onChange: (e) => patch({ queryTemplate: e.target.value })
					}),
					note: '{interest} 替换为兴趣项，{date} 替换为当天日期'
				}))
		}

		// ── ④ 频率与运行 ───────────────────────────────────────────────
		// 时段编辑器：一段一行，随便加；填错了当场标出来，不往宿主存半截。
		const WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/
		const isValidWindow = (text) => {
			const t = String(text || '').trim()
			return t !== '' && WINDOW_RE.test(t)
		}
		const formatBad = (n) => (n === 1 ? '有 1 段格式不对，改好才会保存' : '有 ' + n + ' 段格式不对，改好才会保存')

		function WindowEditor(props) {
			const { cfg, patch } = props
			const saved = (Array.isArray(cfg.windows) ? cfg.windows : []).filter(Boolean)
			const savedKey = saved.join('\n')
			const [rows, setRows] = React.useState(saved.length > 0 ? saved : [''])

			// 宿主侧（别处改过 / 首次加载）变了才同步，避免把自己正在输入的行冲掉
			React.useEffect(() => {
				setRows((prev) => {
					const mine = prev.map((r) => String(r || '').trim()).filter(Boolean).filter(isValidWindow)
					if (mine.join('\n') === savedKey) return prev
					return savedKey ? savedKey.split('\n') : ['']
				})
			}, [savedKey])

			const errors = rows.map((r) => {
				const t = String(r || '').trim()
				if (!t) return null
				return isValidWindow(t) ? null : '格式应为 08:00-23:30'
			})
			const badCount = errors.filter(Boolean).length

			const commit = (next) => {
				const list = (next || rows).map((r) => String(r || '').trim()).filter(Boolean)
				if (list.some((t) => !isValidWindow(t))) return false
				if (list.join('\n') === savedKey) return true
				patch({ windows: list })
				return true
			}

			const edit = (idx, value) => {
				const next = rows.slice()
				next[idx] = value
				setRows(next)
			}
			const addRow = () => {
				if (commit() === false) return
				setRows(rows.concat(['']))
			}
			const removeRow = (idx) => {
				const next = rows.filter((_, i) => i !== idx)
				setRows(next.length > 0 ? next : [''])
				if (badCount === 0) commit(next.length > 0 ? next : [''])
			}
			const clearAll = () => {
				setRows([''])
				if (saved.length > 0) patch({ windows: [] })
			}

			const cell = (r, i) => h('div', { key: i, style: { ...rowList, gap: 6 } },
				h('input', {
					style: { ...inputStyle, width: 140, borderColor: errors[i] ? '#e5534b' : undefined },
					value: r,
					placeholder: '08:00-23:30',
					onChange: (e) => edit(i, e.target.value),
					onBlur: () => commit(),
					onKeyDown: (e) => { if (e.key === 'Enter') commit() }
				}),
				errors[i] ? h('span', { style: errStyle }, errors[i]) : null,
				h('button', {
					style: { ...buttonGhost, height: 24, padding: '0 8px' },
					onClick: () => removeRow(i)
				}, '删除'))

			return h('div', null,
				h('div', { style: wrapRow }, h('span', { style: labelStyle }, '时段配置'),
					h('span', { style: hintStyle }, '可加多段；留空 = 全天')),
				rows.map(cell),
				h('div', { style: wrapRow },
					h('button', { style: buttonGhost, onClick: addRow }, '＋ 添加时段'),
					h('button', { style: buttonGhost, onClick: clearAll }, '清空（全天）'),
					h('span', { style: badCount > 0 ? errStyle : hintStyle },
						badCount > 0
							? (formatBad(badCount))
							: (saved.length === 0 ? '当前：全天' : '当前生效：' + saved.join('、')))),
				h('div', { style: hintStyle }, '跨午夜可以直接写 22:00-02:00；填错的行不会保存，改好会自动生效'))
		}

		function TimingBox(props) {
			const { cfg, patch } = props

			return h('div', null,
				h(Row, {
					label: '运行模式',
					control: h('div', { style: wrapList },
						tabButton(cfg.mode === 'continuous', '持续运行', () => patch({ mode: 'continuous' })),
						tabButton(cfg.mode === 'idle-only', '闲时运行', () => patch({ mode: 'idle-only' }))),
					note: '持续：未回座则按投递冷却重复；闲时：每次离席只投一条，回座解锁'
				}),
				h(Divider, null),
				h(NumRow, {
					label: '闲置阈值（分钟）',
					value: numOr(cfg.idleThresholdMin, 60),
					min: 1,
					max: 1440,
					note: '键鼠无操作超过该时长才开始执行',
					onChange: (n) => patch({ idleThresholdMin: n })
				}),
				h(NumRow, {
					label: '轮询间隔（秒）',
					value: numOr(cfg.pollSec, 60),
					min: 5,
					max: 3600,
					note: '多久检查一次闲置状态；改完立即生效',
					onChange: (n) => patch({ pollSec: n })
				}),
				h(NumRow, {
					label: '投递冷却（分钟）',
					value: numOr(cfg.minGapMin, 120),
					min: 1,
					max: 1440,
					note: '两次投递之间的最小间隔',
					onChange: (n) => patch({ minGapMin: n })
				}),
				h(NumRow, {
					label: '每日表达上限（条）',
					value: numOr(cfg.maxPerDay, 6),
					min: 1,
					max: 100,
					note: '当天达到上限后停止，次日重置',
					onChange: (n) => patch({ maxPerDay: n })
				}),
				h(Divider, null),
				h(WindowEditor, { cfg, patch }),
				h(Divider, null),
				h(Row, {
					label: '总开关',
					control: toggleBtn(cfg.enabled !== false, () => patch({ enabled: !(cfg.enabled !== false) }), '☑ 工作', '☐ 歇一下'),
					note: '关闭后完全不执行'
				}))
		}

		// ── ⑤ 会话状态系统弹窗通知 ───────────────────────────────────────────────
		function DesktopNotifyBox(props) {
			const { cfg, patch } = props
			const dCfg = cfg.desktopNotify || {
				enabled: false,
				onComplete: true,
				onActionRequired: true,
				onError: true,
				sound: true
			}
			const [testState, setTestState] = React.useState({ testing: false, msg: '' })

			const set = (next) => patch({ desktopNotify: { ...dCfg, ...next } })

			const doTest = async () => {
				setTestState({ testing: true, msg: '正在发送测试弹窗…' })
				try {
					const res = await rpc('notify.test')
					if (res && res.sent) {
						setTestState({ testing: false, msg: '✅ 已发出系统通知，请查看屏幕右下角' })
					} else {
						setTestState({ testing: false, msg: '⚠️ 通知调用未成功' })
					}
				} catch (e) {
					setTestState({ testing: false, msg: '❌ 发送失败：' + (e.message || '未知原因') })
				}
				setTimeout(() => setTestState((s) => ({ ...s, msg: '' })), 4000)
			}

			return h('div', null,
				h(Row, {
					label: '弹窗总开关',
					control: toggleBtn(dCfg.enabled, () => set({ enabled: !dCfg.enabled }), '☑ 开启', '☐ 关闭'),
					note: 'AI 回复完成或需要用户操作时，弹出 Windows 桌面系统通知'
				}),
				h(Divider, null),
				h(Row, {
					label: '回复完成通知',
					control: toggleBtn(dCfg.onComplete !== false, () => set({ onComplete: !(dCfg.onComplete !== false) }), '☑ 开启', '☐ 关闭'),
					note: '一轮思考与回复结束时提醒'
				}),
				h(Row, {
					label: '等待操作通知',
					control: toggleBtn(dCfg.onActionRequired !== false, () => set({ onActionRequired: !(dCfg.onActionRequired !== false) }), '☑ 开启', '☐ 关闭'),
					note: 'AI 提出确认问题（提问卡片）或需要授权审批时即时提醒'
				}),
				h(Row, {
					label: '运行出错通知',
					control: toggleBtn(dCfg.onError !== false, () => set({ onError: !(dCfg.onError !== false) }), '☑ 开启', '☐ 关闭'),
					note: '模型调用失败或会话发生异常时提醒'
				}),
				h(Row, {
					label: '提示音',
					control: toggleBtn(dCfg.sound !== false, () => set({ sound: !(dCfg.sound !== false) }), '☑ 提示音', '☐ 静音'),
					note: '弹窗出现时是否播放系统通知提示音'
				}),
				h(Divider, null),
				h('div', { style: wrapRow },
					h('button', {
						style: { ...buttonGhost, cursor: testState.testing ? 'not-allowed' : 'pointer' },
						onClick: doTest,
						disabled: testState.testing
					}, '发送测试弹窗'),
					testState.msg ? h('span', { style: hintStyle }, testState.msg) : null),
				h('div', { style: hintStyle }, '采用 Windows 系统原生 Toast 通知，切到其他窗口或后台工作时亦可提醒。'))
		}

		// ── ⑥ 账单 ─────────────────────────────────────────────────────
		function BillBox() {
			const [tab, setTab] = React.useState('today')
			const [reload, setReload] = React.useState(0)
			const summary = useAsync(() => rpc('bill.summary'), [reload])
			const runs = useAsync(() => rpc('bill.runs', { limit: 30 }), [reload])
			const [confirmClear, setConfirmClear] = React.useState(false)
			const [clearMsg, setClearMsg] = React.useState('')
			const [openId, setOpenId] = React.useState(null)

			const buckets = summary.value || {}
			const bucket = buckets[tab] || buckets.today || { runs: 0, ok: 0, tokens: {} }
			const tokens = bucket.tokens || {}
			const cols = [
				['次数', bucket.runs || 0],
				['成功', bucket.ok || 0],
				['输入 token', tokens.input || 0],
				['输出 token', tokens.output || 0],
				['缓存', (tokens.cacheRead || 0) + (tokens.cacheWrite || 0)],
				['思考', tokens.reasoning || 0]
			]

			const doClear = () => {
				if (!confirmClear) {
					setConfirmClear(true)
					return
				}
				rpc('bill.clear').then(() => {
					setClearMsg('已清空记录')
					setConfirmClear(false)
					setReload((n) => n + 1)
				}, (e) => {
					setClearMsg('清空失败：' + (e.message || '未知原因'))
					setConfirmClear(false)
				})
			}

			const runLine = (r) => {
				const n = (r.entries && r.entries.length) || 0
				const tk = (r.usage?.input || 0) + (r.usage?.output || 0)
				const label = METHOD_LABEL[r.method] || r.method || '内置免 Token 抓取'
				const tail = r.ok ? '已投递' : ('失败：' + (r.error || '未知原因'))
				return fmtStamp(r.at) + ' · ' + n + ' 条 · ' + tk + ' token · ' + label + ' · ' + tail + (r.test ? '（试跑）' : '')
			}

			const detail = (r) => h('div', { style: { paddingLeft: 12, paddingBottom: 6 } },
				r.fallbackFrom ? h('div', { style: hintStyle }, '降级来源：' + (METHOD_LABEL[r.fallbackFrom] || r.fallbackFrom)) : null,
				r.sourcesNote
					? h('div', { style: hintStyle }, r.sourcesNote.error
						? '自定义源：这次没读到（' + r.sourcesNote.error + '），其它源照常'
						: (r.sourcesNote.mode === 'only'
							? '自定义源：只用了自定义源'
							: '自定义源：追加了 ' + (r.sourcesNote.custom || 0) + ' 条'))
					: null,
				Array.isArray(r.trail) && r.trail.length > 0
					? h('div', { style: hintStyle }, '回退链：' + r.trail.map((t) => (METHOD_LABEL[t.from] || t.from) + ' → ' + (t.to ? (METHOD_LABEL[t.to] || t.to) : '停') + '（' + (t.reason || '未记录原因') + '）').join(' ｜ '))
					: null,
				r.text ? h('div', { style: hintStyle }, '投递原文：' + r.text) : null,
				Array.isArray(r.delivered) && r.delivered.length > 0
					? h('div', { style: hintStyle }, '投递结果：' + r.delivered.map((d) => (d.ok ? '已送达' : '失败') + '（' + String(d.id || '').slice(-8) + (d.landed ? '，已进入会话记录' : '') + (d.error ? '，' + d.error : '') + '）').join('；'))
					: null,
				r.imSync
					? h('div', { style: hintStyle }, '同步到手机：' + (Array.isArray(r.imSync.sent) && r.imSync.sent.length > 0
						? r.imSync.sent.map((s) => (s.ok ? (s.fallback ? '已改发私聊' : '已发出') : '失败') + '（' + (s.label || '对话') + (s.note ? '，' + s.note : '') + (s.error ? '，' + s.error : '') + '）').join('；')
						: (r.imSync.ok ? '已发出' : '没发出去（' + (r.imSync.error || '未知原因') + '）')))
					: null,
				(r.entries || []).map((e, i) => h('div', { key: i, style: hintStyle }, '· ' + (e.title || '') + (e.summary ? '：' + e.summary : '') + (e.url ? ' — ' + e.url : ''))),
				r.durationMs ? h('div', { style: hintStyle }, '耗时：' + Math.round(r.durationMs / 100) / 10 + 's') : null)

			const runRows = Array.isArray(runs.value) ? runs.value : []

			return h('div', null,
				h('div', { style: tabRow },
					tabButton(tab === 'today', '今天', () => setTab('today')),
					tabButton(tab === 'week', '本周', () => setTab('week')),
					tabButton(tab === 'all', '全部', () => setTab('all'))),
				h('div', { style: { ...wrapList, gap: 24 } },
					cols.map((c, i) => h('div', { key: i, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
						h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, c[0]),
						h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, String(c[1]))))),
				h('div', { style: { marginTop: 8 } },
					runRows.length === 0
						? h('div', { style: hintStyle }, '还没有运行记录。')
						: runRows.map((r) => h('div', { key: r.id },
							h('div', {
								style: { ...rowList, cursor: 'pointer', color: r.ok ? 'var(--dsw-alias-label-secondary)' : '#e5534b' },
								onClick: () => setOpenId(openId === r.id ? null : r.id)
							}, runLine(r)),
							openId === r.id ? detail(r) : null))),
				h('div', { style: wrapRow },
					h('button', { style: buttonGhost, onClick: doClear }, confirmClear ? '确认清空？' : '清空记录'),
					clearMsg ? h('span', { style: hintStyle }, clearMsg) : null),
				h('div', { style: hintStyle }, '测试运行同样计入这里的统计。只有「内置免 Token 抓取」不消耗 token；web_search、插件直连、插件脚本模式 都会消耗，其中直连（多步读页面）最费、脚本模式较省；详略档位越高，条数与摘要越长、token 也越多。'))
		}

		// ── 卡片 ───────────────────────────────────────────────────────
		function AwayNotifySection() {
			const conf = useAsync(() => rpc('config.get'), [])
			const [cfg, setCfg] = React.useState(null)
			const [save, setSave] = React.useState({ state: 'idle', msg: '' })
			const timer = React.useRef(null)
			const pending = React.useRef({})

			React.useEffect(() => {
				if (conf.value && !cfg) setCfg(conf.value)
			}, [conf.value])

			React.useEffect(() => () => clearTimeout(timer.current), [])

			const patch = (obj) => {
				setCfg((prev) => ({ ...(prev || {}), ...obj }))
				pending.current = { ...pending.current, ...obj }
				setSave({ state: 'saving', msg: '保存中…' })
				clearTimeout(timer.current)
				timer.current = setTimeout(() => {
					const p = pending.current
					pending.current = {}
					rpc('config.set', { patch: p }).then((res) => {
						const next = res && res.config ? res.config : res
						if (next) setCfg(next)
						const bad = (res && res.invalidWindows) || []
						if (bad.length > 0) {
							setSave({ state: 'error', msg: '这些时段没通过校验、没保存：' + bad.join('、') })
							return
						}
						setSave({ state: 'saved', msg: '已保存' })
						setTimeout(() => setSave((s) => (s.state === 'saved' ? { state: 'idle', msg: '' } : s)), 2000)
					}, (e) => {
						setSave({ state: 'error', msg: '保存失败：' + (e.message || '未知原因') })
					})
				}, 400)
			}

			if (conf.error) return h('div', { style: errStyle }, '读不到设置：' + conf.error)
			if (!cfg) return h('div', { style: hintStyle }, '正在读设置…')

			return h('div', { style: { padding: '2px 0' } },
				h(Section, { title: '现在的状态', open: true }, () => h(StatusBox, null)),
				h(Section, { title: '投递' }, () => h(React.Fragment, null, h(TargetBox, { cfg, patch }), h(SaveNote, { save }))),
				h(Section, { title: '资讯采集' }, () => h(React.Fragment, null, h(SourceBox, { cfg, patch }), h(SaveNote, { save }))),
				h(Section, { title: '资讯推送风格' }, () => h(React.Fragment, null, h(StyleBox, { cfg, patch }), h(SaveNote, { save }))),
				h(Section, { title: '🎨 图库采集 (插画/色图)' }, () => h(React.Fragment, null, h(GalleryBox, { cfg, patch }), h(SaveNote, { save }))),
				h(Section, { title: '频率与运行' }, () => h(React.Fragment, null, h(TimingBox, { cfg, patch }), h(SaveNote, { save }))),
				h(Section, { title: '会话状态系统弹窗通知' }, () => h(React.Fragment, null, h(DesktopNotifyBox, { cfg, patch }), h(SaveNote, { save }))),
				h(Section, { title: '账单' }, () => h(BillBox, null)))
		}

		// ── 侧栏「资讯收件箱」面板 ─────────────────────────────────────
		const INBOX_PANEL_ID = 'dsh-intel-pulse-inbox'

		function PulseSidebarIcon(props) {
			const size = props?.size || 16
			return h('svg', {
				width: size,
				height: size,
				viewBox: '0 0 16 16',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.25,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				style: { display: 'block', flex: 'none' }
			},
			// 天线/雷达波脉冲图标
			h('path', { d: 'M1.5 6.5a6.5 6.5 0 0 1 13 0' }),
			h('path', { d: 'M3.8 8.8a3.5 3.5 0 0 1 8.4 0' }),
			h('circle', { cx: 8, cy: 11, r: 1.25, fill: 'currentColor' }))
		}

		function PulseInboxPage() {
			const [limit, setLimit] = React.useState(30)
			const [reload, setReload] = React.useState(0)
			const [selectedItem, setSelectedItem] = React.useState(null)
			const runsAsync = useAsync(() => rpc('bill.runs', { limit }), [limit, reload])

			const runs = Array.isArray(runsAsync.value) ? runsAsync.value : []

			return h('div', {
				style: {
					height: '100%',
					minHeight: 0,
					overflowY: 'auto',
					boxSizing: 'border-box',
					padding: '24px clamp(16px, 4vw, 48px) 36px',
					color: 'var(--dsw-alias-label-primary, #1f2329)',
					background: 'var(--dsw-alias-bg-canvas, transparent)'
				}
			},
			h('div', { style: { maxWidth: 960, margin: '0 auto' } },
				// 头部
				h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, borderBottom: '1px solid var(--dsw-alias-border-l2)', paddingBottom: 14 } },
					h('div', null,
						h('h2', { style: { fontSize: 18, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 } },
							h(PulseSidebarIcon, { size: 20 }),
							'资讯收件箱'
						),
						h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginTop: 4 } },
							'按时间汇总的主动采集资讯流，支持翻阅历史推送与点击原文溯源'
						)
					),
					h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
						h('button', {
							style: { ...buttonGhost, height: 28, padding: '0 12px', fontSize: 12 },
							onClick: () => setReload(n => n + 1)
						}, '刷新'),
						h('button', {
							style: { ...buttonStyle, height: 28, padding: '0 12px', fontSize: 12 },
							onClick: () => rpc('run.test').then(() => setReload(n => n + 1)).catch(() => {})
						}, '⚡ 立即采集一轮')
					)
				),

				// 内容列表
				runsAsync.loading && runs.length === 0
					? h('div', { style: { ...hintStyle, textAlign: 'center', padding: '40px 0' } }, '正在读取资讯流…')
					: runs.length === 0
						? h('div', { style: { textAlign: 'center', padding: '60px 0', color: 'var(--dsw-alias-label-tertiary)' } },
							h('div', { style: { fontSize: 32, marginBottom: 8 } }, '📭'),
							h('div', { style: { fontSize: 14, fontWeight: 500 } }, '暂无收录的资讯记录'),
							h('div', { style: { fontSize: 12, marginTop: 4 } }, '插件在闲置探测触发或定时触发后，采集到的资讯将在此陈列。')
						)
						: h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
							runs.map((r, runIdx) => {
								const entries = Array.isArray(r.entries) ? r.entries : []
								const timeStr = fmtStamp(r.at)
								const methodLabel = METHOD_LABEL[r.method] || r.method || '采集'
								const isInboxOnly = r.targetId === 'inbox' || (Array.isArray(r.delivered) && r.delivered.some(d => d.id === 'inbox'))

								// 提取并聚合图片列表：优先取 runs.jsonl 结构化的 r.images，兜底从 r.text 正则解析
								let images = Array.isArray(r.images) && r.images.length > 0 ? r.images : []
								if (images.length === 0 && r.text) {
									try {
										const mdImgRegex = /(?:🎨\s*([^\n(]+?)(?:\s*\(画师:\s*([^)]+)\))?(?:\s*\[(R18)\])?\s*：?\s*\n\s*)?!\[(.*?)\]\((https?:\/\/[^)\s]+)\)/gi
										let m
										while ((m = mdImgRegex.exec(r.text)) !== null) {
											images.push({
												title: (m[1] || m[4] || '插画').trim(),
												author: (m[2] || '').trim(),
												r18: Boolean(m[3]),
												url: m[5].trim(),
												previewUrl: m[5].trim()
											})
										}
									} catch {}
								}

								// 净化 r.text，避免在下方同时渲染重复的图片 Markdown 语法
								let cleanText = r.text || ''
								if (images.length > 0 && cleanText) {
									cleanText = cleanText
										.replace(/(?:🎨\s*[^\n(]+?(?:\s*\(画师:\s*[^)]+\))?(?:\s*\[R18\])?\s*：?\s*\n\s*)?!\[.*?\]\(https?:\/\/[^)\s]+\)/gi, '')
										.replace(/\n{3,}/g, '\n\n')
										.trim()
								}

								return h('div', {
									key: r.id || runIdx,
									style: {
										background: 'var(--dsw-alias-bg-l2, rgba(255,255,255,0.04))',
										border: '1px solid var(--dsw-alias-border-l2)',
										borderRadius: 10,
										padding: '14px 18px',
										boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
									}
								},
								// 单次运行卡片头部元信息
								h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 6 } },
									h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
										h('span', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, timeStr),
										h('span', {
											style: {
												fontSize: 11,
												padding: '2px 8px',
												borderRadius: 999,
												background: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08))',
												color: 'var(--dsw-alias-label-secondary)'
											}
										}, methodLabel),
										r.test ? h('span', { style: { fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'rgba(51, 156, 255, 0.15)', color: '#339CFF' } }, '试跑') : null,
										isInboxOnly ? h('span', { style: { fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'rgba(63, 185, 80, 0.15)', color: '#3fb950' } }, '独立收件箱') : null
									),
									h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', display: 'flex', gap: 10 } },
										entries.length > 0 ? h('span', null, `共 ${entries.length} 条资讯`) : null,
										images.length > 0 ? h('span', { style: { color: 'var(--dsw-alias-accent, #339CFF)', fontWeight: 500 } }, `🖼️ ${images.length} 张插画`) : null,
										entries.length === 0 && images.length === 0 ? '无聚合条目' : null
									)
								),

								// 聚合条目网格/列表
								entries.length > 0
									? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, marginBottom: images.length > 0 ? 12 : 0 } },
										entries.map((entry, eIdx) => {
											return h('div', {
												key: eIdx,
												style: {
													padding: '10px 14px',
													background: 'var(--dsw-alias-bg-l1, rgba(255,255,255,0.02))',
													border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.06))',
													borderRadius: 8,
													display: 'flex',
													flexDirection: 'column',
													gap: 4
												}
											},
											h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 } },
												h('div', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', lineHeight: 1.4 } },
													entry.title || '未命名资讯'
												),
												entry.url ? h('a', {
													href: entry.url,
													target: '_blank',
													rel: 'noopener noreferrer',
													style: {
														fontSize: 11,
														color: '#339CFF',
														textDecoration: 'none',
														display: 'flex',
														alignItems: 'center',
														gap: 3,
														flex: 'none',
														padding: '2px 8px',
														borderRadius: 4,
														background: 'rgba(51, 156, 255, 0.1)'
													}
												}, '🔗 原文') : null
											),
											entry.summary ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5, marginTop: 2 } },
												entry.summary
											) : null,
											entry.source ? h('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', marginTop: 2 } },
												`来源：${entry.source}`
											) : null)
										})
									)
									: null,

								// 🎨 插画/图片专属网格瀑布展示
								images.length > 0
									? h('div', {
										style: {
											display: 'grid',
											gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
											gap: 12,
											marginBottom: cleanText ? 10 : 0
										}
									},
									images.map((img, imgIdx) => {
										return h('div', {
											key: imgIdx,
											style: {
												border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
												borderRadius: 8,
												overflow: 'hidden',
												background: 'var(--dsw-alias-bg-l1, rgba(0,0,0,0.15))',
												display: 'flex',
												flexDirection: 'column'
											}
										},
										// 图片容器（点击外链新标签页打开高清大图）
										h('a', {
											href: img.url,
											target: '_blank',
											rel: 'noopener noreferrer',
											title: '点击直接在新标签页打开高清大图原图',
											style: {
												display: 'block',
												position: 'relative',
												width: '100%',
												height: 180,
												overflow: 'hidden',
												background: 'rgba(0,0,0,0.2)',
												cursor: 'zoom-in'
											}
										},
										h('img', {
											src: img.previewUrl || img.url,
											alt: img.title || '插画',
											loading: 'lazy',
											style: {
												width: '100%',
												height: '100%',
												objectFit: 'cover',
												transition: 'transform 0.25s ease'
											},
											onMouseEnter: (e) => { e.currentTarget.style.transform = 'scale(1.05)' },
											onMouseLeave: (e) => { e.currentTarget.style.transform = 'scale(1.0)' },
											onError: (e) => {
												// 某些海外反代直连在特定网络下可能偶发加载失败，提供友好的回退指示
												e.currentTarget.style.display = 'none'
												if (e.currentTarget.parentNode) {
													const fallbackBox = document.createElement('div')
													fallbackBox.style.cssText = 'height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:11px;padding:8px;text-align:center;'
													fallbackBox.innerHTML = '<span style=\"font-size:20px;margin-bottom:4px;\">🖼️</span><span>图片加载受限</span><span style=\"color:#339CFF;margin-top:2px;\">点击打开外链</span>'
													e.currentTarget.parentNode.appendChild(fallbackBox)
												}
											}
										}),
										// R18 浮标
										img.r18 ? h('span', {
											style: {
												position: 'absolute',
												top: 6,
												left: 6,
												background: 'rgba(255, 77, 79, 0.9)',
												color: '#fff',
												fontSize: 10,
												fontWeight: 700,
												padding: '1px 5px',
												borderRadius: 4
											}
										}, 'R18') : null,
										// 右下角外链提示小浮标
										h('span', {
											style: {
												position: 'absolute',
												bottom: 6,
												right: 6,
												background: 'rgba(0, 0, 0, 0.65)',
												color: '#fff',
												fontSize: 10,
												padding: '2px 6px',
												borderRadius: 4,
												backdropFilter: 'blur(4px)',
												pointerEvents: 'none'
											}
										}, '↗ 外链')
										),
										// 图片底部信息
										h('div', { style: { padding: '8px 10px', fontSize: 11, display: 'flex', flexDirection: 'column', gap: 2 } },
											h('div', {
												style: {
													fontWeight: 600,
													color: 'var(--dsw-alias-label-primary)',
													overflow: 'hidden',
													textOverflow: 'ellipsis',
													whiteSpace: 'nowrap'
												},
												title: img.title
											}, img.title || '精选插画'),
											h('div', {
												style: {
													display: 'flex',
													alignItems: 'center',
													justifyContent: 'space-between',
													color: 'var(--dsw-alias-label-tertiary)',
													fontSize: 10
												}
											},
											img.author ? h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `画师: ${img.author}`) : h('span', null, '精选画作'),
											h('a', {
												href: img.url,
												target: '_blank',
												rel: 'noopener noreferrer',
												style: { color: '#339CFF', textDecoration: 'none', flex: 'none', marginLeft: 4 }
											}, '外链 ↗')
											)
										)
										)
									})
									)
									: null,

								// 剩余正文文本（若有）
								cleanText
									? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap', lineHeight: 1.5, marginTop: (entries.length > 0 || images.length > 0) ? 8 : 0 } }, cleanText)
									: null
								)
							}),

							// 往回翻页 / 加载更多
							h('div', { style: { textAlign: 'center', marginTop: 12 } },
								h('button', {
									style: { ...buttonGhost, height: 32, padding: '0 20px', fontSize: 12 },
									onClick: () => setLimit(l => l + 30)
								}, '加载更多历史推送…')
							)
						)
			))
		}

		let rpc = null

		function apply(ctx) {
			const getConnection = () => {
				try { return ctx.get('connection') } catch { return undefined }
			}
			rpc = async (endpoint, payload) => {
				const conn = getConnection()
				if (!conn || !conn.rpc || typeof conn.rpc.call !== 'function') {
					throw new Error('连不上 DSH，请确认 DSH 正在运行')
				}
				const result = await conn.rpc.call('/api', 'away-notify', { endpoint, ...(payload ?? {}) }, undefined)
				if (!result || result.ok !== true) {
					throw new Error((result && result.error && result.error.message) || '操作没成功')
				}
				return result.value
			}

			// 注册设置页
			try {
				ctx.slots.inject('settings.section', function* () {
					yield ctx.slots.register(
						{ name: 'settings.section', id: 'dsh-intel-pulse', order: 25, label: () => '自主资讯推送' },
						AwayNotifySection)
				})
			} catch (e) {
				console.warn('[dsh-intel-pulse] settings.section slot unavailable', e)
			}

			// 注册侧栏独立「资讯收件箱」面板
			try {
				if (typeof ctx.inject === 'function') {
					ctx.inject(['layout'], (pageCtx) => {
						try {
							// 注册主工作区视图
							pageCtx.slots.inject('main', () => {
								return pageCtx.slots.register({
									name: 'main',
									key: INBOX_PANEL_ID,
									inject: () => ({})
								}, PulseInboxPage)
							})

							// 注册左侧栏图标入口
							pageCtx.slots.inject('sidebar.panellist', () => {
								return pageCtx.slots.register({
									name: 'sidebar.panellist',
									id: INBOX_PANEL_ID,
									order: 12,
									label: () => '资讯收件箱'
								}, PulseSidebarIcon)
							})
						} catch (err) {
							console.warn('[dsh-intel-pulse] Failed to register inbox layout slots', err)
						}
					})
				}
			} catch (e) {
				console.warn('[dsh-intel-pulse] layout service inject unavailable', e)
			}
		}

		// 声明依赖的客户端服务：加入 layout 以便挂载侧栏面板
		exports.inject = ['slots', 'sessions', 'layout']
		exports.apply = apply
		return module.exports
	}
})
