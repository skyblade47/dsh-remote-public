// Client：知识库整理插件 @local/knowledge-base
// 页签「知识库」：条目列表（分类/标签/别名）/ 检索 / 新增 / 采集 / 统计
window.__ModuleLoader__.load({
  id: '@local/knowledge-base',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    function api(base, action, args) {
      return fetch(base + '/' + action, {
        method: args ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: args ? JSON.stringify(args) : undefined
      }).then(function (r) { return r.json() })
    }

    function inputStyle() {
      return { width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', border: '1px solid var(--kb-border-2)', borderRadius: 5, marginBottom: 8 }
    }
    function btnStyle() {
      return { padding: '8px 16px', fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', background: 'var(--kb-accent)', color: '#fff', border: 'none', borderRadius: 5, cursor: 'pointer', fontWeight: 600, marginRight: 8 }
    }

    // ============ 条目列表 ============
    function ListView(props) {
      var entries = (props.data && props.data.entries) || []
      var cats = (props.data && props.data.categories) || {}
      var [openId, setOpenId] = React.useState(null)
      return React.createElement('div', { style: { padding: 16 } },
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-base-16-font-size, 16px)', fontWeight: 700, marginBottom: 8 } }, '知识条目（' + entries.length + ' 条）'),
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--kb-text-2)', marginBottom: 12 } },
          Object.keys(cats).map(function (c) { return React.createElement('span', { key: c, style: { marginRight: 10 } }, c + ':' + cats[c]) })),
        entries.map(function (e) {
          var open = openId === e.id
          return React.createElement('div', { key: e.id, style: { border: '1px solid var(--kb-border)', borderRadius: 6, padding: 10, marginBottom: 8, background: 'var(--kb-card)' } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }, onClick: function () { setOpenId(open ? null : e.id) } },
              React.createElement('div', {},
                React.createElement('span', { style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', fontWeight: 600 } }, e.title),
                React.createElement('span', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--kb-text-2)', marginLeft: 8 } }, '[' + (e.category || '通用') + ']'),
                (e.aliases && e.aliases.length) ? React.createElement('span', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--kb-accent)', marginLeft: 6 } }, '别名: ' + e.aliases.join('、')) : null),
              React.createElement('span', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--kb-text-3)' } }, open ? '▾' : '▸')),
            open ? React.createElement('div', { style: { marginTop: 8, fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--kb-text)' } },
              e.description ? React.createElement('div', { style: { color: 'var(--kb-text-2)', marginBottom: 4 } }, '📝 ' + e.description) : null,
              React.createElement('div', { style: { background: 'var(--kb-inset)', padding: 8, borderRadius: 4, fontFamily: 'monospace', fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', whiteSpace: 'pre-wrap' } }, e.content || ''),
              (e.tags && e.tags.length) ? React.createElement('div', { style: { marginTop: 4, color: 'var(--kb-text-2)' } }, '标签: ' + e.tags.join('、')) : null,
              (e.evolution && e.evolution.length) ? React.createElement('div', { style: { marginTop: 4 } },
                '演变: ' + e.evolution.map(function (ev) { return '[' + (ev.at || '').slice(0, 10) + '] ' + ev.text }).join(' → '))
              : null)
            : null)
        }))
    }

    // ============ 检索 ============
    function SearchView() {
      var [q, setQ] = React.useState('')
      var [results, setResults] = React.useState(null)
      var run = function () {
        api('/knowledge-base/api', 'search', { q: q }).then(function (d) { setResults(d) })
      }
      return React.createElement('div', { style: { padding: 16 } },
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-base-16-font-size, 16px)', fontWeight: 700, marginBottom: 8 } }, '知识检索'),
        React.createElement('div', { style: { display: 'flex', gap: 8 } },
          React.createElement('input', { value: q, onChange: function (e) { setQ(e.target.value) }, onKeyDown: function (e) { if (e.key === 'Enter') run() }, placeholder: '输入关键词（名字/别名/描述/标签）', style: Object.assign(inputStyle(), { flex: 1, marginBottom: 0 }) }),
          React.createElement('button', { onClick: run, style: btnStyle() }, '🔍 检索')),
        results ? React.createElement('div', { style: { marginTop: 12 } },
          React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--kb-text-2)', marginBottom: 6 } }, '匹配 ' + results.total + ' 条'),
          (results.entries || []).map(function (e) {
            return React.createElement('div', { key: e.id, style: { border: '1px solid var(--kb-border)', borderRadius: 6, padding: 10, marginBottom: 6, background: 'var(--kb-card)', fontSize: 'var(--dsw-font-xs-13-font-size, 13px)' } },
              React.createElement('div', { style: { fontWeight: 600 } }, e.title, React.createElement('span', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--kb-text-2)', marginLeft: 8 } }, '[' + (e.category || '') + ']'), e.kbMode === 'index' ? React.createElement('span', { style: { fontSize: 10, color: 'var(--kb-accent)', marginLeft: 6 } }, '📎索引') : null),
              e.description ? React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--kb-text-2)', marginTop: 2 } }, e.description) : null,
              e.sourcePath ? React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--kb-accent)', marginTop: 3, wordBreak: 'break-all' } }, '📄 ' + e.sourcePath) : null,
              e.content && e.content.indexOf('…(全文见 sourcePath)') < 0 ? React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--kb-text)', marginTop: 3, maxHeight: 40, overflow: 'hidden' } }, e.content) : null)
          }))
        : null)
    }

    // ============ 新增整理条目 ============
    function AddView() {
      var [form, setForm] = React.useState({ title: '', description: '', content: '', category: '通用', tags: '', aliases: '' })
      var [msg, setMsg] = React.useState('')
      var set = function (k) { return function (e) { setForm(Object.assign({}, form, { [k]: e.target.value })) } }
      var submit = function () {
        api('/knowledge-base/api', 'add', { entry: form }).then(function (d) {
          setMsg(d && d.ok ? '✅ 已添加：' + d.id : '❌ ' + (d && d.error || '失败'))
        })
      }
      return React.createElement('div', { style: { padding: 16 } },
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-base-16-font-size, 16px)', fontWeight: 700, marginBottom: 8 } }, '新增知识条目'),
        React.createElement('input', { value: form.title, onChange: set('title'), placeholder: '标题 *', style: inputStyle() }),
        React.createElement('input', { value: form.description, onChange: set('description'), placeholder: '一句话句柄（检索用）', style: inputStyle() }),
        React.createElement('textarea', { value: form.content, onChange: set('content'), placeholder: '内容', rows: 4, style: Object.assign(inputStyle(), { height: 'auto' }) }),
        React.createElement('div', { style: { display: 'flex', gap: 8 } },
          React.createElement('input', { value: form.category, onChange: set('category'), placeholder: '分类', style: Object.assign(inputStyle(), { flex: 1 }) }),
          React.createElement('input', { value: form.tags, onChange: set('tags'), placeholder: '标签（逗号分隔）', style: Object.assign(inputStyle(), { flex: 1 }) }),
          React.createElement('input', { value: form.aliases, onChange: set('aliases'), placeholder: '别名（逗号分隔）', style: Object.assign(inputStyle(), { flex: 1 }) })),
        React.createElement('button', { onClick: submit, style: btnStyle() }, '💾 添加'),
        msg ? React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--kb-accent)' } }, msg) : null)
    }

    // ============ 采集（inbox） ============
    function InboxView() {
      var [form, setForm] = React.useState({ title: '', content: '' })
      var [msg, setMsg] = React.useState('')
      var set = function (k) { return function (e) { setForm(Object.assign({}, form, { [k]: e.target.value })) } }
      var submit = function () {
        api('/knowledge-base/api', 'inbox', form).then(function (d) {
          setMsg(d && d.ok ? '✅ 已入采集箱：' + d.filename : '❌ ' + (d && d.error || '失败'))
        })
      }
      return React.createElement('div', { style: { padding: 16 } },
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-base-16-font-size, 16px)', fontWeight: 700, marginBottom: 8 } }, '知识采集（inbox 原始层）'),
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--kb-text-2)', marginBottom: 8 } }, '原始想法/素材入采集箱，只追加不可变；整理后移入知识条目。'),
        React.createElement('input', { value: form.title, onChange: set('title'), placeholder: '标题（可选）', style: inputStyle() }),
        React.createElement('textarea', { value: form.content, onChange: set('content'), placeholder: '采集内容', rows: 5, style: Object.assign(inputStyle(), { height: 'auto' }) }),
        React.createElement('button', { onClick: submit, style: btnStyle() }, '📥 采集'),
        msg ? React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--kb-accent)' } }, msg) : null)
    }

    // ============ 统计 ============
    function StatsView(props) {
      var d = props.data || {}
      return React.createElement('div', { style: { padding: 16 } },
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-base-16-font-size, 16px)', fontWeight: 700, marginBottom: 12 } }, '知识库统计'),
        React.createElement('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
          React.createElement('div', { style: { border: '1px solid var(--kb-border)', borderRadius: 6, padding: '10px 16px', minWidth: 90, background: 'var(--kb-card)' } },
            React.createElement('div', { style: { fontSize: 'var(--dsw-font-l-20-font-size, 20px)', fontWeight: 700 } }, d.entryTotal || 0),
            React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--kb-text-2)' } }, '条目总数')),
          React.createElement('div', { style: { border: '1px solid var(--kb-border)', borderRadius: 6, padding: '10px 16px', minWidth: 90, background: 'var(--kb-card)' } },
            React.createElement('div', { style: { fontSize: 'var(--dsw-font-l-20-font-size, 20px)', fontWeight: 700 } }, d.linked || 0),
            React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--kb-text-2)' } }, '已关联')),
          React.createElement('div', { style: { border: '1px solid var(--kb-border)', borderRadius: 6, padding: '10px 16px', minWidth: 90, background: 'var(--kb-card)' } },
            React.createElement('div', { style: { fontSize: 'var(--dsw-font-l-20-font-size, 20px)', fontWeight: 700 } }, d.evolved || 0),
            React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--kb-text-2)' } }, '有演变记录'))),
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', fontWeight: 600, marginTop: 12 } }, '分类分布'),
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--kb-text)', marginTop: 4 } },
          Object.keys((d.categories || {})).map(function (c) { return React.createElement('div', { key: c }, c + '：' + d.categories[c] + ' 条') })))
    }

    // ============ 主界面 ============
    function KBHome() {
      var [tab, setTab] = React.useState('list')
      var [data, setData] = React.useState(null)
      var refresh = function () {
        api('/knowledge-base/api', 'list').then(function (d) { if (d && d.ok) setData(d) })
        api('/knowledge-base/api', 'stats').then(function (d) { if (d && d.ok) setData(function (prev) { return Object.assign({}, prev, { entryTotal: d.entryTotal, linked: d.linked, evolved: d.evolved, categories: d.categories }) }) })
      }
      React.useEffect(function () { refresh() }, [])
      var tabs = [
        { id: 'list', label: '条目', comp: function () { return React.createElement(ListView, { data: data }) } },
        { id: 'search', label: '检索', comp: SearchView },
        { id: 'add', label: '新增', comp: AddView },
        { id: 'inbox', label: '采集', comp: InboxView },
        { id: 'stats', label: '统计', comp: function () { return React.createElement(StatsView, { data: data }) } }
      ]
      var active = tabs.find(function (t) { return t.id === tab })
      return React.createElement('div', { style: { height: '100%', display: 'flex', flexDirection: 'column' } },
        React.createElement('div', { style: { display: 'flex', gap: 4, padding: '10px 12px 0', borderBottom: '1px solid var(--kb-border)' } },
          tabs.map(function (t) {
            var isActive = tab === t.id
            return React.createElement('button', {
              key: t.id, onClick: function () { setTab(t.id) },
              style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', padding: '6px 14px', border: 'none', borderBottom: isActive ? '2px solid var(--kb-accent)' : '2px solid transparent', background: 'transparent', color: isActive ? 'var(--kb-accent)' : 'var(--kb-text-2)', fontWeight: isActive ? 600 : 400, cursor: 'pointer' }
            }, t.label)
          })),
        React.createElement('div', { style: { flex: 1, overflow: 'auto', minHeight: 0 } },
          React.createElement(active.comp, null)))
    }

    // ============ 弹窗型入口（2b-1 · 方案 A）============
    // 入口从 conversation.view 页签改为「adapter 的插件抽屉（pluginDock）+ 自己的 shell.overlay 弹窗」：
    //   · 弹窗平时渲染 null，open() 时渲染；
    //   · 弹窗 UI 完全由本插件自己渲染（官方明令插件之间不能 import 组件）；
    //   · 可见性 state 挂在 globalThis 单例上 —— 本插件的 client 也会被 client-hmr 按模块级 reload
    //     重跑（新模块实例不能丢掉已登记的入口与已打开的状态），且 open() 是别人（adapter）持有的回调。
    var GB = (typeof globalThis !== 'undefined') ? globalThis : window;
    var POPUP_STATE_KEY = '__knowledgeBasePopup__';
    var popup = GB[POPUP_STATE_KEY] || (GB[POPUP_STATE_KEY] = { visible: false, dockMissing: false, listeners: [] });
    function popupNotify() {
      var ls = popup.listeners.slice();
      for (var i = 0; i < ls.length; i++) { try { ls[i](); } catch (e) { /* 单个订阅者出错不影响其余 */ } }
    }
    function setPopup(patch) {
      for (var k in patch) popup[k] = patch[k];
      popupNotify();
    }
    /** 订阅弹窗状态（与 reset 无关的极简 store，用法同 lanr 的 useStore） */
    function usePopup() {
      var force = React.useState(0)[1];
      React.useEffect(function () {
        var fn = function () { force(function (n) { return n + 1 }); };
        popup.listeners.push(fn);
        return function () { var i = popup.listeners.indexOf(fn); if (i >= 0) popup.listeners.splice(i, 1); };
      }, []);
    }

    // 弹窗渲染在官方壳级浮层 shell.overlay 里。其容器（dsh-client-ui-layout 的 .overlayLayer）是
    //   z-index:20; position:absolute; inset:0; **pointer-events:none**
    // ⇒ 自身必须显式 pointer-events:auto 才可交互（见 .kb-pop-backdrop）。
    function KBOverlay() {
      usePopup();
      React.useEffect(function () {
        if (!popup.visible) return;
        var onKey = function (e) { if (e.key === 'Escape') setPopup({ visible: false }); };
        document.addEventListener('keydown', onKey);
        return function () { document.removeEventListener('keydown', onKey); };
      }, [popup.visible]);
      if (popup.dockMissing) {
        // 响亮失败：pluginDock 拿不到时不静默 —— 顶部常驻横幅 + 控制台 error，并保留一个自救入口
        return React.createElement('div', { className: 'kb-pop-warn' },
          React.createElement('span', null, '插件清单服务不可用：pluginDock 未注册 —— 「知识库」无法从插件抽屉打开。'),
          React.createElement('button', { className: 'kb-pop-warnbtn', onClick: function () { setPopup({ visible: true }); } }, '仍要打开'));
      }
      if (!popup.visible) return null;
      return React.createElement('div', {
        className: 'kb-pop-backdrop',
        onClick: function () { setPopup({ visible: false }); }
      },
        React.createElement('div', {
          className: 'kb-pop-card',
          onClick: function (e) { e.stopPropagation(); }
        },
          React.createElement('div', { className: 'kb-pop-head' },
            React.createElement('span', { className: 'kb-pop-title' }, '知识库'),
            React.createElement('button', {
              className: 'kb-pop-close', title: '关闭（Esc 亦可）',
              onClick: function () { setPopup({ visible: false }); }
            }, '✕')),
          React.createElement('div', { className: 'kb-pop-body' }, React.createElement(KBHome, null))));
    }

    // ============ 主题 token 映射（--kb-* → 宿主 --dsw-* 语义别名 + fallback）============
    // 本插件所有颜色/边框一律经 --kb-* 间接引用宿主 token；每个 dsw 引用都带 fallback，
    // 使 token 名跨版本漂移时最坏退化为"颜色不对"，不会"样式崩掉"。
    // --kb-* 是本插件私有前缀，不改动官方 --dsw-* 命名空间。
    var THEME_VARS =
      '--kb-card:var(--dsw-alias-bg-layer-1,#fff);' +
      '--kb-inset:var(--dsw-alias-bg-layer-2,#f9fafb);' +
      '--kb-text:var(--dsw-alias-label-primary,#374151);' +
      '--kb-text-2:var(--dsw-alias-label-secondary,#6b7280);' +
      '--kb-text-3:var(--dsw-alias-label-tertiary,#9ca3af);' +
      '--kb-border:var(--dsw-alias-border-l1,#e4e4e7);' +
      '--kb-border-2:var(--dsw-alias-border-l2,#d4d4d8);' +
      '--kb-accent:var(--dsw-alias-state-success-primary,#059669);';

    // 弹窗样式（2b-1 新增）。要点：宿主壳级浮层容器是 pointer-events:none 的
    //   （.overlayLayer{z-index:20;position:absolute;inset:0;pointer-events:none}）
    // ⇒ 遮罩层必须显式 pointer-events:auto，否则整个弹窗「看得见、点不了」。
    var POPUP_CSS =
      '.kb-pop-backdrop{position:absolute;inset:0;pointer-events:auto;background:rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;}' +
      '.kb-pop-card{width:min(920px,92vw);height:min(680px,88vh);display:flex;flex-direction:column;background:var(--kb-card);border:1px solid var(--kb-border-2);border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,0.28);overflow:hidden;}' +
      '.kb-pop-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 14px;border-bottom:1px solid var(--kb-border);flex:0 0 auto;}' +
      '.kb-pop-title{font-size:var(--dsw-font-s-14-font-size,14px);font-weight:700;color:var(--kb-text);}' +
      '.kb-pop-close{border:none;background:transparent;color:var(--kb-text-2);font-size:18px;line-height:1;cursor:pointer;padding:2px 8px;border-radius:6px;}' +
      '.kb-pop-body{flex:1;min-height:0;overflow:auto;}' +
      '.kb-pop-warn{position:absolute;left:50%;top:12px;transform:translateX(-50%);pointer-events:auto;display:flex;align-items:center;gap:10px;background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:8px;padding:8px 12px;font-size:var(--dsw-font-xxs-12-font-size,12px);box-shadow:0 8px 24px rgba(0,0,0,0.18);}' +
      '.kb-pop-warnbtn{border:1px solid #fecaca;background:#fff;color:#b91c1c;border-radius:6px;padding:2px 10px;font-size:var(--dsw-font-xxs-12-font-size,12px);cursor:pointer;}' +
      '.kb-pop-warn .kb-pop-close{color:#b91c1c;}';

    // ============ 插件 apply ============
    var apply = function apply(ctx) {
      var slots = ctx.get('slots');
      if (slots === undefined) return;
      ctx.effect(function () {
        // 沿用宿主 CSS 注入约定：style 打 data-plugin / data-plugin-css 标记，按 tagId 去重。
        // 2b-1 起改为「先移除同名旧 tag 再插」：本文件新增了弹窗 CSS，若沿用「已存在就跳过」，
        // 旧 tag（来自上一次 apply / HMR 之前的实例）会让新增样式永远落不下来。
        var tagId = '@local/knowledge-base/client.css';
        var prev = document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']');
        if (prev !== null) prev.remove();
        var tag = document.createElement('style');
        tag.dataset.plugin = '@local/knowledge-base';
        tag.dataset.pluginCss = tagId;
        tag.textContent = ':root{' + THEME_VARS + '}' + POPUP_CSS;
        document.head.appendChild(tag);
        return function () { tag.remove(); };
      });
      // ---- 入口一：自己的弹窗渲进官方壳级浮层 shell.overlay（平时渲染 null）----
      // 契约：shell.overlay 是 root 级 list 槽（layout-client.js:540-543 声明 / :276 渲染），
      //       register 入参 { name, id, order?, label? }，渲染函数由 owner 以空 props 调用 ⇒ 组件自持状态。
      slots.inject('shell.overlay', function () {
        return slots.register(
          { name: 'shell.overlay', id: 'knowledge-base.popup', order: 50, label: '知识库弹窗' },
          function () { return React.createElement(KBOverlay, null); }
        );
      });
      // ---- 入口二：向 adapter 的 pluginDock 登记自己（共享触发；弹窗 UI 仍由本插件渲染）----
      // 用 ctx.inject 而非裸 ctx.get：adapter 是种子 bundle，先加载，但**加载顺序 ≠ apply 顺序**
      // （cordis inject 会推迟 apply）⇒ inject 兜底时序。
      var settled = false;
      var watchdog = GB.setTimeout(function () {
        if (settled) return;
        try { console.error('[knowledge-base] pluginDock 在 4s 内始终未注册：无法登记「知识库」入口；抽屉里不会有本插件（conversation.view 入口已移除）。'); } catch (e) {}
        setPopup({ dockMissing: true });
      }, 4000);
      ctx.inject(['pluginDock'], function () {
        settled = true;
        try { GB.clearTimeout(watchdog); } catch (e) {}
        var dock = ctx.get('pluginDock');
        if (!dock || typeof dock.register !== 'function') {
          try { console.error('[knowledge-base] pluginDock 不可用：无法登记「知识库」入口。抽屉里不会出现本插件（conversation.view 入口已移除）。'); } catch (e) {}
          setPopup({ dockMissing: true });
          return;
        }
        dock.register({
          id: 'knowledge-base',
          label: '知识库',
          order: 4,
          open: function () { setPopup({ visible: true, dockMissing: false }); }
        });
        try { console.info('[knowledge-base] 已向 pluginDock 登记（id=knowledge-base）'); } catch (e) {}
        ctx.effect(function () {
          return function () {
            try { dock.unregister('knowledge-base'); } catch (e) {}
          };
        });
      });
    };
    var inject = ['timer'];

    exports.name = 'knowledge-base';
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
