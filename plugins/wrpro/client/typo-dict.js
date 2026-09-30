// 本地错别字词库 + 检查逻辑（离线）
// wrong → right 对；检查时全文匹配可疑词，高亮 + 候选提示
// 用法：typoCheck(text) → [{ wrong, right, index, length }]

const TYPO_DICT = [
  ['帐号', '账号'],
  ['按装', '安装'],
  ['既使', '即使'],
  ['布署', '部署'],
  ['松驰', '松弛'],
  ['坐位', '座位'],
  ['做为主', '作为主'],
  ['做为', '作为'],
  ['必需', '必须'], // 场景性，常见误用
  ['决不', '绝不'],
  ['汇萃', '荟萃'],
  ['防碍', '妨碍'],
  ['震憾', '震撼'],
  ['渲泄', '宣泄'],
  ['重叠', '重叠'] // 正确示例（保留无妨）
  // 更多可追加……
].filter(function (p) { return p[0] !== p[1] })

// 去重 + 按长度降序（长词优先匹配）
var dict = TYPO_DICT.slice().sort(function (a, b) { return b[0].length - a[0].length })

/**
 * 检查文本中的错别字
 * @param {string} text
 * @returns {Array<{wrong:string, right:string, index:number, length:number}>}
 */
function typoCheck(text) {
  if (typeof text !== 'string' || text === '') return []
  var results = []
  for (var i = 0; i < dict.length; i++) {
    var wrong = dict[i][0]
    var right = dict[i][1]
    var from = 0
    while (true) {
      var idx = text.indexOf(wrong, from)
      if (idx < 0) break
      results.push({ wrong: wrong, right: right, index: idx, length: wrong.length })
      from = idx + wrong.length
    }
  }
  // 按位置排序
  results.sort(function (a, b) { return a.index - b.index })
  return results
}

/**
 * 替换指定位置的错别字
 */
function replaceAt(text, match, replacement) {
  return text.slice(0, match.index) + replacement + text.slice(match.index + match.length)
}

module.exports = { typoCheck, replaceAt, TYPO_DICT: dict }
