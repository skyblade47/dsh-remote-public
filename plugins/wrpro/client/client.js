// Client：写作工作台静态化 @local/wrpro
// Word 式工作台（纯文本）+ 本地错别字检查 + localStorage 数据层
// 参照 taskkit client.js 的 __ModuleLoader__.load 写法
// ⚠️ 子模块（typo-dict/store）内联：__ModuleLoader__ 的 require 只解析模块表，不支持相对路径
window.__ModuleLoader__.load({
  id: '@local/wrpro',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    // ==================== 内联：错别字词库 ====================
    var TYPO_DICT = [
      ['帐号', '账号'], ['按装', '安装'], ['既使', '即使'], ['布署', '部署'],
      ['松驰', '松弛'], ['坐位', '座位'], ['做为', '作为'], ['决不', '绝不'],
      ['汇萃', '荟萃'], ['防碍', '妨碍'], ['震憾', '震撼'], ['渲泄', '宣泄'],
      ['必需', '必须'], ['真象', '真相'], ['精萃', '精粹'], ['自谥', '自缢']
    ].filter(function (p) { return p[0] !== p[1] })
    var typoDict = TYPO_DICT.slice().sort(function (a, b) { return b[0].length - a[0].length })

    function typoCheck(text) {
      if (typeof text !== 'string' || text === '') return []
      var results = []
      for (var i = 0; i < typoDict.length; i++) {
        var wrong = typoDict[i][0], right = typoDict[i][1]
        var from = 0
        while (true) {
          var idx = text.indexOf(wrong, from)
          if (idx < 0) break
          results.push({ wrong: wrong, right: right, index: idx, length: wrong.length })
          from = idx + wrong.length
        }
      }
      results.sort(function (a, b) { return a.index - b.index })
      return results
    }
    function replaceAt(text, match, replacement) {
      return text.slice(0, match.index) + replacement + text.slice(match.index + match.length)
    }

    // ==================== 内联：本地数据层（localStorage） ====================
    var LS_PREFIX = 'wrpro:'
    function lsRead(key, fallback) {
      try { var raw = localStorage.getItem(LS_PREFIX + key); if (raw === null || raw === undefined) return fallback; return JSON.parse(raw) } catch (e) { return fallback }
    }
    function lsWrite(key, value) {
      try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)); return true } catch (e) { return false }
    }
    var localStore = {
      getDraft: function () { return lsRead('draft', '') },
      setDraft: function (t) { return lsWrite('draft', t) },
      getStash: function () { return lsRead('stash', { content: '', updatedAt: null }) },
      setStash: function (c) { return lsWrite('stash', { content: c, updatedAt: new Date().toISOString() }) },
      getRecords: function () { return lsRead('records', { version: 1, days: {}, totalWords: 0, streak: 0 }) },
      setRecords: function (r) { return lsWrite('records', r) },
      getSchedule: function () { return lsRead('schedule', { startDate: null, done: {} }) },
      setSchedule: function (s) { return lsWrite('schedule', s) }
    }

    // ---- 数据层（localStorage）----
    var listeners = [];
    var state = {
      draft: localStore.getDraft() || '',
      records: localStore.getRecords(),
      schedule: localStore.getSchedule(),
      lastSavedAt: null,
      flash: null,
      typoResults: [],      // 错别字检查结果
      typoMode: false,      // 是否展开检查面板
      busy: false
    };
    function notify() { for (var i = 0; i < listeners.length; i++) listeners[i](); }
    function setState(patch) { for (var k in patch) state[k] = patch[k]; notify(); }
    function useStore() {
      var force = React.useState(0)[1];
      React.useEffect(function () {
        listeners.push(function () { force(function (n) { return n + 1 }); });
        return function () { listeners.splice(listeners.length - 1, 1); };
      }, []);
    }

    // ---- 字数统计（去空白）----
    function countWords(s) { return (s || '').replace(/\s+/g, '').length; }
    function fmtTime(iso) {
      if (!iso) return '—';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      var p = function (n) { return String(n).padStart(2, '0'); };
      return d.getHours() + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    // ---- 今日记录（保存时累加）----
    function todayKey() {
      var d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function saveEntry() {
      if (state.busy || !state.draft.trim()) { setState({ flash: '内容为空，未保存' }); return; }
      setState({ busy: true });
      // v2: 保存→host API（工作区权威存档），暂存→localStorage
      fetch('/wrpro/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: state.draft })
      }).then(function (r) { return r.json() }).then(function (d) {
        if (d && d.ok && d.saved) {
          var words = d.saved.words;
          localStore.setStash(state.draft);
          setState({ lastSavedAt: new Date().toISOString(), flash: '✓ 已保存到工作区 ' + words + ' 字（' + (d.saved.filename || '') + '）', busy: false });
        } else { setState({ flash: '保存失败: ' + (d && d.error || '未知错误'), busy: false }); }
      }).catch(function () { setState({ flash: '保存失败: 网络错误', busy: false }); });
    }

    // ---- 错别字检查 ----
    function runTypoCheck() {
      var results = typoCheck(state.draft);
      setState({ typoResults: results, typoMode: true, flash: results.length ? '发现 ' + results.length + ' 处可疑' : '未发现常见错别字 ✓' });
    }
    function replaceOne(match, right) {
      var next = replaceAt(state.draft, match, right);
      setState({ draft: next });
      localStore.setDraft(next);
      // 重新检查
      var results = typoCheck(next);
      setState({ typoResults: results, flash: '已替换「' + match.wrong + '」→「' + right + '」' });
    }
    function replaceAll() {
      var text = state.draft;
      var results = typoCheck(text);
      if (!results.length) return;
      // 从后往前替换避免 index 错位
      var sorted = results.slice().sort(function (a, b) { return b.index - a.index; });
      for (var i = 0; i < sorted.length; i++) {
        var m = sorted[i];
        text = text.slice(0, m.index) + m.right + text.slice(m.index + m.length);
      }
      setState({ draft: text, typoResults: [], flash: '✓ 已全部替换 ' + results.length + ' 处' });
      localStore.setDraft(text);
    }

    // ---- 自动暂存（输入防抖）----
    var debounceTimer = null;
    function onChange(e) {
      var v = e.target.value;
      setState({ draft: v });
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () { localStore.setDraft(v); }, 800);
    }

    // ---- Word 式工作台 ----
    function WritingWorkspace() {
      useStore();
      return React.createElement('div', { className: 'wr2-root' },
        // 工具栏
        React.createElement('div', { className: 'wr2-toolbar' },
          React.createElement('span', { className: 'wr2-title' }, '✍️ 写作工作台'),
          React.createElement('button', { className: 'wr2-btn wr2-btn-primary', onClick: saveEntry, disabled: state.busy }, state.busy ? '保存中…' : '💾 保存'),
          React.createElement('button', { className: 'wr2-btn', onClick: function () { localStore.setStash(state.draft); setState({ flash: '已暂存' }); } }, '📥 暂存'),
          React.createElement('button', { className: 'wr2-btn', onClick: function () { setState({ draft: localStore.getStash().content || '', flash: '已恢复上次暂存' }); } }, '📤 恢复'),
          React.createElement('button', { className: 'wr2-btn wr2-btn-typo', onClick: runTypoCheck }, '🔍 错别字检查'),
          React.createElement('span', { className: 'wr2-spacer' }),
          React.createElement('span', { className: 'wr2-wordcount' }, countWords(state.draft) + ' 字')
        ),
        // 状态条
        state.flash ? React.createElement('div', { className: 'wr2-flash' }, state.flash) : null,
        // 纸张编辑区
        React.createElement('div', { className: 'wr2-page' },
          React.createElement('textarea', {
            className: 'wr2-editor',
            value: state.draft,
            onChange: onChange,
            placeholder: '在这里开始写作…\n\n内容自动暂存到本地，随时可以离开。\n\n（纯文本模式，无字体/字号/颜色格式）'
          })
        ),
        // 错别字检查面板
        state.typoMode ? React.createElement(TypoPanel, { results: state.typoResults, onReplace: replaceOne, onReplaceAll: replaceAll, onClose: function () { setState({ typoMode: false }); } }) : null,
        // 状态栏
        React.createElement('div', { className: 'wr2-statusbar' },
          React.createElement('span', null, '字数：' + countWords(state.draft)),
          React.createElement('span', null, '今日：' + ((state.records.days && state.records.days[todayKey()] && state.records.days[todayKey()].words) || 0) + ' 字 · 累计：' + (state.records.totalWords || 0) + ' 字'),
          React.createElement('span', null, '上次保存：' + fmtTime(state.lastSavedAt)),
          React.createElement('span', null, '数据存于浏览器本地')
        )
      );
    }

    // ---- 错别字检查面板（高亮 + 候选 + 替换）----
    function TypoPanel(props) {
      var results = props.results || [];
      var onReplace = props.onReplace;
      var onReplaceAll = props.onReplaceAll;
      var onClose = props.onClose;
      return React.createElement('div', { className: 'wr2-typo-panel' },
        React.createElement('div', { className: 'wr2-typo-head' },
          React.createElement('span', null, '🔍 错别字检查（' + results.length + ' 处）'),
          React.createElement('button', { className: 'wr2-btn', onClick: onClose }, '关闭')
        ),
        results.length === 0
          ? React.createElement('div', { className: 'wr2-typo-empty' }, '未发现常见错别字 ✓')
          : React.createElement('div', { className: 'wr2-typo-list' },
              results.map(function (m, i) {
                return React.createElement('div', { key: i, className: 'wr2-typo-item' },
                  React.createElement('span', { className: 'wr2-typo-wrong' }, m.wrong),
                  React.createElement('span', { className: 'wr2-typo-arrow' }, '→'),
                  React.createElement('span', { className: 'wr2-typo-right' }, m.right),
                  React.createElement('button', { className: 'wr2-btn wr2-btn-green', onClick: function () { onReplace(m, m.right); } }, '替换'),
                  React.createElement('button', { className: 'wr2-btn', onClick: function () { onReplace(m, ''); } }, '忽略')
                );
              })
            ),
        results.length ? React.createElement('div', { className: 'wr2-typo-actions' },
          React.createElement('button', { className: 'wr2-btn wr2-btn-primary', onClick: onReplaceAll }, '一键全部替换')
        ) : null
      );
    }

    // ---- 样式（Word 视觉：居中白纸 + 阴影）----
    // 主题对齐（方案A 第二批）：字号统一改用宿主字号 token（font-size 阶梯），颜色改用宿主语义别名；
    // 每个 var(--dsw-*) 都带 fallback（token 名跨版本漂移时最坏退化为"颜色不对"，不会"样式崩掉"）。
    // 「白纸」是本插件刻意的 Word 隐喻（纸面白底 / 墨色深字 / 纸边 / 衬线体）⇒ 保留字面值；
    // 橙、紫为插件自有品牌色（宿主无精确语义 token）⇒ 收进 --wr-* 私有前缀（不改动官方 token 命名空间）。
    var CSS =
      '.wr2-root{--wr-brand:#d97706;--wr-purple:#6d28d9;display:flex;flex-direction:column;gap:8px;height:100%;min-height:62vh;padding:12px 24px 16px;box-sizing:border-box;font-family:inherit;color:var(--dsw-alias-label-primary,#1f2937);}' +
      '.wr2-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 10px;background:var(--dsw-alias-bg-layer-2,#f4f4f5);border:1px solid var(--dsw-alias-border-l1,#e4e4e7);border-radius:8px;}' +
      '.wr2-title{font-size:var(--dsw-font-s-14-font-size,14px);font-weight:700;margin-right:8px;}' +
      '.wr2-btn{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2937);border:1px solid var(--dsw-alias-border-l2,#d4d4d8);border-radius:6px;padding:4px 12px;font-size:var(--dsw-font-xxs-12-font-size,12px);cursor:pointer;font-family:inherit;}' +
      '.wr2-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#e4e4e7);}' +
      '.wr2-btn-primary{background:var(--wr-brand);border-color:transparent;color:#fff;}' +
      '.wr2-btn-green{background:rgba(16,185,129,0.15);border-color:transparent;color:var(--dsw-alias-state-success-primary,#047857);}' +
      '.wr2-btn-typo{background:rgba(126,87,194,0.15);border-color:transparent;color:var(--wr-purple);}' +
      '.wr2-spacer{flex:1;}' +
      '.wr2-wordcount{font-size:var(--dsw-font-xxs-12-font-size,12px);opacity:0.7;}' +
      '.wr2-flash{font-size:var(--dsw-font-xxs-12-font-size,12px);color:var(--dsw-alias-state-success-primary,#059669);padding:2px 4px;}' +
      '.wr2-page{flex:1;display:flex;justify-content:center;padding:8px 0;min-height:0;}' +
      '.wr2-editor{width:min(820px,94%);height:100%;min-height:46vh;box-sizing:border-box;padding:48px 56px;background:#ffffff;color:#1a1a1a;border:1px solid #d4d4d8;border-radius:3px;box-shadow:0 2px 12px rgba(0,0,0,0.12);font-family:"Times New Roman","Songti SC","SimSun",serif;font-size:var(--dsw-font-base-16-font-size,16px);line-height:1.9;resize:none;outline:none;}' +
      '.wr2-editor:focus{border-color:var(--wr-brand);box-shadow:0 2px 14px rgba(217,119,6,0.15);}' +
      '.wr2-editor::placeholder{color:#a1a1aa;font-size:var(--dsw-font-s-14-font-size,14px);}' +
      '.wr2-typo-panel{position:fixed;right:24px;bottom:90px;width:340px;max-height:46vh;overflow:auto;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#d4d4d8);border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.2);padding:12px;z-index:999;display:flex;flex-direction:column;gap:8px;}' +
      '.wr2-typo-head{display:flex;align-items:center;justify-content:space-between;font-size:var(--dsw-font-xs-13-font-size,13px);font-weight:600;}' +
      '.wr2-typo-list{display:flex;flex-direction:column;gap:6px;}' +
      '.wr2-typo-item{display:flex;align-items:center;gap:8px;font-size:var(--dsw-font-xxs-12-font-size,12px);padding:4px 6px;border-radius:6px;background:rgba(239,68,68,0.06);}' +
      '.wr2-typo-wrong{color:var(--dsw-alias-state-error-primary,#dc2626);text-decoration:underline wavy var(--dsw-alias-state-error-primary,#ef4444);font-weight:600;}' +
      '.wr2-typo-arrow{opacity:0.5;}' +
      '.wr2-typo-right{color:var(--dsw-alias-state-success-primary,#059669);font-weight:600;}' +
      '.wr2-typo-empty{font-size:var(--dsw-font-xxs-12-font-size,12px);color:var(--dsw-alias-state-success-primary,#059669);text-align:center;padding:10px;}' +
      '.wr2-typo-actions{display:flex;justify-content:flex-end;}' +
      '.wr2-statusbar{display:flex;gap:18px;flex-wrap:wrap;padding:4px 6px;font-size:var(--dsw-font-xxxs-11-font-size,11px);color:var(--dsw-alias-label-secondary,#6b7280);border-top:1px solid var(--dsw-alias-border-l1,#e4e4e7);}';

    // ---- 插件 apply ----
    var apply = function apply(ctx) {
      var slots = ctx.get('slots');
      if (slots === undefined) return;
      ctx.effect(function () {
        var tag = document.createElement('style');
        tag.textContent = CSS;
        document.head.append(tag);
        return function () { tag.remove(); };
      });
      // 2026-08-25 架构简化：写作/润色/错别字功能已合并进 writing-studio（写作工作台），
      // 不再注册独立「写作」页签（wrpro 插件保留，供 host 端能力；页面无独立入口）
    };
    var inject = ['timer'];

    exports.name = 'wrpro';
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
