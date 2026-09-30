// Client：email-bridge 最小占位（功能主要在 host，无需 UI）
window.__ModuleLoader__.load({
  id: '@local/email-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var apply = function () {}
    exports.name = 'email-bridge'
    exports.apply = apply
    return module.exports
  }
})
