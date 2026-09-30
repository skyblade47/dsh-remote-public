// Client：全能写作工作台 @local/writing-studio
// 入口：adapter 的「插件」抽屉（pluginDock，mode:'page'）+ 本插件注册的 keyed main 面板
//      （2b-2 起；此前是 sidebar.panellist 行，再此前是 conversation.view 页签），子模块切换：
//   灵感库/创作资源/训练成果/记忆工作台 全部调用本插件自己的 /writing-studio/api/*（host 自含 fs 读取，不依赖 taskkit）
window.__ModuleLoader__.load({
  id: '@local/writing-studio',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    // 性能优化(2026-08-26)：GET 结果 sessionStorage 缓存（key=base+action+query），30s TTL
    // 切换页签/重进工作台时避免重复 fetch；写操作(POST) 自动清掉该 base+action 的缓存
    var CLIENT_CACHE_TTL = 30000
    function cacheGet(key) {
      try {
        var raw = sessionStorage.getItem(key)
        if (!raw) return null
        var d = JSON.parse(raw)
        return (d && d.ts && Date.now() - d.ts < CLIENT_CACHE_TTL) ? d.val : null
      } catch (e) { return null }
    }
    function cacheSet(key, val) {
      try { sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), val: val })) } catch (e) {}
    }
    function cacheClearBase(prefix) {
      try {
        var n = sessionStorage.length
        var rm = []
        for (var i = 0; i < n; i++) { var k = sessionStorage.key(i); if (k && k.indexOf(prefix) === 0) rm.push(k) }
        for (var j = 0; j < rm.length; j++) sessionStorage.removeItem(rm[j])
      } catch (e) {}
    }
    function api(base, action, args) {
      var url = base + '/' + action
      if (!args) {
        var ck = 'ws-cache:' + url
        var cached = cacheGet(ck)
        if (cached !== null) return Promise.resolve(cached)
        return fetch(url, { method: 'GET' }).then(function (r) { return r.json() }).then(function (d) { cacheSet(ck, d); return d })
      }
      // 写操作：成功后清对应 base 的 GET 缓存（下次读取最新）
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args)
      }).then(function (r) { return r.json() }).then(function (d) { cacheClearBase('ws-cache:' + base); return d })
    }

    // ============ 子模块组件 ============
    // ⚠️ 2026-09-27（Q3' ① 用户拍板）：原「写作」子模块（写作记录统计 + 编辑器 + 保存到工作区）**已整体移除** ——
    //   写作已迁到桌面客户端；远端落盘改由 agent 工具 `writing_studio_save` 承担
    //   （见 docs/superpowers/plans/2026-09-27-writing-dataplane-consolidation-plan.md 的 T7）。
    //   随之一并删除（删除前已 grep 确认全部无引用）：本地暂存层（stash* + window.__writingStudioStash）、
    //   错别字静态层（TYPO_DICT/typoCheck/typoReplaceAt）、AI 三层介入（SUGGESTION_TYPES/LAYER_BADGE/
    //   classifySuggestion/layerOf/aggregateAiAnalysis/renderAiPanel）、写作教练抽屉（COACH_ENGINE_*/renderCoachDrawer）、
    //   心流条（renderFlowBar）。
    //   ✅ 保留：statCard / renderMilestoneRow（训练成果页仍用）。

    function statCard(i) {
      var colors = ['#dc2626', '#d97706', '#059669']
      return { flex: '1 1 120px', padding: 12, borderRadius: 10, border: '1px solid #e4e4e7', borderTop: '3px solid ' + colors[i % 3] }
    }

    // B4 里程碑进度条（additive，2026-08-30）：累计/连续/当日 → 当前里程碑 + 下一目标 + 进度
    function renderMilestoneRow(label, m) {
      if (!m) return null
      var progress = Math.max(0, Math.min(100, Number(m.progress) || 0))
      var color = progress >= 100 ? '#059669' : (progress >= 60 ? '#d97706' : '#3b82f6')
      var txt = m.done
        ? '🏆 已达成' + (m.current ? ' ' + m.current : '')
        : '当前 ' + (m.current || 0) + ' · 下一目标 ' + (m.next || 0) + '（' + progress + '%）'
      return React.createElement('div', { style: { marginBottom: 8 } },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 } },
          React.createElement('span', { style: { fontWeight: 500 } }, label),
          React.createElement('span', { style: { color: '#6b7280' } }, txt)),
        React.createElement('div', { style: { height: 8, background: '#f3f4f6', borderRadius: 4, overflow: 'hidden' } },
          React.createElement('div', { style: { height: '100%', width: progress + '%', background: color, transition: 'width 0.3s' } })))
    }

    // 灵感库模块（完整版：搜索/标签/新建/编辑/关联草稿，API 复用 taskkit insp 端点）
    function InspModule() {
      var [list, setList] = React.useState([])
      var [q, setQ] = React.useState('')
      var [tag, setTag] = React.useState('')
      var [status, setStatus] = React.useState('')
      var [flash, setFlash] = React.useState('')
      var [sel, setSel] = React.useState(null)
      var [form, setForm] = React.useState({ title: '', oneLiner: '', content: '', source: '', tags: '', hook: '' })
      var [relatedDrafts, setRelatedDrafts] = React.useState([])
      var TASK_INSP = '/taskkit/api/insp'
      var refresh = function () {
        var params = []
        if (q) params.push('query=' + encodeURIComponent(q))
        if (tag) params.push('tags=' + encodeURIComponent(tag))
        if (status) params.push('status=' + encodeURIComponent(status))
        var url = TASK_INSP + '/list' + (params.length ? '?' + params.join('&') : '')
        var ck = 'ws-cache:' + url
        var cached = cacheGet(ck)
        if (cached !== null) { if (cached && cached.entries) setList(cached.entries); return }
        fetch(url).then(function (r) { return r.json() }).then(function (d) {
          if (d && d.entries) { setList(d.entries); cacheSet(ck, d) }
        }).catch(function () {})
      }
      React.useEffect(function () { refresh() }, [q, tag, status])
      var openEntry = function (e) {
        setSel(e)
        setForm({ title: e.title, oneLiner: e.oneLiner || '', content: e.content || '', source: e.source || '', tags: (e.tags || []).join(', '), hook: e.hook || '' })
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
      var saveNew = function () {
        if (!form.title.trim()) { setFlash('标题必填'); return }
        fetch(TASK_INSP + '/create', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: form.title, oneLiner: form.oneLiner, content: form.content, source: form.source, tags: form.tags, hook: form.hook })
        }).then(function (r) { return r.json() }).then(function (d) {
          setFlash(d && d.ok ? '✅ 已创建' : '❌ ' + (d && d.error || '创建失败'))
          if (d && d.ok) { setForm({ title: '', oneLiner: '', content: '', source: '', tags: '', hook: '' }); setSel(null); refresh() }
        }).catch(function () { setFlash('❌ 网络错误') })
      }
      var saveEdit = function () {
        if (!sel) return
        var patch = {}
        if (form.title !== sel.title) patch.title = form.title
        if (form.oneLiner !== (sel.oneLiner || '')) patch.oneLiner = form.oneLiner
        if (form.content !== (sel.content || '')) patch.content = form.content
        if (form.source !== (sel.source || '')) patch.source = form.source
        if (form.hook !== (sel.hook || '')) patch.hook = form.hook
        if (form.tags !== (sel.tags || []).join(', ')) patch.tags = form.tags.split(',').map(function (s) { return s.trim() }).filter(Boolean)
        if (!Object.keys(patch).length) { setFlash('无修改'); return }
        fetch(TASK_INSP + '/update', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sel.id, patch: patch })
        }).then(function (r) { return r.json() }).then(function (d) {
          setFlash(d && d.ok ? '✅ 已保存' : '❌ ' + (d && d.error || '保存失败'))
          if (d && d.ok) { setSel(null); refresh() }
        }).catch(function () { setFlash('❌ 网络错误') })
      }
      var ST = ['预存', '待讨论', '已整理', '已固定']
      var allTags = []
      list.forEach(function (e) { (e.tags || []).forEach(function (t) { if (allTags.indexOf(t) < 0) allTags.push(t) }) })
      return React.createElement('div', { style: { padding: 16 } },
        React.createElement('div', { style: { fontSize: 16, fontWeight: 700, marginBottom: 10 } }, '灵感库'),
        React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' } },
          React.createElement('input', { value: q, onChange: function (e) { setQ(e.target.value) }, placeholder: '搜索灵感…', style: { padding: '4px 8px', fontSize: 12, border: '1px solid #d4d4d8', borderRadius: 5 } }),
          React.createElement('select', { value: tag, onChange: function (e) { setTag(e.target.value) }, style: { padding: '3px 6px', fontSize: 12, border: '1px solid #d4d4d8', borderRadius: 5 } },
            React.createElement('option', { value: '' }, '全部标签'),
            allTags.map(function (t) { return React.createElement('option', { key: t, value: t }, t) })),
          React.createElement('select', { value: status, onChange: function (e) { setStatus(e.target.value) }, style: { padding: '3px 6px', fontSize: 12, border: '1px solid #d4d4d8', borderRadius: 5 } },
            React.createElement('option', { value: '' }, '全部状态'),
            ST.map(function (s) { return React.createElement('option', { key: s, value: s }, s) })),
          React.createElement('button', { onClick: function () { setSel({}); setForm({ title: '', oneLiner: '', content: '', source: '', tags: '', hook: '' }); setFlash('') }, style: btn('primary') }, '＋ 新建灵感'),
          flash ? React.createElement('span', { style: { fontSize: 12, color: '#059669' } }, flash) : null),
        list.map(function (e) {
          return React.createElement('div', { key: e.id, onClick: function () { openEntry(e) }, style: { border: '1px solid #e4e4e7', borderRadius: 10, padding: 10, marginBottom: 8, cursor: 'pointer' } },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between' } },
              React.createElement('span', { style: { fontWeight: 600, fontSize: 13.5 } }, e.title),
              React.createElement('span', { style: { fontSize: 11, color: '#6b7280' } }, e.status + (e.category ? ' · ' + e.category : '') + (e.fixed ? ' · 📌' : ''))),
            React.createElement('div', { style: { marginTop: 4, fontSize: 12, color: '#6b7280' } }, (e.oneLiner || '').slice(0, 120)),
            (e.tags && e.tags.length) ? React.createElement('div', { style: { marginTop: 4 } }, e.tags.map(function (t) { return React.createElement('span', { key: t, style: { fontSize: 10, padding: '1px 6px', borderRadius: 8, background: 'rgba(217,119,6,0.1)', color: '#92400e', marginRight: 4 } }, t) })) : null)
        }),
        (!list.length) ? React.createElement('div', { style: { textAlign: 'center', color: '#9ca3af', padding: 20, fontSize: 12 } }, '无匹配灵感') : null,
        sel ? React.createElement('div', { style: { marginTop: 12, border: '1px solid #e4e4e7', borderRadius: 10, padding: 12, background: '#fafafa' } },
          React.createElement('div', { style: { fontWeight: 700, fontSize: 13, marginBottom: 8 } }, sel.id ? '编辑灵感：' + sel.title : '新建灵感'),
          React.createElement('input', { value: form.title, onChange: function (e) { setForm(Object.assign({}, form, { title: e.target.value })) }, placeholder: '标题*', style: fieldStyle() }),
          React.createElement('input', { value: form.oneLiner, onChange: function (e) { setForm(Object.assign({}, form, { oneLiner: e.target.value })) }, placeholder: '一句话灵感', style: fieldStyle() }),
          React.createElement('textarea', { value: form.content, onChange: function (e) { setForm(Object.assign({}, form, { content: e.target.value })) }, placeholder: '内容/详细设定', rows: 4, style: Object.assign(fieldStyle(), { fontFamily: 'inherit', lineHeight: 1.6 }) }),
          React.createElement('input', { value: form.tags, onChange: function (e) { setForm(Object.assign({}, form, { tags: e.target.value })) }, placeholder: '标签（逗号分隔）', style: fieldStyle() }),
          React.createElement('input', { value: form.hook, onChange: function (e) { setForm(Object.assign({}, form, { hook: e.target.value })) }, placeholder: '钩子（可选）', style: fieldStyle() }),
          relatedDrafts.length ? React.createElement('div', { style: { fontSize: 11, color: '#047857', marginBottom: 6 } }, '关联草稿: ' + relatedDrafts.map(function (d) { return d.title || d.name }).join('、')) : null,
          React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
            React.createElement('button', { onClick: sel.id ? saveEdit : saveNew, style: btn('primary') }, sel.id ? '保存修改' : '创建'),
            React.createElement('button', { onClick: function () { setSel(null); setFlash('') }, style: btn('') }, '取消')))
        : null)
    }
    function fieldStyle() {
      return { width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: 12, border: '1px solid #d4d4d8', borderRadius: 5, marginBottom: 6 }
    }

    // 创作资源模块（归类分组 + 关联展示）
    function ResourceModule() {
      var [data, setData] = React.useState(null)
      React.useEffect(function () {
        api('/writing-studio/api', 'overview').then(function (d) { if (d && d.ok) setData(d) })
      }, [])
      if (!data) return React.createElement('div', { style: { padding: 16, color: '#6b7280' } }, '加载创作资源…')
      var cats = ['主攻', '备选', '冻结', '待启动']
      var colors = { '主攻': '#dc2626', '备选': '#d97706', '冻结': '#6b7280', '待启动': '#059669' }
      return React.createElement('div', { style: { padding: 16 } },
        React.createElement('div', { style: { fontSize: 16, fontWeight: 700, marginBottom: 12 } }, '创作资源库（' + (data.inspTotal !== undefined ? data.inspTotal : (data.total || 0)) + ' 条灵感）'),
        cats.map(function (k) {
          var items = (data.groups || {})[k] || []
          return React.createElement('div', { key: k, style: { marginBottom: 10 } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 } },
              React.createElement('span', { style: { width: 10, height: 10, borderRadius: 5, background: colors[k] } }),
              React.createElement('span', { style: { fontSize: 13, fontWeight: 600 } }, k + '（' + items.length + '）')),
            items.map(function (e) {
              return React.createElement('div', { key: e.id, style: { marginLeft: 16, fontSize: 12, color: '#374151', padding: '3px 0' } },
                React.createElement('span', { style: { fontWeight: 500 } }, e.title),
                (e.drafts && e.drafts.length) ? React.createElement('span', { style: { color: '#6b7280', marginLeft: 8 } }, '↔ ' + e.drafts.join('、')) : null)
            }))
        }))
    }

    // 训练成果模块（写作记录 + 日程 + 草稿 + 关联，/writing-studio/api/training）
    function TrainingModule() {
      var [data, setData] = React.useState(null)
      var [err, setErr] = React.useState('')
      var [milestones, setMilestones] = React.useState(null)
      React.useEffect(function () {
        api('/writing-studio/api', 'training').then(function (d) {
          if (d && d.ok) setData(d.training); else setErr('训练数据加载失败')
        }).catch(function () { setErr('训练数据加载失败') })
        // B4 里程碑（additive）：独立拉取，失败不阻塞主数据
        api('/writing-studio/api', 'milestones').then(function (d) {
          if (d && d.ok) setMilestones(d)
        }).catch(function () {})
      }, [])
      if (err) return React.createElement('div', { style: { padding: 16, color: '#dc2626' } }, err)
      if (!data) return React.createElement('div', { style: { padding: 16, color: '#6b7280' } }, '加载训练成果…')
      var rec = data.record || {}
      return React.createElement('div', { style: { padding: 16 } },
        React.createElement('div', { style: { fontSize: 16, fontWeight: 700, marginBottom: 12 } }, '训练 / 当日成果'),
        React.createElement('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 } },
          React.createElement('div', { style: statCard(0) }, React.createElement('div', { style: { fontSize: 24, fontWeight: 700 } }, rec.totalWords || 0), React.createElement('div', { style: { fontSize: 12, color: '#6b7280' } }, '总字数')),
          React.createElement('div', { style: statCard(1) }, React.createElement('div', { style: { fontSize: 24, fontWeight: 700 } }, rec.streak || 0), React.createElement('div', { style: { fontSize: 12, color: '#6b7280' } }, '连续天数')),
          React.createElement('div', { style: statCard(2) }, React.createElement('div', { style: { fontSize: 24, fontWeight: 700 } }, rec.days || 0), React.createElement('div', { style: { fontSize: 12, color: '#6b7280' } }, '训练天数'))),
        milestones ? React.createElement('div', { style: { marginBottom: 12, border: '1px solid #e4e4e7', borderRadius: 10, padding: 10, background: '#fafafa' } },
          React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '🏆 里程碑（' + (milestones.todayWords || 0) + ' / ' + (milestones.totalWordsNow || 0) + ' 字）'),
          renderMilestoneRow('累计字数', milestones.totalWords),
          renderMilestoneRow('连续天数', milestones.streak),
          renderMilestoneRow('今日字数', milestones.dayWords)) : null,
        React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '每日字数'),
        React.createElement('div', { style: { marginBottom: 12 } },
          (data.daily || []).slice(-7).map(function (d) {
            return React.createElement('div', { key: d.date, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '2px 0' } },
              React.createElement('span', { style: { width: 90, color: '#6b7280' } }, d.date),
              React.createElement('div', { style: { height: 12, background: '#f3f4f6', borderRadius: 4, flex: 1, maxWidth: 300, overflow: 'hidden' } },
                React.createElement('div', { style: { height: '100%', width: Math.min(100, (d.words || 0) / 10) + '%', background: '#059669' } })),
              React.createElement('span', { style: { color: '#374151' } }, String(d.words) + ' 字'))
          })),
        React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '草稿 ' + (data.draftCount || 0) + ' 篇 · 关联 ' + (data.relationsCount || 0) + ' 条'),
        (data.drafts || []).slice(0, 10).map(function (d) {
          return React.createElement('div', { key: d.name, style: { fontSize: 12, padding: '3px 0', color: '#374151' } },
            React.createElement('span', {}, d.name),
            d.inspTitle ? React.createElement('span', { style: { color: '#d97706', marginLeft: 8 } }, '← ' + d.inspTitle) : null)
        }))
    }

    // ============ 工作台主组件（子模块切换） ============
    function StudioHome() {
      var [tab, setTab] = React.useState('insp')
      var tabs = [
        { id: 'insp', label: '灵感库', comp: InspModule },
        { id: 'resource', label: '创作资源', comp: ResourceModule },
        { id: 'training', label: '训练成果', comp: TrainingModule },
        { id: 'mem', label: '🧠 记忆工作台', comp: MemWorkbench }
      ]
      return React.createElement('div', { style: { height: '100%', display: 'flex', flexDirection: 'column' } },
        React.createElement('div', { style: { display: 'flex', gap: 4, padding: '10px 12px 0', borderBottom: '1px solid #e4e4e7' } },
          tabs.map(function (t) {
            var active = tab === t.id
            return React.createElement('button', {
              key: t.id,
              onClick: function () { setTab(t.id) },
              style: { fontSize: 13, padding: '6px 14px', border: 'none', borderBottom: active ? '2px solid #d97706' : '2px solid transparent', background: 'transparent', color: active ? '#d97706' : '#6b7280', fontWeight: active ? 600 : 400, cursor: 'pointer' }
            }, t.label)
          })),
        React.createElement('div', { style: { flex: 1, overflow: 'auto', minHeight: 0 } },
          React.createElement(tabs.find(function (t) { return t.id === tab }).comp, null)))
    }

    // ============ U3 记忆工作台（Phase1 2026-09-02 additive：四入口框架 作品/工程/对话/偏好） ============
    // U1 工程记忆面板 / U2 作品灵感看板 / 对话·偏好 框架页；数据走既有 HTTP 端点 + writing-studio 自持 sidecar，零契约破坏
    var MEM_WS_API = '/writing-studio/api'
    var MEM_MS_API = '/memory-system/api'
    var MEM_INSP_API = '/taskkit/api/insp'
    var MEM_INSP_COLS = ['预存', '待讨论', '已整理', '已固定']
    var MEM_INSP_COL_COLOR = { '预存': '#3b82f6', '待讨论': '#d97706', '已整理': '#059669', '已固定': '#7c3aed' }
    var MEM_REUSE_ROLES = ['主轴', '支线', '改造']
    var MEM_REUSE_COLOR = { '主轴': '#dc2626', '支线': '#d97706', '改造': '#059669' }
    // Phase2 客户端侧枚举（host 另有同名白名单兜底）
    var KB_CATEGORIES = ['创作设定', '创作技法', '创作资料', '踩坑经验·写作', '方法论', '通用']
    var MEMORY_RECORD_TYPES = ['message', 'thought', 'artifact']
    var PREFS_STRICTNESS_CLI = ['严格', '标准', '宽松']
    // R1 定稿：memSummary 一律 POST {}（api() POST 分支不读 GET 缓存、必达 host，成功后清本 base GET 缓存）
    function memSummaryLoad() { return api(MEM_WS_API, 'memSummary', {}) }
    function memReuseList() { return api(MEM_WS_API, 'reuseList', {}) }
    function memReuseSet(id, role) { return api(MEM_WS_API, 'reuseSet', { id: id, role: role || '' }) }
    // ===== Phase2（2026-09-03 additive）：U4 资产图谱 / U5 作品档案 / U7 提炼台 / U8 偏好 —— 全部 POST（POST 分支必达 host + 成功清 ws-cache，R1）=====
    function memAssetGraph() { return api(MEM_WS_API, 'assetGraph', {}) }
    function memWorkSave(payload) { return api(MEM_WS_API, 'workSave', payload || {}) }
    function memWorkDelete(id) { return api(MEM_WS_API, 'workDelete', { id: id }) }
    function memAssetLink(payload) { return api(MEM_WS_API, 'assetLink', payload || {}) }
    function memAssetUnlink(inspId, workId) { return api(MEM_WS_API, 'assetUnlink', { inspId: inspId, workId: workId }) }
    function memWorkArchive(id) { return api(MEM_WS_API, 'workArchive', { id: id }) }
    function memDistillList() { return api(MEM_WS_API, 'distillList', {}) }
    function memDistill(target, payload) { return api(MEM_WS_API, 'distill' + target.charAt(0).toUpperCase() + target.slice(1), payload || {}) }
    function memPrefsGet() { return api(MEM_WS_API, 'prefsGet', {}) }
    function memPrefsSet(payload) { return api(MEM_WS_API, 'prefsSet', payload || {}) }
    function memInput(extra) { return Object.assign({ fontSize: 12, padding: '4px 8px', border: '1px solid #d4d4d8', borderRadius: 6, width: '100%', boxSizing: 'border-box' }, extra || {}) }
    function memCard(extra) { return Object.assign({ border: '1px solid #e4e4e7', borderRadius: 8, padding: 8, marginBottom: 6, background: '#fff' }, extra || {}) }
    function memGet(url) { return fetch(url).then(function (r) { return r.json() }) }
    function memPost(url, payload) {
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) }).then(function (r) { return r.json() })
    }
    function memBtn(text, kind, onClick, disabled, extra) {
      var k = kind || ''
      var s = { fontSize: 11, padding: '2px 8px', borderRadius: 6, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1 }
      if (k === 'primary') s = Object.assign(s, { background: '#d97706', color: '#fff', border: '1px solid #d97706' })
      else if (k === 'danger') s = Object.assign(s, { background: '#fff', color: '#dc2626', border: '1px solid #dc2626' })
      else if (k === 'soft-on') s = Object.assign(s, { background: 'rgba(217,119,6,0.16)', color: '#b45309', border: '1px solid #d97706' })
      else if (k === 'muted-on') s = Object.assign(s, { background: 'rgba(220,38,38,0.08)', color: '#b91c1c', border: '1px solid #fca5a5' })
      else s = Object.assign(s, { background: '#fff', color: '#374151', border: '1px solid #d4d4d8' })
      if (extra) s = Object.assign(s, extra)
      return React.createElement('button', { onClick: onClick, disabled: disabled, style: s }, text)
    }
    // Phase3 批次3（additive）：带 data-* 钩子与 title 的按钮（attrs 合并进 props；样式/配色与 memBtn 同构）
    function memBtnA(text, kind, onClick, disabled, attrs, extra) {
      var k = kind || ''
      var s = { fontSize: 11, padding: '2px 8px', borderRadius: 6, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1 }
      if (k === 'primary') s = Object.assign(s, { background: '#d97706', color: '#fff', border: '1px solid #d97706' })
      else if (k === 'danger') s = Object.assign(s, { background: '#fff', color: '#dc2626', border: '1px solid #dc2626' })
      else if (k === 'soft-on') s = Object.assign(s, { background: 'rgba(217,119,6,0.16)', color: '#b45309', border: '1px solid #d97706' })
      else if (k === 'muted-on') s = Object.assign(s, { background: 'rgba(220,38,38,0.08)', color: '#b91c1c', border: '1px solid #fca5a5' })
      else s = Object.assign(s, { background: '#fff', color: '#374151', border: '1px solid #d4d4d8' })
      if (extra) s = Object.assign(s, extra)
      var props = Object.assign({}, attrs || {})
      props.onClick = onClick
      props.disabled = disabled
      props.style = s
      return React.createElement('button', props, text)
    }
    // Phase3 批次3（additive）：数值安全回退（undefined/null/NaN → 默认值）
    function memNum(v, d) { var n = Number(v); return (typeof v === 'number' && isFinite(n)) ? n : d }
    function memTag(text, hex) {
      return React.createElement('span', { style: { fontSize: 10, padding: '1px 6px', borderRadius: 8, background: hex ? 'rgba(0,0,0,0.05)' : 'rgba(217,119,6,0.1)', color: hex || '#92400e', marginRight: 4, border: hex ? '1px solid ' + hex : 'none' } }, text)
    }
    function memStat(label, value, color) {
      return React.createElement('div', { style: { flex: '0 0 auto', minWidth: 92, padding: '8px 10px', borderRadius: 10, border: '1px solid #e4e4e7', borderTop: '3px solid ' + (color || '#6b7280'), background: '#fff' } },
        React.createElement('div', { style: { fontSize: 18, fontWeight: 700 } }, value),
        React.createElement('div', { style: { fontSize: 11, color: '#6b7280' } }, label))
    }
    function memLoading() {
      return React.createElement('div', { style: { padding: 24, color: '#6b7280', fontSize: 12 } }, '加载中…')
    }
    function memErrBox(msg) {
      return React.createElement('div', { style: { padding: 16, color: '#dc2626', fontSize: 12 } }, msg)
    }
    function memEmptyBox(text) {
      return React.createElement('div', { style: { textAlign: 'center', color: '#9ca3af', padding: 18, fontSize: 12 } }, text)
    }
    // 灵感看板分组：按 status 分四列（未知状态独立列），列内 fixed 置顶 + updatedAt 新→旧
    function memGroupInsp(entries) {
      var groups = {}
      var extras = {}
      var pinnedTotal = 0
      ;(Array.isArray(entries) ? entries : []).forEach(function (e) {
        if (e.fixed) pinnedTotal++
        var st = e.status || ''
        if (MEM_INSP_COLS.indexOf(st) >= 0) {
          if (!groups[st]) groups[st] = []
          groups[st].push(e)
        } else {
          if (!extras[st]) extras[st] = []
          extras[st].push(e)
        }
      })
      var sortFn = function (a, b) {
        if ((a.fixed ? 1 : 0) !== (b.fixed ? 1 : 0)) return (b.fixed ? 1 : 0) - (a.fixed ? 1 : 0)
        var at = a.updatedAt || '', bt = b.updatedAt || ''
        return at < bt ? 1 : (at > bt ? -1 : 0)
      }
      var cols = MEM_INSP_COLS.map(function (c) { return { status: c, items: (groups[c] || []).sort(sortFn) } })
      Object.keys(extras).forEach(function (c) { cols.push({ status: c, items: extras[c].sort(sortFn) }) })
      return { cols: cols, pinnedTotal: pinnedTotal }
    }
    // ============ U3 骨架：记忆工作台容器（四入口导航 作品/工程/对话/偏好） ============
    function MemWorkbench() {
      var [view, setView] = React.useState('works')
      var navs = [
        { id: 'works', label: '🎨 作品记忆' },
        { id: 'engine', label: '⚙️ 工程记忆' },
        { id: 'talk', label: '💬 对话记忆' },
        { id: 'prefs', label: '👤 用户偏好' }
      ]
      var comps = { works: MemWorksView, engine: MemEngineView, talk: MemTalkView, prefs: MemPrefsView }
      return React.createElement('div', { 'data-mem-workbench': '1', style: { height: '100%', display: 'flex', flexDirection: 'column' } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '12px 14px 0', borderBottom: '1px solid #e4e4e7', flexWrap: 'wrap' } },
          React.createElement('span', { style: { fontSize: 15, fontWeight: 700, marginRight: 6 } }, '🧠 记忆工作台'),
          navs.map(function (n) {
            var active = view === n.id
            return React.createElement('button', {
              key: n.id,
              'data-mem-nav': n.id,
              onClick: function () { setView(n.id) },
              style: { fontSize: 13, padding: '6px 12px', border: 'none', borderBottom: active ? '2px solid #d97706' : '2px solid transparent', background: 'transparent', color: active ? '#d97706' : '#6b7280', fontWeight: active ? 600 : 400, cursor: 'pointer' }
            }, n.label)
          })),
        React.createElement('div', { style: { flex: 1, overflow: 'auto', minHeight: 0 } },
          React.createElement(comps[view], null)))
    }
    // ============ U2 作品记忆 · 灵感看板（预存/待讨论/已整理/已固定 四列 + 固定置顶 + 复用标记 主轴/支线/改造） ============
    function MemWorksView() {
      var [sub, setSub] = React.useState('board') // Phase2 U4：board=灵感看板（默认）/ library=灵感资产库
      var [board, setBoard] = React.useState(null)
      var [marks, setMarks] = React.useState({})
      var [q, setQ] = React.useState('')
      var [err, setErr] = React.useState('')
      var [busyKey, setBusyKey] = React.useState('')
      var [flash, setFlash] = React.useState('')
      var loadAll = function () {
        setErr('')
        Promise.all([memGet(MEM_INSP_API + '/list'), memReuseList()]).then(function (rs) {
          var d = rs[0], m = rs[1]
          if (d && d.entries) {
            setBoard(memGroupInsp(d.entries))
            if (m && m.ok) setMarks(m.marks || {})
          } else {
            setErr('灵感列表加载失败：' + ((d && d.error) || '未知错误'))
          }
        }).catch(function (e) { setErr('灵感看板加载失败：' + (e && e.message || '网络错误')) })
      }
      React.useEffect(function () { loadAll() }, [])
      var doStatus = function (item, next) {
        if (busyKey) return
        setBusyKey(item.id + ':st'); setFlash('')
        memPost(MEM_INSP_API + '/update', { id: item.id, patch: { status: next } }).then(function (d) {
          setBusyKey('')
          if (d && d.ok) { setFlash('已移至「' + next + '」：' + item.title); loadAll() }
          else setFlash('❌ ' + ((d && d.error) || '状态更新失败'))
        }).catch(function (e) { setBusyKey(''); setFlash('❌ 请求失败：' + (e && e.message || '网络错误')) })
      }
      var doPin = function (item) {
        if (busyKey) return
        setBusyKey(item.id + ':pin'); setFlash('')
        memPost(MEM_INSP_API + '/toggleFixed', { id: item.id }).then(function (d) {
          setBusyKey('')
          if (d && d.ok) { setFlash((d.fixed ? '📌 已固定（置顶）' : '已取消固定') + '：' + item.title); loadAll() }
          else setFlash('❌ ' + ((d && d.error) || '固定失败'))
        }).catch(function (e) { setBusyKey(''); setFlash('❌ 请求失败：' + (e && e.message || '网络错误')) })
      }
      var doRole = function (item, role) {
        if (busyKey) return
        setBusyKey(item.id + ':role'); setFlash('')
        memReuseSet(item.id, role).then(function (d) {
          setBusyKey('')
          if (d && d.ok) { setMarks(d.marks || {}); setFlash(role ? ('复用标记「' + role + '」：' + item.title) : '已清除复用标记：' + item.title) }
          else setFlash('❌ ' + ((d && d.error) || '复用标记保存失败'))
        }).catch(function (e) { setBusyKey(''); setFlash('❌ 请求失败：' + (e && e.message || '网络错误')) })
      }
      if (sub === 'library') return React.createElement(MemAssetLibrary, { onBack: function () { setSub('board'); loadAll() } })
      if (err) return React.createElement('div', { 'data-mem-view': 'works' }, memErrBox(err))
      if (!board) return React.createElement('div', { 'data-mem-view': 'works' }, memLoading())
      var keyword = q.trim().toLowerCase()
      var match = function (e) {
        if (!keyword) return true
        return (e.title + ' ' + (e.oneLiner || '') + ' ' + (e.content || '') + ' ' + (e.tags || []).join(' ')).toLowerCase().indexOf(keyword) >= 0
      }
      var movePrev = function (item) {
        var idx = MEM_INSP_COLS.indexOf(item.status)
        if (idx <= 0) return
        doStatus(item, MEM_INSP_COLS[idx - 1])
      }
      var moveNext = function (item) {
        var idx = MEM_INSP_COLS.indexOf(item.status)
        if (idx < 0 || idx >= MEM_INSP_COLS.length - 1) return
        doStatus(item, MEM_INSP_COLS[idx + 1])
      }
      return React.createElement('div', { 'data-mem-view': 'works', style: { padding: 12 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
          React.createElement('span', { style: { fontSize: 16, fontWeight: 700 } }, '🎨 作品记忆 · 灵感看板'),
          React.createElement('span', { style: { fontSize: 11, color: '#6b7280' } }, '共 ' + (board.cols.reduce(function (a, c) { return a + c.items.length }, 0)) + ' 条 · 📌 置顶 ' + board.pinnedTotal),
          React.createElement('input', { value: q, onChange: function (ev) { setQ(ev.target.value) }, placeholder: '🔍 过滤…', style: { padding: '3px 8px', fontSize: 12, border: '1px solid #d4d4d8', borderRadius: 5, width: 160 } }),
          memBtn('📚 灵感资产库', 'primary', function () { setSub('library') }),
          memBtn('🔄 刷新', '', loadAll),
          flash ? React.createElement('span', { style: { fontSize: 11, color: flash.indexOf('❌') === 0 ? '#dc2626' : '#059669' } }, flash) : null),
        React.createElement('div', { style: { display: 'flex', gap: 10, alignItems: 'flex-start', overflowX: 'auto', paddingBottom: 8 } },
          board.cols.map(function (col) {
            var visible = col.items.filter(match)
            var color = MEM_INSP_COL_COLOR[col.status] || '#6b7280'
            return React.createElement('div', {
              key: col.status,
              'data-insp-col': col.status,
              style: { flex: '0 0 255px', border: '1px solid #e4e4e7', borderRadius: 10, background: '#fafafa', padding: 8 }
            },
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } },
                React.createElement('span', { style: { width: 9, height: 9, borderRadius: 5, background: color } }),
                React.createElement('span', { style: { fontSize: 13, fontWeight: 600 } }, col.status + '（' + visible.length + '）')),
              visible.length ? visible.map(function (item) {
                var role = (marks[item.id] && marks[item.id].role) || ''
                var idx = MEM_INSP_COLS.indexOf(item.status)
                return React.createElement('div', {
                  key: item.id,
                  'data-insp-card': item.id,
                  style: { border: '1px solid #e4e4e7', borderRadius: 8, padding: 7, marginBottom: 6, background: '#fff', borderLeft: '3px solid ' + (item.fixed ? '#7c3aed' : '#e4e4e7') }
                },
                  React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
                    React.createElement('span', { style: { fontWeight: 600, fontSize: 12.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: item.title }, (item.fixed ? '📌 ' : '') + item.title),
                    memBtn(item.fixed ? '取消固定' : '固定', item.fixed ? 'soft-on' : '', function () { doPin(item) }, busyKey === item.id + ':pin')),
                  React.createElement('div', { style: { fontSize: 11, color: '#6b7280', marginTop: 3, lineHeight: 1.5 } }, (item.oneLiner || '').slice(0, 90)),
                  (item.tags && item.tags.length) ? React.createElement('div', { style: { marginTop: 3 } }, item.tags.slice(0, 4).map(function (t) { return React.createElement('span', { key: t, style: { fontSize: 9.5, padding: '0 5px', borderRadius: 7, background: 'rgba(217,119,6,0.1)', color: '#92400e', marginRight: 3 } }, t) })) : null,
                  React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 4, marginTop: 5 } },
                    idx >= 0 ? React.createElement('button', {
                      'data-insp-move': 'prev',
                      onClick: function () { movePrev(item) },
                      disabled: idx === 0 || busyKey !== '',
                      title: '移到上一列',
                      style: { fontSize: 11, padding: '1px 7px', borderRadius: 5, border: '1px solid #d4d4d8', background: '#fff', color: idx === 0 ? '#cbd5e1' : '#374151', cursor: idx === 0 ? 'default' : 'pointer' }
                    }, '‹') : null,
                    idx >= 0 ? React.createElement('button', {
                      'data-insp-move': 'next',
                      onClick: function () { moveNext(item) },
                      disabled: idx >= MEM_INSP_COLS.length - 1 || busyKey !== '',
                      title: '移到下一列',
                      style: { fontSize: 11, padding: '1px 7px', borderRadius: 5, border: '1px solid #d4d4d8', background: '#fff', color: idx >= MEM_INSP_COLS.length - 1 ? '#cbd5e1' : '#374151', cursor: idx >= MEM_INSP_COLS.length - 1 ? 'default' : 'pointer' }
                    }, '›') : null,
                    React.createElement('span', { style: { fontSize: 10, color: color, marginRight: 'auto' } }, idx >= 0 ? MEM_INSP_COLS[idx] : item.status),
                    React.createElement('select', {
                      'data-insp-role': item.id,
                      value: role,
                      disabled: busyKey !== '',
                      title: '复用标记（主轴/支线/改造）',
                      onChange: function (ev) { doRole(item, ev.target.value) },
                      style: { fontSize: 10, padding: '1px 3px', border: '1px solid #d4d4d8', borderRadius: 5, background: '#fff', maxWidth: 92 }
                    },
                      React.createElement('option', { value: '' }, '复用:未用'),
                      MEM_REUSE_ROLES.map(function (r) { return React.createElement('option', { key: r, value: r }, r) }))))
              }) : memEmptyBox('无卡片' + (keyword ? '（被过滤）' : '')))
          })))
    }
    // ============ Phase2 U4：灵感资产库·复用图谱（作品注册 + 灵感→作品多值使用关系，双向引用；sidecar 自持） ============
    var MEM_ASSET_STATUS = ['在用', '已完成', '搁置']
    function MemUseRow(props) {
      var r = props.r
      var color = MEM_REUSE_COLOR[r.role] || '#6b7280'
      return React.createElement('div', { 'data-asset-use': r.workId, style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, flexWrap: 'wrap' } },
        React.createElement('span', { style: { fontSize: 11, padding: '1px 7px', borderRadius: 8, background: color, color: '#fff', fontWeight: 600 } }, r.role),
        React.createElement('span', { style: { fontSize: 12, fontWeight: 600 } }, '→ ' + (r.workTitle || r.workId)),
        r.adapt ? React.createElement('span', { style: { fontSize: 11, color: '#6b7280' } }, '改造：' + r.adapt) : null,
        React.createElement('span', { style: { fontSize: 10, color: '#9ca3af' } }, '（' + (r.status || '在用') + '）'),
        React.createElement('button', { 'data-asset-unlink': r.workId, onClick: props.onUnlink, disabled: props.busy, style: { fontSize: 10, padding: '1px 7px', borderRadius: 5, border: '1px solid #fca5a5', background: '#fff', color: '#dc2626', cursor: 'pointer', marginLeft: 'auto' } }, '移除'))
    }
    function MemLinkForm(props) {
      var [open, setOpen] = React.useState(false)
      var [workId, setWorkId] = React.useState('')
      var [role, setRole] = React.useState('主轴')
      var [adapt, setAdapt] = React.useState('')
      var [status, setStatus] = React.useState('在用')
      if (!props.works.length) return React.createElement('div', { style: { fontSize: 10.5, color: '#9ca3af', marginTop: 5 } }, '（先「新建作品」才能关联）')
      if (!open) return React.createElement('div', { style: { marginTop: 5 } },
        React.createElement('button', { 'data-asset-link-add': props.inspId, onClick: function () { setOpen(true) }, disabled: props.busy, style: { fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '1px dashed #d97706', background: '#fff', color: '#b45309', cursor: 'pointer' } }, '＋ 关联到作品'))
      return React.createElement('div', { 'data-asset-link-form': props.inspId, style: { marginTop: 6, padding: 6, border: '1px dashed #fdba74', borderRadius: 6, background: '#fff7ed' } },
        React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          React.createElement('select', { value: workId, onChange: function (ev) { setWorkId(ev.target.value) }, style: { fontSize: 11, padding: '2px 4px', border: '1px solid #d4d4d8', borderRadius: 5 } },
            React.createElement('option', { value: '' }, '选择作品…'),
            props.works.map(function (w) { return React.createElement('option', { key: w.id, value: w.id }, w.title) })),
          React.createElement('select', { value: role, onChange: function (ev) { setRole(ev.target.value) }, style: { fontSize: 11, padding: '2px 4px', border: '1px solid #d4d4d8', borderRadius: 5 } },
            MEM_REUSE_ROLES.map(function (r) { return React.createElement('option', { key: r, value: r }, r) })),
          React.createElement('select', { value: status, onChange: function (ev) { setStatus(ev.target.value) }, style: { fontSize: 11, padding: '2px 4px', border: '1px solid #d4d4d8', borderRadius: 5 } },
            MEM_ASSET_STATUS.map(function (s) { return React.createElement('option', { key: s, value: s }, s) })),
          React.createElement('input', { value: adapt, onChange: function (ev) { setAdapt(ev.target.value.slice(0, 200)) }, placeholder: '改造说明（可选，≤200字）', style: { fontSize: 11, padding: '2px 6px', border: '1px solid #d4d4d8', borderRadius: 5, flex: 1, minWidth: 140 } })),
        React.createElement('div', { style: { marginTop: 6, display: 'flex', gap: 6 } },
          React.createElement('button', { 'data-asset-link-ok': props.inspId, onClick: function () { if (!workId) return; props.onLink(workId, role, adapt.trim(), status); setOpen(false); setWorkId(''); setAdapt('') }, disabled: props.busy || !workId, style: { fontSize: 11, padding: '2px 10px', borderRadius: 6, border: '1px solid #d97706', background: '#d97706', color: '#fff', cursor: 'pointer' } }, '确认关联'),
          React.createElement('button', { onClick: function () { setOpen(false) }, style: { fontSize: 11, padding: '2px 10px', borderRadius: 6, border: '1px solid #d4d4d8', background: '#fff', cursor: 'pointer' } }, '取消')))
    }
    function MemAssetLibrary(props) {
      var [graph, setGraph] = React.useState(null)
      var [err, setErr] = React.useState('')
      var [flash, setFlash] = React.useState('')
      var [busy, setBusy] = React.useState(false)
      var [newTitle, setNewTitle] = React.useState('')
      var [newNote, setNewNote] = React.useState('')
      var [showNew, setShowNew] = React.useState(false)
      var [openWork, setOpenWork] = React.useState(null)
      var reload = function () {
        memAssetGraph().then(function (d) {
          if (d && d.ok) { setGraph(d); setErr('') } else setErr((d && d.error) || '资产图谱加载失败')
        }).catch(function (e) { setErr('资产图谱加载失败：' + (e && e.message || '网络错误')) })
      }
      React.useEffect(function () { reload() }, [])
      var done = function (msg) { setBusy(false); setFlash(msg); reload() }
      var fail = function (d) { setBusy(false); setFlash('❌ ' + ((d && d.error) || '操作失败')) }
      var createWork = function () {
        var title = newTitle.trim()
        if (!title) { setFlash('❌ 作品标题必填'); return }
        setBusy(true); setFlash('')
        memWorkSave({ title: title, note: newNote }).then(function (d) {
          if (d && d.ok) { setNewTitle(''); setNewNote(''); setShowNew(false); done('✅ 已新建作品：' + d.work.title) } else fail(d)
        }).catch(function (e) { fail({ error: (e && e.message) || '网络错误' }) })
      }
      var deleteWork = function (wk) {
        if (!window.confirm('删除作品「' + wk.title + '」？其名下 ' + wk.inspCount + ' 条灵感关联将一并移除（仅资产库 sidecar，不影响灵感库）。')) return
        setBusy(true); setFlash('')
        memWorkDelete(wk.id).then(function (d) { if (d && d.ok) done('🗑 已删除作品，移除关联 ' + (d.removedUses || 0) + ' 条'); else fail(d) }).catch(function (e) { fail({ error: (e && e.message) || '网络错误' }) })
      }
      if (openWork && graph) return React.createElement(MemWorkArchive, { key: openWork, workId: openWork, onBack: function () { setOpenWork(null); reload() }, onChanged: reload, setFlash: setFlash })
      if (err) return React.createElement('div', { 'data-asset-view': 'library' }, memErrBox(err))
      if (!graph) return React.createElement('div', { 'data-asset-view': 'library' }, memLoading())
      var works = graph.works || []
      var inspIds = graph.uses ? Object.keys(graph.uses) : []
      return React.createElement('div', { 'data-asset-view': 'library', style: { padding: 12 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
          memBtn('‹ 灵感看板', '', function () { props && props.onBack && props.onBack() }),
          React.createElement('span', { style: { fontSize: 16, fontWeight: 700 } }, '📚 灵感资产库 · 复用图谱'),
          React.createElement('span', { style: { fontSize: 11, color: '#6b7280' } }, '作品 ' + works.length + ' · 被使用灵感 ' + inspIds.length),
          memBtn('🔄 刷新', '', reload),
          memBtn(showNew ? '收起' : '＋ 新建作品', 'primary', function () { setShowNew(!showNew) }, busy),
          flash ? React.createElement('span', { style: { fontSize: 11, color: flash.indexOf('❌') === 0 ? '#dc2626' : '#059669' } }, flash) : null),
        showNew ? React.createElement('div', { 'data-work-new': '1', style: memCard({ background: '#fff7ed', borderColor: '#fdba74' }) },
          React.createElement('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } }, '新建作品'),
          React.createElement('input', { value: newTitle, 'data-work-title': '1', onChange: function (ev) { setNewTitle(ev.target.value) }, placeholder: '作品标题*（如：《异类》长篇）', style: memInput({ marginBottom: 6 }) }),
          React.createElement('input', { value: newNote, 'data-work-note': '1', onChange: function (ev) { setNewNote(ev.target.value) }, placeholder: '备注（可选）', style: memInput({ marginBottom: 6 }) }),
          React.createElement('div', {}, memBtn('✅ 创建', 'primary', createWork, busy), ' ', memBtn('取消', '', function () { setShowNew(false); setNewTitle(''); setNewNote('') }))) : null,
        works.length ? React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8, marginBottom: 12 } },
          works.map(function (wk) {
            return React.createElement('div', { key: wk.id, 'data-work-card': wk.id, style: memCard({ cursor: 'pointer' }), onClick: function () { setOpenWork(wk.id) } },
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                React.createElement('span', { style: { fontWeight: 700, fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: wk.title }, '📖 ' + wk.title),
                React.createElement('span', { 'data-work-count': wk.id, style: { fontSize: 10, padding: '1px 7px', borderRadius: 9, background: 'rgba(217,119,6,0.14)', color: '#92400e', fontWeight: 700 } }, '灵感 ' + wk.inspCount)),
              wk.note ? React.createElement('div', { style: { fontSize: 11, color: '#6b7280', marginTop: 3, lineHeight: 1.5 } }, wk.note) : null,
              React.createElement('div', { style: { fontSize: 10, color: '#9ca3af', marginTop: 4 } }, '更新 ' + String(wk.updatedAt || '').slice(0, 10)),
              React.createElement('div', { style: { marginTop: 6, display: 'flex', gap: 6 }, onClick: function (ev) { ev.stopPropagation() } },
                React.createElement('button', { 'data-work-open': wk.id, onClick: function () { setOpenWork(wk.id) }, style: { fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '1px solid #d4d4d8', background: '#fff', cursor: 'pointer' } }, '档案 →'),
                React.createElement('button', { 'data-work-del': wk.id, onClick: function () { deleteWork(wk) }, disabled: busy, style: { fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '1px solid #fca5a5', background: '#fff', color: '#dc2626', cursor: 'pointer' } }, '删除')))
          })) : memEmptyBox('暂无作品——点「＋ 新建作品」开始登记你的作品'),
        React.createElement('div', { style: { fontSize: 13, fontWeight: 600, margin: '10px 0 6px' } }, '灵感使用清单（灵感 —(主轴/支线/改造)→ 作品 · 双向引用）'),
        inspIds.length ? inspIds.map(function (inspId) {
          var links = (graph.uses && graph.uses[inspId]) || []
          var title = (graph.inspTitles && graph.inspTitles[inspId]) || inspId
          return React.createElement('div', { key: inspId, 'data-asset-insp': inspId, style: memCard() },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
              React.createElement('span', { style: { fontWeight: 600, fontSize: 12.5, flex: '1 1 auto', minWidth: 120 } }, '💡 ' + title),
              React.createElement('span', { style: { fontSize: 10, color: '#92400e' } }, '被 ' + links.length + ' 个作品使用')),
            links.map(function (r) {
              return React.createElement(MemUseRow, { key: r.workId, r: r, busy: busy, onUnlink: function () { setBusy(true); setFlash(''); memAssetUnlink(inspId, r.workId).then(function (d) { if (d && d.ok) done('已移除关联'); else fail(d) }).catch(function (e) { fail({ error: (e && e.message) || '网络错误' }) }) } })
            }),
            React.createElement(MemLinkForm, { key: 'add', inspId: inspId, works: works, busy: busy, onLink: function (workId, role, adapt, status) {
              setBusy(true); setFlash('')
              memAssetLink({ inspId: inspId, workId: workId, role: role, adapt: adapt, status: status }).then(function (d) { if (d && d.ok) done('✅ 已关联到作品'); else fail(d) }).catch(function (e) { fail({ error: (e && e.message) || '网络错误' }) })
            } }))
        }) : memEmptyBox('暂无使用关系——在灵感行「＋关联到作品」登记灵感在某作品中的角色（主轴/支线/改造）'),
        React.createElement('div', { style: { fontSize: 10.5, color: '#9ca3af', marginTop: 8 } }, '数据存于 写作训练/作品库.json + 灵感资产.json（writing-studio 自持 sidecar）；与灵感库.json 完全隔离，不影响 taskkit 灵感数据。'))
    }
    // ============ Phase2 U5：作品档案·聚合视图（作品→使用的灵感/关联草稿/关联设定，只读聚合 + U4 互链） ============
    function MemWorkArchive(props) {
      var [arch, setArch] = React.useState(null)
      var [err, setErr] = React.useState('')
      var [busy, setBusy] = React.useState(false)
      var workId = props.workId
      var load = function () {
        setErr('')
        memWorkArchive(workId).then(function (d) { if (d && d.ok) setArch(d); else setErr((d && d.error) || '作品档案加载失败') }).catch(function (e) { setErr('作品档案加载失败：' + (e && e.message || '网络错误')) })
      }
      React.useEffect(function () { load() }, [workId])
      var unlink = function (inspId) {
        setBusy(true)
        memAssetUnlink(inspId, workId).then(function (d) {
          setBusy(false)
          if (d && d.ok) { load(); props.onChanged && props.onChanged() }
          else props.setFlash && props.setFlash('❌ ' + ((d && d.error) || '移除失败'))
        }).catch(function () { setBusy(false) })
      }
      if (err) return React.createElement('div', { 'data-work-archive': workId },
        React.createElement('div', { style: { padding: 12 } }, memBtn('‹ 返回作品库', '', props.onBack)), memErrBox(err))
      if (!arch) return React.createElement('div', { 'data-work-archive': workId }, memLoading())
      var w = arch.work
      return React.createElement('div', { 'data-work-archive': workId, style: { padding: 12 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
          memBtn('‹ 返回作品库', '', props.onBack),
          React.createElement('span', { style: { fontSize: 16, fontWeight: 700 } }, '📖 ' + w.title),
          React.createElement('span', { style: { fontSize: 11, color: '#6b7280' } }, '作品档案 · 聚合视图')),
        w.note ? React.createElement('div', { style: { fontSize: 12, color: '#6b7280', marginBottom: 8 } }, w.note) : null,
        React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '使用的灵感（' + arch.inspirations.length + ' · 角色色标 主轴红/支线橙/改造绿）'),
        arch.inspirations.length ? arch.inspirations.map(function (it) {
          var color = MEM_REUSE_COLOR[it.role] || '#6b7280'
          return React.createElement('div', { key: it.inspId, 'data-arch-insp': it.inspId, style: memCard({ borderLeft: '3px solid ' + color }) },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
              React.createElement('span', { style: { fontSize: 11, padding: '1px 7px', borderRadius: 8, background: color, color: '#fff', fontWeight: 600 } }, it.role),
              React.createElement('span', { style: { fontWeight: 600, fontSize: 13, flex: 1, minWidth: 120 } }, it.title),
              React.createElement('span', { style: { fontSize: 10, color: '#9ca3af' } }, it.status || '在用'),
              React.createElement('button', { 'data-arch-unlink': it.inspId, onClick: function () { unlink(it.inspId) }, disabled: busy, style: { fontSize: 10, padding: '1px 7px', borderRadius: 5, border: '1px solid #fca5a5', background: '#fff', color: '#dc2626', cursor: 'pointer' } }, '移除关联')),
            it.adapt ? React.createElement('div', { style: { fontSize: 11.5, color: '#374151', marginTop: 3 } }, '改造说明：' + it.adapt) : null,
            it.oneLiner ? React.createElement('div', { style: { fontSize: 11, color: '#6b7280', marginTop: 2 } }, it.oneLiner) : null)
        }) : memEmptyBox('本作品暂未关联灵感（返回资产库，在灵感行「＋关联到作品」登记）'),
        React.createElement('div', { style: { fontSize: 13, fontWeight: 600, margin: '10px 0 6px' } }, '关联草稿（' + arch.drafts.length + ' · 作品标题关键词 / 灵感 relations 命中）'),
        arch.drafts.length ? arch.drafts.map(function (d) {
          return React.createElement('div', { key: d.name, 'data-arch-draft': d.name, style: { display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #e4e4e7', borderRadius: 8, padding: '5px 8px', marginBottom: 4, background: '#fff' } },
            React.createElement('span', { style: { fontSize: 12, flex: 1 } }, '📝 ' + d.name),
            d.words != null ? React.createElement('span', { style: { fontSize: 10, color: '#6b7280' } }, d.words + ' 字') : null,
            d.inspTitle ? React.createElement('span', { style: { fontSize: 10, color: '#92400e' } }, '经灵感：' + d.inspTitle) : null)
        }) : memEmptyBox('暂无命中草稿（按作品标题关键词或作品灵感的 relations 关系匹配）'),
        React.createElement('div', { style: { fontSize: 13, fontWeight: 600, margin: '10px 0 6px' } }, '关联设定（' + arch.settings.length + ' · 灵感 settingsRef 校验）'),
        arch.settings.length ? arch.settings.map(function (s) {
          return React.createElement('div', { key: s.inspId + s.settingsRef, 'data-arch-setting': s.inspId, style: { display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #e4e4e7', borderRadius: 8, padding: '5px 8px', marginBottom: 4, background: '#fff' } },
            React.createElement('span', { style: { fontSize: 12, flex: 1 } }, (s.exists ? '📄 ' : '⚠️ 缺失 ') + s.settingsRef),
            React.createElement('span', { style: { fontSize: 10, color: s.exists ? '#059669' : '#dc2626' } }, s.exists ? '存在' : '未找到'),
            React.createElement('span', { style: { fontSize: 10, color: '#9ca3af' } }, '来自灵感：' + s.title))
        }) : memEmptyBox('本作品灵感暂无 settingsRef 设定引用'),
        React.createElement(MemCrossRailBlock, { workTitle: w.title }),
        React.createElement('div', { style: { fontSize: 10.5, color: '#9ca3af', marginTop: 8 } }, '聚合数据源：作品库.json + 灵感资产.json + 灵感库.json + relations.json + 草稿目录（writing-studio 自有 collectDrafts，只读）'))
    }
    // ============ Phase3 批次3（⑤ 跨轨沉淀 · 方案 A）：作品相关蒸馏历史（distillList×workTitle 过滤，含记忆落库→working 标注）
    //             + kbDomainSearch 领域候选（写作侧 category 白名单直读镜像，§6.2/V1 口径；只读展示，零跨插件写） ============
    function MemCrossRailBlock(props) {
      var wt = (props && props.workTitle) || ''
      var wtl = String(wt).toLowerCase()
      var [hist, setHist] = React.useState(null)
      var [histErr, setHistErr] = React.useState('')
      var [q, setQ] = React.useState(wt)
      var [kbRes, setKbRes] = React.useState(null)
      var [kbErr, setKbErr] = React.useState('')
      var [kbBusy, setKbBusy] = React.useState(false)
      var loadHist = function () {
        memDistillList().then(function (d) {
          if (d && d.ok) { setHist(d.history || []); setHistErr('') }
          else setHistErr((d && d.error) || '提炼历史加载失败')
        }).catch(function (e) { setHistErr('提炼历史加载失败：' + (e && e.message || '网络错误')) })
      }
      React.useEffect(loadHist, [])
      var doSearch = function () {
        setKbBusy(true); setKbErr('')
        api(MEM_WS_API, 'kbDomainSearch', { q: (q || '').trim() || wt, domain: '写作' }).then(function (d) {
          setKbBusy(false)
          if (d && d.ok) setKbRes(d)
          else setKbErr((d && d.error) || '领域检索失败')
        }).catch(function (e) { setKbBusy(false); setKbErr('领域检索失败：' + (e && e.message || '网络错误')) })
      }
      var all = hist === null ? [] : (Array.isArray(hist) ? hist : [])
      var rel = all.filter(function (h) {
        var hw = String(h.workTitle || '')
        if (hw) return hw === wt
        var hay = String((h.title || '') + ' ' + (h.contentPreview || '')).toLowerCase()
        return wtl !== '' && hay.indexOf(wtl) >= 0
      }).slice(0, 20)
      var tLabel = { insp: '灵感', kb: '知识库', memory: '工程记忆' }
      var tColor = { insp: '#d97706', kb: '#059669', memory: '#3b82f6' }
      var byCats = ''
      if (kbRes && kbRes.byCategory) byCats = Object.keys(kbRes.byCategory).map(function (c) { return c + ' ' + kbRes.byCategory[c] }).join(' · ')
      return React.createElement('div', { 'data-crossrail': '1', style: { marginTop: 12, border: '1px solid #e4e4e7', borderRadius: 10, padding: 10, background: '#fafafa' } },
        React.createElement('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 4 } }, '🔄 跨轨沉淀 · ' + wt),
        React.createElement('div', { style: { fontSize: 10.5, color: '#6b7280', marginBottom: 8, lineHeight: 1.6 } }, '写作侧经验 ↔ 工程记忆 双轨联动（方案 A：领域召回 + 提炼可追踪，只读展示不写库）；蒸馏历史按作品标题过滤（host 端 distill 可带可选来源字段 workTitle/sessionId/channel）。'),
        React.createElement('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 4 } }, '作品相关蒸馏历史' + (hist !== null ? '（' + rel.length + '/' + all.length + '）' : '')),
        hist === null ? memLoading() : (histErr ? React.createElement('div', { style: { fontSize: 11, color: '#dc2626', marginBottom: 4 } }, histErr)
          : (rel.length ? rel.map(function (h) {
            var col = tColor[h.target] || '#6b7280'
            return React.createElement('div', { key: h.id || h.at, 'data-crossrail-hist': h.downstreamId || h.taskId || h.id, style: memCard() },
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                React.createElement('span', { style: { width: 8, height: 8, borderRadius: 4, background: col, flex: '0 0 auto' } }),
                React.createElement('span', { style: { fontSize: 11, padding: '0 6px', borderRadius: 7, background: 'rgba(0,0,0,0.05)', color: col } }, tLabel[h.target] || h.target),
                React.createElement('span', { style: { fontSize: 12, fontWeight: 500, flex: 1, minWidth: 100 } }, h.title || h.contentPreview || ''),
                h.workTitle ? React.createElement('span', { style: { fontSize: 10, color: '#92400e' } }, '作品：' + h.workTitle) : null,
                h.channel ? React.createElement('span', { style: { fontSize: 10, color: '#6b7280' } }, '来源：' + h.channel) : null,
                React.createElement('span', { style: { fontSize: 10, color: '#9ca3af' } }, String(h.at || '').slice(0, 16).replace('T', ' '))),
              React.createElement('div', { style: { fontSize: 10.5, color: '#9ca3af', marginTop: 2 } },
                '下游 ' + (h.downstreamId || h.taskId || '—'),
                h.target === 'memory' ? ' · 已沉淀到工程记忆 working/raw（' + (h.taskId || 'distill-…') + '）——如需正式化为 L1，请到任务看板建写作训练任务并以 memory_close 收成 L1（不自动 close）' : ' · ' + (h.contentPreview || '')))
          }) : memEmptyBox('暂无本作品相关蒸馏记录（提炼台落库时如带 workTitle/sessionId 来源字段即在此汇总）'))),
        React.createElement('div', { style: { fontSize: 12, fontWeight: 600, margin: '10px 0 4px' } }, '领域候选检索（写作侧 category 白名单直读镜像 · domain=写作）'),
        React.createElement('div', { 'data-crossrail-search': '1', style: { display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' } },
          React.createElement('input', { value: q, 'data-crossrail-q': '1', onChange: function (ev) { setQ(ev.target.value) }, placeholder: '关键词（默认=作品标题）', style: memInput({ width: 220 }) }),
          memBtn(kbBusy ? '检索中…' : '🔍 检索领域候选', 'primary', doSearch, kbBusy),
          React.createElement('span', { style: { fontSize: 10.5, color: '#9ca3af' } }, kbRes ? '命中 ' + kbRes.count + ' 条（channel ' + kbRes.channel + (kbRes.mode ? ' · ' + kbRes.mode : '') + '）' : '')),
        kbErr ? React.createElement('div', { style: { fontSize: 11, color: '#dc2626', marginBottom: 4 } }, kbErr) : null,
        byCats ? React.createElement('div', { style: { fontSize: 10.5, color: '#6b7280', marginBottom: 4 } }, '分类分布：' + byCats) : null,
        kbRes && kbRes.entries && kbRes.entries.length ? kbRes.entries.slice(0, 12).map(function (e) {
          return React.createElement('div', { key: e.id || e.title, 'data-crossrail-hit': e.title, style: { display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #e4e4e7', borderRadius: 6, padding: '4px 8px', marginBottom: 3, background: '#fff', flexWrap: 'wrap' } },
            React.createElement('span', { style: { fontSize: 12, flex: 1, minWidth: 100 } }, '📚 ' + e.title),
            e.category ? React.createElement('span', { style: { fontSize: 10, padding: '0 6px', borderRadius: 7, background: 'rgba(5,150,105,0.1)', color: '#047857' } }, e.category) : null,
            e.description ? React.createElement('span', { style: { fontSize: 10.5, color: '#6b7280', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, e.description) : null)
        }) : (kbRes ? memEmptyBox('写作领域无匹配候选（写作侧条目走 category 白名单，domain=写作 为空属正常——可换关键词检索）') : null))
    }
    // ============ U1 工程记忆 · 记忆面板（L0/L1/L2 分层 + 分数排序 + pinned/excluded 开关） ============
    function MemEngineView() {
      var [data, setData] = React.useState(null)
      var [err, setErr] = React.useState('')
      var [busyKey, setBusyKey] = React.useState('')
      var [flash, setFlash] = React.useState('')
      // ===== Phase3 批次3（① 真退役/复原 + ④ 注入预览 2026 additive）：U6 区从只读 dryrun 升级为可退役/可复原 =====
      var [retireKey, setRetireKey] = React.useState('')      // busy：候选 taskId（退役中）
      var [restoreKey, setRestoreKey] = React.useState('')    // busy：归档 task_id（复原中）
      var [archive, setArchive] = React.useState(null)        // memArchiveList {count,restored,entries}
      var [archiveErr, setArchiveErr] = React.useState('')
      var [exForm, setExForm] = React.useState({ taskId: '', title: '', requirement: '', project: '' })
      var [exRes, setExRes] = React.useState(null)            // load explain 结果（含 explain/meta/l1hits）
      var [exBusy, setExBusy] = React.useState(false)
      var [exErr, setExErr] = React.useState('')
      // ===== Phase2 U6（additive）：记忆退役预览（dryrun 候选 → Phase3 ① 真退役/复原；client 直调 /memory-system/api/retire-dryrun + host memRetire/memRestore/memArchiveList）=====
      var [retire, setRetire] = React.useState(null) // {candidates,count,scanned} | {skipped,reason} | {unavail}
      var [retireBusy, setRetireBusy] = React.useState(false)
      var runRetirePreview = function () {
        if (retireBusy) return
        setRetireBusy(true); setRetire(null)
        memPost(MEM_MS_API + '/retire-dryrun', {}).then(function (d) {
          setRetireBusy(false)
          if (!d) { setRetire({ unavail: true }); return }
          if (d.skipped === true || (d.ok === false && d.reason === 'scan-running')) { setRetire({ skipped: true, reason: 'scan-running' }); return }
          if (d.ok === false) { setRetire({ unavail: true }); return }
          setRetire({ candidates: d.candidates || [], count: d.count || 0, scanned: d.scanned || 0, lastScanAt: d.lastScanAt || null })
        }).catch(function () { setRetireBusy(false); setRetire({ unavail: true }) })
      }
      var load = function () {
        setErr('')
        memSummaryLoad().then(function (d) {
          if (d && d.ok) { setData(d); setFlash('') }
          else { setErr((d && d.error) || 'memSummary 加载失败'); setData(null) }
        }).catch(function (e) { setErr('工程记忆加载失败：' + (e && e.message || '网络错误')); setData(null) })
      }
      React.useEffect(function () { load(); loadArchive() }, [])
      var toggleFlag = function (kind, item) {
        if (busyKey) return
        setBusyKey(item.task_id + ':' + kind); setFlash('')
        var action = kind === 'pin' ? 'pin' : 'exclude'
        var payload = kind === 'pin' ? { taskId: item.task_id, pinned: !item.pinned } : { taskId: item.task_id, excluded: !item.excluded }
        memPost(MEM_MS_API + '/' + action, payload).then(function (d) {
          setBusyKey('')
          if (d && d.ok) {
            setFlash((kind === 'pin' ? (d.pinned ? '📌 已置顶：' : '已取消置顶：') : (d.excluded ? '🚫 已排除：' : '已取消排除：')) + item.title)
            load() // 开关后立即重投影（消除 host jsonCache + client ws-cache 双层 30s 陈旧，R1 定稿）
          } else {
            setFlash('❌ ' + ((d && d.error) || '操作失败'))
          }
        }).catch(function (e) { setBusyKey(''); setFlash('❌ 请求失败：' + (e && e.message || '网络错误')) })
      }
      // ===== Phase3 批次3（① 真退役/复原 + ④ 注入预览 handler；host 走 /writing-studio/api loopback 或 memory-system 直连只读）=====
      var loadArchive = function () {
        api(MEM_WS_API, 'memArchiveList', {}).then(function (d) {
          if (d && d.ok) { setArchive(d); setArchiveErr('') }
          else { setArchive(null); setArchiveErr((d && d.error) || '归档清单加载失败') }
        }).catch(function (e) { setArchive(null); setArchiveErr('归档清单加载失败：' + (e && e.message || '网络错误')) })
      }
      var doRetireCandidate = function (c) {
        if (retireKey || !c) return
        var title = (c && (c.title || c.taskId)) || ''
        if (!window.confirm('确认退役这条记忆？\n\n' + title + '\n' + (c && c.taskId) + '\n已闭合 ' + (c && c.ageDays) + ' 天 · 分数 ' + (c && c.score) + '\n\n退役 = 归档 + （moveOut）移出活跃 L1 原文件，可在下方「📦 已归档」列表 ↩️ 复原。')) return
        setRetireKey(c.taskId); setFlash('')
        api(MEM_WS_API, 'memRetire', { taskId: c.taskId }).then(function (d) {
          setRetireKey('')
          if (d && d.ok) {
            setFlash('✅ 已退役：' + (d.taskId || c.taskId) + (d.moveOut ? '（原文已 moveOut，可复原）' : '') + (d.compressed ? '（已压缩归档）' : ''))
            setRetire(null)
            load()
            runRetirePreview() // dryrun 与 memSummary 双刷
            loadArchive()      // 归档清单同步
          } else setFlash('❌ 退役失败：' + ((d && d.error) || '未知错误'))
        }).catch(function (e) { setRetireKey(''); setFlash('❌ 请求失败：' + (e && e.message || '网络错误')) })
      }
      var doRestoreEntry = function (e) {
        if (restoreKey || !e) return
        if (e.restored || !e.original_moved) return // UI 已禁用（reason 见按钮 title），双保险
        if (!window.confirm('确认复原「' + (e.title || e.task_id) + '」？\n\n将把退役时移出的 L1 原文件回迁到 longterm/tasks/ 并重新纳入记忆；归档 md / KB 档案条目保留不动。')) return
        setRestoreKey(e.task_id); setFlash('')
        api(MEM_WS_API, 'memRestore', { taskId: e.task_id }).then(function (d) {
          setRestoreKey('')
          if (d && d.ok && d.skipped) { setFlash('ℹ️ 未复原（' + (d.reason || 'skipped') + '）：' + (e.title || e.task_id)); loadArchive() }
          else if (d && d.ok) { setFlash('✅ 已复原：' + (d.taskId || e.task_id) + (d.note ? '（' + d.note + '）' : '')); load(); loadArchive() }
          else setFlash('❌ 复原失败：' + ((d && d.error) || '未知错误'))
        }).catch(function (e2) { setRestoreKey(''); setFlash('❌ 请求失败：' + (e2 && e2.message || '网络错误')) })
      }
      var setEx = function (patch) { setExForm(Object.assign({}, exForm, patch)) }
      var runExplain = function () {
        var ef = exForm || {}
        var payload = { explain: true }
        if (String(ef.taskId || '').trim()) payload.taskId = String(ef.taskId).trim()
        if (String(ef.title || '').trim()) payload.title = String(ef.title).trim()
        if (String(ef.requirement || '').trim()) payload.requirement = String(ef.requirement).trim()
        if (String(ef.project || '').trim()) payload.project = String(ef.project).trim()
        if (!payload.taskId && !payload.title) { setExErr('请至少填写 taskId 或 title（load 端点要求其一）'); return }
        setExBusy(true); setExErr(''); setExRes(null)
        memPost(MEM_MS_API + '/load', payload).then(function (d) {
          setExBusy(false)
          if (d && d.ok && d.context && d.context.explain) {
            var ctx = d.context
            setExRes({ explain: ctx.explain || { l1: [], backtrack: [], skipped: [] }, meta: ctx.meta || null, l1hits: (ctx.l1 && ctx.l1.hits) || [] })
          } else setExErr('注入预览失败：' + ((d && (d.error || (d.context && d.context.error))) || '未知错误'))
        }).catch(function (e) { setExBusy(false); setExErr('注入预览请求失败：' + (e && e.message || '网络错误')) })
      }
      if (err) return React.createElement('div', { 'data-mem-view': 'engine' }, memErrBox(err))
      if (!data) return React.createElement('div', { 'data-mem-view': 'engine' }, memLoading())
      var st = data.stats || {}
      return React.createElement('div', { 'data-mem-view': 'engine', style: { padding: 12 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
          React.createElement('span', { style: { fontSize: 16, fontWeight: 700 } }, '⚙️ 工程记忆 · 分层记忆面板'),
          React.createElement('span', { style: { fontSize: 11, color: '#6b7280' } }, 'memory_pin / memory_exclude 首次 UI 化（写操作直调 /memory-system/api）'),
          memBtn('🔄 刷新', '', load),
          flash ? React.createElement('span', { style: { fontSize: 11, color: flash.indexOf('❌') === 0 ? '#dc2626' : '#059669' } }, flash) : null),
        React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 } },
          memStat('L0 事实', st.facts || 0, '#3b82f6'),
          memStat('待确认', st.factsPending || 0, '#93c5fd'),
          memStat('L1 已确认', st.confirmed || 0, '#059669'),
          memStat('L1 草稿', st.drafts || 0, '#65a30d'),
          memStat('L2 raw', st.rawRecords || 0, '#d97706'),
          memStat('working', st.working || 0, '#6b7280'),
          memStat('归档', st.archived || 0, '#9ca3af')),
        React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, 'L1 任务摘要（' + data.l1.length + ' · 按记忆分数↓ · 记忆分数=(重要度+活跃度)×衰减，镜像 memory-system B4-1 公式）'),
        data.l1.length ? data.l1.map(function (item) {
          var busy = busyKey.indexOf(item.task_id + ':') === 0
          var statusColor = { success: '#059669', silent_completed: '#65a30d', interrupted: '#d97706', failed: '#dc2626' }[item.status] || '#6b7280'
          return React.createElement('div', {
            key: item.task_id,
            'data-mem-l1': item.task_id,
            style: { border: '1px solid #e4e4e7', borderRadius: 8, padding: 8, marginBottom: 6, background: '#fff', borderLeft: '3px solid ' + (item.pinned ? '#7c3aed' : (item.excluded ? '#9ca3af' : statusColor)) }
          },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
              React.createElement('span', { style: { fontWeight: 600, fontSize: 13, flex: '1 1 auto', minWidth: 120 } }, item.title || item.task_id),
              memTag(item.source === 'confirmed' ? '已确认' : '草稿', ''),
              memTag(item.status || 'unknown', statusColor),
              React.createElement('span', { style: { fontSize: 12, fontWeight: 700, color: '#b45309', marginLeft: 'auto' }, title: '记忆分数 ' + item.score + '（重要度 ' + item.importance + '）' }, '分数 ' + Number(item.score).toFixed(3)),
              memBtn(item.pinned ? '📌 已置顶' : '📌 置顶', item.pinned ? 'soft-on' : '', function () { toggleFlag('pin', item) }, busy),
              memBtn(item.excluded ? '🚫 已排除' : '🚫 排除', item.excluded ? 'muted-on' : 'danger', function () { toggleFlag('exclude', item) }, busy)),
            item.project || item.domain.length ? React.createElement('div', { style: { fontSize: 11, color: '#6b7280', marginTop: 3 } },
              (item.project ? memTag(item.project, '#3b82f6') : null),
              item.domain.slice(0, 4).map(function (d) { return React.createElement('span', { key: d, style: { fontSize: 10, padding: '1px 6px', borderRadius: 8, background: 'rgba(59,130,246,0.08)', color: '#1d4ed8', marginRight: 4 } }, d) })) : null,
            item.conclusion ? React.createElement('div', { style: { fontSize: 11.5, color: '#374151', marginTop: 3, lineHeight: 1.6 } }, item.conclusion) : null,
            React.createElement('div', { style: { fontSize: 10.5, color: '#9ca3af', marginTop: 3 } },
              item.task_id + ' · 决策 ' + item.decisionCount + ' · 遗留 ' + item.openQuestionCount + ' · raw ' + item.rawRecords + ' 条 · 消息 ' + item.messageCount + (item.closed_at ? ' · 闭合 ' + String(item.closed_at).slice(0, 10) : '')))
        }) : memEmptyBox('暂无 L1 任务摘要（空库：任务闭合时 memory_close 提炼落 L1；开关即 memory_pin/memory_exclude 首次 UI 化落点）'),
        React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginTop: 12, marginBottom: 6 } }, 'L0 项目事实（' + data.l0.length + ' · 待确认 ' + (data.pending || []).length + '）'),
        data.l0.length ? data.l0.map(function (f) {
          return React.createElement('div', { key: f.id || f.content, style: { border: '1px solid #e4e4e7', borderRadius: 8, padding: '6px 8px', marginBottom: 5, background: '#fff' } },
            React.createElement('div', { style: { fontSize: 12, color: '#374151' } }, f.content),
            React.createElement('div', { style: { fontSize: 10, color: '#9ca3af', marginTop: 2 } }, (f.project || '通用') + (f.source ? ' · ' + f.source : '') + (f.updated_at ? ' · ' + String(f.updated_at).slice(0, 10) : '')))
        }) : memEmptyBox('暂无已确认事实（Agent 提议 + 用户确认后进入 L0）'),
        React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginTop: 12, marginBottom: 6 } }, 'L2 原始记录 · working 工作记忆'),
        React.createElement('div', { style: { border: '1px solid #e4e4e7', borderRadius: 8, padding: 8, background: '#fff', fontSize: 11.5, color: '#374151', lineHeight: 1.8 } },
          'raw 任务目录 ' + (st.rawTasks || 0) + ' 个 · 记录文件 ' + (st.rawRecords || 0) + ' 条（raw/<taskId>/*.jsonl，只增不改）',
          React.createElement('div', {}, 'working 活跃 ' + (st.working || 0) + ' 个' + ((data.workingIds || []).length ? '：' + data.workingIds.join('、') : '（任务生命周期内 memory_record/weave 产生，闭合即提炼 L1）'))),
        React.createElement('div', { style: { fontSize: 10.5, color: '#9ca3af', marginTop: 8 } }, '数据源：' + (data.dir || '') + '（writing-studio host 只读投影，全部 cache:false 读盘；memory-system 代码零改动）'),
        // ===== Phase2 U6 + Phase3 ①升级：记忆退役（dryrun 预览 → 候选行 📦 真退役；下方 📦 已归档 列表 ↩️ 复原）=====
        React.createElement('div', { style: { marginTop: 14, borderTop: '1px dashed #d4d4d8', paddingTop: 10 } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            React.createElement('span', { style: { fontSize: 14, fontWeight: 700 } }, '🧹 记忆退役预览'),
            memBtn(retireBusy ? '扫描中…' : '🔍 预览退役候选', 'primary', runRetirePreview, retireBusy),
            retire && retire.skipped ? React.createElement('span', { style: { fontSize: 11, color: '#b45309' } }, '⏳ 看门狗扫描进行中（scan-running），请稍后点重试') : null,
            retire && retire.unavail ? React.createElement('span', { style: { fontSize: 11, color: '#9ca3af' } }, '退役预览暂不可用（memory-system 未响应），不影响本页其余功能') : null),
          React.createElement('div', { style: { fontSize: 10.5, color: '#9ca3af', marginTop: 4 } }, '当前阈值：闭合 ≥90 天 且 记忆分数 <0.15（默认；可在「用户偏好 → 记忆策略」调参写回）；📌 pinned、成功且重要度≥0.7、failed 的任务不进候选（每轮最多 5 条）。候选行可「📦 退役」真退役（moveOut 移出 L1 原文）；退役后到下方「📦 已归档」列表可「↩️ 复原」。'),
          retire && !retire.skipped && !retire.unavail ? React.createElement('div', { 'data-retire-result': '1', style: { marginTop: 8 } },
            React.createElement('div', { style: { fontSize: 12, color: '#374151', marginBottom: 6 } }, '已扫描 ' + retire.scanned + ' 个已闭合任务 · 命中候选 ' + retire.count + ' 条' + (retire.lastScanAt ? '（扫描于 ' + String(retire.lastScanAt).slice(0, 19).replace('T', ' ') + '）' : '')),
            retire.candidates.length ? retire.candidates.map(function (c) {
              return React.createElement('div', { key: c.taskId, 'data-retire-cand': c.taskId, style: memCard({ borderLeft: '3px solid #d97706' }) },
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                  React.createElement('span', { style: { fontWeight: 600, fontSize: 12.5, flex: 1, minWidth: 120 } }, c.title || c.taskId),
                  memTag(c.status || 'unknown', '#d97706'),
                  React.createElement('span', { style: { fontSize: 11, color: '#b45309', fontWeight: 700 } }, '分数 ' + Number(c.score || 0).toFixed(3)),
                  React.createElement('span', { style: { fontSize: 10.5, color: '#6b7280' } }, c.ageDays + ' 天 · 重要度 ' + Number(c.importance || 0).toFixed(2))),
                React.createElement('div', { style: { fontSize: 10.5, color: '#9ca3af', marginTop: 2 } }, c.taskId + (c.reason ? ' · ' + c.reason : '')),
                React.createElement('div', { style: { marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 } },
                  memBtnA('📦 退役', 'danger', function () { doRetireCandidate(c) }, retireBusy || retireKey !== '', { 'data-retire-act': c.taskId, title: '真退役：归档 + moveOut 移出 L1 原文（可复原）' }),
                  retireKey === c.taskId ? React.createElement('span', { style: { fontSize: 10.5, color: '#9ca3af' } }, '退役中…') : null))
            }) : memEmptyBox('暂无超龄低活跃记忆（无退役候选）')) : null),
        // ===== Phase3 批次3（① U6 升级）：已归档清单（memArchiveList 只读投影 + 复原按钮；restored/never-moved 禁用态）=====
        React.createElement('div', { 'data-archive-list': '1', style: { marginTop: 14, borderTop: '1px dashed #d4d4d8', paddingTop: 10 } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            React.createElement('span', { style: { fontSize: 14, fontWeight: 700 } }, '📦 已归档' + (archive ? '（' + archive.count + ' · 已复原 ' + archive.restored + '）' : '')),
            memBtn('🔄 刷新归档', '', loadArchive),
            archiveErr ? React.createElement('span', { style: { fontSize: 11, color: '#dc2626' } }, archiveErr) : null,
            React.createElement('span', { style: { fontSize: 10.5, color: '#9ca3af' } }, 'moveOut 条目（L1 原文已移出）可 ↩️ 复原回迁；restored=已复原、仅归档（未移出）=never-moved 复原无意义（按钮禁用）')),
          !archive ? memLoading() : (archive.entries && archive.entries.length ? archive.entries.map(function (e) {
            var edge = e.restored ? '#059669' : (e.original_moved ? '#d97706' : '#9ca3af')
            return React.createElement('div', { key: e.task_id, 'data-archive-row': e.task_id, style: memCard({ borderLeft: '3px solid ' + edge }) },
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                React.createElement('span', { style: { fontWeight: 600, fontSize: 12.5, flex: '1 1 auto', minWidth: 120 } }, e.title || e.task_id),
                e.restored ? memTag('✅ 已复原 ' + String(e.restored_at || '').slice(0, 10), '#059669') : null,
                !e.restored && e.original_moved ? memTag('moveOut 已移出', '#d97706') : null,
                !e.restored && !e.original_moved ? memTag('仅归档（未移出）', '#9ca3af') : null,
                e.compressed ? memTag('压缩', '') : null,
                e.kb_indexed ? memTag('KB已索引', '') : null),
              React.createElement('div', { style: { fontSize: 10.5, color: '#6b7280', marginTop: 2 } },
                e.task_id + (e.project ? ' · ' + e.project : '') + (e.archived_at ? ' · 归档 ' + String(e.archived_at).slice(0, 10) : '') + (e.readCount ? ' · 冷读 ' + e.readCount + ' 次' : '') + (e.lastReadAt ? ' · 最近 ' + String(e.lastReadAt).slice(0, 10) : '')),
              React.createElement('div', { style: { marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 } },
                e.restored ? memBtnA('✅ 已复原', 'soft-on', null, true, { 'data-restore-act': e.task_id, title: 'already-restored：上次复原已打标（幂等），无需重复' })
                  : (!e.original_moved ? memBtnA('↩️ 复原（不可用）', '', null, true, { 'data-restore-act': e.task_id, title: 'never-moved：该任务退役时未移出活跃域（L1 一直在 longterm/tasks），复原无意义' })
                    : memBtnA('↩️ 复原', 'primary', function () { doRestoreEntry(e) }, restoreKey === e.task_id, { 'data-restore-act': e.task_id, title: '复原：回迁 L1 原文件到 longterm/tasks/ 并重新纳入记忆（409 防覆盖）' })),
                restoreKey === e.task_id ? React.createElement('span', { style: { fontSize: 10.5, color: '#9ca3af' } }, '复原中…') : null))
          }) : memEmptyBox('暂无归档条目（0 退役）——在候选行执行「📦 退役」后条目出现在这里'))),
        // ===== Phase3 批次3（④ 注入预览·为什么）：模拟 memory_load explain:true → 打分分解 + 回溯深度 =====
        React.createElement('div', { 'data-explain-panel': '1', style: { marginTop: 14, borderTop: '1px dashed #d4d4d8', paddingTop: 10 } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 } },
            React.createElement('span', { style: { fontSize: 14, fontWeight: 700 } }, '🧪 注入预览 · 为什么'),
            React.createElement('span', { style: { fontSize: 10.5, color: '#9ca3af' } }, '模拟一次 memory_load（explain:true，只读预览不 bump loadCount）→ 逐条打分分解/回溯深度，回答「为什么这条被注入」')),
          React.createElement('div', { 'data-explain-form': '1', style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 } },
            React.createElement('input', { value: exForm.taskId, 'data-explain-taskid': '1', onChange: function (ev) { setEx({ taskId: ev.target.value }) }, placeholder: 'taskId（可选）', style: memInput({ width: 130 }) }),
            React.createElement('input', { value: exForm.title, 'data-explain-title': '1', onChange: function (ev) { setEx({ title: ev.target.value }) }, placeholder: 'title（任务/创作主题）', style: memInput({ width: 180 }) }),
            React.createElement('input', { value: exForm.requirement, 'data-explain-req': '1', onChange: function (ev) { setEx({ requirement: ev.target.value }) }, placeholder: 'requirement/正文关键词', style: memInput({ width: 200 }) }),
            React.createElement('input', { value: exForm.project, 'data-explain-project': '1', onChange: function (ev) { setEx({ project: ev.target.value }) }, placeholder: 'project（可选）', style: memInput({ width: 130 }) }),
            memBtn(exBusy ? '预览中…' : '🔍 预览注入', 'primary', runExplain, exBusy, { 'data-explain-run': '1' }),
            exErr ? React.createElement('span', { style: { fontSize: 11, color: '#dc2626', alignSelf: 'center' } }, exErr) : null),
          exRes ? (function () {
            var ex = exRes.explain || {}
            var exl1 = Array.isArray(ex.l1) ? ex.l1 : []
            var exBk = Array.isArray(ex.backtrack) ? ex.backtrack : []
            var exSkip = Array.isArray(ex.skipped) ? ex.skipped : []
            var tMap = {}
            ;(exRes.l1hits || []).forEach(function (h) { if (h && h.task_id) tMap[h.task_id] = h.title || h.task_id })
            var titleOf = function (tid) { return tMap[tid] || tid }
            var fmt = function (r) {
              var parts = []
              parts.push(r.origin || '常规候选')
              if (r.keywordScore !== null && r.keywordScore !== undefined) parts.push('关键词 ' + Math.round(Number(r.keywordScore) || 0) + ' 分')
              parts.push('状态 +' + Math.round(Number(r.statusWeight) || 0))
              if (r.memScore || r.memAdd) parts.push('记忆分 ' + Number(r.memScore || 0).toFixed(3) + '×addScale → +' + Number(r.memAdd || 0))
              if (r.pinnedBonus) parts.push('pinned +' + Number(r.pinnedBonus))
              return parts.join(' + ') + ' = 总 ' + Number(r.total || 0)
            }
            return React.createElement('div', { 'data-explain-result': '1', style: { marginTop: 6 } },
              React.createElement('div', { style: { fontSize: 11, color: '#6b7280', marginBottom: 4 } }, '候选 ' + exl1.length + ' 条 · 回溯 ' + exBk.length + ' 条' + (exSkip.length ? ' · 过滤跳过 ' + exSkip.length + ' 条' : '')),
              exl1.length ? exl1.slice(0, 25).map(function (r, i) {
                var top = Number(r.rank) <= 5
                return React.createElement('div', { key: r.task_id || i, 'data-explain-row': r.task_id || '', style: memCard({ borderLeft: '3px solid ' + (top ? '#059669' : '#e4e4e7') }) },
                  React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                    React.createElement('span', { style: { fontSize: 11, padding: '1px 7px', borderRadius: 8, background: top ? 'rgba(5,150,105,0.12)' : 'rgba(0,0,0,0.05)', color: top ? '#047857' : '#6b7280', fontWeight: 600 } }, '#' + (r.rank || i + 1)),
                    React.createElement('span', { style: { fontWeight: 600, fontSize: 12.5, flex: 1, minWidth: 100 } }, titleOf(r.task_id)),
                    top ? memTag('主载注入 top5', '#059669') : memTag('未入前 5', '')),
                  React.createElement('div', { style: { fontSize: 11, color: '#374151', marginTop: 2, lineHeight: 1.6 } }, fmt(r)))
              }) : React.createElement('div', { style: { fontSize: 11, color: '#9ca3af', marginBottom: 4 } }, '无主循环候选行（无匹配/库为空）'),
              exBk.length ? React.createElement('div', { style: { fontSize: 12, fontWeight: 600, marginTop: 8, marginBottom: 3 } }, '↩️ 回溯依赖（' + exBk.length + ' · 依赖图 BFS，只标深度不分解分数）') : null,
              exBk.length ? exBk.slice(0, 25).map(function (r, i) {
                return React.createElement('div', { key: (r.task_id || 'bk') + i, 'data-explain-bk': r.task_id || '', style: { display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #e4e4e7', borderRadius: 6, padding: '4px 8px', marginBottom: 3, background: '#fff', fontSize: 11.5 } },
                  React.createElement('span', { style: { fontWeight: 500 } }, '↩ ' + titleOf(r.task_id)),
                  React.createElement('span', { style: { color: '#6b7280' } }, 'depth ' + (r.depth !== undefined ? r.depth : '?')))
              }) : null,
              exSkip.length ? React.createElement('div', { style: { fontSize: 10.5, color: '#9ca3af', marginTop: 4 } }, '过滤跳过：' + exSkip.slice(0, 10).map(function (s) { return (s.task_id || '') + '(' + (s.reason || '') + ')' }).join('、') + (exSkip.length > 10 ? '…' : '')) : null)
          })() : null))
    }
    // ============ Phase2 U7：对话记忆·会话提炼台（标记内容→选目标→一键落库；host loopback + 提炼历史） ============
    var MEM_DISTILL_TARGETS = [
      { id: 'insp', label: '① 灵感/点子（→灵感库）', color: '#d97706' },
      { id: 'kb', label: '② 设定/技法/经验（→知识库）', color: '#059669' },
      { id: 'memory', label: '③ 工程结论（→工程记忆 working/raw）', color: '#3b82f6' }
    ]
    function MemTalkDistill() {
      var [target, setTarget] = React.useState('insp')
      var [content, setContent] = React.useState('')
      var [title, setTitle] = React.useState('')
      var [oneLiner, setOneLiner] = React.useState('')
      var [tags, setTags] = React.useState('')
      var [hook, setHook] = React.useState('')
      var [category, setCategory] = React.useState('创作技法')
      var [description, setDescription] = React.useState('')
      var [aliases, setAliases] = React.useState('')
      var [taskId, setTaskId] = React.useState('')
      var [project, setProject] = React.useState('')
      var [mtype, setMtype] = React.useState('message')
      var [busy, setBusy] = React.useState(false)
      var [flash, setFlash] = React.useState('')
      var [history, setHistory] = React.useState(null)
      var [histFilter, setHistFilter] = React.useState('all')
      var loadHistory = function () { memDistillList().then(function (d) { if (d && d.ok) setHistory(d.history || []) }).catch(function () {}) }
      React.useEffect(function () { loadHistory() }, [])
      var contentLen = content.length
      var submit = function () {
        var body = (content || '').trim()
        if (!body) { setFlash('❌ 请先填写要提炼的内容'); return }
        if (contentLen > 2000) { setFlash('❌ 内容超过 2000 字（当前 ' + contentLen + '），请精简'); return }
        if ((target === 'insp' || target === 'kb') && !title.trim()) { setFlash('❌ ' + (target === 'insp' ? '灵感' : '知识库条目') + '标题必填'); return }
        setBusy(true); setFlash('')
        var payload
        if (target === 'insp') payload = { title: title.trim(), content: body, oneLiner: oneLiner, tags: tags, hook: hook }
        else if (target === 'kb') payload = { title: title.trim(), content: body, category: category, description: description, tags: tags, aliases: aliases }
        else payload = { content: body, title: title.trim(), taskId: taskId.trim(), project: project.trim(), type: mtype, tags: tags }
        memDistill(target, payload).then(function (d) {
          setBusy(false)
          if (d && d.ok) {
            var label = target === 'insp' ? '灵感库' : (target === 'kb' ? '知识库' : '工程记忆')
            setFlash('✅ 已沉淀到 ' + label + '：' + (title.trim() || d.taskId || '') + '（下游 id ' + (d.downstreamId || '') + '）')
            setContent(''); setTitle(''); setOneLiner(''); setHook(''); setDescription(''); setAliases(''); setTaskId('')
            loadHistory()
          } else setFlash('❌ ' + ((d && d.error) || '落库失败'))
        }).catch(function (e) { setBusy(false); setFlash('❌ 请求失败：' + (e && e.message || '网络错误')) })
      }
      var shown = (history || []).filter(function (h) { return histFilter === 'all' || h.target === histFilter })
      var tgtLabel = { insp: '灵感', kb: '知识库', memory: '工程记忆' }
      return React.createElement('div', { 'data-distill': '1' },
        React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '🛠 会话提炼台（标记内容 → 选目标 → 一键落库）'),
        React.createElement('div', { style: memCard({ background: '#fafafa' }) },
          React.createElement('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 6 } },
            MEM_DISTILL_TARGETS.map(function (t) {
              var on = target === t.id
              return React.createElement('label', { key: t.id, 'data-distill-target': t.id, style: { fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, color: on ? t.color : '#6b7280', fontWeight: on ? 700 : 400 } },
                React.createElement('input', { type: 'radio', name: 'distill-target', checked: on, onChange: function () { setTarget(t.id); setFlash('') } }), t.label)
            })),
          React.createElement('textarea', { value: content, 'data-distill-content': '1', onChange: function (ev) { setContent(ev.target.value) }, placeholder: '① 把对话中有长期价值的内容标记/粘贴到这里（≤2000 字）…', rows: 4, style: memInput({ resize: 'vertical', marginBottom: 6 }) }),
          React.createElement('div', { style: { fontSize: 10.5, textAlign: 'right', color: contentLen > 2000 ? '#dc2626' : '#9ca3af', marginBottom: 6 } }, contentLen + '/2000'),
          target === 'insp' ? React.createElement('div', null,
            React.createElement('input', { value: title, 'data-distill-title': '1', onChange: function (ev) { setTitle(ev.target.value) }, placeholder: '灵感标题*', style: memInput({ marginBottom: 6 }) }),
            React.createElement('input', { value: oneLiner, onChange: function (ev) { setOneLiner(ev.target.value) }, placeholder: '一句话灵感（oneLiner，可选）', style: memInput({ marginBottom: 6 }) }),
            React.createElement('input', { value: hook, onChange: function (ev) { setHook(ev.target.value) }, placeholder: '钩子 hook（可选）', style: memInput({ marginBottom: 6 }) }),
            React.createElement('input', { value: tags, onChange: function (ev) { setTags(ev.target.value) }, placeholder: '标签（逗号分隔，可选）', style: memInput({ marginBottom: 6 }) }))
            : null,
          target === 'kb' ? React.createElement('div', null,
            React.createElement('input', { value: title, 'data-distill-title': '1', onChange: function (ev) { setTitle(ev.target.value) }, placeholder: '条目标题*', style: memInput({ marginBottom: 6 }) }),
            React.createElement('div', { style: { display: 'flex', gap: 6, marginBottom: 6 } },
              React.createElement('select', { value: category, onChange: function (ev) { setCategory(ev.target.value) }, style: { fontSize: 12, padding: '4px 6px', border: '1px solid #d4d4d8', borderRadius: 6 } },
                KB_CATEGORIES.map(function (c) { return React.createElement('option', { key: c, value: c }, c) })),
              React.createElement('input', { value: tags, onChange: function (ev) { setTags(ev.target.value) }, placeholder: '标签（逗号分隔）', style: memInput({ flex: 1 }) })),
            React.createElement('input', { value: description, onChange: function (ev) { setDescription(ev.target.value) }, placeholder: '一句话描述 description（检索句柄，可选）', style: memInput({ marginBottom: 6 }) }),
            React.createElement('input', { value: aliases, onChange: function (ev) { setAliases(ev.target.value) }, placeholder: '别名 aliases（逗号分隔，口语叫法，可选）', style: memInput({ marginBottom: 6 }) }))
            : null,
          target === 'memory' ? React.createElement('div', null,
            React.createElement('div', { style: { display: 'flex', gap: 6, marginBottom: 6 } },
              React.createElement('input', { value: taskId, 'data-distill-taskid': '1', onChange: function (ev) { setTaskId(ev.target.value) }, placeholder: 'taskId（留空=distill-日期）', style: memInput({ flex: 1 }) }),
              React.createElement('select', { value: mtype, onChange: function (ev) { setMtype(ev.target.value) }, style: { fontSize: 12, padding: '4px 6px', border: '1px solid #d4d4d8', borderRadius: 6 } },
                MEMORY_RECORD_TYPES.map(function (t) { return React.createElement('option', { key: t, value: t }, t) }))),
            React.createElement('input', { value: project, onChange: function (ev) { setProject(ev.target.value) }, placeholder: '项目 project（可选）', style: memInput({ marginBottom: 6 }) }),
            React.createElement('input', { value: title, onChange: function (ev) { setTitle(ev.target.value) }, placeholder: '标题 title（可选）', style: memInput({ marginBottom: 6 }) }),
            React.createElement('input', { value: tags, onChange: function (ev) { setTags(ev.target.value) }, placeholder: '标签（逗号分隔，可选）', style: memInput({ marginBottom: 6 }) }),
            React.createElement('div', { style: { fontSize: 10.5, color: '#9ca3af', marginBottom: 6 } }, '只 record 到 working/raw（不替任务闭合——闭合由任务生命周期负责）'))
            : null,
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            memBtn('🚀 一键落库', 'primary', submit, busy),
            flash ? React.createElement('span', { style: { fontSize: 11, color: flash.indexOf('❌') === 0 ? '#dc2626' : '#059669' } }, flash) : null)),
        React.createElement('div', { style: { fontSize: 13, fontWeight: 600, margin: '12px 0 6px' } }, '📜 提炼历史' + (history ? '（' + history.length + '）' : ''),
          React.createElement('select', { value: histFilter, onChange: function (ev) { setHistFilter(ev.target.value) }, style: { fontSize: 11, padding: '2px 6px', border: '1px solid #d4d4d8', borderRadius: 5, marginLeft: 8 } },
            React.createElement('option', { value: 'all' }, '全部'),
            React.createElement('option', { value: 'insp' }, '灵感'),
            React.createElement('option', { value: 'kb' }, '知识库'),
            React.createElement('option', { value: 'memory' }, '工程记忆'))),
        history === null ? memLoading() : (shown.length ? shown.map(function (h) {
          var t = MEM_DISTILL_TARGETS.find(function (x) { return x.id === h.target }) || { color: '#6b7280' }
          return React.createElement('div', { key: h.id, 'data-distill-hist': h.id, style: { display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #e4e4e7', borderRadius: 8, padding: '5px 8px', marginBottom: 4, background: '#fff', flexWrap: 'wrap' } },
            React.createElement('span', { style: { width: 8, height: 8, borderRadius: 4, background: t.color, flex: '0 0 auto' } }),
            React.createElement('span', { style: { fontSize: 11, color: '#6b7280', flex: '0 0 auto' } }, String(h.at || '').slice(0, 16).replace('T', ' ')),
            React.createElement('span', { style: { fontSize: 11, padding: '0 6px', borderRadius: 7, background: 'rgba(0,0,0,0.05)', color: t.color, flex: '0 0 auto' } }, tgtLabel[h.target] || h.target),
            React.createElement('span', { style: { fontSize: 12, fontWeight: 500, flex: 1, minWidth: 100 } }, h.title || h.contentPreview || ''),
            React.createElement('span', { style: { fontSize: 10, color: '#9ca3af', flex: '0 0 auto' } }, h.downstreamId || h.taskId || ''))
        }) : memEmptyBox('暂无成功提炼记录（落库成功后才会记录，失败不写历史）')))
    }
    // ============ U3 对话记忆页 · 提炼管道框架（Phase1 骨架；会话原始记录留在 jsonl，不重复建库） ============
    function MemTalkView() {
      var [data, setData] = React.useState(null)
      var [err, setErr] = React.useState('')
      React.useEffect(function () {
        memSummaryLoad().then(function (d) { if (d && d.ok) setData(d); else setErr((d && d.error) || '加载失败') }).catch(function (e) { setErr('对话记忆加载失败：' + (e && e.message || '网络错误')) })
      }, [])
      if (err) return React.createElement('div', { 'data-mem-view': 'talk' }, memErrBox(err))
      if (!data) return React.createElement('div', { 'data-mem-view': 'talk' }, memLoading())
      var st = data.stats || {}
      var pipelines = [
        { target: '灵感 / 点子', to: '灵感库（预存）', tool: 'insp_create', color: '#d97706' },
        { target: '设定 / 技法 / 经验', to: 'knowledge-base', tool: 'kb_add', color: '#059669' },
        { target: '工程结论 / 决策', to: 'memory-system L1（任务闭合）', tool: 'memory_record → memory_close', color: '#3b82f6' },
        { target: '成果文件', to: '写作训练/上传', tool: '📎 上传 + kb_import', color: '#7c3aed' }
      ]
      return React.createElement('div', { 'data-mem-view': 'talk', style: { padding: 12 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          React.createElement('span', { style: { fontSize: 16, fontWeight: 700 } }, '💬 对话记忆 · 提炼管道'),
          memBtn('🔄 刷新', '', function () { memSummaryLoad().then(function (d) { if (d && d.ok) setData(d) }).catch(function () {}) })),
        React.createElement('div', { style: { fontSize: 11.5, color: '#6b7280', marginBottom: 8 } }, '原始对话留在会话 jsonl（天然载体，只读回溯）；价值在「提炼」——对话中产生的灵感/设定/经验/结论需显式沉淀到文档记忆才长期可复用。下方为 Phase2 提炼台（标记→选目标→一键落库），再下方为 Phase1 管道说明与记忆系统实况。'),
        React.createElement(MemTalkDistill, null),
        React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0 10px' } },
          memStat('working 活跃', st.working || 0, '#6b7280'),
          memStat('L2 raw', st.rawRecords || 0, '#d97706'),
          memStat('事实待确认', st.factsPending || 0, '#93c5fd'),
          memStat('L1 已确认', st.confirmed || 0, '#059669')),
        React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '提炼动作 → 落库目标（双轨共用一套动作）'),
        pipelines.map(function (p) {
          return React.createElement('div', { key: p.target, style: { display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #e4e4e7', borderRadius: 8, padding: '6px 8px', marginBottom: 5, background: '#fff' } },
            React.createElement('span', { style: { width: 8, height: 8, borderRadius: 4, background: p.color } }),
            React.createElement('span', { style: { fontSize: 12, fontWeight: 500, flex: '0 0 140px' } }, p.target),
            React.createElement('span', { style: { fontSize: 12, color: '#6b7280', flex: 1 } }, '→ ' + p.to),
            React.createElement('span', { style: { fontSize: 10, padding: '1px 6px', borderRadius: 8, background: 'rgba(0,0,0,0.05)', color: '#374151' } }, p.tool))
        }),
        (data.workingIds || []).length ? React.createElement('div', { style: { fontSize: 11.5, color: '#047857', marginTop: 8 } }, '当前工作记忆：' + data.workingIds.join('、') + '（任务闭合前的过程记忆，可回溯）') : React.createElement('div', { style: { fontSize: 11.5, color: '#9ca3af', marginTop: 8 } }, '当前 working 0 使用（memory_* 待激活）——任务进行中可用 memory_record 记录、闭合用 memory_close 提炼 L1。'),
        React.createElement(MemTalkSearch, null),
        React.createElement(MemQueuePanel, null),
        React.createElement('div', { style: { fontSize: 10.5, color: '#9ca3af', marginTop: 8 } }, '已实现：提炼台 / 提炼历史 / 对话回顾检索 / 待提炼队列（下方两区，Phase3 批次3）；规划中：working 工作记忆视图（raw 事件流可视化）。检索与队列为面板内只读/自持操作，不注入会话上下文、不触发记忆加载。'))
    }
    // ============ Phase3 批次3（⑥ 对话回顾检索，只读不注入）：sessionList 下拉 → sessionSearch 关键词/类型过滤 / sessionRecent「最近说了什么」 ============
    var MEM_SESSION_TYPES = ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'todo/write']
    function MemTalkSearch() {
      var [sessions, setSessions] = React.useState(null)
      var [sessErr, setSessErr] = React.useState('')
      var [sel, setSel] = React.useState('')
      var [q, setQ] = React.useState('')
      var [type, setType] = React.useState('')
      var [res, setRes] = React.useState(null)
      var [busy, setBusy] = React.useState('')
      var [msg, setMsg] = React.useState('')
      var loadSessions = function () {
        setSessErr('')
        api(MEM_WS_API, 'sessionList', {}).then(function (d) {
          if (d && d.ok && Array.isArray(d.sessions)) { setSessions(d.sessions); if (!d.sessions.length) setSessErr('当前无可用会话') }
          else setSessErr((d && d.error) || '会话列表不可用')
        }).catch(function (e) { setSessErr('会话列表读取失败：' + (e && e.message || '网络错误')) })
      }
      React.useEffect(loadSessions, [])
      var grayErr = function (m) { return !m ? false : /不可用|超时|请求失败|网络错误|降级|未挂载/i.test(m) }
      var doSearch = function () {
        if (!sel) { setMsg('请先选择会话'); return }
        if (busy) return
        setBusy('search'); setMsg(''); setRes(null)
        api(MEM_WS_API, 'sessionSearch', { sessionId: sel, q: q.trim(), types: type ? [type] : [], limit: 30 }).then(function (d) {
          setBusy('')
          if (d && d.ok) setRes({ mode: 'search', session: d.session || { id: sel }, total: d.total, count: d.count, hits: d.hits || [] })
          else setMsg((d && d.error) || '检索失败')
        }).catch(function (e) { setBusy(''); setMsg('检索请求失败：' + (e && e.message || '网络错误')) })
      }
      var doRecent = function () {
        if (!sel) { setMsg('请先选择会话'); return }
        if (busy) return
        setBusy('recent'); setMsg(''); setRes(null)
        api(MEM_WS_API, 'sessionRecent', { sessionId: sel, n: 20 }).then(function (d) {
          setBusy('')
          if (d && d.ok) setRes({ mode: 'recent', session: d.session || { id: sel }, total: d.total, count: d.count, hits: d.recent || [] })
          else setMsg((d && d.error) || '读取失败')
        }).catch(function (e) { setBusy(''); setMsg('读取请求失败：' + (e && e.message || '网络错误')) })
      }
      var rowTone = function (t) { return t === 'user/message' ? '#059669' : (t === 'assistant/message' ? '#3b82f6' : (t === 'todo/write' ? '#d97706' : '#6b7280')) }
      var rows = (res && res.hits) || []
      return React.createElement('div', { 'data-dialog-search': '1', style: { marginTop: 12, border: '1px solid #e4e4e7', borderRadius: 10, padding: 10, background: '#fafafa' } },
        React.createElement('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 4 } }, '🔍 对话回顾检索'),
        React.createElement('div', { style: { fontSize: 10.5, color: '#6b7280', marginBottom: 8, lineHeight: 1.6 } }, '选会话 → 关键词/事件类型过滤（关键词空 = 事件流尾 30 条）；或「最近说了什么」直接看尾部 20 条。只读面板检索，不注入会话上下文；长会话整段过滤可能较慢（host 8s 守卫超时灰字降级）。'),
        React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 } },
          React.createElement('select', { 'data-dialog-search-session': '1', value: sel, onChange: function (ev) { setSel(ev.target.value); setRes(null) }, style: { fontSize: 11, padding: '3px 6px', border: '1px solid #d4d4d8', borderRadius: 6, maxWidth: 240 } },
            React.createElement('option', { value: '' }, '— 选择会话（标题缺失回退 id）—'),
            (sessions || []).map(function (s) { return React.createElement('option', { key: s.id, value: s.id }, (s.title || s.id) + (s.cwd ? ' · ' + s.cwd : '')) })),
          React.createElement('input', { value: q, 'data-dialog-search-q': '1', onChange: function (ev) { setQ(ev.target.value) }, placeholder: '关键词（空=事件流）', style: memInput({ width: 160 }) }),
          React.createElement('select', { value: type, 'data-dialog-search-type': '1', onChange: function (ev) { setType(ev.target.value); setRes(null) }, style: { fontSize: 11, padding: '3px 6px', border: '1px solid #d4d4d8', borderRadius: 6 } },
            React.createElement('option', { value: '' }, '全部事件类型'),
            MEM_SESSION_TYPES.map(function (t) { return React.createElement('option', { key: t, value: t }, t) })),
          memBtnA('🔍 搜索', 'primary', doSearch, busy !== '', { 'data-dialog-search-run': '1' }),
          memBtnA('🕘 最近说了什么', '', doRecent, busy !== '', { 'data-dialog-search-recent': '1' }),
          memBtn('🔄 会话列表', '', loadSessions)),
        sessErr ? React.createElement('div', { style: { fontSize: 11, color: grayErr(sessErr) ? '#9ca3af' : '#dc2626', marginBottom: 4 } }, sessErr) : null,
        msg ? React.createElement('div', { style: { fontSize: 11, color: grayErr(msg) ? '#9ca3af' : '#dc2626', marginBottom: 4 } }, msg) : null,
        res ? React.createElement('div', { 'data-dialog-search-result': '1', style: { marginTop: 4 } },
          React.createElement('div', { style: { fontSize: 11, color: '#374151', marginBottom: 4 } },
            (res.mode === 'recent' ? '最近 ' + res.count + ' 条事件（该会话共 ' + res.total + ' 条）' : (q.trim() ? '关键词命中 ' + res.total + ' 条 · 显示 ' + res.count + ' 条' : '事件流尾 ' + res.count + ' 条（共 ' + res.total + '）')) + (res.session && res.session.title ? ' · ' + res.session.title : '')),
          rows.length ? rows.map(function (r, i) {
            return React.createElement('div', { key: i, 'data-dialog-search-hit': String(r.seq), style: { border: '1px solid #e4e4e7', borderRadius: 6, padding: '4px 8px', marginBottom: 4, background: '#fff' } },
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                React.createElement('span', { style: { fontSize: 10, color: '#9ca3af' } }, '#' + r.seq),
                React.createElement('span', { style: { fontSize: 10, padding: '0 6px', borderRadius: 7, background: 'rgba(0,0,0,0.05)', color: rowTone(r.type) } }, r.type),
                r.time ? React.createElement('span', { style: { fontSize: 10, color: '#9ca3af' } }, String(r.time).slice(0, 19).replace('T', ' ')) : null,
                React.createElement('span', { style: { fontSize: 10, color: '#9ca3af', marginLeft: 'auto' } }, r.surface || '')),
              r.text ? React.createElement('div', { style: { fontSize: 11.5, color: '#374151', marginTop: 2, lineHeight: 1.5 } }, r.text) : null)
          }) : memEmptyBox('无检索结果（关键词无命中 / 会话为空 / 事件无文本）'))
        : null)
    }
    // ============ Phase3 批次3（⑥ 待提炼队列）：queueSuggest 候选 → 入队(queueAdd) → queueUpdate 状态 + 一键落库（复用 memDistill payload 组装） ============
    // 说明：host 批次2 提供 queueSuggest/queueAdd/queueUpdate 三个 action（无队列读取 action）→ 队列项在本面板会话内维护；
    // queueAdd/queueUpdate 即写盘 sidecar 待提炼队列.json（host 首写才建/缺失空态），刷新后回显需 host 侧补 queueList（非本批次范围）。
    function MemQueuePanel() {
      var [items, setItems] = React.useState([])
      var [cands, setCands] = React.useState(null)
      var [candMsg, setCandMsg] = React.useState('')
      var [selId, setSelId] = React.useState('')
      var [sessions, setSessions] = React.useState(null)
      var [busy, setBusy] = React.useState('')
      var [msg, setMsg] = React.useState('')
      var [draftT, setDraftT] = React.useState({})
      var loadSessions = function () {
        api(MEM_WS_API, 'sessionList', {}).then(function (d) { if (d && d.ok && Array.isArray(d.sessions)) setSessions(d.sessions) }).catch(function () {})
      }
      React.useEffect(loadSessions, [])
      var suggest = function () {
        if (busy) return
        if (!selId) { setCandMsg('请先选择会话（queueSuggest 至少需 sessionId 或 text 一个输入源）'); return }
        setBusy('suggest'); setCandMsg(''); setCands(null)
        api(MEM_WS_API, 'queueSuggest', { sessionId: selId }).then(function (d) {
          setBusy('')
          if (d && d.ok) { setCands(d.candidates || []); setCandMsg(d.note || (d.candidates && d.candidates.length ? '' : '本会话暂无候选')) }
          else { setCands([]); setCandMsg((d && d.error) || '候选生成失败') }
        }).catch(function (e) { setBusy(''); setCands([]); setCandMsg('候选请求失败：' + (e && e.message || '网络错误')) })
      }
      var enqueue = function (c) {
        setBusy('add')
        api(MEM_WS_API, 'queueAdd', { text: c.text, sessionId: c.sessionId || selId || undefined, guess: c.guess || undefined }).then(function (d) {
          setBusy('')
          if (d && d.ok) {
            setItems(function (arr) { return [d.item].concat(arr.filter(function (x) { return x.id !== d.id })) })
            setCands(function (cs) { return (cs || []).filter(function (x) { return x !== c }) })
            setMsg('✅ 已入队（guess ' + ((d.item.guess && d.item.guess.kind) || '?') + '）')
          } else setMsg('❌ 入队失败：' + ((d && d.error) || '未知错误'))
        }).catch(function (e) { setBusy(''); setMsg('❌ 入队请求失败：' + (e && e.message || '网络错误')) })
      }
      var setStatus = function (item, status) {
        if (busy) return
        setBusy('st:' + item.id)
        api(MEM_WS_API, 'queueUpdate', { id: item.id, status: status }).then(function (d) {
          setBusy('')
          if (d && d.ok) {
            setItems(function (arr) { return arr.map(function (x) { return x.id === item.id ? Object.assign({}, x, { status: status }) : x }) })
            setMsg(status === '忽略' ? '已忽略该候选（queueUpdate 写盘）' : '状态已更新')
          } else setMsg('❌ 更新失败：' + ((d && d.error) || '未知错误'))
        }).catch(function (e) { setBusy(''); setMsg('❌ 更新请求失败：' + (e && e.message || '网络错误')) })
      }
      var fallbackTitle = function (text) { var t = String(text || '').trim(); return t.length > 20 ? t.slice(0, 20) + '…' : t }
      var setDraft = function (itemId, patch) { var nd = Object.assign({}, draftT); nd[itemId] = Object.assign({ target: 'insp' }, nd[itemId], patch); setDraftT(nd) }
      var distillItem = function (item) {
        var dt = draftT[item.id] || {}
        var target = dt.target || 'insp'
        var title = (dt.title && String(dt.title).trim()) || fallbackTitle(item.text)
        var payload
        if (target === 'insp') payload = { title: title, content: item.text, oneLiner: '', tags: '' }
        else if (target === 'kb') payload = { title: title, content: item.text, category: '创作技法', description: '', tags: '', aliases: '' }
        else payload = { content: item.text, title: '', taskId: '', project: '', type: 'message', tags: '' }
        setBusy('distill:' + item.id); setMsg('')
        memDistill(target, payload).then(function (d) {
          if (d && d.ok) {
            api(MEM_WS_API, 'queueUpdate', { id: item.id, status: '已落库', distill: { target: target, downstreamId: d.downstreamId || '', at: new Date().toISOString() } }).then(function (u) {
              setBusy('')
              var did = (u && u.ok && u.item && u.item.distill) || { target: target, downstreamId: d.downstreamId || '' }
              setItems(function (arr) { return arr.map(function (x) { return x.id === item.id ? Object.assign({}, x, { status: '已落库', distill: did }) : x }) })
              setMsg('✅ 已落库到 ' + (target === 'insp' ? '灵感库' : (target === 'kb' ? '知识库' : '工程记忆 working/raw')) + '：' + title)
            })
          } else { setBusy(''); setMsg('❌ 落库失败：' + ((d && d.error) || '未知错误')) }
        }).catch(function (e) { setBusy(''); setMsg('❌ 落库请求失败：' + (e && e.message || '网络错误')) })
      }
      var kindColor = { '灵感': '#d97706', '经验': '#059669', '结论': '#3b82f6' }
      var statusColor = { '待处理': '#d97706', '已落库': '#059669', '忽略': '#9ca3af' }
      var dtLabels = [['insp', '① 灵感'], ['kb', '② 知识库'], ['memory', '③ 工程记忆']]
      return React.createElement('div', { 'data-queue': '1', style: { marginTop: 12, border: '1px solid #e4e4e7', borderRadius: 10, padding: 10, background: '#fafafa' } },
        React.createElement('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 4 } }, '🕘 待提炼队列'),
        React.createElement('div', { style: { fontSize: 10.5, color: '#6b7280', marginBottom: 8, lineHeight: 1.6 } }, '候选=会话当前面规则初筛（queueSuggest，启发式无 LLM，仅供提醒，最终决策在用户）；入队即 queueAdd 写盘 sidecar 待提炼队列.json；「一键落库」复用提炼台 payload 组装（memDistill），成功后 queueUpdate 置 已落库+distill 标记。'),
        React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 } },
          React.createElement('select', { 'data-queue-session': '1', value: selId, onChange: function (ev) { setSelId(ev.target.value); setCands(null) }, style: { fontSize: 11, padding: '3px 6px', border: '1px solid #d4d4d8', borderRadius: 6, maxWidth: 240 } },
            React.createElement('option', { value: '' }, '— 选会话（扫描候选用）—'),
            (sessions || []).map(function (s) { return React.createElement('option', { key: s.id, value: s.id }, (s.title || s.id) + (s.cwd ? ' · ' + s.cwd : '')) })),
          memBtnA('✨ 生成候选', 'primary', suggest, busy !== '', { 'data-queue-suggest': '1' })),
        React.createElement('div', { 'data-queue-cands': '1' },
          candMsg ? React.createElement('div', { style: { fontSize: 11, color: candMsg.indexOf('❌') === 0 || candMsg.indexOf('失败') >= 0 ? '#9ca3af' : '#6b7280', marginBottom: 4 } }, candMsg) : null,
          cands && cands.length ? cands.slice(0, 8).map(function (c, i) {
            var gc = c.guess || {}
            return React.createElement('div', { key: i, 'data-queue-cand': i, style: memCard() },
              React.createElement('div', { style: { fontSize: 11.5, color: '#374151', lineHeight: 1.5 } }, String(c.text || '').slice(0, 200)),
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 4 } },
                React.createElement('span', { style: { fontSize: 10, padding: '1px 6px', borderRadius: 8, background: 'rgba(0,0,0,0.05)', color: kindColor[gc.kind] || '#6b7280', fontWeight: 600 } }, '猜判：' + (gc.kind || '?')),
                React.createElement('span', { style: { fontSize: 10, color: '#9ca3af' } }, gc.note || ''),
                React.createElement('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
                  memBtnA('📥 入队', 'primary', function () { enqueue(c) }, busy !== '', { 'data-queue-add': '1' }),
                  memBtnA('忽略', '', function () { setCands((cs || []).filter(function (x) { return x !== c })) }, busy !== '', { 'data-queue-ignore': '1' }))))
          }) : null),
        React.createElement('div', { style: { fontSize: 12, fontWeight: 600, margin: '10px 0 4px' } }, '队列（' + items.length + ' · 会话内维护，queueAdd/queueUpdate 已写盘）'),
        React.createElement('div', { 'data-queue-items': '1' },
          items.length ? items.map(function (item) {
            var gc = item.guess || {}
            var st = item.status || '待处理'
            var dt = draftT[item.id] || { target: 'insp', title: '' }
            return React.createElement('div', { key: item.id, 'data-queue-item': item.id, style: memCard({ borderLeft: '3px solid ' + (statusColor[st] || '#6b7280') }) },
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                React.createElement('span', { style: { fontSize: 10, padding: '0 6px', borderRadius: 7, background: 'rgba(0,0,0,0.05)', color: statusColor[st] || '#6b7280', fontWeight: 600 } }, st),
                React.createElement('span', { style: { fontSize: 10, padding: '0 6px', borderRadius: 7, background: 'rgba(0,0,0,0.05)', color: kindColor[gc.kind] || '#6b7280' } }, gc.kind || '未猜判'),
                React.createElement('span', { style: { fontSize: 10, color: '#9ca3af', flex: 1, minWidth: 60 } }, String(item.at || '').slice(0, 16).replace('T', ' ')),
                item.distill ? React.createElement('span', { style: { fontSize: 10, color: '#047857' } }, '已落库 → ' + item.distill.target + '（' + item.distill.downstreamId + '）') : null),
              React.createElement('div', { style: { fontSize: 11.5, color: '#374151', marginTop: 2, lineHeight: 1.5 } }, String(item.text || '').slice(0, 300)),
              st === '待处理' ? React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 5 } },
                React.createElement('select', { 'data-queue-target': item.id, value: dt.target, onChange: function (ev) { setDraft(item.id, { target: ev.target.value }) }, style: { fontSize: 11, padding: '2px 6px', border: '1px solid #d4d4d8', borderRadius: 5 } },
                  dtLabels.map(function (x) { return React.createElement('option', { key: x[0], value: x[0] }, x[1]) })),
                React.createElement('input', { value: dt.title || '', 'data-queue-title': item.id, onChange: function (ev) { setDraft(item.id, { title: ev.target.value }) }, placeholder: '标题（insp/kb 必填，留空取片段前 20 字）', style: memInput({ width: 200 }) }),
                memBtnA('🚀 一键落库', 'primary', function () { distillItem(item) }, busy !== '', { 'data-queue-distill': item.id }),
                memBtnA('忽略', '', function () { setStatus(item, '忽略') }, busy !== '', { 'data-queue-status': item.id }))
                : null)
          }) : memEmptyBox('队列为空——「生成候选」后入队，或本面板会话内维护（host 未提供队列读取 action，刷新后需重新入队）'),
          msg ? React.createElement('div', { style: { fontSize: 11, color: msg.indexOf('❌') === 0 ? '#dc2626' : '#059669', marginTop: 4 } }, msg) : null))
    }
    // ============ Phase2 U8 + Phase3 ②：用户偏好·编辑化（创作/工程偏好 sidecar 可编辑 + 创作原点 fixed 只读固定区 + 记忆策略可编辑写回 memConfigSet） ============
    function MemPrefsView() {
      var [prefs, setPrefs] = React.useState(null) // prefsGet
      var [data, setData] = React.useState(null) // memSummary（记忆策略/置顶只读）
      var [err, setErr] = React.useState('')
      var [flash, setFlash] = React.useState('')
      var [busy, setBusy] = React.useState(false)
      // Phase3 批次3（② 记忆策略编辑）：本地草稿（null=未编辑，跟随 memSummary 回显值）；保存走 host memConfigSet
      var [strat, setStrat] = React.useState(null)
      var [stratBusy, setStratBusy] = React.useState(false)
      var [stratMsg, setStratMsg] = React.useState('')
      var loadAll = function () {
        setErr('')
        Promise.all([memPrefsGet(), memSummaryLoad()]).then(function (rs) {
          var p = rs[0], d = rs[1]
          if (p && p.ok) {
            setPrefs({ writing: Object.assign({}, p.writing), engineering: Object.assign({}, p.engineering, { toolPrefs: (p.engineering && p.engineering.toolPrefs) || [] }), origins: p.origins || [], reminders: p.reminders || [], updatedAt: p.updatedAt || null })
          } else setErr((p && p.error) || '偏好加载失败')
          if (d && d.ok) { setData(d); setStrat(null) }
        }).catch(function (e) { setErr('偏好加载失败：' + (e && e.message || '网络错误')) })
      }
      React.useEffect(function () { loadAll() }, [])
      var setW = function (k, v) { setPrefs(function (pr) { var nw = Object.assign({}, pr.writing); nw[k] = v; return Object.assign({}, pr, { writing: nw }) }) }
      var setE = function (k, v) { setPrefs(function (pr) { var ne = Object.assign({}, pr.engineering); ne[k] = v; return Object.assign({}, pr, { engineering: ne }) }) }
      var save = function () {
        setBusy(true); setFlash('')
        memPrefsSet({ writing: prefs.writing, engineering: prefs.engineering }).then(function (d) {
          setBusy(false)
          if (d && d.ok) { setPrefs(function (pr) { return Object.assign({}, pr, { writing: d.writing, engineering: d.engineering, updatedAt: d.updatedAt }) }); setFlash('✅ 偏好已保存（写入 用户偏好.json）') }
          else setFlash('❌ ' + ((d && d.error) || '保存失败'))
        }).catch(function (e) { setBusy(false); setFlash('❌ 请求失败：' + (e && e.message || '网络错误')) })
      }
      if (err) return React.createElement('div', { 'data-mem-view': 'prefs' }, React.createElement('div', { style: { padding: 12 } }, memBtn('🔄 重试', '', loadAll)), memErrBox(err))
      if (!prefs) return React.createElement('div', { 'data-mem-view': 'prefs' }, memLoading())
      var cfg = (data && data.config && data.config.memoryScore) || {}
      var wcfg = cfg.weights || {}
      var pinnedL1 = data ? (data.l1 || []).filter(function (x) { return x.pinned }) : []
      // ===== Phase3 批次3（② 记忆策略编辑 draft）：strat=null → 跟随 memSummary 回显（host 已并入默认值）；编辑后 setStrat 快照本地草稿 =====
      var scWDef = { importance: 0.3, accessLog: 0.2, priority: 0.3, reinforcement: 0.2 }
      var draft = strat || {
        enabled: cfg.enabled !== false,
        weights: {
          importance: memNum(wcfg.importance, scWDef.importance),
          accessLog: memNum(wcfg.accessLog, scWDef.accessLog),
          priority: memNum(wcfg.priority, scWDef.priority),
          reinforcement: memNum(wcfg.reinforcement, scWDef.reinforcement)
        },
        decayRate: memNum(cfg.decayRate, 0.01),
        importantThreshold: memNum(cfg.importantThreshold, 0.7),
        addScale: memNum(cfg.addScale, 50)
      }
      var c01 = function (v) { var n = Number(v); if (String(v).trim() === '' || !isFinite(n)) n = 0; return Math.min(1, Math.max(0, n)) }
      var patchStrat = function (patch) { setStrat(Object.assign({}, draft, patch)) }
      var patchWeight = function (k, v) { var w = Object.assign({}, draft.weights); w[k] = v; patchStrat({ weights: w }) }
      var saveStrategy = function () {
        if (stratBusy) return
        setStratBusy(true); setStratMsg('')
        var payload = {
          memoryScore: {
            enabled: draft.enabled === true,
            weights: {
              importance: c01(draft.weights.importance),
              accessLog: c01(draft.weights.accessLog),
              priority: c01(draft.weights.priority),
              reinforcement: c01(draft.weights.reinforcement)
            },
            decayRate: c01(draft.decayRate),
            importantThreshold: c01(draft.importantThreshold),
            addScale: Math.min(10000, Math.max(0, Math.round(Number(draft.addScale) || 0)))
          }
        }
        api(MEM_WS_API, 'memConfigSet', payload).then(function (d) {
          setStratBusy(false)
          if (d && d.ok) {
            setStratMsg('✅ 记忆策略已保存到 memory.json.config.memoryScore' + (d.appliedAt ? '（' + String(d.appliedAt).slice(0, 19).replace('T', ' ') + '）' : ''))
            setStrat(null) // 回显用服务端合并值
            memSummaryLoad().then(function (dd) { if (dd && dd.ok) setData(dd) }).catch(function () {}) // 即时回显
          } else setStratMsg('❌ ' + ((d && d.error) || '保存失败'))
        }).catch(function (e) { setStratBusy(false); setStratMsg('❌ 请求失败：' + (e && e.message || '网络错误')) })
      }
      var field = function (label, node) {
        return React.createElement('div', { style: { marginBottom: 8 } },
          React.createElement('div', { style: { fontSize: 11.5, color: '#6b7280', marginBottom: 3 } }, label),
          node)
      }
      return React.createElement('div', { 'data-mem-view': 'prefs', style: { padding: 12 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' } },
          React.createElement('span', { style: { fontSize: 16, fontWeight: 700 } }, '👤 用户偏好'),
          memBtn('🔄 刷新', '', loadAll),
          memBtn('💾 保存偏好', 'primary', save, busy),
          flash ? React.createElement('span', { style: { fontSize: 11, color: flash.indexOf('❌') === 0 ? '#dc2626' : '#059669' } }, flash) : null),
        // 创作偏好（可编辑 → 用户偏好.json）
        React.createElement('div', { 'data-prefs-section': 'writing', style: memCard({ padding: 10 }) },
          React.createElement('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 8 } }, '✍️ 创作偏好（可编辑）'),
          field('题材倾向 genre', React.createElement('input', { value: prefs.writing.genre || '', 'data-prefs-w-genre': '1', onChange: function (ev) { setW('genre', ev.target.value) }, placeholder: '如：都市悬疑 / 东方奇幻', style: memInput() })),
          React.createElement('div', { style: { display: 'flex', gap: 8 } },
            field('写作时间', React.createElement('input', { value: prefs.writing.writingTime || '', onChange: function (ev) { setW('writingTime', ev.target.value) }, placeholder: '如：每晚 21:00-23:00', style: memInput() })),
            field('提醒时间（现状只读·写作记录.json）', React.createElement('input', { value: (prefs.reminders && prefs.reminders.length) ? prefs.reminders.join(' / ') : '未设置', disabled: true, style: memInput({ background: '#f4f4f5', color: '#6b7280' }) }))),
          React.createElement('div', { style: { display: 'flex', gap: 8 } },
            field('目标字数（累计）', React.createElement('input', { type: 'number', min: 0, value: prefs.writing.goalWords || 0, 'data-prefs-w-goalWords': '1', onChange: function (ev) { setW('goalWords', Math.max(0, Number(ev.target.value) || 0)) }, style: memInput() })),
            field('连续目标（天）', React.createElement('input', { type: 'number', min: 0, value: prefs.writing.goalStreak || 0, onChange: function (ev) { setW('goalStreak', Math.max(0, Number(ev.target.value) || 0)) }, style: memInput() }))),
          field('风格偏好 style', React.createElement('textarea', { value: prefs.writing.style || '', 'data-prefs-w-style': '1', onChange: function (ev) { setW('style', ev.target.value) }, rows: 3, placeholder: '如：冷硬短句、多对话推进、节制形容词…', style: memInput({ resize: 'vertical' }) }))),
        // 创作原点（固定区，只读不可改）
        React.createElement('div', { 'data-prefs-origins': '1', style: memCard({ padding: 10, borderLeft: '3px solid #7c3aed' }) },
          React.createElement('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 4 } }, '🔒 创作原点（固定灵感 · 只读）'),
          React.createElement('div', { style: { fontSize: 10.5, color: '#9ca3af', marginBottom: 8 } }, '创作原点 = 灵感库中已固定（📌）的灵感，是你创作的根本出发点；本页不可修改——请到「作品记忆 → 灵感看板」固定/取消固定。'),
          prefs.origins.length ? prefs.origins.map(function (o) {
            return React.createElement('div', { key: o.id, 'data-prefs-origin': o.id, style: { border: '1px solid #ede9fe', borderRadius: 8, padding: '6px 8px', marginBottom: 5, background: '#faf5ff' } },
              React.createElement('div', { style: { fontSize: 12.5, fontWeight: 600 } }, '📌 ' + o.title),
              o.oneLiner ? React.createElement('div', { style: { fontSize: 11, color: '#6b7280', marginTop: 2 } }, o.oneLiner) : null,
              (o.tags && o.tags.length) ? React.createElement('div', { style: { marginTop: 3 } }, o.tags.slice(0, 5).map(function (t) { return React.createElement('span', { key: t, style: { fontSize: 9.5, padding: '0 5px', borderRadius: 7, background: 'rgba(124,58,237,0.1)', color: '#6d28d9', marginRight: 3 } }, t) })) : null)
          }) : memEmptyBox('暂无固定灵感（在作品记忆页固定灵感即成为创作原点）')),
        // 工程偏好（可编辑）
        React.createElement('div', { 'data-prefs-section': 'engineering', style: memCard({ padding: 10 }) },
          React.createElement('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 8 } }, '⚙️ 工程偏好（可编辑）'),
          field('技术选型倾向', React.createElement('input', { value: prefs.engineering.techTendency || '', 'data-prefs-e-tech': '1', onChange: function (ev) { setE('techTendency', ev.target.value) }, placeholder: '如：偏好 Node 静态插件 / Cordis 动态插件…', style: memInput() })),
          field('规范遵循等级', React.createElement('select', { value: prefs.engineering.strictness || '标准', 'data-prefs-e-strictness': '1', onChange: function (ev) { setE('strictness', ev.target.value) }, style: { fontSize: 12, padding: '4px 8px', border: '1px solid #d4d4d8', borderRadius: 6, width: '100%' } },
            PREFS_STRICTNESS_CLI.map(function (s) { return React.createElement('option', { key: s, value: s }, s) }))),
          field('工具偏好 tags（逗号分隔）', React.createElement('input', { value: (prefs.engineering.toolPrefs || []).join(','), 'data-prefs-e-tools': '1', onChange: function (ev) { setE('toolPrefs', ev.target.value.split(',').map(function (s) { return s.trim() }).filter(Boolean)) }, placeholder: '如：writing-studio, taskkit, knowledge-base', style: memInput() }))),
        // 置顶记忆（只读，沿用 Phase1）
        React.createElement('div', { style: { fontSize: 13, fontWeight: 600, margin: '12px 0 6px' } }, '📌 置顶工程记忆' + (pinnedL1.length ? '' : '（暂无——在「工程记忆」面板点 📌 置顶）')),
        pinnedL1.length ? pinnedL1.map(function (x) {
          return React.createElement('div', { key: x.task_id, style: { display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #e4e4e7', borderRadius: 8, padding: '5px 8px', marginBottom: 4, background: '#fff' } },
            React.createElement('span', { style: { fontSize: 12, fontWeight: 500, flex: 1 } }, x.title),
            React.createElement('span', { style: { fontSize: 10, color: '#6b7280' } }, x.project || '—'),
            React.createElement('span', { style: { fontSize: 10, color: '#6b7280' } }, x.source === 'confirmed' ? '已确认' : '草稿'))
        }) : memEmptyBox('暂无置顶工程记忆'),
        // 记忆策略（Phase3 ② 可编辑 → host memConfigSet → memory.json.config.memoryScore；与「用户偏好」分层独立保存）
        React.createElement('div', { 'data-policy-form': '1', style: memCard({ padding: 10, marginTop: 12, borderTop: '3px solid #3b82f6' }) },
          React.createElement('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 4 } }, '🧭 记忆策略（memory.json.config.memoryScore · 可编辑写回）'),
          React.createElement('div', { style: { fontSize: 10.5, color: '#6b7280', marginBottom: 8, lineHeight: 1.6 } },
            '记忆分 =（重要度×importance + 活跃度×accessLog + 优先级×priority + 强化×reinforcement）× 衰减(decayRate)；4 权重建议和为 1（不强制归一）；enabled=false 关闭记忆分排序（逃生门）；addScale 上限 10000（过大翻转关键词层级，UI 已钳制）。'),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
            React.createElement('label', { style: { fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' } },
              React.createElement('input', { type: 'checkbox', 'data-policy-enabled': '1', checked: draft.enabled === true, onChange: function (ev) { patchStrat({ enabled: ev.target.checked }) } }),
              '启用记忆分数排序（enabled）')),
          React.createElement('div', { style: { fontSize: 11.5, color: '#6b7280', marginBottom: 4 } }, 'weights（0-1，step 0.05；建议和=1）'),
          React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
            React.createElement('label', { style: { fontSize: 11, color: '#6b7280' } }, 'importance',
              React.createElement('input', { type: 'number', min: 0, max: 1, step: 0.05, value: draft.weights.importance, 'data-policy-importance': '1', onChange: function (ev) { patchWeight('importance', c01(ev.target.value)) }, style: Object.assign(memInput({ width: 84 }), { display: 'block', marginTop: 2 }) })),
            React.createElement('label', { style: { fontSize: 11, color: '#6b7280' } }, 'accessLog',
              React.createElement('input', { type: 'number', min: 0, max: 1, step: 0.05, value: draft.weights.accessLog, 'data-policy-accesslog': '1', onChange: function (ev) { patchWeight('accessLog', c01(ev.target.value)) }, style: Object.assign(memInput({ width: 84 }), { display: 'block', marginTop: 2 }) })),
            React.createElement('label', { style: { fontSize: 11, color: '#6b7280' } }, 'priority',
              React.createElement('input', { type: 'number', min: 0, max: 1, step: 0.05, value: draft.weights.priority, 'data-policy-priority': '1', onChange: function (ev) { patchWeight('priority', c01(ev.target.value)) }, style: Object.assign(memInput({ width: 84 }), { display: 'block', marginTop: 2 }) })),
            React.createElement('label', { style: { fontSize: 11, color: '#6b7280' } }, 'reinforcement',
              React.createElement('input', { type: 'number', min: 0, max: 1, step: 0.05, value: draft.weights.reinforcement, 'data-policy-reinforce': '1', onChange: function (ev) { patchWeight('reinforcement', c01(ev.target.value)) }, style: Object.assign(memInput({ width: 84 }), { display: 'block', marginTop: 2 }) }))),
          React.createElement('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 } },
            React.createElement('label', { style: { fontSize: 11, color: '#6b7280' } }, 'decayRate（0-1 衰减率/天）',
              React.createElement('input', { type: 'number', min: 0, max: 1, step: 0.01, value: draft.decayRate, 'data-policy-decay': '1', onChange: function (ev) { patchStrat({ decayRate: c01(ev.target.value) }) }, style: Object.assign(memInput({ width: 120 }), { display: 'block', marginTop: 2 }) })),
            React.createElement('label', { style: { fontSize: 11, color: '#6b7280' } }, 'importantThreshold（0-1 重要阈值）',
              React.createElement('input', { type: 'number', min: 0, max: 1, step: 0.05, value: draft.importantThreshold, 'data-policy-impthr': '1', onChange: function (ev) { patchStrat({ importantThreshold: c01(ev.target.value) }) }, style: Object.assign(memInput({ width: 120 }), { display: 'block', marginTop: 2 }) })),
            React.createElement('label', { style: { fontSize: 11, color: '#6b7280' } }, 'addScale（0-10000 整数）',
              React.createElement('input', { type: 'number', min: 0, max: 10000, step: 1, value: draft.addScale, 'data-policy-addscale': '1', onChange: function (ev) { patchStrat({ addScale: Math.min(10000, Math.max(0, Math.round(Number(ev.target.value) || 0))) }) }, style: Object.assign(memInput({ width: 120 }), { display: 'block', marginTop: 2 }) }))),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            memBtnA('💾 保存记忆策略', 'primary', saveStrategy, stratBusy, { 'data-policy-save': '1' }),
            stratMsg ? React.createElement('span', { 'data-policy-msg': '1', style: { fontSize: 11, color: stratMsg.indexOf('❌') === 0 ? '#dc2626' : '#059669' } }, stratMsg) : null,
            React.createElement('span', { style: { fontSize: 10.5, color: '#9ca3af' } }, '保存成功即 reload memSummary 即时回显（写端点白名单仅 memoryScore 命名空间）'))),
        React.createElement('div', { style: { fontSize: 10.5, color: '#9ca3af' } }, '记忆策略（系统级 memory.json）与上方「用户偏好」（用户级 用户偏好.json sidecar）分层独立保存；策略只允许写 memoryScore 命名空间（rawPolicy/migration/retireWatchdog 只读），host+memory-system 双层白名单校验，非法值 400 红字透传不落盘。'))
    }

    // ============ B5 对话上传文件按钮（2026-08-30 用户需求，additive） ============
    // 落点：conversation.input.right（list/session 槽，ui-conversation 输入区右侧工具行）
    // 行为：隐藏 input[type=file] + 📎 按钮 → FileReader 读文本（readAsText）或二进制（dataURL base64）
    //       → POST /writing-studio/api/upload（host 落盘 DATA_ROOT/上传/）→ inputActions.setDraft 把路径注入输入框
    //       → 用户直接发送，Agent 即可读文件 / kb_import 索引 / writing_coach_retrieve 引用
    var UPLOAD_TEXT_EXT = /\.(md|txt|json|csv|yaml|yml|log|js|ts|py|html|css|xml|ini|conf|toml)$/i
    var UPLOAD_STATE_KEY = 'writing-studio:uploaded'
    function uploadStateGet() {
      try { var raw = sessionStorage.getItem(UPLOAD_STATE_KEY); return raw ? JSON.parse(raw) : [] } catch (e) { return [] }
    }
    function uploadStateAdd(path, name) {
      try {
        var list = uploadStateGet().concat([{ path: path, name: name, at: new Date().toISOString() }]).slice(-20)
        sessionStorage.setItem(UPLOAD_STATE_KEY, JSON.stringify(list))
      } catch (e) {}
    }
    function UploadButton(props) {
      var inputActions = props && props.inputActions
      var input = props && props.input
      var fileRef = React.useRef(null)
      var [busy, setBusy] = React.useState(false)
      var [msg, setMsg] = React.useState('')
      var doUpload = function (file) {
        if (!file) return
        setBusy(true); setMsg('上传中…')
        var isText = UPLOAD_TEXT_EXT.test(file.name)
        var finish = function (payload) {
          fetch('/writing-studio/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          }).then(function (r) { return r.json() }).then(function (d) {
            setBusy(false)
            if (d && d.ok) {
              uploadStateAdd(d.path, d.filename)
              setMsg('✅ ' + d.filename)
              // 路径注入输入框：用户直接发送即被 Agent 引用（对齐 fileMentions/openFile 能力）
              var draft = (input && input.draft) || ''
              var note = (draft ? '\n\n' : '') + '📎 已上传文件：' + d.path + '（可让我导入知识库 / 引用写作）'
              if (inputActions && typeof inputActions.setDraft === 'function') inputActions.setDraft(draft + note)
              else setMsg('✅ 已上传：' + d.path + '（当前会话输入框不可用，可手动粘贴路径）')
            } else {
              setMsg('❌ ' + ((d && d.error) || '上传失败'))
            }
          }).catch(function (e) { setBusy(false); setMsg('❌ 上传请求失败：' + (e && e.message || '网络错误')) })
        }
        if (isText) {
          var readerText = new FileReader()
          readerText.onload = function () { finish({ filename: file.name, content: String(readerText.result || ''), isBase64: false, mime: file.type || 'text/plain' }) }
          readerText.onerror = function () { setBusy(false); setMsg('❌ 读取文本失败') }
          readerText.readAsText(file)
        } else {
          var readerBin = new FileReader()
          readerBin.onload = function () {
            var dataUrl = String(readerBin.result || '')
            var comma = dataUrl.indexOf(',')
            var base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
            finish({ filename: file.name, content: base64, isBase64: true, mime: file.type || 'application/octet-stream' })
          }
          readerBin.onerror = function () { setBusy(false); setMsg('❌ 读取文件失败') }
          readerBin.readAsDataURL(file)
        }
      }
      var recent = uploadStateGet()
      var last = recent.length ? recent[recent.length - 1] : null
      return React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, position: 'relative' } },
        React.createElement('input', { ref: fileRef, type: 'file', style: { display: 'none' }, onChange: function (ev) { var f = ev.target.files && ev.target.files[0]; if (f) doUpload(f); ev.target.value = '' } }),
        React.createElement('button', {
          'data-dsh-upload-btn': '1',
          type: 'button',
          title: '上传文件到工作区（写作训练/上传/），发送后可让我导入知识库或引用写作',
          onClick: function () { if (fileRef.current) fileRef.current.click() },
          disabled: busy,
          style: { fontSize: 14, padding: '2px 6px', border: '1px solid #d4d4d8', borderRadius: 6, background: '#fff', color: '#374151', cursor: 'pointer', lineHeight: 1.4 }
        }, busy ? '⏳' : '📎'),
        msg ? React.createElement('span', { style: { fontSize: 10, color: msg.indexOf('❌') === 0 ? '#dc2626' : '#059669', maxWidth: 160, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, msg) : (last ? React.createElement('span', { title: last.path, style: { fontSize: 10, color: '#6b7280', maxWidth: 120, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, '📄 ' + last.name) : null))
    }

    // ============ 插件 apply ============
    var apply = function apply(ctx) {
      var slots = ctx.get('slots');
      if (slots === undefined) return;
      // 2026-09-24 入口重排 2a：原 conversation.view「写作工作台」(order1) 页签已移除，改由 sidebar.panellist + keyed main 承载。
      // 2026-09-24 入口重排 2b-2：（侧栏行也收走）本插件的 sidebar.panellist 行已移除，改由「插件」抽屉统一承载；
      //   keyed main 面板**保留**并被抽屉以 mode:'page' 切到（组件未变，仍是 StudioHome）。
      // B5 对话上传文件按钮（2026-08-30 用户需求，additive）：
      // conversation.input.right 是 list/session 槽（ui-conversation 输入区右侧工具行），
      // 标准 kit 提供 inputActions（setDraft 注入路径进输入框）——契约零破坏，不影响既有 StatsLine。
      try {
        slots.inject('conversation.input.right', function () {
          return slots.register(
            { name: 'conversation.input.right', id: 'upload-file', order: 0 },
            UploadButton
          );
        });
      } catch (e) {}
      // ============ 整页入口（B 路线 pilot-2 · 2b-2 起由「插件」抽屉触发）============
      // · keyed main 面板（key = id = 'writing-studio'）**保留**：2b-2 起由 adapter 的插件抽屉以 mode:'page'
      //   调 layout.selectPanel('writing-studio') 切到它（= 原生侧栏点一行所做的同一件事：
      //   sidebar-client.js PanelRow.onClick → ctx.layout.selectPanel(id)）。契约与 taskkit 同：
      //   panellist 用 id、main 用同名 key（layout-client.js:515 按 key 匹配）。
      // · 2b-2 删除本插件自己的 sidebar.panellist 行（order=1）：侧栏收敛为 taskkit 两行 + adapter「插件」一行。
      // 复用既有 StudioHome 组件（与已移除的 conversation.view 页签是同一个组件，不复制；2b-2 不改其 UI）。
      var WS_PANEL_ID = 'writing-studio'
      slots.inject('main', function () {
        return slots.register(
          { name: 'main', key: WS_PANEL_ID },
          function () { return React.createElement(StudioHome, null); }
        )
      })
      try { console.info('[writing-studio] keyed main 面板已注册：main key = ' + WS_PANEL_ID) } catch (e) {}
      // ── 向 adapter 的插件抽屉（pluginDock）登记自己 ────────────────────────────────
      // mode:'page' ⇒ adapter 直接调 ctx.get('layout').selectPanel('writing-studio') 切整页，**不需要弹窗**；
      // 故本插件不提供 open（契约允许 mode:'page' 省略 open），也因此**不需要** globalThis 状态
      // （没有跨模块重估要保留的回调/可见性）。用 ctx.inject 而非裸 ctx.get：adapter 是种子 bundle 先加载，
      // 但「加载顺序 ≠ apply 顺序」（cordis inject 会推迟 apply）⇒ 用 inject 兜底时序。
      var settled = false
      var watchdog = window.setTimeout(function () {
        if (settled) return
        try { console.error('[writing-studio] pluginDock 在 4s 内始终未注册：无法登记「写作工作台」入口；抽屉里不会出现本插件（sidebar.panellist 行已于 2b-2 移除）。') } catch (e) {}
      }, 4000)
      ctx.inject(['pluginDock'], function () {
        settled = true
        try { window.clearTimeout(watchdog) } catch (e) {}
        var dock = ctx.get('pluginDock')
        if (!dock || typeof dock.register !== 'function') {
          try { console.error('[writing-studio] pluginDock 不可用：无法登记「写作工作台」入口；抽屉里不会出现本插件（sidebar.panellist 行已于 2b-2 移除）。') } catch (e) {}
          return
        }
        dock.register({ id: 'writing-studio', label: '写作工作台', order: 1, mode: 'page' })
        try { console.info('[writing-studio] 已向 pluginDock 登记（id=writing-studio, mode=page, 无 open）') } catch (e) {}
        ctx.effect(function () {
          return function () {
            try { dock.unregister('writing-studio') } catch (e) {}
          }
        })
      })
      // 2026-09-24 入口重排 2a：原「侧边栏入口」DOM 注入块（data-dsh-writingstudio-entry + 双 MutationObserver
      // + collapsed 探测 + 收起态 CSS dsh-writingstudio-collapsed-style + activateView 页签点击兜底）已整体删除。
      // 同时删除其头部一句错误注释「DSH 侧边栏无外部可用 slot（workspaces/settings 单占），用 DOM 注入」——
      // 该说法不成立：左侧栏有 6 个官方 slot，其中 sidebar.panellist 在 2a 阶段曾是本插件的入口
      // （2b-2 起该行也已收走，改由 adapter 的「插件」抽屉 + main keyed 面板承载，见上方「整页入口」块）。
      // 原块靠 document.querySelector 找原生侧栏插按钮、再点 role="tab" 切页签，属"改 DOM 蹭原生"的旧路线；
      // 且其点击目标（conversation.view 页签）本阶段已移除 ⇒ 整块连同它专用的样式/助手函数一并作废。
      // 注意：仅"侧栏入口"相关被删；上方 conversation.input.right（上传文件按钮）与本插件其余功能均保留。
    };
    var inject = ['timer'];

    exports.name = 'writing-studio';
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

// 工具函数（供模块内使用）
function btn(tone) {
  var base = { fontSize: 12, padding: '3px 10px', borderRadius: 6, cursor: 'pointer' }
  return tone === 'primary'
    ? Object.assign(base, { background: '#d97706', color: '#fff', border: '1px solid #d97706' })
    : Object.assign(base, { background: '#fff', color: '#374151', border: '1px solid #d4d4d8' })
}
