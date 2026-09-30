// Client：元提示词路由 + 参考库 + 评估迭代体系 @local/prompt-router
// 入口：adapter 的「插件」抽屉（pluginDock，mode:'modal'）+ 本插件自己的 shell.overlay 弹窗
//      （2b-2 起；此前是 conversation.view「提示词」页签，order=3）
// 内容：参考库列表（分类/评分/模板）/ 路由测试 / 新增条目 / 统计
window.__ModuleLoader__.load({
  id: '@local/prompt-router',
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

    // 五维中文标签
    var DIMS = [
      ['effect', '效果'], ['clarity', '清晰度'], ['stability', '稳定性'], ['generality', '通用性'], ['cost', '成本']
    ]

    function ScoreBadge(props) {
      var s = props.score || {}
      var tot = 0, n = 0
      DIMS.forEach(function (d) { var v = Number(s[d[0]]) || 0; if (v >= 1 && v <= 5) { tot += v; n++ } })
      var avg = n ? (tot / n) : 0
      var color = avg >= 4.5 ? 'var(--pr-success)' : (avg >= 3.5 ? 'var(--pr-accent)' : 'var(--pr-error)')
      return React.createElement('span', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: color, fontWeight: 600, marginLeft: 6 } }, '★' + Math.round(avg * 10) / 10)
    }

    // ============ 参考库列表 ============
    function LibraryView(props) {
      var data = props.data
      var prompts = (data && data.prompts) || []
      var cats = (data && data.categories) || {}
      var [openId, setOpenId] = React.useState(null)
      return React.createElement('div', { style: { padding: 16 } },
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-base-16-font-size, 16px)', fontWeight: 700, marginBottom: 8 } }, '提示词参考库（' + prompts.length + ' 条）'),
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--pr-text-2)', marginBottom: 12 } },
          Object.keys(cats).map(function (c) { return React.createElement('span', { key: c, style: { marginRight: 10 } }, c + ':' + cats[c]) })),
        prompts.map(function (p) {
          var open = openId === p.id
          return React.createElement('div', { key: p.id, style: { border: '1px solid var(--pr-border)', borderRadius: 6, padding: 10, marginBottom: 8, background: 'var(--pr-card)' } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }, onClick: function () { setOpenId(open ? null : p.id) } },
              React.createElement('div', {},
                React.createElement('span', { style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', fontWeight: 600 } }, p.title),
                React.createElement('span', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--pr-text-2)', marginLeft: 8 } }, '[' + p.category + ']'),
                React.createElement(ScoreBadge, { score: p.score })),
              React.createElement('span', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--pr-text-3)' } }, open ? '▾' : '▸')),
            open ? React.createElement('div', { style: { marginTop: 8, fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--pr-text)' } },
              React.createElement('div', { style: { background: 'var(--pr-inset)', padding: 8, borderRadius: 4, fontFamily: 'monospace', fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', whiteSpace: 'pre-wrap' } }, p.template),
              React.createElement('div', { style: { marginTop: 6, color: 'var(--pr-text-2)' } }, '来源：' + (p.source || '—') + ' ｜ 变量：' + ((p.vars || []).join(', ') || '—')),
              p.eval ? React.createElement('div', { style: { marginTop: 4 } },
                '评估：' + DIMS.map(function (d) { return d[1] + ' ' + (p.score && p.score[d[0]] || 0) }).join(' ｜ ') + ' ｜ 总分 ' + p.eval.total + '（' + p.eval.level + '）')
              : null) : null)
        }))
    }

    // ============ 路由测试 ============
    function RouteView() {
      var [title, setTitle] = React.useState('')
      var [req, setReq] = React.useState('')
      var [result, setResult] = React.useState(null)
      var run = function () {
        api('/prompt-router/api', 'route', { title: title, requirement: req }).then(function (d) { setResult(d) })
      }
      return React.createElement('div', { style: { padding: 16 } },
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-base-16-font-size, 16px)', fontWeight: 700, marginBottom: 8 } }, '元提示词路由'),
        React.createElement('input', { value: title, onChange: function (e) { setTitle(e.target.value) }, placeholder: '任务标题（如：撰写一篇科幻短篇）', style: inputStyle() }),
        React.createElement('textarea', { value: req, onChange: function (e) { setReq(e.target.value) }, placeholder: '任务要求/目标（可选）', rows: 3, style: Object.assign(inputStyle(), { height: 'auto' }) }),
        React.createElement('button', { onClick: run, style: btnStyle() }, '🚀 路由匹配'),
        result && result.ok ? React.createElement('div', { style: { marginTop: 12, border: '1px solid var(--pr-border-3)', borderRadius: 6, padding: 10, background: 'var(--pr-inset)' } },
          React.createElement('div', { style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', fontWeight: 600 } }, '匹配模板：' + result.matchedTitle + '（' + result.category + '）'),
          React.createElement('div', { style: { marginTop: 6, fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--pr-text)', fontFamily: 'monospace', whiteSpace: 'pre-wrap' } }, result.optimized))
        : null)
    }

    // ============ 新增条目 ============
    function AddView() {
      var [form, setForm] = React.useState({ title: '', category: '通用', tags: '', template: '', source: '人工补充' })
      var [msg, setMsg] = React.useState('')
      var set = function (k) { return function (e) { setForm(Object.assign({}, form, { [k]: e.target.value })) } }
      var submit = function () {
        api('/prompt-router/api', 'add', { prompt: {
          title: form.title, category: form.category, tags: form.tags.split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean),
          template: form.template, source: form.source
        } }).then(function (d) { setMsg(d && d.ok ? '✅ 已添加：' + d.id : '❌ ' + (d && d.error || '失败')) })
      }
      return React.createElement('div', { style: { padding: 16 } },
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-base-16-font-size, 16px)', fontWeight: 700, marginBottom: 8 } }, '新增提示词'),
        React.createElement('input', { value: form.title, onChange: set('title'), placeholder: '标题', style: inputStyle() }),
        React.createElement('div', { style: { display: 'flex', gap: 8 } },
          React.createElement('input', { value: form.category, onChange: set('category'), placeholder: '分类', style: Object.assign(inputStyle(), { flex: 1 }) }),
          React.createElement('input', { value: form.tags, onChange: set('tags'), placeholder: '标签（逗号分隔）', style: Object.assign(inputStyle(), { flex: 2 }) })),
        React.createElement('textarea', { value: form.template, onChange: set('template'), placeholder: '模板（用 {var} 表示变量，如：请撰写关于{topic}的{genre}）', rows: 5, style: Object.assign(inputStyle(), { height: 'auto', fontFamily: 'monospace', fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)' }) }),
        React.createElement('button', { onClick: submit, style: btnStyle() }, '💾 添加'),
        msg ? React.createElement('div', { style: { marginTop: 8, fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--pr-success)' } }, msg) : null)
    }

    // ============ 统计 ============
    function StatsView(props) {
      var d = props.data
      return React.createElement('div', { style: { padding: 16 } },
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-base-16-font-size, 16px)', fontWeight: 700, marginBottom: 12 } }, '体系统计'),
        React.createElement('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
          statCard('提示词总数', d.promptTotal || 0),
          statCard('平均评分', d.avgScore || 0),
          statCard('尝试次数', d.trialTotal || 0)),
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', fontWeight: 600, marginTop: 12, marginBottom: 6 } }, '最近尝试'),
        ((d.trials || []).slice(0, 10).map(function (t) {
          return React.createElement('div', { key: t.id, style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', padding: '4px 0', borderBottom: '1px solid var(--pr-divider)' } },
            '[' + t.result + '] ' + t.taskTitle + ' ｜ ' + (t.appliedAt || '').slice(0, 16).replace('T', ' '))
        })))
    }

    function statCard(label, val) {
      return React.createElement('div', { style: { border: '1px solid var(--pr-border)', borderRadius: 6, padding: '10px 16px', minWidth: 90, background: 'var(--pr-card)' } },
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-l-20-font-size, 20px)', fontWeight: 700 } }, val),
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--pr-text-2)' } }, label))
    }
    function inputStyle() {
      return { width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', border: '1px solid var(--pr-border-2)', borderRadius: 5, marginBottom: 8 }
    }
    function btnStyle() {
      return { padding: '8px 16px', fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', background: 'var(--pr-accent)', color: '#fff', border: 'none', borderRadius: 5, cursor: 'pointer', fontWeight: 600 }
    }

    // ============ 主界面 ============
    function PromptHome() {
      var [tab, setTab] = React.useState('library')
      var [data, setData] = React.useState(null)
      var refresh = function () {
        api('/prompt-router/api', 'list').then(function (d) { if (d && d.ok) setData(d) })
        api('/prompt-router/api', 'stats').then(function (d) { if (d && d.ok) setData(function (prev) { return Object.assign({}, prev, { promptTotal: d.promptTotal, avgScore: d.avgScore, trialTotal: d.trialTotal, trials: d.trials }) }) })
      }
      React.useEffect(function () { refresh() }, [])
      var tabs = [
        { id: 'library', label: '参考库', comp: function () { return React.createElement(LibraryView, { data: data }) } },
        { id: 'route', label: '路由测试', comp: RouteView },
        { id: 'add', label: '新增', comp: AddView },
        { id: 'stats', label: '统计', comp: function () { return React.createElement(StatsView, { data: data }) } }
      ]
      var active = tabs.find(function (t) { return t.id === tab })
      return React.createElement('div', { style: { height: '100%', display: 'flex', flexDirection: 'column' } },
        React.createElement('div', { style: { display: 'flex', gap: 4, padding: '10px 12px 0', borderBottom: '1px solid var(--pr-border)' } },
          tabs.map(function (t) {
            var isActive = tab === t.id
            return React.createElement('button', {
              key: t.id, onClick: function () { setTab(t.id) },
              style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', padding: '6px 14px', border: 'none', borderBottom: isActive ? '2px solid var(--pr-accent)' : '2px solid transparent', background: 'transparent', color: isActive ? 'var(--pr-accent)' : 'var(--pr-text-2)', fontWeight: isActive ? 600 : 400, cursor: 'pointer' }
            }, t.label)
          })),
        React.createElement('div', { style: { flex: 1, overflow: 'auto', minHeight: 0 } },
          React.createElement(active.comp, null)))
    }

    // ============ 弹窗型入口（2b-2 · 入口重排）============
    // 入口从 conversation.view 页签改为「adapter 的插件抽屉（pluginDock）+ 自己的 shell.overlay 弹窗」：
    //   · 弹窗平时渲染 null，open() 时渲染；
    //   · 弹窗 UI 完全由本插件自己渲染（官方明令插件之间不能 import 组件）；
    //   · 可见性 state 挂在 globalThis 单例上 —— 本插件的 client 也会被 client-hmr 按模块级 reload
    //     重跑（新模块实例不能丢掉已登记的入口与已打开的状态），且 open() 是别人（adapter）持有的回调。
    var GB = (typeof globalThis !== 'undefined') ? globalThis : window;
    var POPUP_STATE_KEY = '__promptRouterPopup__';
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
    // ⇒ 自身必须显式 pointer-events:auto 才可交互（见 .pr-pop-backdrop）。
    function PROverlay() {
      usePopup();
      React.useEffect(function () {
        if (!popup.visible) return;
        var onKey = function (e) { if (e.key === 'Escape') setPopup({ visible: false }); };
        document.addEventListener('keydown', onKey);
        return function () { document.removeEventListener('keydown', onKey); };
      }, [popup.visible]);
      if (popup.dockMissing) {
        // 响亮失败：pluginDock 拿不到时不静默 —— 顶部常驻横幅 + 控制台 error，并保留一个自救入口
        return React.createElement('div', { className: 'pr-pop-warn' },
          React.createElement('span', null, '插件清单服务不可用：pluginDock 未注册 —— 「提示词」无法从插件抽屉打开。'),
          React.createElement('button', { className: 'pr-pop-warnbtn', onClick: function () { setPopup({ visible: true }); } }, '仍要打开'));
      }
      if (!popup.visible) return null;
      return React.createElement('div', {
        className: 'pr-pop-backdrop',
        onClick: function () { setPopup({ visible: false }); }
      },
        React.createElement('div', {
          className: 'pr-pop-card',
          onClick: function (e) { e.stopPropagation(); }
        },
          React.createElement('div', { className: 'pr-pop-head' },
            React.createElement('span', { className: 'pr-pop-title' }, '提示词中心'),
            React.createElement('button', {
              className: 'pr-pop-close', title: '关闭（Esc 亦可）',
              onClick: function () { setPopup({ visible: false }); }
            }, '✕')),
          React.createElement('div', { className: 'pr-pop-body' }, React.createElement(PromptHome, null))));
    }

    // ============ 主题 token 映射（--pr-* → 宿主 --dsw-* 语义别名 + fallback）============
    // 本插件所有颜色/边框一律经 --pr-* 间接引用宿主 token；每个 dsw 引用都带 fallback，
    // 使 token 名跨版本漂移时最坏退化为"颜色不对"，不会"样式崩掉"。
    // --pr-* 是本插件私有前缀，不改动官方 --dsw-* 命名空间。
    // --pr-accent(#d97706 橙) 为插件自有品牌色，宿主无对应 token ⇒ 保留字面值。
    var THEME_VARS =
      '--pr-card:var(--dsw-alias-bg-layer-1,#fff);' +
      '--pr-inset:var(--dsw-alias-bg-layer-2,#f9fafb);' +
      '--pr-text:var(--dsw-alias-label-primary,#374151);' +
      '--pr-text-2:var(--dsw-alias-label-secondary,#6b7280);' +
      '--pr-text-3:var(--dsw-alias-label-tertiary,#9ca3af);' +
      '--pr-border:var(--dsw-alias-border-l1,#e4e4e7);' +
      '--pr-border-2:var(--dsw-alias-border-l2,#d4d4d8);' +
      '--pr-border-3:var(--dsw-alias-border-l2,#d1d5db);' +
      '--pr-divider:var(--dsw-alias-border-l1,#f3f4f6);' +
      '--pr-success:var(--dsw-alias-state-success-primary,#059669);' +
      '--pr-error:var(--dsw-alias-state-error-primary,#dc2626);' +
      '--pr-accent:#d97706;';

    // 弹窗样式（2b-2 新增）。要点：宿主壳级浮层容器是 pointer-events:none 的
    //   （.overlayLayer{z-index:20;position:absolute;inset:0;pointer-events:none}）
    // ⇒ 遮罩层必须显式 pointer-events:auto，否则整个弹窗「看得见、点不了」。
    var POPUP_CSS =
      '.pr-pop-backdrop{position:absolute;inset:0;pointer-events:auto;background:rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;}' +
      '.pr-pop-card{width:min(920px,92vw);height:min(680px,88vh);display:flex;flex-direction:column;background:var(--pr-card);border:1px solid var(--pr-border-2);border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,0.28);overflow:hidden;}' +
      '.pr-pop-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 14px;border-bottom:1px solid var(--pr-border);flex:0 0 auto;}' +
      '.pr-pop-title{font-size:var(--dsw-font-s-14-font-size,14px);font-weight:700;color:var(--pr-text);}' +
      '.pr-pop-close{border:none;background:transparent;color:var(--pr-text-2);font-size:18px;line-height:1;cursor:pointer;padding:2px 8px;border-radius:6px;}' +
      '.pr-pop-body{flex:1;min-height:0;overflow:auto;}' +
      '.pr-pop-warn{position:absolute;left:50%;top:12px;transform:translateX(-50%);pointer-events:auto;display:flex;align-items:center;gap:10px;background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:8px;padding:8px 12px;font-size:var(--dsw-font-xxs-12-font-size,12px);box-shadow:0 8px 24px rgba(0,0,0,0.18);}' +
      '.pr-pop-warnbtn{border:1px solid #fecaca;background:#fff;color:#b91c1c;border-radius:6px;padding:2px 10px;font-size:var(--dsw-font-xxs-12-font-size,12px);cursor:pointer;}' +
      '.pr-pop-warn .pr-pop-close{color:#b91c1c;}';

    // ============ 插件 apply ============
    var apply = function apply(ctx) {
      var slots = ctx.get('slots');
      if (slots === undefined) return;
      ctx.effect(function () {
        // 沿用宿主 CSS 注入约定：style 打 data-plugin / data-plugin-css 标记，按 tagId 去重。
        // 2b-2 起改为「先移除同名旧 tag 再插」：本文件新增了弹窗 CSS，若沿用「已存在就跳过」，
        // 旧 tag（来自上一次 apply / HMR 之前的实例）会让新增样式永远落不下来。
        var tagId = '@local/prompt-router/client.css';
        var prev = document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']');
        if (prev !== null) prev.remove();
        var tag = document.createElement('style');
        tag.dataset.plugin = '@local/prompt-router';
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
          { name: 'shell.overlay', id: 'prompt-router.popup', order: 50, label: '提示词弹窗' },
          function () { return React.createElement(PROverlay, null); }
        );
      });
      // ---- 入口二：向 adapter 的 pluginDock 登记自己（共享触发；弹窗 UI 仍由本插件渲染）----
      // 用 ctx.inject 而非裸 ctx.get：adapter 是种子 bundle，先加载，但**加载顺序 ≠ apply 顺序**
      // （cordis inject 会推迟 apply）⇒ inject 兜底时序。
      var settled = false;
      var watchdog = GB.setTimeout(function () {
        if (settled) return;
        try { console.error('[prompt-router] pluginDock 在 4s 内始终未注册：无法登记「提示词」入口；抽屉里不会有本插件（conversation.view 入口已移除）。'); } catch (e) {}
        setPopup({ dockMissing: true });
      }, 4000);
      ctx.inject(['pluginDock'], function () {
        settled = true;
        try { GB.clearTimeout(watchdog); } catch (e) {}
        var dock = ctx.get('pluginDock');
        if (!dock || typeof dock.register !== 'function') {
          try { console.error('[prompt-router] pluginDock 不可用：无法登记「提示词」入口。抽屉里不会出现本插件（conversation.view 入口已移除）。'); } catch (e) {}
          setPopup({ dockMissing: true });
          return;
        }
        dock.register({
          id: 'prompt-router',
          label: '提示词',
          order: 3,
          mode: 'modal',
          open: function () { setPopup({ visible: true, dockMissing: false }); }
        });
        try { console.info('[prompt-router] 已向 pluginDock 登记（id=prompt-router, mode=modal）'); } catch (e) {}
        ctx.effect(function () {
          return function () {
            try { dock.unregister('prompt-router'); } catch (e) {}
          };
        });
      });
    };
    var inject = ['timer'];

    exports.name = 'prompt-router';
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
