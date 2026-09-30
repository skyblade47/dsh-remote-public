// Client：writing-coach 最小占位（引擎全部在 host；B2 断章/节奏面板再注入 conversation.view slot）
window.__ModuleLoader__.load({
  id: '@local/writing-coach',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports;
    var apply = function () {}
    exports.name = 'writing-coach'
    exports.apply = apply
    return module.exports
  }
})
