// Client：记忆管理系统插件 @local/memory-system
// 入口：adapter 的「插件」抽屉（pluginDock，mode:'modal'）+ 本插件自己的 shell.overlay 弹窗
//      （2b-2 起；此前是 conversation.view「记忆」页签 id=memory，order=6）
// 内容：记忆概览（分层统计）/ 上下文加载包预览 / 冲突列表
window.__ModuleLoader__.load({
  id: '@local/memory-system',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    var API = '/memory-system/api';

    function api(action, args) {
      return fetch(API + '/' + action, {
        method: args ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: args ? JSON.stringify(args) : undefined
      }).then(function (r) { return r.json() }).catch(function () { return { ok: false, error: 'network' } })
    }

    function inputStyle() {
      return { width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', border: '1px solid var(--ms-border-2)', borderRadius: 5, marginBottom: 8 }
    }
    function btnStyle() {
      return { padding: '8px 16px', fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', background: 'var(--ms-accent)', color: '#fff', border: 'none', borderRadius: 5, cursor: 'pointer', fontWeight: 600, marginRight: 8 }
    }
    function card() {
      return { border: '1px solid var(--ms-border)', borderRadius: 6, padding: 10, marginBottom: 8, background: 'var(--ms-card)', fontSize: 'var(--dsw-font-xs-13-font-size, 13px)' }
    }
    function dim() { return { fontSize: 'var(--dsw-font-xxxs-11-font-size, 11px)', color: 'var(--ms-text-2)' } }

    // ============ 概览（stats） ============
    function StatsView(props) {
      var d = props.data || {}
      var L = d.layers || {}
      var E = d.external || {}
      return React.createElement('div', { style: { padding: 16 } },
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-base-16-font-size, 16px)', fontWeight: 700, marginBottom: 8 } }, '记忆系统概览'),
        React.createElement('div', { style: dim(), marginBottom: 12 }, '数据目录：' + (d.dataDir || '') + ' · 迁移策略：' + ((d.config && d.config.migration) || '')),
        React.createElement('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 } },
          React.createElement('div', { style: Object.assign(card(), { minWidth: 84 }) }, React.createElement('div', { style: { fontSize: 'var(--dsw-font-l-20-font-size, 20px)', fontWeight: 700 } }, L.facts || 0), React.createElement('div', { style: dim() }, 'L0 项目事实')),
          React.createElement('div', { style: Object.assign(card(), { minWidth: 84 }) }, React.createElement('div', { style: { fontSize: 'var(--dsw-font-l-20-font-size, 20px)', fontWeight: 700 } }, L.longterm || 0), React.createElement('div', { style: dim() }, 'L1 任务摘要')),
          React.createElement('div', { style: Object.assign(card(), { minWidth: 84 }) }, React.createElement('div', { style: { fontSize: 'var(--dsw-font-l-20-font-size, 20px)', fontWeight: 700 } }, (L.drafts || 0) + '/' + (L.working || 0)), React.createElement('div', { style: dim() }, '草稿/工作记忆')),
          React.createElement('div', { style: Object.assign(card(), { minWidth: 84 }) }, React.createElement('div', { style: { fontSize: 'var(--dsw-font-l-20-font-size, 20px)', fontWeight: 700 } }, L.rawTasks || 0), React.createElement('div', { style: dim() }, 'L2 任务/记录 ' + (L.rawRecords || 0))),
          React.createElement('div', { style: Object.assign(card(), { minWidth: 84 }) }, React.createElement('div', { style: { fontSize: 'var(--dsw-font-l-20-font-size, 20px)', fontWeight: 700 } }, L.graphEntries || 0), React.createElement('div', { style: dim() }, '依赖图节点'))),
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', fontWeight: 600, marginBottom: 4 } }, '外部对接（只读联动）'),
        React.createElement('div', { style: dim() }, '知识库条目 ' + (E.kbEntries || 0) + ' · 技能 ' + (E.skills || 0) + ' · 提示词模板 ' + (E.prompts || 0)),
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', fontWeight: 600, marginTop: 10, marginBottom: 4 } }, '调用计数'),
        React.createElement('div', { style: dim() },
          'load ' + ((d.counters && d.counters.loadCount) || 0) + ' · record ' + ((d.counters && d.counters.recordCount) || 0) + ' · close ' + ((d.counters && d.counters.closeCount) || 0) + ' · weave ' + ((d.counters && d.counters.weaveCount) || 0) + ' · search ' + ((d.counters && d.counters.searchCount) || 0)))
    }

    // ============ 加载包预览（load） ============
    function LoadView() {
      var [form, setForm] = React.useState({ taskId: '', title: '', requirement: '', project: '' })
      var [ctx, setCtx] = React.useState(null)
      var [err, setErr] = React.useState('')
      var set = function (k) { return function (e) { setForm(Object.assign({}, form, { [k]: e.target.value })) } }
      var run = function () {
        setErr(''); setCtx(null)
        api('load', form).then(function (d) {
          if (d && d.ok && d.context) setCtx(d.context)
          else setErr((d && d.error) || '加载失败')
        })
      }
      return React.createElement('div', { style: { padding: 16 } },
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-base-16-font-size, 16px)', fontWeight: 700, marginBottom: 8 } }, '上下文加载包预览'),
        React.createElement('input', { value: form.taskId, onChange: set('taskId'), placeholder: 'taskId（可选，自动读看板）', style: inputStyle() }),
        React.createElement('input', { value: form.title, onChange: set('title'), placeholder: '任务标题', style: inputStyle() }),
        React.createElement('input', { value: form.requirement, onChange: set('requirement'), placeholder: '任务要求', style: inputStyle() }),
        React.createElement('input', { value: form.project, onChange: set('project'), placeholder: '项目（可选）', style: inputStyle() }),
        React.createElement('button', { onClick: run, style: btnStyle() }, '🔍 加载'),
        err ? React.createElement('div', { style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', color: 'var(--ms-error)' } }, '❌ ' + err) : null,
        ctx ? React.createElement('div', { style: { marginTop: 10 } },
          React.createElement('div', { style: card() },
            React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, '任务类型：' + (ctx.meta && ctx.meta.taskType || '通用') + ' · 通道 kb=' + (ctx.meta && ctx.meta.channels && ctx.meta.channels.kb) + ' skill=' + (ctx.meta && ctx.meta.channels && ctx.meta.channels.skill) + ' prompt=' + (ctx.meta && ctx.meta.channels && ctx.meta.channels.prompt)),
            React.createElement('div', { style: dim() }, 'L0 事实 ' + (ctx.l0 && ctx.l0.total || 0) + ' 条 / L1 摘要 ' + (ctx.l1 && ctx.l1.total || 0) + ' 条（预算 ' + (ctx.l1 && ctx.l1.cap) + '）/ KB 命中 ' + (ctx.kb && ctx.kb.total || 0) + ' / 技能 ' + (ctx.methods && ctx.methods.skills || []).length + ' / 提示词引用 ' + (ctx.methods && ctx.methods.prompts || []).length)),
          React.createElement('div', { style: card() },
            React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, 'L1 摘要'),
            (ctx.l1 && ctx.l1.hits || []).map(function (s) {
              return React.createElement('div', { key: s.task_id, style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', marginBottom: 3 } },
                React.createElement('span', { style: { color: 'var(--ms-accent)', fontWeight: 600 } }, '[' + s.status + ']'),
                ' ' + s.title + React.createElement('span', { style: dim(), marginLeft: 6 }, s.task_id))
            })),
          React.createElement('div', { style: card() },
            React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, '知识库命中'),
            (ctx.kb && ctx.kb.hits || []).map(function (e) {
              return React.createElement('div', { key: e.id, style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', marginBottom: 3 } },
                e.title, React.createElement('span', { style: dim(), marginLeft: 6 }, '[' + (e.category || '') + ']'), e.kbMode === 'index' ? React.createElement('span', { style: { fontSize: 10, color: 'var(--ms-accent)', marginLeft: 6 } }, '📎索引') : null,
                e.sourcePath ? React.createElement('span', { style: dim() }, ' ' + e.sourcePath) : null)
            })),
          React.createElement('div', { style: card() },
            React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, '工具调用记录（' + (ctx.toolRecords && ctx.toolRecords.source) + '，失败优先 ' + (ctx.toolRecords && ctx.toolRecords.records || []).length + ' 条）'),
            (ctx.toolRecords && ctx.toolRecords.records || []).map(function (r, i) {
              return React.createElement('div', { key: i, style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)', marginBottom: 3 } },
                React.createElement('span', { style: r.ok ? { color: 'var(--ms-accent)' } : { color: 'var(--ms-error)', fontWeight: 600 } }, r.ok ? '✓' : '✗'),
                ' ' + r.toolName + React.createElement('span', { style: dim(), marginLeft: 6 }, String(r.content || '').slice(0, 60)))
            })),
          (ctx.conflicts && ctx.conflicts.length) ? React.createElement('div', { style: Object.assign(card(), { borderColor: 'var(--ms-warn)' }) },
            React.createElement('div', { style: { fontWeight: 600, marginBottom: 4, color: 'var(--ms-warn-text)' } }, '⚠️ 冲突提示（不自动消解）'),
            ctx.conflicts.map(function (c, i) { return React.createElement('div', { key: i, style: { fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)' } }, c.id + ' ⟷ ' + c.targetId + '（' + c.targetTitle + '）') })) : null)
        : null)
    }

    // ============ 冲突列表（conflicts） ============
    function ConflictsView() {
      var [list, setList] = React.useState(null)
      var run = function () { api('conflicts', {}).then(function (d) { setList(d && d.ok ? d.conflicts : []) }) }
      React.useEffect(function () { run() }, [])
      return React.createElement('div', { style: { padding: 16 } },
        React.createElement('div', { style: { fontSize: 'var(--dsw-font-base-16-font-size, 16px)', fontWeight: 700, marginBottom: 8 } }, '冲突列表'),
        React.createElement('div', { style: dim(), marginBottom: 8 }, 'conflicts_with 关系只登记不消解：'),
        list === null ? React.createElement('div', { style: dim() }, '加载中…') :
        !list.length ? React.createElement('div', { style: dim() }, '暂无冲突') :
        list.map(function (c, i) {
          return React.createElement('div', { key: i, style: Object.assign(card(), { borderColor: 'var(--ms-warn)' }) },
            React.createElement('div', { style: { fontWeight: 600, fontSize: 'var(--dsw-font-xxs-12-font-size, 12px)' } }, c.title + ' ⟷ ' + c.targetTitle),
            React.createElement('div', { style: dim() }, c.id + ' conflicts_with ' + c.targetId + ' · 未消解'))
        }))
    }

    // ============ 主界面 ============
    function MemoryHome() {
      var [tab, setTab] = React.useState('stats')
      var [stats, setStats] = React.useState(null)
      React.useEffect(function () { api('stats', {}).then(function (d) { if (d && d.ok) setStats(d) }) }, [])
      var tabs = [
        { id: 'stats', label: '概览', comp: function () { return React.createElement(StatsView, { data: stats }) } },
        { id: 'load', label: '加载包预览', comp: LoadView },
        { id: 'conflicts', label: '冲突', comp: ConflictsView }
      ]
      var active = tabs.find(function (t) { return t.id === tab })
      return React.createElement('div', { style: { height: '100%', display: 'flex', flexDirection: 'column' } },
        React.createElement('div', { style: { display: 'flex', gap: 4, padding: '10px 12px 0', borderBottom: '1px solid var(--ms-border)' } },
          tabs.map(function (t) {
            var isActive = tab === t.id
            return React.createElement('button', {
              key: t.id, onClick: function () { setTab(t.id) },
              style: { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', padding: '6px 14px', border: 'none', borderBottom: isActive ? '2px solid var(--ms-accent)' : '2px solid transparent', background: 'transparent', color: isActive ? 'var(--ms-accent)' : 'var(--ms-text-2)', fontWeight: isActive ? 600 : 400, cursor: 'pointer' }
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
    var POPUP_STATE_KEY = '__memorySystemPopup__';
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
    // ⇒ 自身必须显式 pointer-events:auto 才可交互（见 .ms-pop-backdrop）。
    function MSOverlay() {
      usePopup();
      React.useEffect(function () {
        if (!popup.visible) return;
        var onKey = function (e) { if (e.key === 'Escape') setPopup({ visible: false }); };
        document.addEventListener('keydown', onKey);
        return function () { document.removeEventListener('keydown', onKey); };
      }, [popup.visible]);
      if (popup.dockMissing) {
        // 响亮失败：pluginDock 拿不到时不静默 —— 顶部常驻横幅 + 控制台 error，并保留一个自救入口
        return React.createElement('div', { className: 'ms-pop-warn' },
          React.createElement('span', null, '插件清单服务不可用：pluginDock 未注册 —— 「记忆」无法从插件抽屉打开。'),
          React.createElement('button', { className: 'ms-pop-warnbtn', onClick: function () { setPopup({ visible: true }); } }, '仍要打开'));
      }
      if (!popup.visible) return null;
      return React.createElement('div', {
        className: 'ms-pop-backdrop',
        onClick: function () { setPopup({ visible: false }); }
      },
        React.createElement('div', {
          className: 'ms-pop-card',
          onClick: function (e) { e.stopPropagation(); }
        },
          React.createElement('div', { className: 'ms-pop-head' },
            React.createElement('span', { className: 'ms-pop-title' }, '记忆系统'),
            React.createElement('button', {
              className: 'ms-pop-close', title: '关闭（Esc 亦可）',
              onClick: function () { setPopup({ visible: false }); }
            }, '✕')),
          React.createElement('div', { className: 'ms-pop-body' }, React.createElement(MemoryHome, null))));
    }

    // ============ 主题 token 映射（--ms-* → 宿主 --dsw-* 语义别名 + fallback）============
    // 本插件所有颜色/边框一律经 --ms-* 间接引用宿主 token；每个引用都带 fallback，
    // 使 token 名跨版本漂移时最坏退化为"颜色不对"，不会"样式崩掉"。
    // --ms-* 是本插件私有前缀，不改动官方 --dsw-* 命名空间。
    var THEME_VARS =
      '--ms-card:var(--dsw-alias-bg-layer-1,#fff);' +
      '--ms-text-2:var(--dsw-alias-label-secondary,#6b7280);' +
      '--ms-border:var(--dsw-alias-border-l1,#e4e4e7);' +
      '--ms-border-2:var(--dsw-alias-border-l2,#d4d4d8);' +
      '--ms-accent:var(--dsw-alias-state-success-primary,#059669);' +
      '--ms-error:var(--dsw-alias-state-error-primary,#dc2626);' +
      '--ms-warn:var(--dsw-alias-state-warn-primary,#f59e0b);' +
      '--ms-warn-text:var(--dsw-alias-state-warn-label,#b45309);';

    // 弹窗样式（2b-2 新增）。要点：宿主壳级浮层容器是 pointer-events:none 的
    //   （.overlayLayer{z-index:20;position:absolute;inset:0;pointer-events:none}）
    // ⇒ 遮罩层必须显式 pointer-events:auto，否则整个弹窗「看得见、点不了」。
    var POPUP_CSS =
      '.ms-pop-backdrop{position:absolute;inset:0;pointer-events:auto;background:rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;}' +
      '.ms-pop-card{width:min(920px,92vw);height:min(680px,88vh);display:flex;flex-direction:column;background:var(--ms-card);border:1px solid var(--ms-border-2);border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,0.28);overflow:hidden;}' +
      '.ms-pop-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 14px;border-bottom:1px solid var(--ms-border);flex:0 0 auto;}' +
      '.ms-pop-title{font-size:var(--dsw-font-s-14-font-size,14px);font-weight:700;color:var(--dsw-alias-label-primary,#374151);}' +
      '.ms-pop-close{border:none;background:transparent;color:var(--ms-text-2);font-size:18px;line-height:1;cursor:pointer;padding:2px 8px;border-radius:6px;}' +
      '.ms-pop-body{flex:1;min-height:0;overflow:auto;}' +
      '.ms-pop-warn{position:absolute;left:50%;top:12px;transform:translateX(-50%);pointer-events:auto;display:flex;align-items:center;gap:10px;background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:8px;padding:8px 12px;font-size:var(--dsw-font-xxs-12-font-size,12px);box-shadow:0 8px 24px rgba(0,0,0,0.18);}' +
      '.ms-pop-warnbtn{border:1px solid #fecaca;background:#fff;color:#b91c1c;border-radius:6px;padding:2px 10px;font-size:var(--dsw-font-xxs-12-font-size,12px);cursor:pointer;}' +
      '.ms-pop-warn .ms-pop-close{color:#b91c1c;}';

    // ============ 插件 apply ============
    var apply = function apply(ctx) {
      var slots = ctx.get('slots');
      if (slots === undefined) return;
      ctx.effect(function () {
        // 沿用宿主 CSS 注入约定：style 打 data-plugin / data-plugin-css 标记，按 tagId 去重。
        // 2b-2 起改为「先移除同名旧 tag 再插」：本文件新增了弹窗 CSS，若沿用「已存在就跳过」，
        // 旧 tag（来自上一次 apply / HMR 之前的实例）会让新增样式永远落不下来。
        var tagId = '@local/memory-system/client.css';
        var prev = document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']');
        if (prev !== null) prev.remove();
        var tag = document.createElement('style');
        tag.dataset.plugin = '@local/memory-system';
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
          { name: 'shell.overlay', id: 'memory-system.popup', order: 50, label: '记忆弹窗' },
          function () { return React.createElement(MSOverlay, null); }
        );
      });
      // ---- 入口二：向 adapter 的 pluginDock 登记自己（共享触发；弹窗 UI 仍由本插件渲染）----
      // 用 ctx.inject 而非裸 ctx.get：adapter 是种子 bundle，先加载，但**加载顺序 ≠ apply 顺序**
      // （cordis inject 会推迟 apply）⇒ inject 兜底时序。
      var settled = false;
      var watchdog = GB.setTimeout(function () {
        if (settled) return;
        try { console.error('[memory-system] pluginDock 在 4s 内始终未注册：无法登记「记忆」入口；抽屉里不会有本插件（conversation.view 入口已移除）。'); } catch (e) {}
        setPopup({ dockMissing: true });
      }, 4000);
      ctx.inject(['pluginDock'], function () {
        settled = true;
        try { GB.clearTimeout(watchdog); } catch (e) {}
        var dock = ctx.get('pluginDock');
        if (!dock || typeof dock.register !== 'function') {
          try { console.error('[memory-system] pluginDock 不可用：无法登记「记忆」入口。抽屉里不会出现本插件（conversation.view 入口已移除）。'); } catch (e) {}
          setPopup({ dockMissing: true });
          return;
        }
        dock.register({
          id: 'memory-system',
          label: '记忆',
          order: 6,
          mode: 'modal',
          open: function () { setPopup({ visible: true, dockMissing: false }); }
        });
        try { console.info('[memory-system] 已向 pluginDock 登记（id=memory-system, mode=modal）'); } catch (e) {}
        ctx.effect(function () {
          return function () {
            try { dock.unregister('memory-system'); } catch (e) {}
          };
        });
      });
    };
    var inject = ['timer'];

    exports.name = 'memory-system';
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
