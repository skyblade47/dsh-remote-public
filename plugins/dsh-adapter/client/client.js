// Client：@local/dsh-adapter 的「插件热拔插」设置面板
//
// 位置：设置 → 插件热拔插（slot `settings.section`，已向宿主核实该 slot 真实存在：
//   `@deepseek-ai/dsh-cordis-client-runner/lib/client.js` 的 slot 清单里与 `settings.plugins.tab` 等并列）。
//
// 数据面：全部走 adapter 自己的 HTTP 数据面（与工具层共用同一个 HotplugService，避免两套逻辑漂移）：
//   GET  /adapter/api/hotplug               → 快照 + 条目清单
//   POST /adapter/api/hotplug  {op, id, …}  → 单次操作
//   GET  /adapter/api/hotplug/audit?tail=N  → 审计尾部
//
// 「最近事件」没有专用字段：HotplugService 不再维护运行时 state-store（见设计 §3.2），
// 所以这里用审计尾部按 `extra.id` 反查最近一条——不为了 UI 好看而把已删掉的状态层加回来。
window.__ModuleLoader__.load({
  id: '@local/dsh-adapter',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var BASE = '/adapter/api/hotplug'

    function req(method, path, body) {
      return fetch(path, {
        method: method,
        credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      }).then(function (r) {
        return r.json().then(function (j) {
          if (!j || j.ok === false) {
            var e = new Error((j && j.message) || ('HTTP ' + r.status))
            e.code = (j && j.code) || ('HTTP_' + r.status)
            e.extra = (j && j.extra) || null
            throw e
          }
          return j
        }, function () {
          throw Object.assign(new Error('响应非 JSON（HTTP ' + r.status + '）'), { code: 'BAD_RESPONSE' })
        })
      })
    }
    var getJson = function (p) { return req('GET', p) }
    var postOp = function (body) { return req('POST', BASE, body) }

    // ===== 样式（自注入，不依赖外部 CSS；变量名沿用宿主主题别名）=====
    // 主题对齐（方案A 第二批）：字号统一改用宿主字号 token（font-size 阶梯），灰色/边框/状态前景色改用宿主语义别名；
    // 每个 var(--dsw-*) 都带 fallback（token 名跨版本漂移时最坏退化为"颜色不对"，不会"样式崩掉"）。
    // 保留字面值的两类：
    //   (a) 自洽的"软状态"色组（浅底 + 深字/深边：横幅、档位徽标、软按钮）—— 宿主无跨主题的 tertiary 底 + 对应深字组合，
    //       强行只换底或只换字会在暗色下变成低对比；且它们是"浅底 + 深字"的整体，不存在"token 前景落在固定浅底"的翻转缺陷。
    //   (b) 实底 + 白字（toast）/ 插件自有品牌色（靛、蓝 → 收进 --hp-* 私有前缀）。
    var CSS =
      '.hp{--hp-accent:#4f46e5;--hp-info:#2563eb;padding:12px 16px;font-family:system-ui,"Segoe UI",sans-serif;font-size:var(--dsw-font-xs-13-font-size,13px);line-height:1.5;color:var(--dsw-alias-label-primary,#18181b);}' +
      '.hp h2{font-size:15px;font-weight:600;margin:2px 0 8px;}' +
      '.hp-sub{font-size:var(--dsw-font-xxs-12-font-size,12px);color:var(--dsw-alias-label-secondary,#6b7280);margin-bottom:10px;}' +
      '.hp-banner{border-radius:8px;padding:8px 12px;font-size:var(--dsw-font-xxs-12-font-size,12px);margin-bottom:10px;border:1px solid;}' +
      '.hp-banner-err{background:#fef2f2;border-color:#fecaca;color:#b91c1c;}' +
      '.hp-banner-warn{background:#fffbeb;border-color:#fde68a;color:#92400e;}' +
      '.hp-tabs{display:flex;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l2,#d4d4d8);margin-bottom:10px;}' +
      '.hp-tab{padding:6px 12px;font-size:var(--dsw-font-xxs-12-font-size,12px);cursor:pointer;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary,#6b7280);}' +
      '.hp-tab-on{color:var(--hp-accent);border-color:var(--hp-accent);font-weight:600;}' +
      '.hp-table{border-collapse:collapse;width:100%;font-size:var(--dsw-font-xxs-12-font-size,12px);}' +
      '.hp-table th,.hp-table td{border:1px solid var(--dsw-alias-border-l2,#d4d4d8);padding:5px 8px;text-align:left;vertical-align:top;}' +
      '.hp-table th{background:var(--dsw-alias-bg-layer-2,#f4f4f5);font-weight:600;white-space:nowrap;}' +
      '.hp-table tr:hover td{background:rgba(99,102,241,0.04);}' +
      '.hp-mono{font-family:ui-monospace,Consolas,monospace;font-size:var(--dsw-font-xxxs-11-font-size,11px);}' +
      '.hp-ell{display:inline-block;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;}' +
      '.hp-btn{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l2,#d4d4d8);background:var(--dsw-alias-bg-layer-1,#fff);border-radius:6px;padding:3px 8px;font-size:var(--dsw-font-xxs-12-font-size,12px);cursor:pointer;color:inherit;}' +
      '.hp-btn:disabled{opacity:.45;cursor:not-allowed;}' +
      '.hp-btn-p{background:var(--hp-accent);color:#fff;border-color:var(--hp-accent);}' +
      '.hp-btn-d{background:#fee2e2;color:#b91c1c;border-color:#fecaca;}' +
      '.hp-acts{display:flex;gap:4px;flex-wrap:wrap;}' +
      '.hp-tag{display:inline-block;padding:1px 6px;font-size:10px;border-radius:4px;background:#eef2ff;color:#4338ca;}' +
      '.hp-form{border:1px dashed var(--dsw-alias-border-l2,#d4d4d8);border-radius:10px;padding:10px;margin-top:10px;background:var(--dsw-alias-bg-layer-2,rgba(250,250,250,.5));}' +
      '.hp-form label{display:block;font-size:var(--dsw-font-xxs-12-font-size,12px);color:var(--dsw-alias-label-secondary,#6b7280);margin-bottom:6px;}' +
      '.hp-form input{width:100%;box-sizing:border-box;margin-top:2px;border:1px solid var(--dsw-alias-border-l2,#d4d4d8);border-radius:6px;padding:5px 7px;font-family:system-ui;font-size:var(--dsw-font-xxs-12-font-size,12px);line-height:1.4;}' +
      '.hp-pre{max-height:220px;overflow:auto;background:var(--dsw-alias-markdown-code-block,#fafafa);border:1px solid var(--dsw-alias-border-l2,#d4d4d8);border-radius:6px;padding:8px 10px;font-family:ui-monospace,Consolas,monospace;font-size:var(--dsw-font-xxxs-11-font-size,11px);white-space:pre-wrap;}' +
      '.hp-audit{max-height:300px;overflow:auto;background:var(--dsw-alias-markdown-code-block,#fafafa);border:1px solid var(--dsw-alias-border-l2,#d4d4d8);border-radius:6px;padding:6px 10px;font-family:ui-monospace,Consolas,monospace;font-size:var(--dsw-font-xxxs-11-font-size,11px);}' +
      '.hp-row{display:flex;gap:8px;white-space:pre-wrap;}' +
      '.hp-row+.hp-row{border-top:1px dashed var(--dsw-alias-border-l1,#e5e7eb);padding-top:3px;margin-top:3px;}' +
      '.hp-lvl{flex:0 0 48px;}' +
      '.hp-ts{flex:0 0 108px;color:var(--dsw-alias-label-secondary,#71717a);}' +
      '.hp-toast{position:fixed;right:20px;bottom:30px;z-index:9999;padding:8px 14px;border-radius:8px;font-size:var(--dsw-font-xxs-12-font-size,12px);box-shadow:0 6px 20px rgba(0,0,0,.15);}' +
      '.hp-toast-ok{background:var(--dsw-alias-state-success-primary,#059669);color:#fff;}' +
      '.hp-toast-err{background:var(--dsw-alias-state-error-primary,#dc2626);color:#fff;}' +
      '.hp-empty{padding:18px;color:var(--dsw-alias-label-secondary,#6b7280);}' +
      // 插件抽屉（main key = 'plugins'）—— 只做「共享清单」，弹窗 UI 由各插件自己在 shell.overlay 里渲染
      '.pd{padding:16px;font-family:system-ui,"Segoe UI",sans-serif;font-size:var(--dsw-font-xs-13-font-size,13px);line-height:1.5;color:var(--dsw-alias-label-primary,#18181b);}' +
      '.pd h2{font-size:15px;font-weight:600;margin:2px 0 8px;}' +
      '.pd-sub{font-size:var(--dsw-font-xxs-12-font-size,12px);color:var(--dsw-alias-label-secondary,#6b7280);margin-bottom:12px;}' +
      '.pd-row{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l1,#e4e4e7);border-radius:8px;padding:8px 10px;margin-bottom:6px;background:var(--dsw-alias-bg-layer-1,#fff);}' +
      '.pd-label{flex:1;font-size:var(--dsw-font-xs-13-font-size,13px);font-weight:600;}' +
      '.pd-id{font-family:ui-monospace,Consolas,monospace;font-size:var(--dsw-font-xxxs-11-font-size,11px);color:var(--dsw-alias-label-secondary,#6b7280);}' +
      '.pd-warn{border-radius:8px;padding:8px 12px;font-size:var(--dsw-font-xxs-12-font-size,12px);margin-bottom:10px;border:1px solid #fecaca;background:#fef2f2;color:#b91c1c;}' +
      '.pd-err{border-radius:8px;padding:8px 12px;font-size:var(--dsw-font-xxs-12-font-size,12px);margin-bottom:10px;border:1px solid #fecaca;background:#fef2f2;color:#b91c1c;}' +
      '.pd-mode{flex:0 0 auto;font-size:10px;border-radius:4px;padding:1px 6px;}' +
      '.pd-mode-page{background:#e0f2fe;color:#075985;}' +
      '.pd-mode-modal{background:#f4f4f5;color:#3f3f46;}' +
      '.pd-empty{padding:18px;color:var(--dsw-alias-label-secondary,#6b7280);}'

    function lvlColor(l) {
      if (l === 'ERROR') return 'var(--dsw-alias-state-error-primary,#dc2626)'
      if (l === 'WARN') return 'var(--dsw-alias-state-warn-primary,#d97706)'
      if (l === 'INFO') return 'var(--hp-info)'
      if (l === 'DEBUG') return 'var(--dsw-alias-label-secondary,#71717a)'
      return 'var(--dsw-alias-label-primary,#18181b)'
    }
    function fmtTs(t) {
      try {
        if (!t) return ''
        var d = new Date(t)
        return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0')
      } catch (_) { return '' }
    }
    function tierStyle(tier) {
      if (tier === 'free') return { background: '#d1fae5', color: '#065f46' }
      if (tier === 'guarded') return { background: '#fef3c7', color: '#92400e' }
      if (tier === 'locked') return { background: '#fee2e2', color: '#b91c1c' }
      return { background: '#e4e4e7', color: '#3f3f46' }
    }
    /** 用审计尾部反查某条目的最近事件（不新增状态层，见文件头注） */
    function lastEventOf(audit, id) {
      for (var i = audit.length - 1; i >= 0; i--) {
        var r = audit[i]
        if (r && r.extra && r.extra.id === id) return r
      }
      return null
    }

    // ================= 面板 =================
    function HotplugSection() {
      var t = React.useState({
        data: null, audit: [], loading: true, busy: null, toast: null,
        tab: 'list', lastOp: null, showAdd: false, minLevel: 'INFO', kw: ''
      })
      var state = t[0]
      var setState = t[1]
      var seq = React.useRef(0)

      function set(patch) { setState(function (p) { return Object.assign({}, p, patch) }) }

      function refresh() {
        var my = ++seq.current
        return Promise.all([
          getJson(BASE).catch(function (e) { return { __err: e } }),
          getJson(BASE + '/audit?tail=200').catch(function () { return { entries: [] } })
        ]).then(function (res) {
          if (my !== seq.current) return
          var snap = res[0] || {}
          if (snap.__err) {
            set({ loading: false, toast: { type: 'err', message: '快照加载失败: ' + snap.__err.message } })
            return
          }
          set({ data: snap, audit: (res[1] && res[1].entries) || [], loading: false })
        })
      }
      React.useEffect(function () {
        refresh()
        var h = setInterval(function () { if (!document.hidden) refresh() }, 5000)
        return function () { clearInterval(h) }
      }, [])

      function runOp(opName, payload, okMsg) {
        set({ busy: (payload && payload.id) || opName, lastOp: null })
        postOp(Object.assign({ op: opName }, payload || {})).then(function (j) {
          set({ busy: null, lastOp: { ok: true, op: opName, result: j.result }, toast: { type: 'ok', message: okMsg } })
          setTimeout(refresh, 150)
        }).catch(function (e) {
          set({
            busy: null,
            lastOp: { ok: false, op: opName, code: e.code, message: e.message, extra: e.extra },
            toast: { type: 'err', message: e.code + ': ' + e.message }
          })
          // 失败也要刷新：可能已发生回滚（HOTPLUG_ROLLBACK_OK）或代次回退
          setTimeout(refresh, 150)
        })
      }

      if (state.loading) return React.createElement('div', { className: 'hp-empty' }, '热拔插面板加载中…')

      var d = state.data || {}
      var buster = d.buster || {}
      var entries = d.entries || []
      var hotplugUsable = buster.level === 'L1' && d.treeAvailable !== false && !d.unstable

      var banners = []
      if (d.unstable) {
        banners.push(React.createElement('div', { key: 'st', className: 'hp-banner hp-banner-err' },
          '加载树已被判定为不稳定（' + (d.unstableReason || '原因未记录') + '）⇒ 所有热替操作被拒绝，需重启宿主。'))
      }
      if (d.treeAvailable === false) {
        banners.push(React.createElement('div', { key: 'tr', className: 'hp-banner hp-banner-err' },
          'loader 树不可用（loader 服务未在插件挂载时注入）⇒ 无法 load/unload/swap/reload。'))
      }
      if (buster.level !== 'L1') {
        banners.push(React.createElement('div', { key: 'bu', className: 'hp-banner hp-banner-warn' },
          '热替不可用：ModuleGraphBuster 自检未通过（' + (buster.reason || '未记录') + '）。' +
          '本 Node（' + (buster.nodeVersion || '?') + '）上无法保证子模块级热替 ⇒ 写操作会被明确拒绝（RESTART_REQUIRED），请重启宿主。'))
      }
      if (d.inFlight) {
        banners.push(React.createElement('div', { key: 'if', className: 'hp-banner hp-banner-warn' },
          '有操作在途：' + (d.inFlight.action || '') + ' on ' + (d.inFlight.id || '') + '（请等它结束）'))
      }

      return React.createElement('div', { className: 'hp' },
        React.createElement('h2', null, '插件热拔插 ',
          React.createElement('span', { className: 'hp-tag', style: buster.level === 'L1' ? { background: '#d1fae5', color: '#065f46' } : { background: '#fef3c7', color: '#92400e' } },
            buster.level === 'L1' ? '可热替 L1' : '降级 L3'),
          React.createElement('span', { className: 'hp-tag' }, String(buster.mode || '?')),
          React.createElement('span', { className: 'hp-tag' }, 'node ' + String(buster.nodeVersion || '?'))),
        React.createElement('div', { className: 'hp-sub' },
          '白名单插件可在不重启宿主的前提下 load / unload / swap / reload；' +
          'reload 会按「代次」重载整条 ESM 子图（含非入口子模块），失败不会把旧插件卸掉。'),
        banners,
        React.createElement('div', { className: 'hp-tabs' },
          [['list', '白名单与热替'], ['audit', '运行与审计']].map(function (k) {
            return React.createElement('div', {
              key: k[0], className: 'hp-tab' + (state.tab === k[0] ? ' hp-tab-on' : ''),
              onClick: function () { set({ tab: k[0] }) }
            }, k[1])
          })),
        state.tab === 'list'
          ? React.createElement(React.Fragment, null,
              React.createElement(EntryTable, { entries: entries, audit: state.audit, busy: state.busy, usable: hotplugUsable, runOp: runOp }),
              React.createElement(AddForm, { open: state.showAdd, busy: state.busy, set: set, runOp: runOp }))
          : React.createElement(AuditView, { audit: state.audit, minLevel: state.minLevel, kw: state.kw, set: set }),
        state.lastOp ? React.createElement(OpResult, { op: state.lastOp }) : null,
        state.toast ? React.createElement('div', { className: 'hp-toast hp-toast-' + state.toast.type }, state.toast.message) : null
      )
    }

    function EntryTable(props) {
      var entries = props.entries || []
      if (!entries.length) {
        return React.createElement('div', { className: 'hp-empty' },
          '白名单为空。点下方「新增白名单条目」把插件纳入热拔插管理（白名单 = 开机自动加载，且可热替）。')
      }
      var head = ['ID', '档位', '已加载', '代次', 'moduleRev', '最近事件', '操作']
      return React.createElement('table', { className: 'hp-table' },
        React.createElement('thead', null, React.createElement('tr', null,
          head.map(function (h) { return React.createElement('th', { key: h }, h) }))),
        React.createElement('tbody', null,
          entries.map(function (e) {
            var isBusy = props.busy === e.id
            var allowed = e.allowedOps || []
            var can = function (op) { return props.usable && allowed.indexOf(op) >= 0 && !isBusy }
            var acts = []
            if (!e.loaded) {
              acts.push(React.createElement('button', {
                key: 'ld', className: 'hp-btn hp-btn-p', disabled: !can('load') || !e.enabled,
                title: can('load') ? '' : ('不可用：' + (props.usable ? '档位 ' + e.tier + ' 不允许 load' : '热替当前不可用')),
                onClick: function () { props.runOp('load', { id: e.id }, '已加载 ' + e.id) }
              }, '加载'))
            } else {
              acts.push(React.createElement('button', {
                key: 'rl', className: 'hp-btn hp-btn-p', disabled: !can('reload'),
                title: '按代次重载整条 ESM 子图（含非入口子模块）；失败不影响旧实例',
                onClick: function () { props.runOp('reload', { id: e.id }, '已重载 ' + e.id) }
              }, '重载'))
              acts.push(React.createElement('button', {
                key: 'sw', className: 'hp-btn', disabled: !can('swap'),
                title: '同 id 换 path/config（失败自动回滚）',
                onClick: function () { props.runOp('swap', { id: e.id }, '已热换 ' + e.id) }
              }, '热换'))
              acts.push(React.createElement('button', {
                key: 'ul', className: 'hp-btn hp-btn-d', disabled: !can('unload'),
                onClick: function () {
                  if (!confirm('确认卸载 ' + e.id + '？（guard 档同样允许，但与 reload 走同一条 dispose 路径）')) return
                  props.runOp('unload', { id: e.id }, '已卸载 ' + e.id)
                }
              }, '卸载'))
            }
            acts.push(React.createElement('button', {
              key: 'en', className: 'hp-btn', disabled: isBusy,
              onClick: function () { props.runOp(e.enabled ? 'disable' : 'enable', { id: e.id }, (e.enabled ? '已禁用 ' : '已启用 ') + e.id) }
            }, e.enabled ? '禁用' : '启用'))
            acts.push(React.createElement('button', {
              key: 'rm', className: 'hp-btn', disabled: isBusy,
              title: '从白名单移除（已加载会先热卸载；卸载失败则中止）',
              onClick: function () {
                if (!confirm('确认从白名单移除 ' + e.id + '？')) return
                props.runOp('remove', { id: e.id }, '已移除 ' + e.id)
              }
            }, '移除'))

            var ev = lastEventOf(props.audit, e.id)
            return React.createElement('tr', { key: e.id },
              React.createElement('td', null,
                React.createElement('span', { className: 'hp-mono' }, e.id),
                e.builtin ? React.createElement('span', { className: 'hp-tag' }, 'bundles 来源') : null),
              React.createElement('td', null,
                React.createElement('span', { className: 'hp-tag', style: tierStyle(e.tier) }, String(e.tier || '?')),
                React.createElement('div', { className: 'hp-mono', style: { color: 'var(--dsw-alias-label-secondary, #71717a)', marginTop: 2 } },
                  String(e.tierReason || '').slice(0, 40))),
              React.createElement('td', null,
                e.loaded
                  ? React.createElement('span', { className: 'hp-tag', style: { background: '#d1fae5', color: '#065f46' } }, '✓')
                  : React.createElement('span', { className: 'hp-tag', style: { background: '#f4f4f5', color: '#71717a' } }, '—'),
                e.enabled ? null : React.createElement('span', { className: 'hp-tag', style: { background: '#fee2e2', color: '#b91c1c' } }, '已禁用')),
              React.createElement('td', { className: 'hp-mono' }, String(e.gen == null ? '-' : e.gen)),
              React.createElement('td', { className: 'hp-mono' },
                e.moduleRev ? String(e.moduleRev) : '—',
                e.files && e.files.length
                  ? React.createElement('div', { style: { color: 'var(--dsw-alias-label-secondary, #71717a)' } }, e.files.length + ' 文件')
                  : null),
              React.createElement('td', { className: 'hp-mono' },
                ev
                  ? React.createElement('span', null, fmtTs(ev.ts) + ' ' + String(ev.event || '').replace('hotplug.', ''))
                  : React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary, #a1a1aa)' } }, '—')),
              React.createElement('td', { className: 'hp-acts' }, acts)
            )
          }))
      )
    }

    function AddForm(props) {
      var idRef = React.useRef(null)
      var pathRef = React.useRef(null)
      var cfgRef = React.useRef(null)
      var bltRef = React.useRef(null)
      var enRef = React.useRef(null)
      if (!props.open) {
        return React.createElement('div', { style: { marginTop: 10 } },
          React.createElement('button', { className: 'hp-btn hp-btn-p', onClick: function () { props.set({ showAdd: true }) } }, '+ 新增白名单条目'))
      }
      function submit() {
        var id = (idRef.current && idRef.current.value || '').trim()
        var path = (pathRef.current && pathRef.current.value || '').trim()
        var cfgRaw = (cfgRef.current && cfgRef.current.value || '{}').trim() || '{}'
        if (!id || !path) { props.set({ toast: { type: 'err', message: 'ID 与 Path 必填' } }); return }
        var config = {}
        try { config = JSON.parse(cfgRaw) } catch (_) { props.set({ toast: { type: 'err', message: 'config 必须是合法 JSON' } }); return }
        props.set({ showAdd: false })
        props.runOp('add', {
          id: id, path: path, config: config,
          builtin: !!(bltRef.current && bltRef.current.checked),
          enabled: !(enRef.current && enRef.current.checked === false)
        }, '已新增 ' + id)
      }
      return React.createElement('div', { className: 'hp-form' },
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', fontWeight: 600, marginBottom: 8 } }, '新增白名单条目'),
        React.createElement('label', null, 'ID', React.createElement('input', { ref: idRef, type: 'text', placeholder: '例如 my-plugin' })),
        React.createElement('label', null, 'Path（包名，或 file: 绝对路径）',
          React.createElement('input', { ref: pathRef, type: 'text', placeholder: '@local/your-plugin   或   file:///<插件目录>' })),
        React.createElement('label', null, 'config（JSON）', React.createElement('input', { ref: cfgRef, type: 'text', defaultValue: '{}' })),
        React.createElement('div', { style: { display: 'flex', gap: 14, alignItems: 'center', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', marginBottom: 8 } },
          React.createElement('label', { style: { display: 'flex', gap: 4, alignItems: 'center', margin: 0 } },
            React.createElement('input', { ref: bltRef, type: 'checkbox' }), '由 bundles 静态加载（仅作来源标记，不影响档位判定）'),
          React.createElement('label', { style: { display: 'flex', gap: 4, alignItems: 'center', margin: 0 } },
            React.createElement('input', { ref: enRef, type: 'checkbox', defaultChecked: true }), '启用')),
        React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          React.createElement('button', { className: 'hp-btn', onClick: function () { props.set({ showAdd: false }) } }, '取消'),
          React.createElement('button', { className: 'hp-btn hp-btn-p', onClick: submit }, '提交'))
      )
    }

    function OpResult(props) {
      var op = props.op
      if (op.ok) {
        var r = op.result || {}
        var lines = ['gen: ' + r.prevGen + ' → ' + r.gen, 'moduleRev: ' + (r.moduleRev || '—')]
        if (r.exports) lines.push('入口导出: ' + r.exports.join(', '))
        if (r.files && r.files.length) lines.push('本代加载文件: ' + r.files.map(function (f) { return f.path.split(/[\\/]/).pop() }).join(', '))
        if (r.durationMs != null) lines.push('耗时: ' + r.durationMs + ' ms')
        if (r.status) lines.push('status: ' + r.status)
        return React.createElement('div', { className: 'hp-banner', style: { background: '#ecfdf5', borderColor: '#a7f3d0', color: '#065f46' } },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, '上次操作成功：' + op.op),
          React.createElement('div', { className: 'hp-pre', style: { marginTop: 4, maxHeight: 140 } },
            lines.join('\n') + '\n\n' + JSON.stringify(r, null, 2)))
      }
      var extra = op.extra || {}
      var kind = op.code === 'HOTPLUG_ROLLBACK_OK' ? 'warn' : 'err'
      var style = kind === 'warn'
        ? { background: '#fffbeb', borderColor: '#fde68a', color: '#92400e' }
        : { background: '#fef2f2', borderColor: '#fecaca', color: '#b91c1c' }
      return React.createElement('div', { className: 'hp-banner', style: style },
        React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, '上次操作失败：' + op.op + '（' + op.code + '）'),
        React.createElement('div', null, op.message || ''),
        extra.stage ? React.createElement('div', { className: 'hp-mono' }, '失败阶段: ' + extra.stage) : null,
        extra.treeClean === false ? React.createElement('div', null, '⚠ 加载树不干净，需重启宿主') : null,
        extra.treeClean === true ? React.createElement('div', null, '加载树干净：该插件现处未加载态，修好后可直接重试，无需重启') : null,
        React.createElement('div', { className: 'hp-pre', style: { marginTop: 6, maxHeight: 140 } },
          JSON.stringify(Object.assign({ code: op.code, message: op.message }, extra), null, 2)))
    }

    function AuditView(props) {
      var rows = props.audit || []
      var kw = (props.kw || '').toLowerCase()
      var rank = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 }
      var min = rank[props.minLevel] || 0
      var filtered = rows.filter(function (r) {
        if (min && rank[r.level] && rank[r.level] < min) return false
        if (kw) {
          var hay = ((r.event || '') + ' ' + (r.message || '') + ' ' + JSON.stringify(r.extra || {})).toLowerCase()
          if (hay.indexOf(kw) < 0) return false
        }
        return true
      })
      return React.createElement('div', null,
        React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)' } },
          React.createElement('span', null, '级别'),
          React.createElement('select', {
            value: props.minLevel, style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)' },
            onChange: function (e) { props.set({ minLevel: e.target.value }) }
          }, ['DEBUG', 'INFO', 'WARN', 'ERROR'].map(function (l) { return React.createElement('option', { key: l, value: l }, '≥ ' + l) })),
          React.createElement('input', {
            value: props.kw, placeholder: '关键字（含 id / 错误码）', style: { flex: 1, fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', padding: '4px 6px' },
            onChange: function (e) { props.set({ kw: e.target.value }) }
          }),
          React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary, #71717a)' } }, filtered.length + ' / ' + rows.length + ' 条')),
        filtered.length
          ? React.createElement('div', { className: 'hp-audit' },
              filtered.slice().reverse().map(function (r, i) {
                return React.createElement('div', { className: 'hp-row', key: (r.ts || '') + i },
                  React.createElement('span', { className: 'hp-lvl', style: { color: lvlColor(r.level) } }, r.level),
                  React.createElement('span', { className: 'hp-ts' }, fmtTs(r.ts)),
                  React.createElement('span', null, String(r.event || '') + ' — ' + String(r.message || '')))
              }))
          : React.createElement('div', { className: 'hp-empty' }, '暂无匹配的审计记录。'))
    }

    // ================= 插件抽屉（pluginDock）：跨插件「共享触发 + 共享清单」=================
    // 目的（入口重排 2b-1 · 方案 A）：把「弹窗型插件」的入口从 conversation.view 页签收敛到
    // 侧栏一行「插件」+ 一个清单面板：面板只列出各插件登记的元数据，点「打开」调它登记的 open()。
    // 契约（与本批实现一致；调用方 = 各入口型插件）：
    //   ctx.inject(['pluginDock'], (scoped) => { scoped.get('pluginDock').register({ id, label, order?, mode?, open? }) })
    //   · id 必填（string，唯一）
    //   · mode 可选：'modal'（缺省）| 'page'。**语义（2b-2 新增）**：
    //       'modal' ⇒ 点「打开」调 entry.open()，插件自己开 shell.overlay 弹窗（只做共享触发，**不托管别人的 UI**；
    //                 官方明令插件之间不能 import 组件 ⇒ 弹窗 UI 一律由各插件自己渲染）。此时 open 必填（function）。
    //       'page'  ⇒ 点「打开」由 adapter 调 `ctx.get('layout').selectPanel(entry.id)` 切**整页**
    //                 （= 原生侧栏点一行所做的同一件事：sidebar-client.js 的 PanelRow.onClick → ctx.layout.selectPanel(id)）
    //                 ⇒ 前提是该插件已注册 key 与其 id 同名的 main 面板。此时 open 可省略；
    //                 若仍传了 open，则在 selectPanel 失败时作为**退路**（弹窗）被调用。
    //   · unregister(id) 供调用方 disposer 用；entries() 返回按 order 升序的数组
    //   · subscribe(fn) 是本实现**新增**的一项（契约里没写）：清单面板需要一个「登记后重渲染」的信号，
    //     否则插件在面板已挂载之后登记时只能等下次重渲染才出现。纯附加，不破坏前三项语义。
    // ⚠️ 两个坑（均为 cordis 语义，故如此写）：
    //   1) provide 二次注册会抛（service 池不允许重名）⇒ 下面有幂等守卫；
    //   2) adapter 的 client 是**种子 bundle**，会被 client-hmr 的 500ms 轮询探到并按模块级 reload
    //      重跑本模块 ⇒ 登记的清单**不能**只放在模块作用域（模块重估即清空、且已登记的插件不会跟着重跑）。
    //      故清单与订阅者挂到 globalThis 单例上：模块重估后仍是同一份，已登记的插件不会掉线。
    var DOCK_NAME = 'pluginDock'
    var DOCK_PANEL_ID = 'plugins'
    var DOCK_STATE_KEY = '__dshAdapterPluginDock__'

    function dockState() {
      var g = (typeof globalThis !== 'undefined') ? globalThis : window
      if (!g[DOCK_STATE_KEY]) g[DOCK_STATE_KEY] = { entries: {}, listeners: [], service: null, ctx: null, pageError: null }
      return g[DOCK_STATE_KEY]
    }
    // mode 归一：只认 'page'，其余（缺省 / 未知值）一律 'modal'
    function normMode(m) {
      return m === 'page' ? 'page' : 'modal'
    }
    function dockNotify(st) {
      var ls = st.listeners.slice()
      for (var i = 0; i < ls.length; i++) {
        try { ls[i]() } catch (e) { /* 单个订阅者出错不影响其余 */ }
      }
    }
    function createDockService(st) {
      return {
        register: function (entry) {
          if (!entry || typeof entry.id !== 'string' || entry.id === '') {
            try { console.error('[dsh-adapter] pluginDock.register 拒绝：id 必填（string）') } catch (e) {}
            return
          }
          if (typeof entry.open !== 'function' && normMode(entry.mode) !== 'page') {
            try { console.error('[dsh-adapter] pluginDock.register 拒绝：open 必须是 function（id=' + entry.id + '，mode=' + normMode(entry.mode) + '）') } catch (e) {}
            return
          }
          if (st.entries[entry.id] !== undefined) {
            try { console.error('[dsh-adapter] pluginDock.register 拒绝：id 重复（' + entry.id + '）') } catch (e) {}
            return
          }
          st.entries[entry.id] = {
            id: entry.id,
            label: (entry.label === undefined || entry.label === null || entry.label === '') ? entry.id : String(entry.label),
            order: (entry.order === undefined || entry.order === null) ? 0 : entry.order,
            mode: normMode(entry.mode),
            open: typeof entry.open === 'function' ? entry.open : null
          }
          dockNotify(st)
        },
        unregister: function (id) {
          if (st.entries[id] !== undefined) {
            delete st.entries[id]
            dockNotify(st)
          }
        },
        entries: function () {
          return Object.keys(st.entries).map(function (k) { return st.entries[k] }).sort(function (a, b) {
            if (a.order !== b.order) return a.order < b.order ? -1 : 1
            return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)
          })
        },
        subscribe: function (fn) {
          if (typeof fn !== 'function') return function () {}
          st.listeners.push(fn)
          return function () {
            var i = st.listeners.indexOf(fn)
            if (i >= 0) st.listeners.splice(i, 1)
          }
        }
      }
    }

    // 官方组件库（种子模块：无需在 package.json 声明即可 require；此处**延迟**到面板首次渲染再取，
    // 避免在种子位置（boot #48）就依赖更晚注册的表；取不到就退回内置样式，不抛错）。
    var _prim = null
    var _primTried = false
    function prims() {
      if (!_primTried) {
        _primTried = true
        try {
          _prim = require('@deepseek-ai/dsh-client-ui-primitives')
        } catch (e) {
          _prim = null
          try { console.error('[dsh-adapter] ui-primitives require 失败，抽屉退回内置样式：' + ((e && e.message) || e)) } catch (_) {}
        }
      }
      return _prim
    }

    /** mode:'page' ⇒ 由 adapter 用 layout.selectPanel(id) 切整页（与原生侧栏点一行是同一件事）。
     *  失败仅两种：adapter 未持有 ctx / layout 服务不可达 / layout.selectPanel 抛错（如没有同名 main 面板）。
     *  @returns {{ok:true}|{ok:false, reason:string}} */
    function openPageEntry(en) {
      var st = dockState()
      var ctx = st.ctx
      if (!ctx || typeof ctx.get !== 'function') return { ok: false, reason: 'adapter 未持有可用 ctx' }
      var layout = null
      try {
        layout = ctx.get('layout')
      } catch (e) {
        return { ok: false, reason: 'ctx.get("layout") 抛错：' + ((e && e.message) || e) }
      }
      if (!layout || typeof layout.selectPanel !== 'function') return { ok: false, reason: 'layout 服务不可达（ctx.get("layout") 为空/无 selectPanel）' }
      try {
        layout.selectPanel(en.id)
        return { ok: true }
      } catch (e) {
        return { ok: false, reason: 'layout.selectPanel("' + en.id + '") 抛错：' + ((e && e.message) || e) }
      }
    }

    function openEntry(en) {
      var st = dockState()
      if (en.mode === 'page') {
        var r = openPageEntry(en)
        if (r.ok) {
          if (st.pageError) { st.pageError = null; dockNotify(st) }
          return
        }
        // 响亮失败：不静默 —— 控制台 error + 抽屉面板内联提示（面板此时仍在，因为没有切页成功）
        try {
          console.error('[dsh-adapter] 整页切换失败（' + en.id + '）：' + r.reason + (en.open ? ' ⇒ 退路：调用该插件自带的 open()' : ' ⇒ 该插件未提供 open()，无弹窗退路'))
        } catch (_) {}
        if (en.open) {
          try { en.open(); return } catch (e2) {
            try { console.error('[dsh-adapter] 退路 open() 也失败（' + en.id + '）：' + ((e2 && e2.message) || e2)) } catch (_) {}
          }
        }
        st.pageError = { id: en.id, reason: r.reason }
        dockNotify(st)
        return
      }
      try {
        en.open()
      } catch (e) {
        try { console.error('[dsh-adapter] 调用插件 open() 失败（' + en.id + '）：' + ((e && e.message) || e)) } catch (_) {}
      }
    }

    function PluginDockPanel() {
      var force = React.useState(0)[1]
      var st = dockState()
      React.useEffect(function () {
        var svc = st.service
        if (!svc || typeof svc.subscribe !== 'function') return
        return svc.subscribe(function () { force(function (n) { return n + 1 }) })
      }, [])
      var svc = st.service
      if (!svc) {
        // 响亮失败：不静默降级成空清单
        try { console.error('[dsh-adapter] 插件清单服务不可用：pluginDock 未注册') } catch (e) {}
        return React.createElement('div', { className: 'pd' },
          React.createElement('div', { className: 'pd-warn' },
            '插件清单服务不可用：pluginDock 未注册 —— 抽屉无法列出任何插件。' +
            '请检查 dsh-adapter 客户端是否正常 apply（浏览器控制台应有 [dsh-adapter] 开头的日志）。'))
      }
      var list = svc.entries() || []
      var P = prims()
      var Btn = P && P.Button ? P.Button : null
      var TagC = P && P.Tag ? P.Tag : null
      var err = st.pageError
      return React.createElement('div', { className: 'pd' },
        React.createElement('h2', null, '插件（已登记 ' + String(list.length) + ' 个）'),
        React.createElement('div', { className: 'pd-sub' },
          '这里只做「共享触发 + 共享清单」：标注「弹窗」的插件点「打开」调它登记的 open()，UI 由插件自己在 shell.overlay 里渲染；' +
          '标注「整页」的插件点「打开」由本面板调 layout.selectPanel(id) 切到该插件注册的整页面板（与点原生侧栏行同一机制）。'),
        err
          ? React.createElement('div', { className: 'pd-err' },
              '整页切换失败（' + String(err.id) + '）：' + String(err.reason))
          : null,
        list.length
          ? list.map(function (en) {
              var isPage = en.mode === 'page'
              var modeText = isPage ? '整页' : '弹窗'
              return React.createElement('div', { className: 'pd-row', key: en.id },
                TagC
                  ? React.createElement(TagC, { tone: isPage ? 'info' : 'neutral' }, modeText)
                  : React.createElement('span', { className: 'pd-mode pd-mode-' + (isPage ? 'page' : 'modal') }, modeText),
                React.createElement('span', { className: 'pd-label' }, String(en.label)),
                TagC
                  ? React.createElement(TagC, { tone: 'outline' }, String(en.id))
                  : React.createElement('span', { className: 'pd-id' }, String(en.id)),
                Btn
                  ? React.createElement(Btn, { variant: 'primary', size: 'sm', onClick: function () { openEntry(en) } }, '打开')
                  : React.createElement('button', { className: 'hp-btn hp-btn-p', onClick: function () { openEntry(en) } }, '打开'))
            })
          : React.createElement('div', { className: 'pd-empty' }, '暂无已登记的插件。'))
    }

    // 侧栏「插件」行的图标（panellist 的「行图标」= 注册时传的渲染函数本身，props { size, active }）
    function PluginRowIcon(owner) {
      var size = (owner && owner.size) || 18
      var on = !!(owner && owner.active)
      var cell = function (x, y, fill) {
        return React.createElement('rect', {
          x: x, y: y, width: 5, height: 5, rx: 1.2,
          stroke: 'currentColor', strokeWidth: 1.3,
          fill: fill ? 'currentColor' : 'none', fillOpacity: fill ? 0.18 : 0
        })
      }
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true'
      }, cell(2.2, 2.2, on), cell(8.8, 2.2, false), cell(2.2, 8.8, false), cell(8.8, 8.8, on))
    }

    // ================= 客户端模块注册 =================
    // ① pluginDock 服务（跨插件） ② settings.section（原有热拔插面板）
    // ③ sidebar.panellist「插件」行 + keyed main 面板（id/key 同名，见下方静默陷阱说明）
    var apply = function apply(ctx) {
      // ---- ① pluginDock：先建 service 并 provide（不依赖 slots ⇒ 无论 slots 是否就绪，登记通道都在）----
      var st = dockState()
      if (!st.service) st.service = createDockService(st)
      // mode:'page' 型入口需要 adapter 自己的 ctx 才能 ctx.get('layout').selectPanel(id)
      //（HMR 重跑本模块时 ctx 会变 ⇒ 每次 apply 都刷新）
      st.ctx = ctx
      var existing = ctx.get && ctx.get(DOCK_NAME)
      if (existing === undefined) {
        try {
          ctx.provide(DOCK_NAME, st.service)
        } catch (e) {
          try { console.error('[dsh-adapter] pluginDock provide 失败：' + ((e && e.message) || e)) } catch (_) {}
        }
      } else if (existing !== st.service) {
        // 幂等守卫：已被**别人**注册 ⇒ 不重复 provide（cordis 二次 provide 会抛），也不覆盖别人的服务
        try { console.warn('[dsh-adapter] pluginDock 已被其他插件注册，跳过 provide（幂等守卫）') } catch (_) {}
      }
      // existing === st.service ⇒ 自己的重入（HMR 模块级 reload 会重跑本模块），静默跳过

      var slots = ctx.get && ctx.get('slots')
      if (!slots || typeof slots.inject !== 'function') return
      try {
        // 幂等：HMR 会重跑本模块（种子 bundle 被 client-hmr 探到），同一份 CSS 不必重复插
        if (document.querySelector('style[data-hotplug-style]') === null) {
          var tag = document.createElement('style')
          tag.setAttribute('data-hotplug-style', '1')
          tag.textContent = CSS
          document.head.appendChild(tag)
        }
      } catch (_) { /* 样式注入失败不影响功能 */ }
      ctx.effect(function () {
        slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'hotplug', order: 90, label: function () { return '插件热拔插' } },
            function () { return React.createElement(HotplugSection, null) }
          )
        })
        return function () { /* noop：随客户端模块生命周期常驻 */ }
      })
      // ---- ③ 官方侧栏入口：sidebar.panellist 用 id、main 用同名 key ----
      // 契约（内核 rc.1，已逐行核对；与 2a 阶段 taskkit / writing-studio 同一套）：
      //  · sidebar.panellist 是 root 级 list 槽，register 入参 { name, id, order, label }，id 必填；
      //    行的图标 = 注册时传的渲染函数本身（渲进 .panelGlyph，props { size, active }）；
      //    激活态/收起态由原生自动处理。
      //  · main 是 root 级 keyed 槽，register 入参 { name, key }，key 必须与 panellist 的 id 相同
      //    （layout-client.js:515 按 entry.options.key === activePanelId 匹配）——
      //    🔴 写错字段名会「注册成功、一点就抛错」。
      //  · 回原生会话是原生行为（openSession()/startSession() 会 selectPanel(null)），不需要自造入口。
      slots.inject('sidebar.panellist', function () {
        return slots.register(
          { name: 'sidebar.panellist', id: DOCK_PANEL_ID, order: 4, label: '插件' },
          PluginRowIcon
        )
      })
      slots.inject('main', function () {
        return slots.register(
          { name: 'main', key: DOCK_PANEL_ID },
          function () { return React.createElement(PluginDockPanel, null) }
        )
      })
      try { console.info('[dsh-adapter] pluginDock 已 provide；侧栏「插件」入口已注册（panellist id = main key = ' + DOCK_PANEL_ID + '）') } catch (e) {}
    }

    exports.inject = ['timer']
    exports.name = 'dsh-adapter'
    exports.apply = apply
    return module.exports
  }
})
