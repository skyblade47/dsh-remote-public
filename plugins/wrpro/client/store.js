// 本地数据层（localStorage）：草稿 / 记录 / 日程 / 暂存
// 不依赖 host fs；首次启动尝试从旧动态版工作区文件迁移（若通过 API 可读）

var PREFIX = 'wrpro:'

function read(key, fallback) {
  try {
    var raw = localStorage.getItem(PREFIX + key)
    if (raw === null || raw === undefined) return fallback
    return JSON.parse(raw)
  } catch (e) { return fallback }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
    return true
  } catch (e) { return false }
}

function remove(key) {
  try { localStorage.removeItem(PREFIX + key) } catch (e) {}
}

var store = {
  // 草稿（自动暂存）
  getDraft: function () { return read('draft', '') },
  setDraft: function (text) { return write('draft', text) },
  // 暂存（显式保存）
  getStash: function () { return read('stash', { content: '', updatedAt: null }) },
  setStash: function (content) { return write('stash', { content: content, updatedAt: new Date().toISOString() }) },
  // 写作记录
  getRecords: function () { return read('records', { version: 1, days: {}, totalWords: 0, streak: 0 }) },
  setRecords: function (records) { return write('records', records) },
  // 日程完成
  getSchedule: function () { return read('schedule', { startDate: null, done: {} }) },
  setSchedule: function (scd) { return write('schedule', scd) },
  // 移除
  clearDraft: function () { remove('draft') },
  clearAll: function () { Object.keys(localStorage).filter(function (k) { return k.indexOf(PREFIX) === 0 }).forEach(function (k) { localStorage.removeItem(k) }) }
}

module.exports = store
