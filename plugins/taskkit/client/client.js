// Client：灵感库可视化 @local/taskkit
// 入口（2a 起为两个官方侧栏行 + 各自主面板；侧栏行 id 与 main key 同名）：
//   任务 panel（sidebar.panellist id='taskboard' + main key='taskboard'）
//   唤醒 panel（sidebar.panellist id='wakeboard' + main key='wakeboard'）
// 内容：列表/卡片/详情编辑/固定/会议保存
// 数据经 host HTTP API /taskkit/api/insp/*（fetch）
window.__ModuleLoader__.load({
  id: '@local/taskkit',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    // ==================== 官方 UI 组件库探针（B 路线 pilot-1，最小探针）====================
    // 来源：浏览器端「种子模块表」——__ModuleLoader__ 的 makeRequire 命中 seed 即直接返回，
    // 不走 node_modules（真正生效的是内核 rc.1 前端 bundle 内联的那份；profile 侧 rc.3 对浏览器是死代码）。
    // 本批只用"经由 rc.1 bundle 逐字核对确认存在"的 Tag / StateDot 做「一处状态展示」最小探针。
    var primitives = null
    var PRIM_REQ_ERR = ''
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (e) {
      PRIM_REQ_ERR = (e && e.message) || String(e)
      primitives = null
    }
    var PRIM_KEYS = primitives ? Object.keys(primitives).sort() : []
    var PRIM_OK = !!(primitives && primitives.Tag && primitives.StateDot)
    // [pilot-1 临时证据] 运行时导出键清单，供 DevTools（window.__tkPrimitivesKeys）抓取；探针验证完成后可删
    try { if (typeof window !== 'undefined') window.__tkPrimitivesKeys = PRIM_KEYS } catch (e) {}
    try {
      console.info('[taskkit] ui-primitives ' + (PRIM_OK ? 'OK' : 'MISSING') + ' keys=' + PRIM_KEYS.length + ': ' + PRIM_KEYS.join(', '))
    } catch (e) {}
    if (!PRIM_OK) {
      try { console.error('[taskkit] 组件库不可用：@deepseek-ai/dsh-client-ui-primitives 的 Tag/StateDot 缺失；requireErr=' + (PRIM_REQ_ERR || '(none)') + ' keys=' + JSON.stringify(PRIM_KEYS)) } catch (e) {}
    }

    var API_BASE = '/taskkit/api/insp'

    function api(action, args) {
      return fetch(API_BASE + '/' + action, {
        method: args ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: args ? JSON.stringify(args) : undefined
      }).then(function (r) { return r.json() })
    }

    var STATUS = ['预存', '待讨论', '已整理', '已固定']
    var CATEGORY = ['主攻', '备选', '冻结', '待启动']

    // ==================== 创作资源库（crelib）：归类分组 + 灵感↔草稿↔状态关联 ====================
    function CreLib() {
      var force = React.useState(0)[1]
      var [data, setData] = React.useState(null)
      var [selId, setSelId] = React.useState(null)
      var [err, setErr] = React.useState('')
      var load = function () {
        fetch('/taskkit/api/crelib/overview').then(function (r) { return r.json() }).then(function (d) {
          if (d && d.ok) { setData(d); setErr('') } else { setErr('加载失败') }
        }).catch(function () { setErr('加载失败') })
      }
      React.useEffect(function () { load() }, [])
      var setCat = function (id, cat) {
        fetch('/taskkit/api/crelib/category', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, category: cat }) })
          .then(function (r) { return r.json() }).then(function () { load() })
      }
      if (err) return React.createElement('div', { style: { padding: 20, color: 'var(--tk-error)' } }, err)
      if (!data) return React.createElement('div', { style: { padding: 20, color: 'var(--tk-text-2)' } }, '加载创作资源库…')
      var cats = CATEGORY
      var totals = { '主攻': 0, '备选': 0, '冻结': 0, '待启动': 0 }
      cats.forEach(function (k) { totals[k] = (data.groups[k] || []).length })
      var catColor = { '主攻': '#dc2626', '备选': '#d97706', '冻结': '#6b7280', '待启动': '#059669' }
      var sel = null
      if (selId) { cats.forEach(function (k) { (data.groups[k] || []).forEach(function (e) { if (e.id === selId) sel = e }) }) }
      var cardStyle = { border: '1px solid var(--dsw-alias-border-l2,#e4e4e7)', borderRadius: 10, padding: 12, background: 'var(--tk-card)', marginBottom: 10 }
      return React.createElement('div', { style: { padding: 16, maxWidth: 1000, margin: '0 auto' } },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
          React.createElement('div', {},
            React.createElement('div', { style: { fontSize: 17, fontWeight: 700 } }, '创作资源库'),
            React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--tk-text-2)' } }, '灵感 ' + data.total + ' 条 · 草稿 ' + data.draftCount + ' 篇 · ' + data.updatedAt.slice(0, 16).replace('T', ' ') + ' 更新')),
          React.createElement('button', { onClick: load, style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', padding: '4px 10px', borderRadius: 6, border: '1px solid var(--tk-border-2)', background: 'var(--tk-card)', cursor: 'pointer' } }, '刷新')),
        cats.map(function (k) {
          var items = data.groups[k] || []
          return React.createElement('div', { key: k, style: { marginBottom: 14 } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
              React.createElement('span', { style: { width: 10, height: 10, borderRadius: 5, background: catColor[k], display: 'inline-block' } }),
              React.createElement('span', { style: { fontSize: 'var(--dsw-font-s-14-font-size, 14px)', fontWeight: 600 } }, k),
              React.createElement('span', { style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--tk-text-2)' } }, items.length + ' 条')),
            items.length === 0 ? React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--tk-text-3)', padding: '4px 12px' } }, '（空）') :
            items.map(function (e) {
              return React.createElement('div', { key: e.id, onClick: function () { setSelId(e.id === selId ? null : e.id) }, style: Object.assign({ cursor: 'pointer' }, cardStyle, selId === e.id ? { borderColor: 'var(--tk-accent)' } : {}) },
                React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
                  React.createElement('div', { style: { fontSize: 13.5, fontWeight: 600 } }, e.title),
                  React.createElement('span', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--tk-text-2)', whiteSpace: 'nowrap' } }, e.status)),
                React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--tk-text-2)', marginTop: 3 } }, e.oneLiner ? e.oneLiner.slice(0, 90) + (e.oneLiner.length > 90 ? '…' : '') : ''),
                React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--tk-text-3)', marginTop: 5 } },
                  '草稿: ' + (e.drafts && e.drafts.length ? e.drafts.join('、') : '无') + (e.settingsRef ? ' · 设定: ' + e.settingsRef : '')),
                selId === e.id ? React.createElement('div', { style: { marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--tk-border)' } },
                  React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--tk-text-2)', marginBottom: 6 } }, '归类管理：'),
                  CATEGORY.map(function (cc) {
                    var active = e.category === cc
                    return React.createElement('button', { key: cc, onClick: function (ev) { ev.stopPropagation(); setCat(e.id, cc) }, style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', padding: '3px 10px', marginRight: 6, borderRadius: 6, border: '1px solid ' + (active ? catColor[cc] : 'var(--tk-border-2)'), background: active ? catColor[cc] : 'var(--tk-card)', color: active ? '#fff' : 'var(--tk-text)', cursor: 'pointer' } }, cc)
                  })) : null)
            }))
        }))
    }


    function InspLibrary() {
      var force = React.useState(0)[1]
      var [list, setList] = React.useState([])
      var [sel, setSel] = React.useState(null)
      var [q, setQ] = React.useState('')
      var [tag, setTag] = React.useState('')
      var [status, setStatus] = React.useState('')
      var [flash, setFlash] = React.useState('')
      var [form, setForm] = React.useState({ title: '', oneLiner: '', content: '', source: '', tags: '', hook: '' })
        var [relatedDrafts, setRelatedDrafts] = React.useState([])

      function refresh() {
        var params = []
        if (q) params.push('query=' + encodeURIComponent(q))
        if (tag) params.push('tags=' + encodeURIComponent(tag))
        if (status) params.push('status=' + encodeURIComponent(status))
        var url = API_BASE + '/list' + (params.length ? '?' + params.join('&') : '')
        fetch(url).then(function (r) { return r.json() }).then(function (d) {
          if (d && d.entries) setList(d.entries)
        }).catch(function () {})
      }

      React.useEffect(function () { refresh(); var t = setInterval(refresh, 30000); return function () { clearInterval(t) } }, [q, tag, status])

      function openEntry(e) {
        setSel(e)
        setForm({ title: e.title, oneLiner: e.oneLiner, content: e.content, source: e.source, tags: (e.tags || []).join(', '), hook: e.hook })
          fetch('/taskkit/api/relations/list').then(function (r) { return r.json() }).then(function (d) {
            if (!d || !d.ok) return
            var rels = d.relations || {}
            var drafts = d.drafts || []
            setRelatedDrafts(drafts.filter(function (dr) {
              var rel = rels[dr.name]
              return rel && (rel.refInspId === e.id || rel.refResourceId === e.id)
            }))
          }).catch(function () {})
      }
      function saveNew() {
        if (!form.title.trim()) { setFlash('标题必填'); return }
        api('create', { title: form.title, oneLiner: form.oneLiner, content: form.content, source: form.source, tags: form.tags, hook: form.hook }).then(function (d) {
          if (d && d.ok) { setFlash('已预存「' + form.title + '」'); setForm({ title: '', oneLiner: '', content: '', source: '', tags: '', hook: '' }); refresh() } else { setFlash('失败: ' + (d && d.error || '')) }
        })
      }
      function saveEdit() {
        if (!sel) return
        api('update', { id: sel.id, patch: { title: form.title, oneLiner: form.oneLiner, content: form.content, source: form.source, tags: form.tags, hook: form.hook } }).then(function (d) {
          if (d && d.ok) { setFlash('已保存'); refresh(); openEntry(d.entry) } else { setFlash('失败: ' + (d && d.error || '')) }
        })
      }
      function toggleFixed(id) {
        api('toggleFixed', { id: id }).then(function (d) { if (d && d.ok) { setFlash(d.fixed ? '已固定' : '已取消固定'); refresh() } })
      }
      function changeStatus(id, st) {
        api('update', { id: id, patch: { status: st } }).then(function (d) { if (d && d.ok) { setFlash('状态→' + st); refresh() } })
      }

      return React.createElement('div', { style: { display: 'flex', gap: '12px', padding: '12px', minHeight: '60vh', fontFamily: 'inherit' } },
        React.createElement('div', { style: { flex: 1, minWidth: '280px', display: 'flex', flexDirection: 'column', gap: '8px' } },
          React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
            React.createElement('input', { placeholder: '搜索…', value: q, onChange: function (e) { setQ(e.target.value) }, style: { flex: 1, padding: '4px 8px', border: '1px solid var(--tk-border-2)', borderRadius: '6px', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', background: 'var(--tk-card)', color: 'var(--tk-text)' } }),
            React.createElement('input', { placeholder: '标签', value: tag, onChange: function (e) { setTag(e.target.value) }, style: { width: '80px', padding: '4px 8px', border: '1px solid var(--tk-border-2)', borderRadius: '6px', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', background: 'var(--tk-card)', color: 'var(--tk-text)' } }),
            React.createElement('select', { value: status, onChange: function (e) { setStatus(e.target.value) }, style: { padding: '4px', border: '1px solid var(--tk-border-2)', borderRadius: '6px', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', background: 'var(--tk-card)', color: 'var(--tk-text)' } },
              React.createElement('option', { value: '' }, '全部状态'),
              STATUS.map(function (s) { return React.createElement('option', { key: s, value: s }, s) })
            )
          ),
          React.createElement('div', { style: { flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' } },
            (list || []).map(function (e) {
              return React.createElement('div', { key: e.id, onClick: function () { openEntry(e) }, style: { padding: '8px 10px', border: '1px solid ' + (e.fixed ? 'var(--tk-accent)' : 'var(--tk-border)'), borderRadius: '8px', cursor: 'pointer', background: 'var(--tk-card)' } },
                React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                  React.createElement('span', { style: { fontWeight: 600, fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', color: 'var(--tk-text)' } }, (e.fixed ? '⭐ ' : '') + e.title),
                  React.createElement('span', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--tk-text-2)' } }, e.status)
                ),
                e.oneLiner ? React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--tk-text-2)', marginTop: '2px' } }, e.oneLiner) : null,
                (e.tags && e.tags.length) ? React.createElement('div', { style: { marginTop: '4px' } }, e.tags.map(function (t) { return React.createElement('span', { key: t, style: { display: 'inline-block', padding: '1px 6px', marginRight: '4px', background: 'rgba(217,119,6,0.12)', color: '#92400e', borderRadius: '10px', fontSize: '10px' } }, t) })) : null
              )
            }),
            (!list || !list.length) ? React.createElement('div', { style: { textAlign: 'center', color: 'var(--tk-text-3)', padding: '20px', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)' } }, '暂无灵感条目') : null
          )
        ),
        React.createElement('div', { style: { flex: 1, minWidth: '300px', display: 'flex', flexDirection: 'column', gap: '8px' } },
          flash ? React.createElement('div', { style: { padding: '6px 10px', background: 'rgba(5,150,105,0.1)', color: 'var(--tk-success)', borderRadius: '6px', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)' } }, flash) : null,
          React.createElement('div', { style: { padding: '10px', border: '1px solid var(--tk-border)', borderRadius: '8px', background: 'var(--tk-card)', display: 'flex', flexDirection: 'column', gap: '6px' } },
            React.createElement('div', { style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', fontWeight: 600, color: 'var(--tk-text)' } }, sel ? '编辑：' + sel.title : '新增灵感'),
            React.createElement('input', { placeholder: '标题 *', value: form.title, onChange: function (e) { setForm(Object.assign({}, form, { title: e.target.value })) }, style: INP }),
            React.createElement('input', { placeholder: '一句话灵感', value: form.oneLiner, onChange: function (e) { setForm(Object.assign({}, form, { oneLiner: e.target.value })) }, style: INP }),
            React.createElement('textarea', { placeholder: '内容/设定', value: form.content, onChange: function (e) { setForm(Object.assign({}, form, { content: e.target.value })) }, rows: 4, style: Object.assign({}, INP, { resize: 'vertical' }) }),
            React.createElement('input', { placeholder: '来源', value: form.source, onChange: function (e) { setForm(Object.assign({}, form, { source: e.target.value })) }, style: INP }),
            React.createElement('input', { placeholder: '标签（逗号分隔）', value: form.tags, onChange: function (e) { setForm(Object.assign({}, form, { tags: e.target.value })) }, style: INP }),
            React.createElement('input', { placeholder: '钩子', value: form.hook, onChange: function (e) { setForm(Object.assign({}, form, { hook: e.target.value })) }, style: INP }),
            React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
              sel ? React.createElement('button', { onClick: saveEdit, style: BTN_PRIMARY }, '💾 保存修改') : React.createElement('button', { onClick: saveNew, style: BTN_PRIMARY }, '➕ 新增灵感')
            ),
            sel ? React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
              React.createElement('button', { onClick: function () { toggleFixed(sel.id) }, style: BTN }, sel.fixed ? '取消固定' : '⭐ 固定'),
              STATUS.filter(function (s) { return s !== sel.status }).map(function (s) { return React.createElement('button', { key: s, onClick: function () { changeStatus(sel.id, s) }, style: BTN }, '→ ' + s) })
            ) : null,
            sel && sel.meeting && sel.meeting.output ? React.createElement('div', { style: { padding: '8px', background: 'rgba(126,87,194,0.08)', borderRadius: '6px', fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: '#6d28d9' } },
              React.createElement('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '📋 会议成果'),
              React.createElement('div', null, sel.meeting.output)
            ) : null,
              sel ? React.createElement('div', { style: { padding: '8px', background: 'rgba(5,150,105,0.06)', borderRadius: '6px', fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--tk-success)' } },
                React.createElement('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '🔗 关联成果'),
                (relatedDrafts && relatedDrafts.length) ? relatedDrafts.map(function (d) {
                  return React.createElement('div', { key: d.name, style: { padding: '4px 0', borderBottom: '1px solid rgba(5,150,105,0.12)', cursor: 'pointer' } },
                    React.createElement('a', { href: '#', onClick: function (ev) { ev.preventDefault(); alert('打开草稿：' + d.name) }, style: { color: 'var(--tk-success)', textDecoration: 'none' } }, d.title + '（' + d.words + ' 字）')
                  )
                }) : React.createElement('div', null, '暂无关联草稿')
              ) : null
          )
        )
      );
    }

    var INP = { padding: '4px 8px', border: '1px solid var(--tk-border-2)', borderRadius: '6px', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', background: 'var(--tk-card)', color: 'var(--tk-text)', fontFamily: 'inherit' }
    var BTN = { background: 'var(--tk-card)', color: 'var(--tk-text)', border: '1px solid var(--tk-border-2)', borderRadius: '6px', padding: '4px 10px', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', cursor: 'pointer', fontFamily: 'inherit' }
    var BTN_PRIMARY = Object.assign({}, BTN, { background: 'var(--tk-accent)', borderColor: 'transparent', color: '#fff' })

    // ==================== 写作成果可视化 ====================
    var WRITING_API = '/taskkit/api/writing'

    function WritingPanel() {
      var [ov, setOv] = React.useState(null)
      var [drafts, setDrafts] = React.useState([])
      var [sched, setSched] = React.useState(null)
      var [selDraft, setSelDraft] = React.useState(null)
      var [draftText, setDraftText] = React.useState('')
      var [tab, setTab] = React.useState('overview')

      function loadAll() {
        fetch(WRITING_API + '/overview').then(function (r) { return r.json() }).then(function (d) { if (d && d.ok) setOv(d) }).catch(function () {})
        fetch(WRITING_API + '/drafts').then(function (r) { return r.json() }).then(function (d) { if (d && d.drafts) setDrafts(d.drafts) }).catch(function () {})
        fetch(WRITING_API + '/schedule').then(function (r) { return r.json() }).then(function (d) { if (d && d.ok) setSched(d) }).catch(function () {})
      }
      React.useEffect(function () { loadAll(); var t = setInterval(loadAll, 30000); return function () { clearInterval(t) } }, [])

      function openDraft(name) {
        fetch(WRITING_API + '/draft?name=' + encodeURIComponent(name)).then(function (r) { return r.json() }).then(function (d) {
          if (d && d.ok) { setSelDraft(d); setDraftText(d.text); setTab('draft') }
        }).catch(function () {})
      }

      var daily = (ov && ov.daily) || []
      var maxWords = Math.max.apply(null, daily.map(function (d) { return d.words }).concat([1]))
      var weekly = (ov && ov.weekly) || []
      var maxWeekWords = Math.max.apply(null, weekly.map(function (w) { return w.words }).concat([1]))

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px', minHeight: '60vh', fontFamily: 'inherit' } },
        React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          React.createElement('button', { onClick: function () { setTab('overview') }, style: tab === 'overview' ? BTN_PRIMARY : BTN }, '📊 数据概览'),
          React.createElement('button', { onClick: function () { setTab('drafts') }, style: tab === 'drafts' ? BTN_PRIMARY : BTN }, '📄 草稿'),
          React.createElement('button', { onClick: function () { setTab('schedule') }, style: tab === 'schedule' ? BTN_PRIMARY : BTN }, '🗓 日程'),
          React.createElement('button', { onClick: function () { setTab('milestones') }, style: tab === 'milestones' ? BTN_PRIMARY : BTN }, '🏆 成果汇总')
        ),
        tab === 'overview' ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          React.createElement('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            React.createElement(Card, { label: '总字数', value: ov ? String(ov.record.totalWords) : '—' }),
            React.createElement(Card, { label: '连续天数', value: ov ? String(ov.record.streak) : '—' }),
            React.createElement(Card, { label: '打卡天数', value: ov ? String(ov.record.checkins) : '—' }),
            React.createElement(Card, { label: '草稿数', value: ov ? String(ov.drafts.total) : '—' }),
            React.createElement(Card, { label: '日程完成', value: ov ? (ov.schedule.doneDays + '/' + ov.schedule.totalDays) : '—' })
          ),
          React.createElement('div', { style: { padding: '10px', border: '1px solid var(--tk-border)', borderRadius: '8px', background: 'var(--tk-card)' } },
            React.createElement('div', { style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', fontWeight: 600, marginBottom: '8px', color: 'var(--tk-text)' } }, '每日字数趋势'),
            daily.length ? React.createElement('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '6px', height: '100px' } },
              daily.map(function (d) { return React.createElement('div', { key: d.date, style: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' } },
                React.createElement('div', { title: d.date + '：' + d.words + ' 字', style: { width: '100%', background: 'var(--tk-accent)', borderRadius: '3px 3px 0 0', height: Math.max(4, Math.round(d.words / maxWords * 80)) + 'px' } }),
                React.createElement('span', { style: { fontSize: '10px', color: 'var(--tk-text-2)', whiteSpace: 'nowrap' } }, d.date.slice(5))
              )})) : React.createElement('div', { style: { color: 'var(--tk-text-3)', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)' } }, '暂无每日写作数据')
          ),
          React.createElement('div', { style: { padding: '10px', border: '1px solid var(--tk-border)', borderRadius: '8px', background: 'var(--tk-card)' } },
            React.createElement('div', { style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', fontWeight: 600, marginBottom: '8px', color: 'var(--tk-text)' } }, '每周字数趋势'),
            weekly.length ? React.createElement('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '6px', height: '80px' } },
              weekly.map(function (w) { return React.createElement('div', { key: w.week, style: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' } },
                React.createElement('div', { title: w.week + '：' + w.words + ' 字', style: { width: '100%', background: '#6d28d9', borderRadius: '3px 3px 0 0', height: Math.max(4, Math.round(w.words / maxWeekWords * 60)) + 'px' } }),
                React.createElement('span', { style: { fontSize: '10px', color: 'var(--tk-text-2)', whiteSpace: 'nowrap' } }, w.week)
              )})) : React.createElement('div', { style: { color: 'var(--tk-text-3)', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)' } }, '暂无每周写作数据')
          )
        ) : null,
        tab === 'drafts' ? React.createElement('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
          React.createElement('div', { style: { flex: 1, minWidth: '260px', display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '60vh', overflow: 'auto' } },
            (drafts || []).map(function (d) { return React.createElement('div', { key: d.name, onClick: function () { openDraft(d.name) }, style: { padding: '8px 10px', border: '1px solid ' + (selDraft && selDraft.name === d.name ? 'var(--tk-accent)' : 'var(--tk-border)'), borderRadius: '8px', cursor: 'pointer', background: 'var(--tk-card)' } },
              React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '6px' } },
                React.createElement('span', { style: { fontWeight: 600, fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', color: 'var(--tk-text)' } }, d.title),
                React.createElement('span', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--tk-text-2)', whiteSpace: 'nowrap' } }, d.date || '')
              ),
              React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--tk-text-3)', marginTop: '2px' } }, d.words + ' 字'),
              React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--tk-text-2)', marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, d.preview || '')
            ) }),
            (!drafts || !drafts.length) ? React.createElement('div', { style: { textAlign: 'center', color: 'var(--tk-text-3)', padding: '20px', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)' } }, '暂无草稿') : null
          ),
          React.createElement('div', { style: { flex: 1, minWidth: '300px', padding: '10px', border: '1px solid var(--tk-border)', borderRadius: '8px', background: 'var(--tk-card)', maxHeight: '60vh', overflow: 'auto' } },
            selDraft ? React.createElement(React.Fragment, null,
              React.createElement('div', { style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', fontWeight: 600, marginBottom: '6px', color: 'var(--tk-text)' } }, selDraft.name + '（' + selDraft.words + ' 字）'),
              React.createElement('pre', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--tk-text)', fontFamily: 'inherit', margin: 0 } }, draftText)
            ) : React.createElement('div', { style: { color: 'var(--tk-text-3)', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', textAlign: 'center', padding: '20px' } }, '点击左侧草稿查看内容'))
        ) : null,
        tab === 'schedule' ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          sched ? React.createElement('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            React.createElement(Card, { label: '总训练日', value: String(sched.totalDays) }),
            React.createElement(Card, { label: '已完成', value: String(sched.doneDays) }),
            React.createElement(Card, { label: '完成率', value: sched.percent + '%' })
          ) : null,
          (sched && sched.weeks || []).map(function (w) {
            return React.createElement('div', { key: w.title, style: { padding: '10px', border: '1px solid var(--tk-border)', borderRadius: '8px', background: 'var(--tk-card)' } },
              React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '6px' } },
                React.createElement('span', { style: { fontWeight: 600, fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', color: 'var(--tk-text)' } }, w.title),
                React.createElement('span', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--tk-text-2)' } }, w.doneCount + '/' + w.totalCount)
              ),
              React.createElement('div', { style: { height: '6px', background: 'var(--tk-inset)', borderRadius: '3px', overflow: 'hidden', marginBottom: '6px' } },
                React.createElement('div', { style: { height: '100%', width: (w.totalCount ? Math.round(w.doneCount / w.totalCount * 100) : 0) + '%', background: 'var(--tk-accent)' } })
              ),
              React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } },
                w.days.map(function (d) { return React.createElement('span', { key: d.key, title: d.label, style: { padding: '2px 6px', borderRadius: '10px', fontSize: '10px', background: d.done ? 'rgba(5,150,105,0.12)' : 'rgba(107,114,128,0.12)', color: d.done ? 'var(--tk-success)' : 'var(--tk-text-2)' } }, (d.done ? '✅ ' : '⬜ ') + d.label) })
              )
            )
          }),
          (!sched || !sched.weeks || !sched.weeks.length) ? React.createElement('div', { style: { textAlign: 'center', color: 'var(--tk-text-3)', padding: '20px', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)' } }, '暂无训练日程') : null
        ) : null,
        tab === 'milestones' ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          ov ? React.createElement('div', { style: { padding: '10px', border: '1px solid var(--tk-border)', borderRadius: '8px', background: 'var(--tk-card)' } },
            React.createElement('div', { style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', fontWeight: 600, marginBottom: '6px', color: 'var(--tk-text)' } }, '🏆 里程碑'),
            React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--tk-text-2)', lineHeight: 1.8 } },
              React.createElement('div', null, '累计写作：' + ov.record.totalWords + ' 字'),
              React.createElement('div', null, '连续打卡：' + ov.record.streak + ' 天'),
              React.createElement('div', null, '累计打卡：' + ov.record.checkins + ' 天'),
              React.createElement('div', null, '草稿存档：' + ov.drafts.total + ' 篇'),
              React.createElement('div', null, '保存成功：' + ov.saveLog.count + ' 次 / ' + ov.saveLog.words + ' 字'),
              React.createElement('div', null, '日程进度：' + ov.schedule.doneDays + '/' + ov.schedule.totalDays + '（' + ov.schedule.percent + '%）')
            )
          ) : null,
          React.createElement('div', { style: { padding: '10px', border: '1px solid var(--tk-border)', borderRadius: '8px', background: 'var(--tk-card)' } },
            React.createElement('div', { style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', fontWeight: 600, marginBottom: '6px', color: 'var(--tk-text)' } }, '📚 训练计划'),
            React.createElement('button', { onClick: function () { fetch(WRITING_API + '/plan').then(function (r) { return r.json() }).then(function (d) { if (d && d.ok) { setSelDraft({ name: '训练计划.md', words: d.trainingPlan.length }); setDraftText(d.trainingPlan); setTab('draft') } }).catch(function () {}) }, style: BTN }, '打开训练计划'),
            React.createElement('button', { onClick: function () { fetch(WRITING_API + '/plan').then(function (r) { return r.json() }).then(function (d) { if (d && d.ok) { setSelDraft({ name: '写作技巧速查手册.md', words: d.handbook.length }); setDraftText(d.handbook); setTab('draft') } }).catch(function () {}) }, style: Object.assign({}, BTN, { marginLeft: '6px' }) }, '打开技巧手册'),
            React.createElement('button', { onClick: function () { fetch(WRITING_API + '/plan').then(function (r) { return r.json() }).then(function (d) { if (d && d.ok) { setSelDraft({ name: '周复盘模板.md', words: d.reviewTemplate.length }); setDraftText(d.reviewTemplate); setTab('draft') } }).catch(function () {}) }, style: Object.assign({}, BTN, { marginLeft: '6px' }) }, '周复盘模板')
          )
        ) : null,
        tab === 'draft' ? React.createElement('div', { style: { padding: '10px', border: '1px solid var(--tk-border)', borderRadius: '8px', background: 'var(--tk-card)', maxHeight: '70vh', overflow: 'auto' } },
          selDraft ? React.createElement(React.Fragment, null,
            React.createElement('div', { style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', fontWeight: 600, marginBottom: '6px', color: 'var(--tk-text)' } }, selDraft.name + '（' + selDraft.words + ' 字）'),
            React.createElement('pre', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--tk-text)', fontFamily: 'inherit', margin: 0 } }, draftText)
          ) : null
        ) : null
      );
    }

    function Card(props) {
      return React.createElement('div', { style: { flex: 1, minWidth: '120px', padding: '10px', border: '1px solid var(--tk-border)', borderRadius: '8px', background: 'var(--tk-card)', textAlign: 'center' } },
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--tk-text-2)', marginBottom: '4px' } }, props.label),
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-l-20-font-size, 20px)', fontWeight: 700, color: 'var(--tk-text)' } }, props.value)
      );
    }


    // ==================== 任务面板（含筛选栏，筛选 S2）====================
    var TASK_STATUSES = ['待执行', '执行中', '需审批', '已完成', '中止', '已取消']

    // 状态 → 官方 Tag(tone) / StateDot(state) 映射
    // 取值依据：内核 rc.1 前端 bundle（index-Du6ti6f.js 定义 + index-DPX2bQLO.css 内联样式）实测绘出的合法值，
    //   而非 profile 侧 rc.3 的 .d.ts 推断：
    //   Tag  tone 合法值：outline(默认) / solid / neutral / quiet / success / info / warning / danger
    //   StateDot state 合法值：idle / done / warning / error（+ ongoing：JS 特判渲染动画点阵，非 CSS）
    var STATUS_PRIM = {
      '待执行': { tone: 'neutral', state: 'idle' },
      '执行中': { tone: 'info', state: 'ongoing' },
      '需审批': { tone: 'warning', state: 'warning' },
      '已完成': { tone: 'success', state: 'done' },
      '中止': { tone: 'danger', state: 'error' },
      '已取消': { tone: 'danger', state: 'error' }
    }
    var STATUS_PRIM_FALLBACK = { tone: 'outline', state: 'idle' }

    function TaskBoard() {
      var [tasks, setTasks] = React.useState([])
      var [sessions, setSessions] = React.useState([])
      var [owners, setOwners] = React.useState([])
      var [projects, setProjects] = React.useState([])
      var [fSel, setFSel] = React.useState({ session: [], owner: [], project: [], status: [] })
      var [kw, setKw] = React.useState('')
      var [serverMode, setServerMode] = React.useState(false)
      // 五列看板（借鉴 task-board）：列定义 + 详情面板 + 归档
      var [detailId, setDetailId] = React.useState(null)
      var [archivedOnly, setArchivedOnly] = React.useState(false)
      var [rev, setRev] = React.useState(0)
      var COLUMNS = [
        { key: '待执行', label: '待执行', color: '#d97706' },
        { key: '执行中', label: '执行中', color: '#2563eb' },
        { key: '需审批', label: '需审批', color: '#7c3aed' },
        { key: '已完成', label: '已完成', color: '#059669' },
        { key: '已取消', label: '已取消', color: '#6b7280' }
      ]

      function loadAll() {
        fetch('/taskkit/api/read').then(function (r) { return r.json() }).then(function (d) {
          if (d && d.tasks) {
            setTasks(d.tasks)
            var o = {}; var p = {}
            d.tasks.forEach(function (t) { if (t.owner) o[t.owner] = 1; if (t.project) p[t.project] = 1 })
            setOwners(Object.keys(o).sort())
            setProjects(Object.keys(p).sort())
            setServerMode(d.tasks.length > 200)
            if (typeof d.revision === 'number') setRev(d.revision)
          }
        }).catch(function () {})
        fetch('/taskkit/api/sessions').then(function (r) { return r.json() }).then(function (d) {
          if (d && d.sessions) setSessions(d.sessions)
        }).catch(function () {})
      }
      React.useEffect(function () {
        loadAll()
        var t = setInterval(loadAll, 60000)
        // SSE 实时同步（借鉴 task-board）：revision 变更即时刷新
        var es = null
        try {
          if (typeof EventSource !== 'undefined') {
            es = new EventSource('/taskkit/api/board/events')
            es.addEventListener('change', function () { loadAll() })
          }
        } catch (e) {}
        return function () { clearInterval(t); if (es) es.close() }
      }, [])

      function toggle(arr, v) {
        return arr.indexOf(v) >= 0 ? arr.filter(function (x) { return x !== v }) : arr.concat([v])
      }
      function filtered() {
        var list = tasks
        if (fSel.session.length) list = list.filter(function (t) { return fSel.session.indexOf(t.assignedSession) >= 0 })
        if (fSel.owner.length) list = list.filter(function (t) { return fSel.owner.indexOf(t.owner) >= 0 })
        if (fSel.project.length) list = list.filter(function (t) { return fSel.project.indexOf(t.project) >= 0 })
        if (fSel.status.length) list = list.filter(function (t) { return fSel.status.indexOf(t.status) >= 0 })
        if (kw) { var k = kw.toLowerCase(); list = list.filter(function (t) { return ((t.title || '') + ' ' + (t.requirement || '')).toLowerCase().indexOf(k) >= 0 }) }
        return list
      }
      var shown = filtered()
      var used = (fSel.session.length ? 1 : 0) + (fSel.owner.length ? 1 : 0) + (fSel.project.length ? 1 : 0) + (fSel.status.length ? 1 : 0) + (kw ? 1 : 0)

      function MultiSelect(label, values, key, color) {
        var selArr = fSel[key] || []
        return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
          React.createElement('span', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--tk-text-2)', whiteSpace: 'nowrap' } }, label),
          React.createElement('select', {
            multiple: true, size: 1, value: selArr,
            onChange: function (e) {
              var opts = Array.prototype.slice.call(e.target.options).filter(function (o) { return o.selected }).map(function (o) { return o.value })
              setFSel(Object.assign({}, fSel, (function () { var o = {}; o[key] = opts; return o })()))
            },
            style: { maxWidth: '120px', padding: '2px 4px', fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', border: '1px solid ' + (selArr.length ? 'var(--tk-accent)' : 'var(--tk-border-2)'), borderRadius: '4px', background: 'var(--tk-card)', color: 'var(--tk-text)' }
          }, values.map(function (v) { return React.createElement('option', { key: v, value: v }, v) }))
        )
      }

      var detail = detailId ? tasks.find(function (t) { return t.id === detailId }) : null

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px', minHeight: '50vh', fontFamily: 'inherit' } },
        // [pilot-1] 响亮失败：拿不到官方组件时不要静默降级为原样式
        !PRIM_OK ? React.createElement('div', { style: { color: 'var(--tk-error)', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', padding: '6px 8px', border: '1px solid var(--tk-error)', borderRadius: '6px', background: 'rgba(220,38,38,0.06)' } },
          '组件库不可用：@deepseek-ai/dsh-client-ui-primitives 的 Tag/StateDot 缺失（requireErr=' + (PRIM_REQ_ERR || '(none)') + '，keys=' + PRIM_KEYS.length + '）——状态探针已停用，详见 console') : null,
        // 工具栏：筛选 + 归档切换 + revision 显示
        React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', padding: '6px 8px', background: 'var(--tk-inset)', border: '1px solid var(--tk-border)', borderRadius: '8px' } },
          MultiSelect('会话', sessions.map(function (s) { return s.id }), 'session'),
          MultiSelect('负责人', owners, 'owner'),
          MultiSelect('项目', projects, 'project'),
          MultiSelect('状态', TASK_STATUSES, 'status'),
          React.createElement('input', { placeholder: '关键词…', value: kw, onChange: function (e) { setKw(e.target.value) }, style: { padding: '3px 8px', border: '1px solid var(--tk-border-2)', borderRadius: '4px', fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', background: 'var(--tk-card)', color: 'var(--tk-text)', width: '120px' } }),
          React.createElement('button', { onClick: function () { setFSel({ session: [], owner: [], project: [], status: [] }); setKw('') }, style: BTN }, '清除筛选'),
          React.createElement('button', { onClick: function () { setArchivedOnly(!archivedOnly) }, style: archivedOnly ? BTN_PRIMARY : BTN }, archivedOnly ? '📦 仅归档' : '📦 归档'),
          React.createElement('span', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: used ? 'var(--tk-accent)' : 'var(--tk-text-3)' } }, used ? ('已用 ' + used + ' 项筛选') : '全部任务'),
          rev ? React.createElement('span', { style: { fontSize: '10px', color: 'var(--tk-text-3)', marginLeft: 'auto' } }, 'rev ' + rev) : null
        ),
        // [pilot-1 探针·可见位] 看板顶部状态图例：官方 Tag + StateDot 逐条渲染 6 种状态
        // 选此处的理由：不依赖"是否有任务"（0 任务也在）、不受 60vh 看板高度挤压、不改动任务卡结构；
        // 打开「任务」页签即见，硬刷新后一眼可判组件库是否生效。失败时"响亮失败"（红字 + console.error），不静默降级。
        React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', padding: '4px 8px', border: '1px dashed var(--tk-border-2)', borderRadius: '6px' } },
          React.createElement('span', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--tk-text-2)' } }, '状态图例(primitives.Tag + StateDot)：'),
          TASK_STATUSES.map(function (st) {
            var prim = STATUS_PRIM[st] || STATUS_PRIM_FALLBACK
            return PRIM_OK
              ? React.createElement(primitives.Tag, { key: st, tone: prim.tone },
                  React.createElement(primitives.StateDot, { state: prim.state, size: 8 }),
                  ' ', st)
              : React.createElement('span', { key: st, style: { color: 'var(--tk-error)', fontWeight: 600 } }, '⚠ ' + st + '（Tag/StateDot 缺失）')
          })
        ),
        // 主体：五列看板（待执行/执行中/需审批/已完成/已取消）
        React.createElement('div', { style: { display: 'flex', gap: '8px', overflowX: 'auto', flex: 1, alignItems: 'flex-start' } },
          COLUMNS.map(function (col) {
            var colTasks = shown.filter(function (t) { return t.status === col.key && (!archivedOnly || (t.note || '').indexOf('归档') >= 0) })
            return React.createElement('div', { key: col.key, style: { flex: '1 1 180px', minWidth: '180px', maxWidth: '260px', background: 'var(--tk-inset)', borderRadius: '8px', padding: '6px', display: 'flex', flexDirection: 'column', maxHeight: '60vh' } },
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 6px', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', fontWeight: 600, color: col.color } },
                React.createElement('span', {}, col.label),
                React.createElement('span', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--tk-text-3)', background: 'rgba(107,114,128,0.1)', borderRadius: '8px', padding: '0 6px' } }, colTasks.length)
              ),
              React.createElement('div', { style: { overflow: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '4px', padding: '2px' } },
                colTasks.map(function (t) {
                  return React.createElement('div', { key: t.id, onClick: function () { setDetailId(t.id) }, style: { padding: '6px 8px', border: '1px solid ' + (detailId === t.id ? col.color : 'var(--tk-border)'), borderRadius: '6px', background: 'var(--tk-card)', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', cursor: 'pointer', borderLeft: '3px solid ' + col.color } },
                    React.createElement('div', { style: { fontWeight: 600, color: 'var(--tk-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (t.title || '')),
                    React.createElement('div', { style: { fontSize: '10px', color: 'var(--tk-text-2)', marginTop: '2px' } },
                      (t.owner || '') + (t.project ? ' · ' + t.project : '') + (t.pipeline && t.pipeline.phase ? ' · ' + t.pipeline.phase : '')),
                    React.createElement('div', { style: { fontSize: '9px', color: 'var(--tk-text-3)', marginTop: '2px' } },
                      (t.updatedAt || '').slice(0, 16).replace('T', ' '))
                  )
                }),
                !colTasks.length ? React.createElement('div', { style: { textAlign: 'center', color: '#c4c4c8', fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', padding: '12px' } }, '—') : null
              )
            )
          })
        ),
        // 详情面板（点击任务展开）
        detail ? React.createElement('div', { style: { padding: '10px', border: '1px solid var(--tk-border)', borderRadius: '8px', background: 'var(--tk-card)', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)' } },
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' } },
            React.createElement('div', { style: { fontWeight: 700, fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', color: 'var(--tk-text)' } }, detail.title),
            React.createElement('button', { onClick: function () { setDetailId(null) }, style: BTN }, '✕ 关闭')),
          React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--tk-text-2)', marginBottom: '6px' } },
            React.createElement('span', { style: { padding: '1px 6px', borderRadius: '4px', background: 'rgba(107,114,128,0.1)' } }, detail.status),
            React.createElement('span', {}, 'owner: ' + (detail.owner || '—')),
            React.createElement('span', {}, 'project: ' + (detail.project || '—')),
            React.createElement('span', {}, 'assigned: ' + (detail.assignedSession || '—')),
            detail.pipeline && detail.pipeline.phase ? React.createElement('span', {}, '阶段: ' + detail.pipeline.phase) : null),
          React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--tk-text)', background: 'var(--tk-inset)', padding: '8px', borderRadius: '6px', maxHeight: '120px', overflow: 'auto', whiteSpace: 'pre-wrap', marginBottom: '6px' } }, detail.requirement || '（无要求）'),
          detail.note ? React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--tk-text-2)', background: 'var(--tk-inset)', padding: '6px 8px', borderRadius: '6px', marginBottom: '6px' } }, 'note: ' + detail.note) : null,
          React.createElement('div', { style: { fontSize: '10px', color: 'var(--tk-text-3)' } },
            'created: ' + (detail.createdAt || '—') + ' | updated: ' + (detail.updatedAt || '—') + (detail.finishedAt ? ' | finished: ' + detail.finishedAt : '')),
          detail.lessons && detail.lessons.length ? React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--tk-success)', marginTop: '4px' } }, 'lessons: ' + detail.lessons.join(' ; ')) : null
        ) : null
      );
    }



    // ==================== 训练 / 当日成果页 ====================
    function TrainingDayPanel() {
      var [ov, setOv] = React.useState(null)
      var [sched, setSched] = React.useState(null)
      var [drafts, setDrafts] = React.useState([])
      React.useEffect(function () {
        fetch(WRITING_API + '/overview').then(function (r) { return r.json() }).then(function (d) { if (d && d.ok) setOv(d) }).catch(function () {})
        fetch(WRITING_API + '/schedule').then(function (r) { return r.json() }).then(function (d) { if (d && d.ok) setSched(d) }).catch(function () {})
        fetch(WRITING_API + '/drafts').then(function (r) { return r.json() }).then(function (d) { if (d && d.drafts) setDrafts(d.drafts) }).catch(function () {})
      }, [])
      var today = new Date().toISOString().slice(0, 10)
      var todayDaily = (ov && ov.daily || []).filter(function (d) { return d.date === today })[0] || { words: 0, entries: 0 }
      var todayDrafts = (drafts || []).filter(function (d) { return d.date === today })
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        React.createElement('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          React.createElement(Card, { label: '今日字数', value: String(todayDaily.words) }),
          React.createElement(Card, { label: '今日篇数', value: String(todayDaily.entries) }),
          React.createElement(Card, { label: '连续天数', value: ov ? String(ov.record.streak) : '—' }),
          React.createElement(Card, { label: '今日草稿', value: String(todayDrafts.length) })
        ),
        React.createElement('div', { style: { padding: '10px', border: '1px solid var(--tk-border)', borderRadius: '8px', background: 'var(--tk-card)' } },
          React.createElement('div', { style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', fontWeight: 600, marginBottom: '6px', color: 'var(--tk-text)' } }, '📅 训练日程'),
          (sched && sched.weeks || []).map(function (w) {
            return React.createElement('div', { key: w.title, style: { marginBottom: '8px' } },
              React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', fontWeight: 600, color: 'var(--tk-text)' } }, w.title + '（' + w.doneCount + '/' + w.totalCount + '）'),
              React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' } },
                w.days.map(function (d) {
                  return React.createElement('span', { key: d.key, style: { padding: '2px 6px', borderRadius: '10px', fontSize: '10px', background: d.done ? 'rgba(5,150,105,0.12)' : 'rgba(107,114,128,0.12)', color: d.done ? 'var(--tk-success)' : 'var(--tk-text-2)' } }, (d.done ? '✅ ' : '⬜ ') + d.label)
                })
              )
            )
          }),
          (!sched || !sched.weeks || !sched.weeks.length) ? React.createElement('div', { style: { color: 'var(--tk-text-3)', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)' } }, '暂无训练日程') : null
        ),
        React.createElement('div', { style: { padding: '10px', border: '1px solid var(--tk-border)', borderRadius: '8px', background: 'var(--tk-card)' } },
          React.createElement('div', { style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', fontWeight: 600, marginBottom: '6px', color: 'var(--tk-text)' } }, '📝 当日草稿'),
          todayDrafts.length ? todayDrafts.map(function (d) {
            return React.createElement('div', { key: d.name, style: { padding: '6px 0', borderBottom: '1px solid var(--tk-border)', cursor: 'pointer' } },
              React.createElement('a', { href: '#', onClick: function (ev) { ev.preventDefault(); alert('打开草稿：' + d.name) }, style: { color: 'var(--tk-success)', textDecoration: 'none' } }, d.title + '（' + d.words + ' 字）')
            )
          }) : React.createElement('div', { style: { color: 'var(--tk-text-3)', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)' } }, '今日暂无草稿')
        )
      );
    }


    // ==================== 全能写作工作台（统一入口） ====================
    function WritingStudio() {
      var [tab, setTab] = React.useState('writing')
      var [rels, setRels] = React.useState({ relations: {}, drafts: [], byInsp: {} })
      React.useEffect(function () {
        fetch('/taskkit/api/relations/list').then(function (r) { return r.json() }).then(function (d) { if (d && d.ok) setRels(d) }).catch(function () {})
      }, [])
      var tabs = [
        { key: 'writing', label: '✍️ 写作' },
        { key: 'insp', label: '💡 灵感' },
        { key: 'crelib', label: '📚 创作资源' },
        { key: 'training', label: '📊 训练成果' },
        { key: 'task', label: '🗂 任务' },
        { key: 'relations', label: '🔗 关联' }
      ]
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px', minHeight: '60vh', fontFamily: 'inherit' } },
        React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          tabs.map(function (t) { return React.createElement('button', { key: t.key, onClick: function () { setTab(t.key) }, style: tab === t.key ? BTN_PRIMARY : BTN }, t.label) })
        ),
        tab === 'writing' ? React.createElement(WritingPanel, null) : null,
        tab === 'insp' ? React.createElement(InspLibrary, null) : null,
        tab === 'crelib' ? React.createElement(CreLib, null) : null,
        tab === 'training' ? React.createElement(TrainingDayPanel, null) : null,
        tab === 'task' ? React.createElement(TaskBoard, null) : null,
        tab === 'relations' ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          React.createElement('div', { style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', fontWeight: 600, color: 'var(--tk-text)' } }, '草稿 ↔ 灵感/资源关联'),
          (rels.drafts || []).map(function (d) {
            var rel = (rels.relations || {})[d.name] || { type: '自由写作', refInspId: '', refResourceId: '', note: '' }
            return React.createElement('div', { key: d.name, style: { padding: '8px 10px', border: '1px solid var(--tk-border)', borderRadius: '8px', background: 'var(--tk-card)' } },
              React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '6px' } },
                React.createElement('span', { style: { fontWeight: 600, fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', color: 'var(--tk-text)' } }, d.title),
                React.createElement('span', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--tk-text-2)' } }, rel.type)
              ),
              React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--tk-text-3)', marginTop: '2px' } },
                (rel.refInspId ? '灵感: ' + rel.refInspId : '') + (rel.refResourceId ? (rel.refInspId ? ' / ' : '') + '资源: ' + rel.refResourceId : '') + (rel.note ? ' / ' + rel.note : '')
              )
            )
          }),
          (!rels.drafts || !rels.drafts.length) ? React.createElement('div', { style: { color: 'var(--tk-text-3)', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', textAlign: 'center', padding: '20px' } }, '暂无草稿关联数据') : null
        ) : null
      );
    }

    // ==================== 唤醒管理面板（启动自动唤醒清单：查看/增删/启停/立即唤醒，持久化 写作训练/唤醒配置.json）====================
    function WakeBoard() {
      var [data, setData] = React.useState(null)
      var [err, setErr] = React.useState('')
      var [flash, setFlash] = React.useState('')
      var [newTitle, setNewTitle] = React.useState('')
      var [newId, setNewId] = React.useState('')
      var load = function () {
        fetch('/taskkit/api/wake/list').then(function (r) { return r.json() }).then(function (d) {
          if (d && d.ok) { setData(d); setErr('') } else { setErr('加载失败') }
        }).catch(function () { setErr('加载失败') })
      }
      React.useEffect(function () {
        load()
        var t = setInterval(load, 30000)
        return function () { clearInterval(t) }
      }, [])
      var call = function (action, body, done) {
        fetch('/taskkit/api/wake/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
          .then(function (r) { return r.json() }).then(function (d) {
            if (d && d.ok) { setFlash(''); load(); if (done) done(d) }
            else { setFlash((d && d.error) || '操作失败') }
          }).catch(function () { setFlash('操作失败') })
      }
      var addEntry = function () {
        var id = (newId || '').trim()
        if (!id) { setFlash('请填写会话 id'); return }
        call('add', { id: id, title: (newTitle || '').trim() }, function () { setNewId(''); setNewTitle('') })
      }
      var removeEntry = function (e) {
        if (!window.confirm('确认从唤醒清单移除「' + e.title + '」？')) return
        call('remove', { id: e.id })
      }
      var toggleEntry = function (e) { call('toggle', { id: e.id, enabled: !e.enabled }) }
      var runAll = function () { call('run', {}) }
      var entries = (data && data.entries) || []
      var liveCount = entries.filter(function (e) { return e.live }).length
      var rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', borderBottom: '1px solid var(--tk-border)', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)' }
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px', minHeight: '50vh', fontFamily: 'inherit' } },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px' } },
          React.createElement('div', {},
            React.createElement('div', { style: { fontSize: 'var(--dsw-font-base-16-font-size, 16px)', fontWeight: 700, color: 'var(--tk-text)' } }, '⏰ 唤醒管理'),
            React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--tk-text-2)' } }, 'DSH 启动后自动唤醒清单 · ' + entries.length + ' 个会话（' + liveCount + ' 活跃）' + (data && data.updatedAt ? ' · 更新于 ' + data.updatedAt.slice(0, 16).replace('T', ' ') : ''))
          ),
          React.createElement('div', { style: { display: 'flex', gap: '6px' } },
            React.createElement('button', { onClick: load, style: BTN }, '🔄 刷新'),
            React.createElement('button', { onClick: runAll, style: BTN_PRIMARY }, '⚡ 立即唤醒')
          )
        ),
        err ? React.createElement('div', { style: { color: 'var(--tk-error)', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', padding: '6px' } }, err) : null,
        React.createElement('div', { style: { border: '1px solid var(--tk-border)', borderRadius: '8px', background: 'var(--tk-card)', overflow: 'hidden' } },
          React.createElement('div', { style: Object.assign({}, rowStyle, { background: 'var(--tk-inset)', fontWeight: 600, color: 'var(--tk-text)' }) },
            React.createElement('span', { style: { width: '22%', minWidth: '90px' } }, '标题'),
            React.createElement('span', { style: { flex: 1, minWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '会话 id'),
            React.createElement('span', { style: { width: '80px', textAlign: 'center' } }, '启用'),
            React.createElement('span', { style: { width: '70px', textAlign: 'center' } }, '状态'),
            React.createElement('span', { style: { width: '56px', textAlign: 'center' } }, '操作')
          ),
          entries.map(function (e) {
            return React.createElement('div', { key: e.id, style: rowStyle },
              React.createElement('span', { style: { width: '22%', minWidth: '90px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--tk-text)' } }, e.title),
              React.createElement('span', { style: { flex: 1, minWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--tk-text-2)', fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)' } }, e.id),
              React.createElement('span', { style: { width: '80px', textAlign: 'center' } },
                React.createElement('button', { onClick: function () { toggleEntry(e) }, style: e.enabled ? BTN_PRIMARY : BTN }, e.enabled ? '✅ 开' : '⭕ 关')
              ),
              React.createElement('span', { style: { width: '70px', textAlign: 'center', fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)' } },
                e.live ? React.createElement('span', { style: { color: 'var(--tk-success)' } }, '● 活跃') : React.createElement('span', { style: { color: 'var(--tk-text-3)' } }, '○ 休眠')
              ),
              React.createElement('span', { style: { width: '56px', textAlign: 'center' } },
                React.createElement('button', { onClick: function () { removeEntry(e) }, style: { background: 'none', border: 'none', color: 'var(--tk-error)', cursor: 'pointer', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)' } }, '🗑 删除')
              )
            )
          }),
          !entries.length ? React.createElement('div', { style: { textAlign: 'center', color: 'var(--tk-text-3)', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', padding: '20px' } }, '清单为空（配置缺失时使用内置默认三会话）') : null
        ),
        React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', padding: '8px', border: '1px solid var(--tk-border)', borderRadius: '8px', background: 'var(--tk-card)' } },
          React.createElement('span', { style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', fontWeight: 600, color: 'var(--tk-text)' } }, '➕ 添加会话'),
          React.createElement('input', { placeholder: '标题（可空自动反查）', value: newTitle, onChange: function (ev) { setNewTitle(ev.target.value) }, style: { padding: '4px 8px', border: '1px solid var(--tk-border-2)', borderRadius: '4px', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', background: 'var(--tk-card)', color: 'var(--tk-text)', width: '140px' } }),
          React.createElement('input', { placeholder: 'session-xxx', value: newId, onChange: function (ev) { setNewId(ev.target.value) }, style: { padding: '4px 8px', border: '1px solid var(--tk-border-2)', borderRadius: '4px', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', background: 'var(--tk-card)', color: 'var(--tk-text)', width: '220px' } }),
          React.createElement('button', { onClick: addEntry, style: BTN_PRIMARY }, '添加')
        ),
        flash ? React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', padding: '6px 10px', borderRadius: '6px', background: 'rgba(220,38,38,0.08)', color: 'var(--tk-error)' } }, flash) : null,
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--tk-text-3)' } }, '唤醒消息：' + ((data && data.message) || '—') + (data && data.sendMessage === false ? '（当前关闭消息发送）' : '') + ' · 配置：' + ((data && data.defaults && data.defaults.provider) || '') + ' / ' + ((data && data.defaults && data.defaults.model) || ''))
      );
    }

    // ============ 主题 token 映射（--tk-* → 宿主 --dsw-* 语义别名 + fallback）============
    // 本插件所有颜色/边框一律经 --tk-* 间接引用宿主语义别名；每个 --dsw-* 引用都带 fallback，
    // 使 token 名跨版本漂移时最坏退化为"颜色不对"，不会"样式崩掉"。
    // --tk-* 为本插件私有前缀，不改动官方 --dsw-* 命名空间。
    // --tk-accent（#d97706 品牌橙）为插件自有品牌色，宿主无对应 token ⇒ 保留字面值。
    var THEME_VARS =
      '--tk-card:var(--dsw-alias-bg-layer-1,#fff);' +
      '--tk-inset:var(--dsw-alias-bg-layer-2,#f4f4f5);' +
      '--tk-text:var(--dsw-alias-label-primary,#1f2937);' +
      '--tk-text-2:var(--dsw-alias-label-secondary,#6b7280);' +
      '--tk-text-3:var(--dsw-alias-label-tertiary,#9ca3af);' +
      '--tk-border:var(--dsw-alias-border-l1,#e4e4e7);' +
      '--tk-border-2:var(--dsw-alias-border-l2,#d4d4d8);' +
      '--tk-success:var(--dsw-alias-state-success-primary,#059669);' +
      '--tk-error:var(--dsw-alias-state-error-primary,#dc2626);' +
      '--tk-accent:#d97706;';

    var apply = function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return
      // 2026-08-25 架构简化：灵感库/创作资源/写作成果 功能已统一到 writing-studio（写作工作台），
      // taskkit 仅保留「任务」页签（任务中心五列看板，writing-studio 无此功能）
      // 2026-09-24 入口重排 2a：原 conversation.view「任务」(order2) / 「唤醒」(order3) 两个页签已移除，
      // 统一改由下方 sidebar.panellist + keyed main 承载（组件未变，仍是 TaskBoard / WakeBoard）。
      // ============ 官方侧栏入口试点（B 路线 pilot-2 · 只加不删）============
      // 用官方 sidebar.panellist 行 + keyed main 面板，把「任务看板」做成一个真·全局面板。
      // 契约（内核 rc.1，逐行核对；出处 dsh-client-ui-sidebar / dsh-client-ui-layout 的 lib/client.js）：
      //  1) sidebar.panellist 是 root 级 list 槽（sidebar-client.js:387-390 声明 / :271-282 渲染）。
      //     register 入参 = { name, id, order, label }：
      //     · id 必填，是本行自己的 cell key（同时就是 selectPanel 的 panelId、main 的 entryKey）；
      //     · order 可选，升序排位（默认 0）；label 可选，行文字（Tooltip 与展开态标题由 sidebar 自己投影）；
      //     · 渲染函数即「行首图标」，收到 owner props { size, active }（SidebarPanelIconOwnerProps）。
      //  2) main 是 root 级 keyed 槽（layout-client.js:532-535 声明）。register 入参 = { name, key }；
      //     key 必须与 panellist 的 id 相同，二者靠 activePanelId 串起来（layout-client.js:113-116）。
      //  3) 点行 → 原生 PanelRow 调 ctx.layout.selectPanel(id)（sidebar-client.js:117-119 → :370-372）；
      //     该方法先查实时 main 注册表，key 缺失直接抛错（layout-client.js:412-413）⇒ 两边必须成对注册。
      //  4) 激活态/收起态全由原生处理：active = (activePanelId === id)，收起态 CSS 自动只留图标
      //     （PanelRow sidebar-client.js:106-133）——插件无需自理。
      //  5) 原生 main 只有 key='conversation'（dsh-client-ui-conversation/lib/client.js:16823-16827），
      //     故本插件必须用全新 key，绝不占用 'conversation'，以免覆盖原生会话面板。
      //  6) 回原生会话：workspace 客户端的 openSession()/startSession() 会调 ctx.layout.selectPanel(null)
      //     （dsh-client-ui-workspace/lib/client.js:63 / :90）⇒ 点侧栏任一会话、或点「新会话」，即回会话视图。
      // 2026-09-24 2a 收口：原 conversation.view「任务」/「唤醒」页签已在本阶段删除，本块即二者的唯一入口。
      var TK_PANEL_ID = 'taskboard'
      slots.inject('sidebar.panellist', function () {
        return slots.register(
          { name: 'sidebar.panellist', id: TK_PANEL_ID, order: 2, label: '任务' },
          function (owner) {
            var size = (owner && owner.size) || 18
            var on = !!(owner && owner.active)
            var bar = function (x) {
              return React.createElement('rect', {
                x: x, y: 2.5, width: 3.4, height: 11, rx: 1.2,
                stroke: 'currentColor', strokeWidth: 1.3,
                fill: on ? 'currentColor' : 'none', fillOpacity: on ? 0.18 : 0
              })
            }
            return React.createElement('svg', {
              width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
              xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true'
            }, bar(1.8), bar(6.3), bar(10.8))
          }
        )
      })
      slots.inject('main', function () {
        return slots.register(
          { name: 'main', key: TK_PANEL_ID },
          function () { return React.createElement(TaskBoard, null); }
        )
      })
      // 「唤醒」看板同类接入：panellist 用 id、main 用同名 key（都是 'wakeboard'，见上方静默陷阱注释）。
      // order=3，排在「任务」(order=2) 之后；复用文件内既有 WakeBoard 组件（与已移除的 conversation.view
      // 唤醒页签是同一个组件，不复制）。
      var TK_WAKE_ID = 'wakeboard'
      slots.inject('sidebar.panellist', function () {
        return slots.register(
          { name: 'sidebar.panellist', id: TK_WAKE_ID, order: 3, label: '唤醒' },
          function (owner) {
            var size = (owner && owner.size) || 18
            var on = !!(owner && owner.active)
            return React.createElement('svg', {
              width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
              xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true',
              stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round'
            },
              React.createElement('circle', { cx: 8, cy: 8.9, r: 4.7, fill: on ? 'currentColor' : 'none', fillOpacity: on ? 0.18 : 0 }),
              React.createElement('path', { d: 'M8 6.3V8.9l1.9 1.1' }),
              React.createElement('path', { d: 'M3.5 4.4 2.1 3M12.5 4.4 13.9 3' }),
              React.createElement('path', { d: 'M8 1.5v1.7' }),
              React.createElement('path', { d: 'M5 12.6l-1 1M11 12.6l1 1' })
            )
          }
        )
      })
      slots.inject('main', function () {
        return slots.register(
          { name: 'main', key: TK_WAKE_ID },
          function () { return React.createElement(WakeBoard, null); }
        )
      })
      try { console.info('[taskkit] pilot-2 官方侧栏入口：sidebar.panellist id + main key = ' + TK_PANEL_ID + ' / ' + TK_WAKE_ID) } catch (e) {}
      // 2026-09-24 入口重排 2a：原「任务侧边栏入口」DOM 注入块（data-dsh-taskboard-entry + 双 MutationObserver
      // + collapsed 探测 + 收起态 CSS dsh-taskboard-collapsed-style + activateTaskView 页签点击兜底）已整体删除。
      // 原因：它靠 document.querySelector 找原生侧栏 [data-pane="sidebar"] 插按钮、再点 role="tab" 切页签，
      // 属"改 DOM 蹭原生"的旧路线；官方 sidebar.panellist + keyed main 已原生提供同一入口（见上方 pilot-2 块），
      // 且其点击目标（conversation.view 页签）本阶段已移除 ⇒ 整块连同它专用的样式/助手函数一并作废。
      // 注意：仅"侧栏入口"相关被删；本文件下方的 --tk-* 主题变量注入（TK_STYLE_ID）是另一件事，予以保留。
      // ============ 主题变量集中定义（--tk-*）注入 :root ============
      // 沿用宿主 CSS 注入约定：style 打 id 标记去重，unmount 时移除；纯 CSS，零运行时风险。
      var TK_STYLE_ID = 'dsh-taskkit-theme-style'
      if (document.getElementById(TK_STYLE_ID) === null) {
        var tkStyle = document.createElement('style')
        tkStyle.id = TK_STYLE_ID
        tkStyle.textContent = ':root{' + THEME_VARS + '}'
        ;(document.head || document.documentElement).appendChild(tkStyle)
        ctx.effect(function () { return function () { if (tkStyle.parentElement) tkStyle.parentElement.removeChild(tkStyle) } })
      }
    };
    var inject = ['timer'];

    exports.name = 'taskkit';
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
