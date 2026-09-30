// @local/writing-coach · lib/engines.js —— 写作分析引擎纯函数域（零依赖，node --check 可直测）
// ============================================================
// B1-3 断章判定引擎  analyzeChapterBreaks（chapterBreakAgent.js L97-190 源码直移）
// B1-4 节奏分析引擎  analyzeBlockPacing（pacingAgent.js L109-277 源码直移）
// B1-5 审查规则引擎  reviewText（reviewService.ts + textScanner.js + review-score-service.ts 直移
//                      + 形近/音近词典自补，学员实例：约/跃、仍/扔、留下/流下、寒蝉/寒噤、的/地/得）
// ============================================================
// 双副本约定：TYPO_DICT（第 1 层词典）与 writing-studio client.js 词典同步维护——
//             修改任一方必须同步另一方（反之亦然）。
// 本文件不 import 任何模块（纯函数域），可被 node 直接 import 测试。

// ==================== 通用：块归一化 ====================
// input: {blocks?:[{id,content}], text?:string} → [{id, content}]
// text 时按空行（\n\s*\n）分块，id='b'+index
export function normalizeBlocks(input) {
  if (input && Array.isArray(input.blocks)) {
    return input.blocks.map(function (b, i) {
      return { id: String((b && b.id !== undefined && b.id !== null) ? b.id : 'b' + i), content: String((b && b.content) || '') }
    })
  }
  const text = String((input && input.text) || '')
  if (!text.trim()) return []
  return text.split(/\n\s*\n/).map(function (seg, i) { return { id: 'b' + i, content: seg } })
}

// ==================== B1-3 断章判定引擎（chapterBreakAgent.js 直移） ====================
export function analyzeBlockFeatures(content) {
  let confidence = 0
  let reasoning = ''
  let isLikelyBreak = false

  if (content.trim().length > 500) {
    confidence += 0.2
    reasoning += '文本长度适中，'
  }
  if (/[.。!?！？]$/.test(content.trim())) {
    confidence += 0.2
    reasoning += '句子完整，'
  }
  if (/[“"”]$/.test(content.trim())) {
    confidence += 0.3
    reasoning += '对话结束，'
  }
  if (/悬念|疑问|困惑|不解|震惊/.test(content)) {
    confidence += 0.4
    reasoning += '包含悬念内容，'
    isLikelyBreak = true
  }
  if (/站起身|离开|转身|消失|等待|思考/.test(content)) {
    confidence += 0.3
    reasoning += '动作结束，'
    isLikelyBreak = true
  }
  confidence = Math.min(0.9, confidence)
  if (!isLikelyBreak && confidence > 0.3) {
    isLikelyBreak = true
  }
  return {
    confidence: Math.round(confidence * 100) / 100,
    reasoning: reasoning + '适合断章。',
    isLikelyBreak
  }
}

export function determineBreakType(content) {
  if (/悬念|惊讶|疑惑/.test(content)) return 'suspense'
  if (/发现|揭示|变化/.test(content)) return 'reversal'
  if (/危机|危险|紧急/.test(content)) return 'crisis'
  if (/决定|选择|选择/.test(content)) return 'decision'
  return 'suspense'
}

export function generateBreakSuggestion(confidence) {
  if (confidence > 0.7) return '这是一个很好的断章位置，建议在这里暂停并设置悬念。'
  if (confidence > 0.5) return '这里可以考虑断章，建议增强悬念效果。'
  return '建议检查是否需要在这里设置章节末尾。'
}

// 入口：analyzeChapterBreaks({blocks?|text?}) → {blocks, breaks, summary}
export function analyzeChapterBreaks(input) {
  const blocks = normalizeBlocks(input)
  const breaks = []
  blocks.forEach(function (block, i) {
    const content = block.content || ''
    const features = analyzeBlockFeatures(content)
    if (features.isLikelyBreak) {
      breaks.push({
        id: 'break_' + i,
        blockId: block.id,
        type: determineBreakType(content),
        position: i,
        confidence: features.confidence,
        suggestion: generateBreakSuggestion(features.confidence),
        reasoning: features.reasoning
      })
    }
  })
  return {
    blocks: blocks.map(function (b, i) { return { id: b.id, index: i, contentLength: (b.content || '').length } }),
    breaks: breaks,
    summary: '发现 ' + breaks.length + ' 个候选断章点'
  }
}

// ==================== B1-4 节奏分析引擎（pacingAgent.js 直移） ====================
// 单块分析（源码 analyzeBlockPacing 直移）
export function analyzeBlockPacingSingle(content) {
  const wordCount = content.length
  const estimatedReadTime = Math.round((wordCount / 200) * 100) / 100

  let sceneType = 'description'
  let intensity = 0.5

  const dialogueRatio = (content.match(/[“"”]/g) || []).length / Math.max(1, content.length / 50)
  const actionWords = (content.match(/冲|跑|打|攻击|战斗|爆炸/g) || []).length
  const descriptionWords = (content.match(/看|观察|感觉|感受/g) || []).length

  if (dialogueRatio > 0.3) {
    sceneType = 'dialogue'
    intensity = 0.4
  } else if (actionWords > 2) {
    sceneType = 'action'
    intensity = 0.8
  } else if (descriptionWords > 3) {
    sceneType = 'description'
    intensity = 0.3
  } else {
    sceneType = 'transition'
    intensity = 0.5
  }

  let pacingScore = 0.5
  if (wordCount < 200) {
    pacingScore = 0.8
  } else if (wordCount > 800) {
    pacingScore = 0.3
  } else {
    pacingScore = 0.6 - ((wordCount - 200) / 1200) * 0.3
  }
  if (sceneType === 'action') pacingScore = Math.min(0.9, pacingScore + 0.2)
  if (sceneType === 'description') pacingScore = Math.max(0.2, pacingScore - 0.2)

  return {
    sceneType,
    wordCount,
    estimatedReadTime,
    pacingScore: Math.round(Math.max(0, Math.min(1, pacingScore)) * 100) / 100,
    intensity
  }
}

export function assessOverallPacing(avgPacing, blockCount) {
  if (avgPacing > 0.7) {
    return '节奏偏快，建议适当增加一些描述内容让读者有时间消化'
  } else if (avgPacing < 0.4) {
    return '节奏偏慢，建议增加一些对话或动作来提升节奏'
  }
  return '节奏基本平衡，建议保持并适时调整'
}

export function generateLocalAnalysis(pacingMap) {
  const avgPacing = pacingMap.length > 0 ? pacingMap.reduce(function (sum, item) { return sum + item.pacingScore }, 0) / pacingMap.length : 0.5
  const sceneTypeCounts = { action: 0, dialogue: 0, description: 0, transition: 0 }
  pacingMap.forEach(function (item) {
    if (item.sceneType && sceneTypeCounts[item.sceneType] !== undefined) sceneTypeCounts[item.sceneType]++
  })
  return {
    averagePacing: Math.round(avgPacing * 100) / 100,
    totalBlocks: pacingMap.length,
    sceneTypeDistribution: sceneTypeCounts,
    overallAssessment: assessOverallPacing(avgPacing, pacingMap.length)
  }
}

export function generateLocalSuggestions(pacingMap) {
  const suggestions = []
  if (pacingMap.length < 2) return suggestions

  for (let i = 1; i < pacingMap.length; i++) {
    const prev = pacingMap[i - 1]
    const current = pacingMap[i]
    const diff = Math.abs(current.pacingScore - prev.pacingScore)
    if (diff > 0.5) {
      suggestions.push({
        type: 'pacing_change',
        blockId: current.blockId,
        severity: 'warning',
        suggestion: '节奏变化较大，建议适当平滑过渡',
        position: i
      })
    }
  }

  let consecutiveDescription = 0
  let consecutiveDialogue = 0
  pacingMap.forEach(function (item, index) {
    if (item.sceneType === 'description') {
      consecutiveDescription++
      consecutiveDialogue = 0
    } else if (item.sceneType === 'dialogue') {
      consecutiveDialogue++
      consecutiveDescription = 0
    } else {
      consecutiveDescription = 0
      consecutiveDialogue = 0
    }
    if (consecutiveDescription >= 3) {
      suggestions.push({
        type: 'too_much_description',
        blockId: item.blockId,
        severity: 'info',
        suggestion: '连续描述较多，建议插入对话或动作打破节奏',
        position: index
      })
      consecutiveDescription = 0
    }
    if (consecutiveDialogue >= 4) {
      suggestions.push({
        type: 'too_much_dialogue',
        blockId: item.blockId,
        severity: 'info',
        suggestion: '连续对话较多，建议适当加入动作或描述',
        position: index
      })
      consecutiveDialogue = 0
    }
  })
  return suggestions
}

// 入口：analyzeBlockPacing({blocks?|text?}) → {pacingMap, analysis, suggestions}
export function analyzeBlockPacing(input) {
  const blocks = normalizeBlocks(input)
  const pacingMap = blocks.map(function (block, index) {
    const a = analyzeBlockPacingSingle(block.content || '')
    return {
      blockId: block.id,
      index,
      sceneType: a.sceneType,
      wordCount: a.wordCount,
      estimatedReadTime: a.estimatedReadTime,
      pacingScore: a.pacingScore,
      intensity: a.intensity
    }
  })
  const analysis = generateLocalAnalysis(pacingMap)
  const suggestions = generateLocalSuggestions(pacingMap)
  return { pacingMap, analysis, suggestions }
}

// ==================== B1-5 审查规则引擎（三层合并：词典→规则→AI） ====================
// —— 第 1 层：现有词典（writing-studio client.js TYPO_DICT v2 原样复制，双副本同步） ——
export const TYPO_DICT = [
  // —— 原16组 ——
  ['帐号', '账号'], ['按装', '安装'], ['既使', '即使'], ['布署', '部署'],
  ['松驰', '松弛'], ['坐位', '座位'], ['做为', '作为'], ['决不', '绝不'],
  ['汇萃', '荟萃'], ['防碍', '妨碍'], ['震憾', '震撼'], ['渲泄', '宣泄'],
  ['必需', '必须'], ['真象', '真相'], ['精萃', '精粹'], ['自谥', '自缢'],
  // —— v2 扩充：形近/音近常见错字 ——
  ['约下', '跃下'], ['约过', '跃过'], ['跳下', '跃下'], ['寒蝉', '寒噤'], ['寒颤', '寒噤'],
  ['震奋', '振奋'], ['急燥', '急躁'], ['浮燥', '浮躁'], ['干燥', '干躁'], ['暴躁', '暴躁'],
  ['傍徨', '彷徨'], ['徘徊', '徘徊'], ['仓桑', '沧桑'], ['苍海', '沧海'], ['沧茫', '苍茫'],
  ['磨糊', '模糊'], ['溶洽', '融洽'], ['圆滑', '圆滑'], ['狡滑', '狡猾'], ['滑头', '滑头'],
  ['殉丽', '绚丽'], ['炫烂', '绚烂'], ['斑澜', '斑斓'], ['澜珊', '阑珊'], ['嘻戏', '嬉戏'],
  ['撕杀', '厮杀'], ['撕打', '厮打'], ['宣嚣', '喧嚣'], ['渲嚣', '喧嚣'], ['枯躁', '枯燥'],
  ['烦燥', '烦躁'], ['焦燥', '焦躁'], ['爆燥', '暴躁'], ['装磺', '装潢'], ['装璜', '装潢'],
  ['慰籍', '慰藉'], ['藉口', '借口'], ['狼籍', '狼藉'], ['杯盘狼籍', '杯盘狼藉'],
  ['泊来', '舶来'], ['泊来品', '舶来品'], ['发髻', '发髻'], ['髻子', '发髻'],
  ['慎密', '缜密'], ['缜密', '缜密'], ['告戒', '告诫'], ['告介', '告诫'],
  ['陷井', '陷阱'], ['井然', '井然'], ['无耐', '无奈'], ['奈心', '耐心'],
  ['云宵', '云霄'], ['九宵', '九霄'], ['响彻云宵', '响彻云霄'], ['直冲云宵', '直冲云霄'],
  ['欧打', '殴打'], ['欧斗', '殴斗'], ['欧气', '呕气'], ['沤气', '呕气'],
  ['防犯', '防范'], ['防碍', '妨碍'], ['妨害', '妨害'], ['防害', '妨害'],
  ['克苦', '刻苦'], ['克薄', '刻薄'], ['刻服', '克服'], ['攻克', '攻克'],
  ['痉孪', '痉挛'], ['精孪', '痉挛'], ['缰绳', '缰绳'], ['疆绳', '缰绳'],
  ['遨游', '遨游'], ['傲游', '遨游'], ['翱游', '遨游'],
  ['震摄', '震慑'], ['摄人心魄', '慑人心魄'], ['威慑', '威慑'],
  ['魁力', '魅力'], ['媚力', '魅力'], ['魅惑', '魅惑'],
  ['彷佛', '仿佛'], ['仿拂', '仿佛'], ['佛若', '仿佛'],
  ['再接再励', '再接再厉'], ['厉害', '厉害'], ['利害', '厉害'],
  ['挖墙角', '挖墙脚'], ['墙脚', '墙角'], ['墙角', '墙角'],
  ['赋于', '赋予'], ['赋与', '赋予'], ['给予', '给予'],
  ['融汇贯通', '融会贯通'], ['会贯通', '会贯通'],
  ['提纲挈领', '提纲挈领'], ['提携', '提携'],
  ['不径而走', '不胫而走'], ['胫骨', '胫骨'],
  ['迫不急待', '迫不及待'], ['急不可待', '急不可待'],
  ['一如继往', '一如既往'], ['既往', '既往'],
  ['变本加利', '变本加厉'], ['变本加励', '变本加厉'],
  ['走头无路', '走投无路'], ['走投无路', '走投无路'],
  ['兵慌马乱', '兵荒马乱'], ['荒乱', '荒乱'],
  ['草管人命', '草菅人命'], ['菅', '菅'],
  ['好高鹜远', '好高骛远'], ['趋之若骛', '趋之若鹜'], ['好高骛远', '好高骛远'],
  ['震聋发聩', '振聋发聩'], ['振聋发聩', '振聋发聩'],
  ['饮鸠止渴', '饮鸩止渴'], ['饮鸩止渴', '饮鸩止渴'],
  ['相形见拙', '相形见绌'], ['见拙', '见绌'],
  ['声名雀起', '声名鹊起'], ['鹊起', '鹊起'],
  ['鸦雀无声', '鸦雀无声'], ['鸦鹊无声', '鸦雀无声'],
  ['再接再励', '再接再厉'], ['励精图治', '励精图治'],
  ['悬梁刺骨', '悬梁刺股'], ['刺骨', '刺骨'],
  ['暗然失色', '黯然失色'], ['黯然', '黯然'],
  ['精兵减政', '精兵简政'], ['精简', '精简'],
  ['甘败下风', '甘拜下风'], ['拜下风', '拜下风'],
  ['自抱自弃', '自暴自弃'], ['自暴', '自暴'],
  ['一愁莫展', '一筹莫展'], ['一筹', '一筹'],
  ['穿流不息', '川流不息'], ['川流', '川流'],
  ['渡假', '度假'], ['渡假村', '度假村'],
  ['言简意骇', '言简意赅'], ['意赅', '意赅'],
  ['滥芋充数', '滥竽充数'], ['竽', '竽'],
  ['默守成规', '墨守成规'], ['墨守', '墨守'],
  ['沤心沥血', '呕心沥血'], ['呕心', '呕心'],
  ['磬竹难书', '罄竹难书'], ['罄竹', '罄竹'],
  ['委屈求全', '委曲求全'], ['委曲', '委曲'],
  ['金榜提名', '金榜题名'], ['题名', '题名'],
  ['谈笑风声', '谈笑风生'], ['风生', '风生'],
  ['挺而走险', '铤而走险'], ['铤而', '铤而'],
  ['人情事故', '人情世故'], ['世故', '世故'],
  ['有持无恐', '有恃无恐'], ['有恃', '有恃'],
  ['九宵云外', '九霄云外'], ['九霄', '九霄'],
  // —— v2 语义级搭配纠错（上下文规则） ——
  ['留着鲜血', '流着鲜血'], ['留着血', '流着血'], ['留下鲜血', '流下鲜血'],
  ['留下眼泪', '流下眼泪'], ['留下泪水', '流下泪水'], ['留下汗', '流下汗'],
  ['留下泪', '流下泪'], ['掉下眼泪', '流下眼泪'], ['留下一地', '流了一地'],
  ['激动地跳下', '激动地跳起'], ['跳下泪水', '流下泪水'],
  ['寒蝉若噤', '寒噤若蝉'], ['打了寒蝉', '打了个寒噤'], ['打了个寒蝉', '打了个寒噤'],
  ['的的确确地', '的的确确'], ['的地地', '地地'], ['的的', '的'],
  // —— 的/地/得 常见误用（静态规则：动词后应「得」） ——
  ['跑的飞快', '跑得飞快'], ['跑的很快', '跑得很快'], ['走的很快', '走得很快'],
  ['看的清楚', '看得清楚'], ['说的好听', '说得好听'], ['写的很好', '写得很好'],
  ['吃的好', '吃得好'], ['睡的好', '睡得好'], ['玩的开', '玩得开'],
  ['激动的说', '激动地说'], ['兴奋的说', '兴奋地说'], ['大声的说', '大声地说'],
  ['快速的跑', '快速地跑'], ['轻轻的走', '轻轻地走'], ['慢慢的走', '慢慢地走']
].filter(function (p) { return p[0] !== p[1] })

function scanDict(text) {
  const results = []
  const sorted = TYPO_DICT.slice().sort(function (a, b) { return b[0].length - a[0].length })
  for (const pair of sorted) {
    const wrong = pair[0]
    const right = pair[1]
    let from = 0
    while (true) {
      const idx = text.indexOf(wrong, from)
      if (idx < 0) break
      results.push({
        type: 'typo',
        category: '常见错字',
        originalText: wrong,
        position: { start: idx, end: idx + wrong.length },
        suggestion: right,
        severity: 'warning',
        confidence: 'high',
        source: 'dict',
        description: '「' + wrong + '」应为「' + right + '」（静态词典）'
      })
      from = idx + wrong.length
    }
  }
  return results
}

// —— 第 2 层：11+5 规则（reviewService.ts typo4+logic3+forbidden4 + textScanner/review-score + 形近音近词典） ——
// 11 条正则（de_di_de 由上下文规则实现；forbidden4 默认关闭）
const TYPO_RULES_11 = [
  { type: 'typo', category: 'common_mistakes', pattern: /在哪里/g, description: '"在哪里"应为"在哪儿"或"在哪里"（根据语境）', severity: 'info', suggestion: '请确认"在哪儿/在哪里"', confidence: 'medium' },
  { type: 'typo', category: 'common_mistakes', pattern: /再在/g, description: '"再在"应为"再"或"在"', severity: 'warning', suggestion: '应为"再"或"在"', confidence: 'high' },
  { type: 'typo', category: 'homophone', pattern: /象像/g, description: '需要确认"象"和"像"的用法', severity: 'info', suggestion: '确认"象/像"用法', confidence: 'low' },
  { type: 'logic', category: 'time_contradiction', pattern: /(早上|上午).*(晚上|夜里|凌晨)/, description: '时间逻辑矛盾：事件发生在同一时间段', severity: 'error', suggestion: '请检查时间线是否合理', confidence: 'medium' },
  { type: 'logic', category: 'space_contradiction', pattern: /(北京).*(广州).*(瞬间|马上|立即)/, description: '空间逻辑矛盾：短时间内无法到达', severity: 'warning', suggestion: '请检查地点转换是否合理', confidence: 'medium' },
  { type: 'logic', category: 'character_behavior', pattern: /(性格内向|沉默寡言).*(大声说|滔滔不绝)/, description: '角色行为与性格不符', severity: 'warning', suggestion: '请确保角色行为符合其性格设定', confidence: 'medium' },
  { type: 'forbidden', category: 'political', pattern: /领导[人家]|总书记/g, description: '涉及政治敏感人物', severity: 'error', suggestion: '建议修改为更通用的表达', confidence: 'high', forbidden: true },
  { type: 'forbidden', category: 'violence', pattern: /(杀人|死亡|流血).*(详细|具体)/g, description: '过度详细的暴力描写', severity: 'warning', suggestion: '建议减少暴力描写的细节', confidence: 'medium', forbidden: true },
  { type: 'forbidden', category: 'pornography', pattern: /(裸体|全裸|脱光)/g, description: '可能涉及色情内容', severity: 'error', suggestion: '建议删除或委婉表达', confidence: 'high', forbidden: true },
  { type: 'forbidden', category: 'illegal', pattern: /(毒品|吸毒|制毒|贩毒)/g, description: '涉及毒品相关内容', severity: 'error', suggestion: '建议删除或改写相关内容', confidence: 'high', forbidden: true }
]

function scanRegexRules(text, opts) {
  const out = []
  for (const rule of TYPO_RULES_11) {
    if (rule.forbidden && !opts.includeForbidden) continue
    const re = new RegExp(rule.pattern.source, 'g')
    for (const m of text.matchAll(re)) {
      out.push({
        type: rule.type,
        category: rule.category,
        originalText: m[0],
        position: { start: m.index, end: m.index + m[0].length },
        suggestion: rule.suggestion,
        severity: rule.severity,
        confidence: rule.confidence,
        source: 'rule',
        description: rule.description
      })
    }
  }
  return out
}

// 标点检查（连续标点/感叹号/问号/空格/引号配对）
function escapeRe(ch) {
  return String(ch).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function scanPunctuation(text) {
  const out = []
  const add = function (m, msg) {
    out.push({
      type: 'style',
      category: '标点',
      originalText: m[0],
      position: { start: m.index, end: m.index + m[0].length },
      suggestion: msg,
      severity: 'info',
      confidence: 'high',
      source: 'rule',
      description: msg
    })
  }
  // 连续标点（同字符重复）
  for (const m of text.matchAll(/([，。；：])\1{1,}/g)) add(m, '连续标点，建议保留一个')
  // 感叹号过多
  for (const m of text.matchAll(/[！!]{2,}/g)) add(m, '感叹号过多，考虑减少使用')
  // 问号过多
  for (const m of text.matchAll(/[？?]{2,}/g)) add(m, '问号过多，考虑减少使用')
  // 多余空格
  for (const m of text.matchAll(/\s{2,}/g)) add(m, '多余的空格')
  // 引号不配对计数
  const pairs = [['“', '”', '双引号'], ['‘', '’', '单引号'], ['（', '）', '括号'], ['《', '》', '书名号'], ['「', '」', '直角引号'], ['『', '』', '直角引号']]
  for (const p of pairs) {
    const openCount = (text.match(new RegExp(escapeRe(p[0]), 'g')) || []).length
    const closeCount = (text.match(new RegExp(escapeRe(p[1]), 'g')) || []).length
    if (openCount !== closeCount) {
      const char = openCount > closeCount ? p[0] : p[1]
      const idx = text.indexOf(char)
      out.push({
        type: 'style',
        category: '标点',
        originalText: char,
        position: { start: idx, end: idx + 1 },
        suggestion: '检查' + p[2] + '配对',
        severity: 'info',
        confidence: 'low',
        source: 'rule',
        description: p[2] + '数量不配对（开 ' + openCount + ' / 闭 ' + closeCount + '），请检查'
      })
    }
  }
  return out
}

// 重复用词（review-score-service 算法：2 字以上中文词出现 >5 次）
function scanRepeatedWords(text) {
  const words = text.match(/[\u4e00-\u9fa5]{2,}/g) || []
  const count = {}
  for (const w of words) count[w] = (count[w] || 0) + 1
  const freq = Object.keys(count).filter(function (w) { return count[w] > 5 }).sort(function (a, b) { return count[b] - count[a] }).slice(0, 3)
  return freq.map(function (w) {
    const idx = text.indexOf(w)
    return {
      type: 'style',
      category: '词汇重复',
      originalText: w,
      position: { start: idx, end: idx + w.length },
      suggestion: '考虑使用同义词或调整表达',
      severity: 'info',
      confidence: 'low',
      source: 'rule',
      description: '「' + w + '」出现 ' + count[w] + ' 次，可能存在词汇重复问题'
    }
  })
}

// 长句（句均长度 >50 字）
function scanLongSentence(text) {
  const wordCount = text.length
  const sentenceCount = (text.match(/[。！？]/g) || []).length
  const avg = sentenceCount > 0 ? wordCount / sentenceCount : 0
  if (avg > 50) {
    return [{
      type: 'style',
      category: '句子结构',
      originalText: '',
      position: { start: 0, end: text.length },
      suggestion: '过长的句子会影响阅读体验，建议适当断句',
      severity: 'warning',
      confidence: 'medium',
      source: 'rule',
      description: '平均句长 ' + Math.round(avg) + ' 字，句子偏长，建议适当断句'
    }]
  }
  return []
}

// 形近词典（学员实例：约/跃、仍/扔、留下/流下 等，含搭配规则）
function scanShapePairs(text) {
  const out = []
  // 仍 + 在|下|掉 → 扔（学员实例：将金币仍在了吧台上）
  for (const m of text.matchAll(/仍(?=[在下掉])/g)) {
    out.push({
      type: 'typo',
      category: '形近字',
      originalText: m[0],
      position: { start: m.index, end: m.index + 1 },
      suggestion: '扔',
      severity: 'warning',
      confidence: 'high',
      source: 'rule',
      description: '「仍」应为「扔」（形近字，后接 在/下/掉）'
    })
  }
  // 金币|硬币|骰子 + 跳动 → 疑似 转动/滚动（medium，学员实例：不等金币在桌面上的跳动停止）
  if (/金币|硬币|骰子/.test(text)) {
    for (const m of text.matchAll(/跳动/g)) {
      out.push({
        type: 'typo',
        category: '形近搭配',
        originalText: m[0],
        position: { start: m.index, end: m.index + 2 },
        suggestion: '转动/滚动',
        severity: 'warning',
        confidence: 'medium',
        source: 'rule',
        description: '疑似「跳动」应为「转动/滚动」（金币/硬币/骰子语境）'
      })
    }
  }
  // 留下 + 液体语境（后 14 字内含 血|泪|汗|水）→ 流下（学员实例：水顺着他的面孔留下…泪水）
  for (const m of text.matchAll(/留下/g)) {
    const tail = text.slice(m.index + 2, m.index + 2 + 14)
    if (/[血泪汗水]/.test(tail)) {
      out.push({
        type: 'typo',
        category: '形近搭配',
        originalText: m[0],
        position: { start: m.index, end: m.index + 2 },
        suggestion: '流下',
        severity: 'warning',
        confidence: 'medium',
        source: 'rule',
        description: '疑似「留下」应为「流下」（液体语境）'
      })
    }
  }
  return out
}

// 音近词典（学员实例：寒蝉→寒噤） + 的/地/得 上下文规则
function scanSoundPairs(text) {
  const out = []
  // 打了个?寒蝉 → 打了个?寒噤
  for (const m of text.matchAll(/打了(个)?寒蝉/g)) {
    out.push({
      type: 'typo',
      category: '音近字',
      originalText: m[0],
      position: { start: m.index, end: m.index + m[0].length },
      suggestion: m[0].replace('寒蝉', '寒噤'),
      severity: 'warning',
      confidence: 'high',
      source: 'rule',
      description: '「寒蝉」应为「寒噤」（音近字，打寒噤）'
    })
  }
  // 寒蝉若噤（误写，实为「噤若寒蝉」）
  for (const m of text.matchAll(/寒蝉若噤/g)) {
    out.push({
      type: 'typo',
      category: '音近字',
      originalText: m[0],
      position: { start: m.index, end: m.index + m[0].length },
      suggestion: '噤若寒蝉',
      severity: 'warning',
      confidence: 'medium',
      source: 'rule',
      description: '「寒蝉若噤」应为「噤若寒蝉」'
    })
  }
  out.push(...scanDeDiDe(text))
  return out
}

// 的/地/得 上下文规则（学员实例：激的→激得、逐步变的癫狂→变得、激动地说→激动地）
function scanDeDiDe(text) {
  const out = []
  // 动词 + 的 + 补语/结果 → 得（激的打了个寒蝉 / 逐步变的癫狂 / 跑的飞快 / 看的清楚 / 吃的好）
  const verbSet = '激变跑走看说写吃喝玩乐听学笑哭跳叫喊打骂想记改演唱读讲谈做干弄拉推举提抓拿穿戴洗刷擦扫搬运送迎接站坐躺蹲爬飞游滚转停躲藏开关装卸倒洒泼浇灌滴流漂浮沉落降升退进出回来去到达'
  const compSet = '了|个|很|飞快|很快|清楚|好听|很好|好|开|癫狂|疯|鲜血|寒蝉|说不出|发白|发抖|发颤|死|透|起|完|成|准|稳|对|错|快|慢|净|干|湿|疼|痛|累|饿|饱|醉|迷|愣|傻|呆'
  const deVerbRe = new RegExp('([' + verbSet + '])(的)(?=[^，。；！？\\n]{0,8}(?:' + compSet + '))', 'g')
  for (const m of text.matchAll(deVerbRe)) {
    const right = m[0].replace('的', '得')
    out.push({
      type: 'typo',
      category: 'de_di_de',
      originalText: m[0],
      position: { start: m.index, end: m.index + m[0].length },
      suggestion: right,
      severity: 'warning',
      confidence: 'medium',
      source: 'rule',
      description: '「' + m[0] + '」应为「' + right + '」（动词后接补语用「得」）'
    })
  }
  // 状语 + 的 + 动词 → 地（激动地说 / 大声的说 / 轻轻的走）
  // 排除 他她它你我们 的是得地 + 方位词 上里中下前左右旁（防止「桌面上的跳动」这类定语误报）
  const deAdvRe = /(?<![他她它你我们的是得地上里中下前左右旁])的(?=[^，。；！？\n]{0,4}(?:说|道|问|喊|叫|哭|笑|走|跑|看|望|指|点头|摇头|握|抬|举|冲|扑|跳|坐|站))/g
  for (const m of text.matchAll(deAdvRe)) {
    out.push({
      type: 'typo',
      category: 'de_di_de',
      originalText: m[0],
      position: { start: m.index, end: m.index + 1 },
      suggestion: '地',
      severity: 'warning',
      confidence: 'medium',
      source: 'rule',
      description: '「的」应为「地」（状语修饰动词用「地」）'
    })
  }
  return out
}

function scanRules(text, opts) {
  const out = []
  out.push(...scanRegexRules(text, opts))
  out.push(...scanPunctuation(text))
  out.push(...scanRepeatedWords(text))
  out.push(...scanLongSentence(text))
  out.push(...scanShapePairs(text))
  out.push(...scanSoundPairs(text))
  return out
}

// —— 合并：按 (start,originalText) 去重、保最高置信度；子跨度被更长条目覆盖则丢弃；按位置排序、封顶 ——
const CONF_RANK = { high: 3, medium: 2, low: 1 }
const SRC_RANK = { dict: 3, rule: 2, ai: 1 }

export function mergeFindings(findings, cap) {
  cap = cap || 50
  const map = {}
  for (const f of findings) {
    const key = f.position.start + '|' + f.originalText
    const existing = map[key]
    if (!existing) { map[key] = f; continue }
    const curRank = (CONF_RANK[f.confidence] || 1)
    const oldRank = (CONF_RANK[existing.confidence] || 1)
    if (curRank > oldRank || (curRank === oldRank && (SRC_RANK[f.source] || 0) > (SRC_RANK[existing.source] || 0))) {
      map[key] = f
    }
  }
  let list = Object.keys(map).map(function (k) { return map[k] })
  // 长词优先 → 完全被更长条目覆盖的子跨度丢弃（如 dict「打了个寒蝉」覆盖 rule「寒蝉」）
  list.sort(function (a, b) { return (b.position.end - b.position.start) - (a.position.end - a.position.start) })
  const kept = []
  for (const f of list) {
    const covered = kept.some(function (k) { return f.position.start >= k.position.start && f.position.end <= k.position.end })
    if (!covered) kept.push(f)
  }
  kept.sort(function (a, b) { return a.position.start - b.position.start || a.position.end - b.position.end })
  return kept.slice(0, cap).map(function (f, i) { return Object.assign({ id: 'rev_' + (i + 1) }, f) })
}

// 三层合并辅助：本地 findings + AI findings 合并
export function mergeWithAi(localFindings, aiFindings, cap) {
  return mergeFindings((localFindings || []).concat(aiFindings || []), cap || 50)
}

// —— 入口：reviewText(text, {includeForbidden?}) → {findings, layerCounts, total, summary} ——
export function reviewText(text, opts) {
  opts = opts || {}
  const includeForbidden = opts.includeForbidden === true
  if (typeof text !== 'string' || !text.trim()) {
    return { findings: [], layerCounts: { dict: 0, rule: 0 }, total: 0, summary: '无文本可审查' }
  }
  const findings = []
  findings.push(...scanDict(text))
  findings.push(...scanRules(text, { includeForbidden }))
  const merged = mergeFindings(findings)
  const layerCounts = {
    dict: merged.filter(function (f) { return f.source === 'dict' }).length,
    rule: merged.filter(function (f) { return f.source === 'rule' }).length
  }
  const summary = merged.length
    ? '发现 ' + merged.length + ' 处可疑（词典 ' + layerCounts.dict + ' + 规则 ' + layerCounts.rule + '）'
    : '未发现可疑点'
  return { findings: merged, layerCounts, total: merged.length, summary }
}

// ==================== B2-3 自一致性检查引擎（content-review-enhanced.ts L104-260 直移增强） ====================
// —— consistencyCheckCharacter：角色一致性（FIX-2 判定矩阵，新增矛盾检测） ——
// 输入：character {name, attributes:{appearance?, personality?, background?}}，content
// 判定矩阵（写死，与设计一一对应）：
//   appearance：V=split(/,，/) 去空（互斥外观设定集合）；H={v∈V|content 含 v}
//     |V|==1（单值）：|H|==1 且正文无冲突外观词 → passed（与设定一致）；|H|==1 且正文含其他外观词 → warning（疑似前后矛盾）
//                     |H|==0 → warning（无证据）
//     |V|>=2（多值互斥）：|H|==0 → warning（无证据）；|H|==1 → warning（疑似前后不一致，待复核）；|H|>=2 → failed（实锤矛盾）
//   personality / background：按 /[,，]/ 拆关键词，任一命中 → evidence；累计 evidence>0 且 appearance 未判 failed → passed；0 命中 → warning
//   汇总：任一维度 failed → failed；否则任一 warning → warning；否则 passed
// 外观冲突词启发式（组长验证反馈 2026-08-28）：颜色+部位（发/眼/瞳/肤）二元词，
//   单值设定命中后，正文出现与设定不同颜色的其他外观词 → 疑似矛盾（warning）
const APPEARANCE_PART_RE = /[黑金白红蓝绿棕银灰紫黄褐青][发眼瞳肤]/g

export function consistencyCheckCharacter(name, attributes, content) {
  name = String(name || '未知角色')
  attributes = attributes || {}
  content = String(content || '')
  const issues = []
  const evidence = []
  let overall = 'passed'

  // 1) appearance：互斥外观设定集合判定
  const appearanceRaw = String(attributes.appearance || '')
  if (appearanceRaw.trim()) {
    const V = appearanceRaw.split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean)
    const H = V.filter(function (v) { return content.indexOf(v) >= 0 })
    let appStatus = 'passed'
    if (V.length === 1) {
      if (H.length === 1) {
        // 单值命中：扫描正文是否出现与设定不同颜色的其他外观词（发/眼/瞳/肤），疑似矛盾
        const conflictWords = []
        for (const m of content.matchAll(APPEARANCE_PART_RE)) {
          if (V.indexOf(m[0]) >= 0) continue // 设定词本身不算冲突
          if (conflictWords.indexOf(m[0]) < 0) conflictWords.push(m[0])
        }
        if (conflictWords.length) {
          appStatus = 'warning'
          issues.push('设定外观为「' + V[0] + '」，但正文同时出现冲突外观描述「' + conflictWords.join('/') + '」，疑似前后不一致，待复核')
        } else {
          evidence.push('外貌匹配: ' + H[0])
        }
      } else { appStatus = 'warning'; issues.push('未找到外貌设定「' + V[0] + '」在正文中的体现（无证据）') }
    } else {
      if (H.length === 0) { appStatus = 'warning'; issues.push('互斥外观设定 ' + V.join('/') + ' 均未在正文出现（无证据）') }
      else if (H.length === 1) { appStatus = 'warning'; issues.push('互斥外观设定 ' + V.join('/') + ' 仅命中「' + H[0] + '」，疑似前后不一致，待复核') }
      else { appStatus = 'failed'; issues.push('同一角色同时出现互斥外观：' + H.join(' 与 ') + '（实锤矛盾）') }
    }
    if (appStatus === 'failed') overall = 'failed'
    else if (overall !== 'failed' && appStatus === 'warning') overall = 'warning'
  }

  // 2) personality / background：拆词正向匹配
  for (const attr of ['personality', 'background']) {
    const raw = String(attributes[attr] || '')
    if (!raw.trim()) continue
    const keywords = raw.split(/[,，]/).map(function (k) { return k.trim() }).filter(Boolean)
    let hits = 0
    for (const kw of keywords) {
      if (content.indexOf(kw) >= 0) { evidence.push((attr === 'personality' ? '性格匹配' : '背景匹配') + ': ' + kw); hits++ }
    }
    if (hits === 0 && overall !== 'failed') overall = 'warning'
  }

  const status = overall
  return {
    checkId: 'char_' + Math.random().toString(36).substr(2, 9),
    checkType: 'character',
    target: name,
    status: status,
    details: issues.length ? issues.join('; ') : (evidence.length ? '角色特征一致（命中 ' + evidence.length + ' 项设定）' : '角色特征一致'),
    evidence: evidence,
    suggestion: status === 'failed' ? '建议检查角色「' + name + '」的设定一致性（互斥外观/特征矛盾）' : (status === 'warning' ? '建议补充或复核角色「' + name + '」的设定体现' : undefined)
  }
}

// —— consistencyCheckWorld：世界观一致性（no_ 前缀规则：forbidden 词出现即 violation） ——
// worldRules：[{rule:'no_xxx'|'no_xxx=描述', description?}] 或 {no_xxx:描述, xxx:描述} 或 ['no_xxx']
export function consistencyCheckWorld(worldRules, content) {
  content = String(content || '')
  const violations = []
  const evidence = []
  const rules = []
  if (Array.isArray(worldRules)) {
    for (const r of worldRules) {
      if (typeof r === 'string') rules.push({ rule: r, description: r })
      else if (r && typeof r === 'object') rules.push({ rule: String(r.rule || ''), description: String(r.description || r.rule || '') })
    }
  } else if (worldRules && typeof worldRules === 'object') {
    for (const k of Object.keys(worldRules)) rules.push({ rule: k, description: String(worldRules[k] || k) })
  }
  for (const r of rules) {
    if (r.rule.indexOf('no_') === 0) {
      const forbidden = r.rule.replace('no_', '')
      if (forbidden && content.indexOf(forbidden) >= 0) {
        violations.push('违反规则: ' + (r.description || forbidden) + '（正文出现「' + forbidden + '」）')
      } else if (forbidden) {
        evidence.push('未出现禁止内容: ' + (r.description || forbidden))
      }
    } else if (r.rule && content.indexOf(r.rule) >= 0) {
      evidence.push('设定体现: ' + (r.description || r.rule))
    }
  }
  const status = violations.length ? 'failed' : 'passed'
  return {
    checkId: 'world_' + Math.random().toString(36).substr(2, 9),
    checkType: 'world',
    target: '世界观',
    status: status,
    details: violations.length ? violations.join('; ') : '世界观设定一致',
    evidence: evidence,
    suggestion: status === 'failed' ? '建议修正正文中与世界设定冲突的内容' : undefined
  }
}

// —— consistencyCheckTimeline：时间线一致性（数字/ISO 归一比较，逆序→warning，不可解析→passed 不误报） ——
// events：[{time, description}]，newEvent：{time, description}
export function consistencyCheckTimeline(events, newEvent) {
  events = Array.isArray(events) ? events : []
  const issues = []
  const evidence = []
  const normalize = function (tm) {
    if (tm === undefined || tm === null) return null
    const s = String(tm).trim()
    if (!s) return null
    const n = Number(s)
    if (!isNaN(n) && String(n) === s) return n // 纯数字
    const d = new Date(s.replace(/[./]/g, '-'))
    if (!isNaN(d.getTime()) && /^\d{4}/.test(s)) return d.getTime() // ISO/日期
    return null
  }
  const newTime = normalize(newEvent && newEvent.time)
  evidence.push('事件时间: ' + String((newEvent && newEvent.time) || ''))
  if (newTime === null) {
    return {
      checkId: 'time_' + Math.random().toString(36).substr(2, 9),
      checkType: 'timeline',
      target: String((newEvent && newEvent.time) || ''),
      status: 'passed',
      details: '时间不可解析，跳过顺序比较',
      evidence: evidence
    }
  }
  for (const e of events) {
    const et = normalize(e && e.time)
    if (et !== null && et > newTime) {
      issues.push('时间线逆序：已有事件「' + String((e && e.description) || '') + '」时间 ' + String(e && e.time) + ' 晚于新事件 ' + String(newEvent && newEvent.time))
    }
  }
  const status = issues.length ? 'warning' : 'passed'
  return {
    checkId: 'time_' + Math.random().toString(36).substr(2, 9),
    checkType: 'timeline',
    target: String((newEvent && newEvent.time) || ''),
    status: status,
    details: issues.length ? issues.join('; ') : '时间线一致',
    evidence: evidence,
    suggestion: status === 'warning' ? '建议检查时间线顺序是否合理' : undefined
  }
}

// —— consistencyCheckLogic：逻辑一致性（facts 正向命中→supporting；contradictions 反向） ——
// facts：[{fact:'xxx', negation?:'yyy'}] 或 ['xxx']
export function consistencyCheckLogic(facts, content) {
  content = String(content || '')
  const contradictions = []
  const supporting = []
  const list = Array.isArray(facts) ? facts : []
  for (const f of list) {
    if (typeof f === 'string') {
      if (f && content.indexOf(f) >= 0) supporting.push(f)
      continue
    }
    if (f && typeof f === 'object') {
      const fact = String(f.fact || f.value || '')
      if (fact && content.indexOf(fact) >= 0) supporting.push(fact)
      const neg = String(f.negation || f.contradicts || '')
      if (neg && content.indexOf(neg) >= 0) contradictions.push('逻辑矛盾：正文出现「' + neg + '」，与事实/规则冲突')
    }
  }
  const status = contradictions.length ? 'failed' : 'passed'
  return {
    checkId: 'logic_' + Math.random().toString(36).substr(2, 9),
    checkType: 'logic',
    target: '逻辑一致性',
    status: status,
    details: contradictions.length ? contradictions.join('; ') : '逻辑一致',
    evidence: supporting,
    suggestion: status === 'failed' ? '建议修正正文中的逻辑矛盾' : undefined
  }
}

// —— consistencyBatchCheck：批量检查入口（B2-3 端点/工具复用） ——
// input: {content(必填), characters?, worldRules?, facts?, events?, newEvent?}
// characters: [{name, attributes:{appearance?, personality?, background?}}]
export function consistencyBatchCheck(input) {
  input = input || {}
  const content = String(input.content || '')
  const checks = []
  if (Array.isArray(input.characters)) {
    for (const c of input.characters) {
      checks.push(consistencyCheckCharacter(c && c.name, c && c.attributes, content))
    }
  }
  if (input.worldRules !== undefined && input.worldRules !== null) {
    checks.push(consistencyCheckWorld(input.worldRules, content))
  }
  if (Array.isArray(input.facts)) {
    checks.push(consistencyCheckLogic(input.facts, content))
  }
  if (input.newEvent !== undefined && input.newEvent !== null) {
    checks.push(consistencyCheckTimeline(Array.isArray(input.events) ? input.events : [], input.newEvent))
  }
  const passedCount = checks.filter(function (c) { return c.status === 'passed' }).length
  const failedCount = checks.filter(function (c) { return c.status === 'failed' }).length
  const warningCount = checks.filter(function (c) { return c.status === 'warning' }).length
  const summary = failedCount
    ? '发现 ' + failedCount + ' 项实锤矛盾（failed），' + warningCount + ' 项待复核（warning）'
    : (warningCount ? '未发现实锤矛盾，但有 ' + warningCount + ' 项待复核（warning）' : '一致性检查全部通过')
  return { checks: checks, summary: summary, passedCount: passedCount, failedCount: failedCount, warningCount: warningCount }
}

// —— verifyWithMultipleSources：多源表决（MultiVerificationEngine L262-293 直移） ——
// sources: [{source, verify:(text)=>boolean|Promise<boolean>}] 或 [{source, result}]（预置结果）
export async function verifyWithMultipleSources(claim, sources) {
  claim = String(claim || '')
  sources = Array.isArray(sources) ? sources : []
  const results = []
  for (const item of sources) {
    const src = String((item && item.source) || 'unknown')
    try {
      if (item && typeof item.verify === 'function') {
        const r = await item.verify(claim)
        results.push({ source: src, result: !!r })
      } else {
        results.push({ source: src, result: !!((item && item.result)) })
      }
    } catch (e) {
      results.push({ source: src, result: false })
    }
  }
  const positiveCount = results.filter(function (r) { return r.result }).length
  const consensus = results.length ? Math.round((positiveCount / results.length) * 100) / 100 : 0
  const verified = consensus >= 0.5
  return { claim: claim, verified: verified, consensus: consensus, results: results }
}

// ==================== B2-4 文风 AI 味检测引擎（style-control.ts L51-327 直移增强） ====================
// 10 条 AI 特征正则（与 style-control.ts L51-62 逐条一致，indicator 中文标签直移）
export const AI_PATTERNS_10 = [
  { pattern: /首先，其次，另外，而且，此外/g, indicator: '过度使用连接词' },
  { pattern: /值得注意的是/g, indicator: '过度使用填充词' },
  { pattern: /综上所述，总而言之/g, indicator: '过度总结' },
  { pattern: /一般来说，通常情况下/g, indicator: '过度使用概括词' },
  { pattern: /我们可以发现/g, indicator: '过度使用主语' },
  { pattern: /这是一个.{0,40}的问题/g, indicator: '过度使用句式' },
  { pattern: /不仅.{0,40}而且/g, indicator: '过度使用递进句' },
  { pattern: /如果.{0,40}那么/g, indicator: '过度使用条件句' },
  { pattern: /随着.{0,40}的发展/g, indicator: '过度使用背景句' },
  { pattern: /在.{0,40}方面/g, indicator: '过度使用介词短语' }
]

// detectAIWriting：AI 味检测（FIX-3：matchAll 位置提取；非正则型指标兜底 position={0,0}）
// → {isAI, confidence, indicators, findings, suggestions}
// confidence = min(1, matchCount*0.15)；isAI = confidence > 0.5（与源码公式一致）
export function detectAIWriting(text) {
  text = String(text || '')
  const indicators = []
  const findings = []
  let matchCount = 0
  for (const { pattern, indicator } of AI_PATTERNS_10) {
    for (const m of text.matchAll(pattern)) {
      indicators.push(indicator)
      matchCount++
      findings.push({
        type: 'style',
        category: 'ai味',
        originalText: m[0],
        position: { start: m.index, end: m.index + m[0].length },
        suggestion: getDeAISuggestionFor(indicator),
        severity: 'info',
        confidence: 'low',
        source: 'style',
        indicator: indicator,
        description: indicator + '（命中「' + m[0] + '」）'
      })
    }
  }
  // 额外 AI 特征（源码 detectAIWriting L257-269）：长句 avg>40 / 全句含逗号
  const sentences = text.split(/[。！？]/).filter(function (s) { return s.trim() })
  const avgLength = sentences.length ? sentences.reduce(function (a, s) { return a + s.length }, 0) / sentences.length : 0
  if (avgLength > 40) {
    indicators.push('句子普遍过长')
    matchCount += 0.5
    findings.push({
      type: 'style',
      category: 'ai味',
      originalText: '句子普遍过长',
      position: { start: 0, end: 0 },
      suggestion: '缩短过长的句子，增加句式变化',
      severity: 'info',
      confidence: 'medium',
      source: 'style',
      indicator: '句子普遍过长',
      description: '句子普遍过长（平均 ' + Math.round(avgLength) + ' 字）'
    })
  }
  if (sentences.length && sentences.every(function (s) { return s.indexOf(',') >= 0 || s.indexOf('，') >= 0 })) {
    indicators.push('过度使用逗号')
    matchCount += 0.5
    findings.push({
      type: 'style',
      category: 'ai味',
      originalText: '过度使用逗号',
      position: { start: 0, end: 0 },
      suggestion: '减少逗号，增加句号断句',
      severity: 'info',
      confidence: 'low',
      source: 'style',
      indicator: '过度使用逗号',
      description: '所有句子均含逗号'
    })
  }
  const confidence = Math.min(1, matchCount * 0.15)
  const isAI = confidence > 0.5
  return {
    isAI: isAI,
    confidence: Math.round(confidence * 100) / 100,
    indicators: indicators,
    findings: findings,
    suggestions: getDeAISuggestions(text)
  }
}

function getDeAISuggestionFor(indicator) {
  const map = {
    '过度使用连接词': '减少「首先/其次/另外/而且/此外」等过渡词，让叙事更自然',
    '过度使用填充词': '去除「值得注意的是」等填充词',
    '过度总结': '减少「综上所述/总而言之」式总结，直接陈述结论',
    '过度使用概括词': '去除「一般来说/通常情况下」等概括表达',
    '过度使用主语': '避免反复使用「我们可以发现」等主语引导',
    '过度使用句式': '变换「这是一个…的问题」句式',
    '过度使用递进句': '减少「不仅…而且」递进句式，增加句式多样性',
    '过度使用条件句': '减少「如果…那么」条件句式',
    '过度使用背景句': '减少「随着…的发展」背景句式',
    '过度使用介词短语': '减少「在…方面」介词短语',
    '句子普遍过长': '缩短过长的句子，增加句式变化',
    '过度使用逗号': '减少逗号，增加句号断句'
  }
  return map[indicator] || '调整句式，去除 AI 化表达'
}

// getDeAISuggestions：去 AI 化建议（style-control.ts getDeAISuggestions L287-327 直移）
export function getDeAISuggestions(text) {
  text = String(text || '')
  const suggestions = []
  const sentences = text.split(/[。！？]/).filter(function (s) { return s.trim() })
  const avgLength = sentences.length ? sentences.reduce(function (a, s) { return a + s.length }, 0) / sentences.length : 0
  if (avgLength > 35) suggestions.push('缩短过长的句子，增加句式变化')
  const transitionCount = (text.match(/首先|其次|另外|而且|此外/gi) || []).length
  if (transitionCount > sentences.length * 0.3) suggestions.push('减少过渡词使用，让叙事更自然')
  if (text.indexOf('值得注意的是') >= 0 || text.indexOf('一般来说') >= 0) suggestions.push('去除过度使用的填充词和概括句')
  const uniquePatterns = new Set()
  for (const sentence of sentences.slice(0, 10)) {
    if (sentence.indexOf('不仅') >= 0 && sentence.indexOf('而且') >= 0) uniquePatterns.add('递进')
    if (sentence.indexOf('如果') >= 0 && sentence.indexOf('那么') >= 0) uniquePatterns.add('条件')
    if (sentence.indexOf('因为') >= 0 && sentence.indexOf('所以') >= 0) uniquePatterns.add('因果')
  }
  if (uniquePatterns.size < 2) suggestions.push('增加句式多样性，避免重复使用相同句式')
  const emotionWords = ['感动', '难过', '开心', '愤怒', '惊讶', '害怕']
  if (!emotionWords.some(function (w) { return text.indexOf(w) >= 0 })) suggestions.push('增加情感表达，让文字更有感染力')
  return suggestions
}

// 4 风格预置（style-control.ts PRESET_STYLES L78-110 直移）
export const STYLE_PRESETS = {
  '网文': {
    targetStyle: '网文',
    vocabularyLevel: 'simple',
    sentenceLength: 'short',
    dialogueDensity: 'high',
    descriptionDensity: 'low',
    useTransitions: false
  },
  '传统文学': {
    targetStyle: '传统文学',
    vocabularyLevel: 'complex',
    sentenceLength: 'long',
    dialogueDensity: 'medium',
    descriptionDensity: 'high',
    useTransitions: true,
    useInnerThought: true
  },
  '剧本': {
    targetStyle: '剧本',
    vocabularyLevel: 'moderate',
    sentenceLength: 'short',
    dialogueDensity: 'high',
    descriptionDensity: 'low',
    useTransitions: false,
    useInnerThought: false
  },
  '轻小说': {
    targetStyle: '轻小说',
    vocabularyLevel: 'simple',
    sentenceLength: 'varied',
    dialogueDensity: 'high',
    descriptionDensity: 'medium',
    useTransitions: false,
    useInnerThought: true
  }
}

export function getPresetStyles() {
  return Object.keys(STYLE_PRESETS)
}

// applyStyleTransformation：应用风格转换（返回建议，实际转换由 LLM 完成）
export function applyStyleTransformation(text, targetStyle) {
  const preset = STYLE_PRESETS[String(targetStyle || '')] || {}
  const suggestions = []
  if (preset.vocabularyLevel === 'simple') suggestions.push('简化词汇，使用更直白的表达')
  else if (preset.vocabularyLevel === 'complex') suggestions.push('丰富词汇，使用更有文采的表达')
  if (preset.sentenceLength === 'short') suggestions.push('使用短句，增加节奏感')
  else if (preset.sentenceLength === 'long') suggestions.push('使用长句，丰富描写')
  if (preset.dialogueDensity === 'high') suggestions.push('增加对话描写')
  else if (preset.dialogueDensity === 'low') suggestions.push('减少对话，增加叙述')
  if (preset.useTransitions === false) suggestions.push('减少过渡词，让叙事更流畅')
  return { transformed: String(text || ''), suggestions: suggestions, targetStyle: String(targetStyle || '') }
}

// ==================== P1-1 文本分析规则引擎（textAnalyzer.js L100-227 源码直移） ====================
// 4 维：结构 analyzeTextStructure（L100-122 + calculateHierarchy L124-131）
//       情感 analyzeTextSentiment（L133-167）
//       意图 analyzeTextIntent（L169-204 + extractKeyElements L187-204）
//       节奏 analyzeTextRhythm（L206-227，源函数名 analyzePacing）
// 阈值/词表/正则逐字照搬，禁等价改写（审查约束 F6 / t8 §D.3），行号注释随函数标注。

// —— 结构（源 L100-122） ——
// hasDialogue 正则逐字复制（源 L101：四引号字符类原样保留，含全角引号语义禁重写）
export function analyzeTextStructure(text) {
  text = String(text || '')
  const hasDialogue = /[""""].*?[""""]/.test(text)
  const hasDescription = text.includes('。') && text.length > 100
  const hasNarration = !hasDialogue && hasDescription

  let type = 'narration'
  if (hasDialogue && hasDescription) {
    type = 'mixed'
  } else if (hasDialogue) {
    type = 'dialogue'
  } else if (hasDescription) {
    type = 'description'
  }

  const hierarchy = calculateHierarchy(text)

  return {
    type,
    hierarchy,
    wordCount: text.length,
    paragraphCount: text.split('\n\n').filter((p) => p.trim()).length,
  }
}

// calculateHierarchy（源 L124-131：avg<50→1、<200→2、否则 3）
export function calculateHierarchy(text) {
  const paragraphs = text.split('\n\n').filter((p) => p.trim())
  const avgLength = paragraphs.length > 0 ? paragraphs.reduce((sum, p) => sum + p.length, 0) / paragraphs.length : 0

  if (avgLength < 50) return 1
  if (avgLength < 200) return 2
  return 3
}

// —— 情感（源 L133-167：正负词表各 10 词逐字复制、intensity 公式、tone 分支结构照搬） ——
export function analyzeTextSentiment(text) {
  text = String(text || '')
  const positiveWords = ['开心', '快乐', '幸福', '美好', '希望', '成功', '胜利', '爱', '喜欢', '感动']
  const negativeWords = ['悲伤', '痛苦', '绝望', '失败', '死亡', '恐惧', '愤怒', '讨厌', '害怕', '哭泣']

  let positiveCount = 0
  let negativeCount = 0

  positiveWords.forEach((word) => {
    const regex = new RegExp(word, 'g')
    const matches = text.match(regex)
    if (matches) positiveCount += matches.length
  })

  negativeWords.forEach((word) => {
    const regex = new RegExp(word, 'g')
    const matches = text.match(regex)
    if (matches) negativeCount += matches.length
  })

  const total = positiveCount + negativeCount
  const intensity = total > 0 ? Math.min(total / (text.length / 100), 1) : 0

  let tone = 'neutral'
  if (positiveCount > negativeCount * 1.5) tone = 'positive'
  else if (negativeCount > positiveCount * 1.5) tone = 'negative'
  else if (positiveCount > negativeCount) tone = 'positive'
  else if (negativeCount > positiveCount) tone = 'negative'

  return {
    tone,
    intensity,
    positiveCount,
    negativeCount,
  }
}

// —— 意图（源 L169-204：冲突/解决/开始词 → conflict/resolution/setup/transition） ——
export function analyzeTextIntent(text) {
  text = String(text || '')
  const hasConflictWords = /冲突|战斗|争论|对抗|危机/.test(text)
  const hasResolutionWords = /解决|和解|结束|完成|胜利/.test(text)
  const hasSetupWords = /开始|出现|发现|遇到/.test(text)

  let type = 'transition'
  if (hasConflictWords) type = 'conflict'
  else if (hasResolutionWords) type = 'resolution'
  else if (hasSetupWords) type = 'setup'

  const keyElements = extractKeyElements(text)

  return {
    type,
    keyElements,
  }
}

// extractKeyElements（源 L187-204）
export function extractKeyElements(text) {
  text = String(text || '')
  const elements = []
  const characterMatches = text.match(/[他她它]说/g)
  if (characterMatches) {
    elements.push(`对话场景: ${characterMatches.length}处对话`)
  }

  const locationMatches = text.match(/在.*?[的地上房间里]/g)
  if (locationMatches) {
    elements.push(`场景描写: 包含环境描写`)
  }

  if (elements.length === 0) {
    elements.push('叙述性内容')
  }

  return elements
}

// —— 节奏（源 analyzePacing L206-227：句均长 → speed、逗号密度 → density） ——
export function analyzeTextRhythm(text) {
  text = String(text || '')
  const sentences = text.split(/[。！？!?]+/).filter((s) => s.trim())
  const avgSentenceLength =
    sentences.length > 0 ? sentences.reduce((sum, s) => sum + s.length, 0) / sentences.length : 0

  let speed = 'medium'
  let density = 'medium'

  if (avgSentenceLength < 15) speed = 'fast'
  else if (avgSentenceLength > 30) speed = 'slow'

  const commaCount = (text.match(/，/g) || []).length
  if (commaCount > sentences.length * 2) density = 'high'
  else if (commaCount < sentences.length) density = 'low'

  return {
    speed,
    density,
    avgSentenceLength: Math.round(avgSentenceLength),
    sentenceCount: sentences.length,
  }
}

// 入口：analyzeText({text?}) → {structure, sentiment, intent, pacing}（P1-1 /analyze 四维）
export function analyzeText(input) {
  const text = String((input && input.text) || '')
  return {
    structure: analyzeTextStructure(text),
    sentiment: analyzeTextSentiment(text),
    intent: analyzeTextIntent(text),
    pacing: analyzeTextRhythm(text),
  }
}

// ==================== P1-2 写作建议生成（suggestionGenerator.js L92-272 源码直移） ====================
// 8 类 taxonomy 与第二批 B2-2 面板分组一致：
//   writing_tip / pacing_note / transition / tension_point / word_replace / sentence_optimize / detail_enhance / redundancy_fix
// 其中 6 类直移源 generate* 函数（L118-272）；tension_point/redundancy_fix 为 includeCrossEngine 附加
// （additive：跨引擎从断章引擎/文风引擎派生，默认 false 保源语义——审查约束 t2 确认）

// generateWritingTips（源 L118-152）
export function generateWritingTips(text, analysis) {
  const tips = []
  text = String(text || '')
  analysis = analysis || {}
  const pacing = analysis.pacing || {}

  if (pacing.speed === 'fast') {
    tips.push({
      id: 'tip_fast_pace',
      type: 'writing_tip',
      content: '当前节奏较快，可以适当增加一些描述性细节，让读者有时间消化情节',
      reasoning: '快速节奏适合动作场景，但长时间快节奏可能让读者疲劳',
      confidence: 0.7,
    })
  } else if (pacing.speed === 'slow') {
    tips.push({
      id: 'tip_slow_pace',
      type: 'writing_tip',
      content: '当前节奏较慢，可以考虑增加一些对话或动作来提升节奏',
      reasoning: '慢节奏适合铺垫和情感描写，但需要避免过于拖沓',
      confidence: 0.7,
    })
  }

  const wordCount = text.length
  if (wordCount > 0 && wordCount < 500) {
    tips.push({
      id: 'tip_short_text',
      type: 'writing_tip',
      content: '当前内容较短，可以考虑扩展更多细节来丰富场景',
      reasoning: '丰富的细节能让读者更好地代入情境',
      confidence: 0.6,
    })
  }

  return tips
}

// generatePacingNotes（源 L154-179）
export function generatePacingNotes(text, analysis) {
  const notes = []
  text = String(text || '')
  const wordCount = text.length

  if (wordCount > 0) {
    if (wordCount < 500) {
      notes.push({
        id: 'pacing_short',
        type: 'pacing_note',
        content: '当前段落较短，可以考虑扩展内容或加入更多细节',
        reasoning: '短段落节奏快，但可能缺乏深度',
        confidence: 0.6,
      })
    } else if (wordCount > 2000) {
      notes.push({
        id: 'pacing_long',
        type: 'pacing_note',
        content: '当前段落较长，可以考虑拆分成多个小段以改善阅读体验',
        reasoning: '过长的段落可能让读者感到疲劳',
        confidence: 0.7,
      })
    }
  }

  return notes
}

// generateTransitions（源 L181-196）
export function generateTransitions(text, analysis) {
  const transitions = []
  text = String(text || '')
  analysis = analysis || {}
  const structure = analysis.structure || {}

  if (structure.type === 'scene') {
    transitions.push({
      id: 'transition_scene',
      type: 'transition',
      content: '当前是场景描写，可以考虑在结束时加入对下一场景的预示',
      reasoning: '好的场景过渡能保持读者的阅读兴趣',
      confidence: 0.6,
    })
  }

  return transitions
}

// generateWordReplacements（源 L198-226，5 组词表逐字照搬）
export function generateWordReplacements(text) {
  const replacements = []
  text = String(text || '')
  const commonWords = [
    { original: '非常', suggestion: '极其、格外、分外、特别', position: -1 },
    { original: '很', suggestion: '挺、相当、颇、十分', position: -1 },
    { original: '说', suggestion: '道、讲、开口、说道', position: -1 },
    { original: '看', suggestion: '望、瞧、注视、凝视', position: -1 },
    { original: '想', suggestion: '思索、寻思、暗想、考虑', position: -1 },
  ]

  for (let i = 0; i < commonWords.length; i++) {
    const item = commonWords[i]
    if (text.includes(item.original)) {
      replacements.push({
        id: 'word_replace_' + i,
        type: 'word_replace',
        content: `"${item.original}" 可以考虑替换为 ${item.suggestion}`,
        reasoning: '丰富词汇能让文字更生动',
        confidence: 0.5,
        actionable: {
          originalText: item.original,
          suggestedText: item.suggestion.split('、')[0],
        },
      })
    }
  }

  return replacements
}

// generateSentenceOptimizations（源 L228-245）
export function generateSentenceOptimizations(text) {
  const optimizations = []
  text = String(text || '')

  if (text.length > 0) {
    const firstChar = text.charAt(0)
    if (firstChar === '他' || firstChar === '她') {
      optimizations.push({
        id: 'sentence_optimize_pronoun_start',
        type: 'sentence_optimize',
        content: '段落以人称代词开头是可以的，但要避免连续多个段落都这样',
        reasoning: '适当变换句首能让行文更多样',
        confidence: 0.5,
      })
    }
  }

  return optimizations
}

// generateDetailEnhancements（源 L247-272）
export function generateDetailEnhancements(text, analysis) {
  const enhancements = []
  text = String(text || '')
  analysis = analysis || {}

  if (text.length > 0) {
    enhancements.push({
      id: 'detail_enhance_sense',
      type: 'detail_enhance',
      content: '可以考虑加入感官描写（视觉、听觉、嗅觉、触觉、味觉）来丰富场景',
      reasoning: '多感官描写能增强读者的代入感',
      confidence: 0.6,
    })
  }

  const structure = analysis.structure || {}
  if (structure.type === 'narration') {
    enhancements.push({
      id: 'detail_enhance_narration',
      type: 'detail_enhance',
      content: '当前是叙述部分，可以考虑加入一些环境描写或人物心理活动',
      reasoning: '叙述容易显得平淡，适当的细节描写能让场景更生动',
      confidence: 0.65,
    })
  }

  return enhancements
}

// 跨引擎附加（includeCrossEngine，additive）：tension_point ← 断章引擎、redundancy_fix ← 文风引擎
// （与第二批 B2-2 classifySuggestion 映射一致：breakpoints→tension_point、style AI味→redundancy_fix）
export function generateCrossEngineSuggestions(text) {
  const out = []
  text = String(text || '')
  // tension_point：断章引擎候选断章点即张力点
  try {
    const breaks = analyzeChapterBreaks({ text: text }).breaks || []
    breaks.slice(0, 5).forEach(function (b, i) {
      out.push({
        id: 'tension_point_' + i,
        type: 'tension_point',
        content: '检测到候选张力点（' + (b.type || 'suspense') + '）：' + (b.suggestion || '可在该位置强化悬念'),
        reasoning: '断章特征（' + (b.reasoning || '') + '）提示此处可制造张力',
        confidence: b.confidence || 0.5,
      })
    })
  } catch (e) {}
  // redundancy_fix：文风引擎 AI 味命中时给出去 AI 化建议
  try {
    const det = detectAIWriting(text)
    if (det.isAI) {
      ;(det.suggestions || []).slice(0, 5).forEach(function (s, i) {
        out.push({
          id: 'redundancy_fix_' + i,
          type: 'redundancy_fix',
          content: s,
          reasoning: '文风检测判定存在 AI 味（confidence=' + det.confidence + '）',
          confidence: 0.5,
        })
      })
    }
  } catch (e) {}
  return out
}

// 入口：generateSuggestions({text?, analysis?, types?, includeCrossEngine?})
// types 默认 ['writing_tip','pacing_note','transition']（源 L26）；includeCrossEngine 默认 false（保源语义）
export function generateSuggestions(input) {
  input = input || {}
  const text = String(input.text || '')
  const analysis = input.analysis && typeof input.analysis === 'object' ? input.analysis : {}
  const types = Array.isArray(input.types) ? input.types : ['writing_tip', 'pacing_note', 'transition']
  const includeCrossEngine = input.includeCrossEngine === true
  const suggestions = []

  if (types.includes('writing_tip')) {
    suggestions.push(...generateWritingTips(text, analysis))
  }
  if (types.includes('pacing_note')) {
    suggestions.push(...generatePacingNotes(text, analysis))
  }
  if (types.includes('transition')) {
    suggestions.push(...generateTransitions(text, analysis))
  }
  if (types.includes('word_replace')) {
    suggestions.push(...generateWordReplacements(text))
  }
  if (types.includes('sentence_optimize')) {
    suggestions.push(...generateSentenceOptimizations(text))
  }
  if (types.includes('detail_enhance')) {
    suggestions.push(...generateDetailEnhancements(text, analysis))
  }
  if (includeCrossEngine) {
    suggestions.push(...generateCrossEngineSuggestions(text))
  }

  return {
    suggestions: suggestions,
    totalCount: suggestions.length,
    types: types,
    summary: '使用本地规则生成建议',
  }
}

// ==================== P1-3 结构设计规则（structureDesigner.js L82-169 源码直移） ====================
// determineChapterPosition（源 L113-120：阈值 0.2/0.7/0.9/1.0 逐字照搬，审查约束 F6；
//   源函数名 determinePosition，此处语义等价重命名，t4 用 chapters=5 断言 position 分布）
export function determineChapterPosition(index, total) {
  const ratio = index / total
  if (ratio < 0.2) return 'opening'
  if (ratio < 0.7) return 'rising'
  if (ratio < 0.9) return 'climax'
  if (ratio < 1.0) return 'falling'
  return 'ending'
}

// generateChapterSuggestions（源 L90-111：Math.max(3,count)、wordTarget 1500/2500/4000）
export function generateChapterSuggestions(existingChapters) {
  const suggestions = []
  existingChapters = Array.isArray(existingChapters) ? existingChapters : []
  const chapterCount = existingChapters.length

  for (let i = 0; i < Math.max(3, chapterCount); i++) {
    const position = determineChapterPosition(i, Math.max(3, chapterCount))

    suggestions.push({
      index: i,
      wordTarget: {
        min: 1500,
        ideal: 2500,
        max: 4000,
      },
      position: position,
      title: `第${i + 1}章建议`,
      suggestedBreakpoint: generateBreakpointSuggestion(i, position),
    })
  }

  return suggestions
}

// generateBreakpointSuggestion（源 L122-147：breakpointTypes + hooks 逐字照搬，position 固定 0.8）
export function generateBreakpointSuggestion(index, position) {
  const breakpointTypes = {
    opening: 'setup',
    rising: 'suspense',
    climax: 'crisis',
    falling: 'decision',
    ending: 'resolution',
  }

  const hooks = {
    setup: '在章节结尾引入新的谜团或问题',
    suspense: '制造悬念，让读者猜测接下来会发生什么',
    crisis: '让角色陷入两难的困境',
    decision: '让角色做出关键抉择',
    reversal: '出现意想不到的反转',
    resolution: '为下一个故事线埋下伏笔',
  }

  const type = breakpointTypes[position] || 'suspense'

  return {
    type: type,
    position: 0.8,
    hookSuggestion: hooks[type] || '在章节结尾设置悬念',
  }
}

// generatePacingPlan（源 L149-169：ratio 阈值 0.2/0.5/0.8 逐字照搬）
export function generatePacingPlan(existingChapters) {
  const plan = []
  existingChapters = Array.isArray(existingChapters) ? existingChapters : []
  const total = Math.max(3, existingChapters.length)

  for (let i = 0; i < total; i++) {
    const ratio = i / total
    let targetSpeed = 'medium'

    if (ratio < 0.2) targetSpeed = 'slow'
    else if (ratio < 0.5) targetSpeed = 'medium'
    else if (ratio < 0.8) targetSpeed = 'fast'
    else targetSpeed = 'slow'

    plan.push({
      chapterIndex: i,
      targetSpeed: targetSpeed,
    })
  }

  return plan
}

// 入口：designStructure({chapters?}) → {chapters, pacingPlan, summary}（P1-3 /structure）
export function designStructure(input) {
  input = input || {}
  const existingChapters = Array.isArray(input.chapters) ? input.chapters : []
  return {
    chapters: generateChapterSuggestions(existingChapters),
    pacingPlan: generatePacingPlan(existingChapters),
    summary: '使用本地规则进行结构分析（网络连接受限）',
  }
}

// ==================== P1-4 知识检索（knowledgeRetriever.js L153-188 直移 + knowledge-base 检索编排） ====================
// scoreKnowledge ← 源 calculateRelevance L153-188（唯一打分来源：/search 不跨 HTTP 返回 score——审查约束 F2）
export function scoreKnowledge(item, query) {
  item = item || {}
  if (!query) {
    return 0.5
  }

  let score = 0
  const lowerQuery = String(query).toLowerCase()
  const title = String(item.title || '').toLowerCase()
  const content = String(item.content || '').toLowerCase()
  const name = String(item.name || '').toLowerCase()

  if (title.includes(lowerQuery) || name.includes(lowerQuery)) {
    score += 0.5
  }

  if (content.includes(lowerQuery)) {
    score += 0.3
  }

  const queryWords = lowerQuery.split(/\s+/).filter(function (w) {
    return w.length > 0
  })
  let matchCount = 0
  for (let i = 0; i < queryWords.length; i++) {
    const word = queryWords[i]
    if (title.includes(word) || content.includes(word) || name.includes(word)) {
      matchCount += 1
    }
  }

  if (queryWords.length > 0) {
    score += (matchCount / queryWords.length) * 0.2
  }

  return Math.max(0, Math.min(1, score))
}

// knowledgeTypeOf：创作域类型识别（category 主表 + extra.分类细分 + tags/aliases/title 兜底 + other 兜底——审查约束 F3 / t8 §B.3）
// DSH 侧以 tags 为主、category 为辅（先 category 粗筛 → 再 tags 细分）
export const KNOWLEDGE_CATEGORY_CANDIDATES = {
  '创作技法': ['character', 'setting', 'worldview', 'event'],
  '创作设定': ['setting', 'worldview'],
  '创作': ['character', 'setting', 'worldview', 'event'],
  '创作资料': ['character', 'setting', 'worldview', 'event'],
  '灵感': ['character', 'setting', 'worldview', 'event'],
  '技术文档': ['other'],
  '方法论': ['other'],
  '踩坑经验·插件开发': ['other'],
  '踩坑经验·写作': ['other'],
}

export const KNOWLEDGE_TYPE_KEYWORDS = [
  { type: 'character', re: /人设|角色|人物|主角|配角|性格/ },
  { type: 'worldview', re: /世界观|力量体系|世界规则/ },
  { type: 'event', re: /桥段|事件|情节|剧情|冲突|转折/ },
  { type: 'setting', re: /设定|场景|环境|地点/ },
]

export function knowledgeTypeOf(entry) {
  entry = entry || {}
  // 1) extra.分类 细分（创作技法 739 条实测：人设21/设定105/桥段109/场景4/角色3/人物3）
  const extraCat = String((entry.extra && (entry.extra['分类'] || entry.extra['category'])) || '')
  if (extraCat) {
    if (/人设|角色|人物|主角|配角/.test(extraCat)) return 'character'
    if (/桥段|事件|情节/.test(extraCat)) return 'event'
    if (/设定|场景|环境/.test(extraCat)) return 'setting'
    if (/世界观|世界/.test(extraCat)) return 'worldview'
  }
  // 2) category 粗筛（实测 9 类全入表）
  const candidates = KNOWLEDGE_CATEGORY_CANDIDATES[String(entry.category || '')] || ['other']
  // 3) tags/aliases/title 细分（tags 为「空格连接单字符串」数组，保留 /[\s,，]/ 拆分语义）
  const tagText = (Array.isArray(entry.tags) ? entry.tags : []).join(' ') + ' ' +
    (Array.isArray(entry.aliases) ? entry.aliases : []).join(' ') + ' ' +
    String(entry.title || '')
  for (const item of KNOWLEDGE_TYPE_KEYWORDS) {
    if (item.re.test(tagText)) {
      if (candidates.indexOf(item.type) >= 0) return item.type
      return candidates[0]
    }
  }
  return candidates[0]
}

// retrieveKnowledgeLocal：本地过滤（多类型 + projectScope）+ 重打分 + 排序 + slice（P1-4 /retrieve 纯函数层）
// opts: {query?, types?[], limit?(默认20 cap50), projectScope?}
// projectScope 弱约束：KB 无 project 字段（基线实测），按 title/description/content/sourcePath 包含匹配
// query 过滤：score>0 等价源 L98-103 include 语义（score 不跨 HTTP，本地重打分是必需——审查约束 F2）
export function retrieveKnowledgeLocal(entries, opts) {
  opts = opts || {}
  const query = String(opts.query || '').trim()
  const types = Array.isArray(opts.types) && opts.types.length ? opts.types.map(String) : null
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 20))
  const projectScope = String(opts.projectScope || '').trim()
  let items = Array.isArray(entries) ? entries : []

  // 多类型过滤（character/setting/worldview/event/other，源 allowedTypes 同构）
  if (types && types.length) {
    items = items.filter(function (e) { return types.indexOf(knowledgeTypeOf(e)) >= 0 })
  }
  // projectScope 弱约束
  if (projectScope) {
    const ps = projectScope.toLowerCase()
    items = items.filter(function (e) {
      return String(e.title + ' ' + (e.description || '') + ' ' + (e.content || '') + ' ' + (e.sourcePath || '')).toLowerCase().indexOf(ps) >= 0
    })
  }

  const scored = items.map(function (e) {
    return { id: e.id, type: knowledgeTypeOf(e), title: e.title, content: String(e.content || ''), relevance: scoreKnowledge(e, query) }
  })
  // 本地查询过滤（query 命中过滤）
  const matched = query ? scored.filter(function (s) { return s.relevance > 0 }) : scored
  matched.sort(function (a, b) { return b.relevance - a.relevance })
  const sliced = matched.slice(0, limit)
  return {
    items: sliced,
    totalCount: matched.length,
    summary: matched.length ? '找到 ' + matched.length + ' 个相关知识库条目' : '未找到相关知识库条目',
  }
}

// ==================== 方向 B · B1 文档导入语义分析（additive，2026-08-30） ====================
// analyzeDocument({title?, content, sourcePath?}) → 语义分析 + 建议导入字段（喂既有 knowledge-base /import）
// 复用既有引擎：knowledgeTypeOf（类型识别）/ analyzeTextStructure / analyzeTextSentiment /
// analyzeTextIntent（含 extractKeyElements）/ analyzeTextRhythm —— 全部签名不动，本函数纯组合。
// 注：knowledgeTypeOf 的 category 主表依赖 KB 既有分类（空 category → candidates=['other']，关键词细分被压回 other），
//     对「原始文档」直接用同一关键词表（KNOWLEDGE_TYPE_KEYWORDS）推导类型，避免人设文档被误判 other。
const DOC_KIND_CATEGORY = { character: '创作设定', setting: '创作设定', worldview: '创作设定', event: '创作设定', other: '文档' }

function docKindOf(input) {
  const text = String(input.title || '') + ' ' + String(input.sourcePath || '') + ' ' + String(input.content || '')
  for (const item of KNOWLEDGE_TYPE_KEYWORDS) {
    if (item.re.test(text)) return item.type
  }
  return 'other'
}

export function analyzeDocument(input) {
  input = input || {}
  const title = String(input.title || '')
  const content = String(input.content || '')
  const sourcePath = String(input.sourcePath || '')
  const kind = docKindOf(input)
  const structure = analyzeTextStructure(content)
  const sentiment = analyzeTextSentiment(content)
  const intent = analyzeTextIntent(content)
  const pacing = analyzeTextRhythm(content)
  const keyElements = Array.isArray(intent.keyElements) ? intent.keyElements : []
  const suggestedCategory = DOC_KIND_CATEGORY[kind] || '文档'
  const suggestedTags = ['文档导入']
  if (kind && kind !== 'other' && suggestedTags.indexOf(kind) < 0) suggestedTags.push(kind)
  if (structure && structure.type && suggestedTags.indexOf(structure.type) < 0) suggestedTags.push(structure.type)
  if (intent && intent.type && suggestedTags.indexOf(intent.type) < 0) suggestedTags.push(intent.type)
  if (pacing && pacing.speed) {
    const pt = '节奏' + pacing.speed
    if (suggestedTags.indexOf(pt) < 0) suggestedTags.push(pt)
  }
  keyElements.forEach(function (s) {
    const t = String(s || '').split(':')[0].trim()
    if (t && suggestedTags.indexOf(t) < 0) suggestedTags.push(t)
  })
  const suggestedAliases = []
  if (title) suggestedAliases.push(title)
  const base = String(sourcePath || '').split(/[\\/]/).pop() || ''
  if (base) suggestedAliases.push(base.replace(/\.[^.]+$/, ''))
  const summary = content.length > 600 ? content.slice(0, 600) + '\n…(全文见 sourcePath)' : content
  return {
    kind: kind,
    structure: structure,
    sentiment: sentiment,
    intent: intent,
    pacing: pacing,
    keyElements: keyElements,
    summary: summary,
    suggestedCategory: suggestedCategory,
    suggestedTags: suggestedTags.slice(0, 8),
    suggestedAliases: suggestedAliases.slice(0, 3),
    engine: 'local'
  }
}

// ==================== 方向 B · B2 审查结果一键修复（additive，2026-08-30） ====================
// applyReviewFixes(text, findings)：按 position.start 升序批量应用修复
// 跳过无 suggestion / 无 position / 与已应用区间重叠 / 原文已漂移 的条目；维护 offset 修正。
// findings 四段式（reviewText/normalizeAiFindings 既有 schema）：{position:{start,end}, originalText, suggestion}
export function applyReviewFixes(text, findings) {
  text = String(text || '')
  const list = Array.isArray(findings) ? findings : []
  const items = []
  const skipped = []
  for (let i = 0; i < list.length; i++) {
    const f = list[i] || {}
    const pos = f.position
    let start = -1
    let end = -1
    if (typeof pos === 'number') { start = pos; end = pos + String(f.originalText || '').length }
    else if (pos && typeof pos === 'object' && typeof pos.start === 'number') {
      start = pos.start
      end = typeof pos.end === 'number' ? pos.end : start + String(f.originalText || '').length
    }
    const orig = String(f.originalText || '')
    const sugg = String(f.suggestion || '')
    if (start < 0 || end < start) { skipped.push({ index: i, reason: '无有效 position' }); continue }
    if (!orig) { skipped.push({ index: i, reason: '无 originalText' }); continue }
    if (!sugg) { skipped.push({ index: i, reason: '无 suggestion' }); continue }
    items.push({ index: i, start: start, end: end, orig: orig, sugg: sugg })
  }
  items.sort(function (a, b) { return a.start - b.start || a.end - b.end })
  let out = text
  let offset = 0
  let lastAppliedEnd = -1
  const applied = []
  for (const it of items) {
    const adjStart = it.start + offset
    const adjEnd = it.end + offset
    if (adjStart < lastAppliedEnd) { skipped.push({ index: it.index, reason: '与已应用修复区间重叠' }); continue }
    if (out.slice(adjStart, adjEnd) !== it.orig) { skipped.push({ index: it.index, reason: '原文不匹配（位置漂移）' }); continue }
    out = out.slice(0, adjStart) + it.sugg + out.slice(adjEnd)
    applied.push({ index: it.index, originalText: it.orig, suggestion: it.sugg, position: { start: adjStart, end: adjStart + it.sugg.length } })
    offset += it.sugg.length - (adjEnd - adjStart)
    lastAppliedEnd = adjStart + it.sugg.length
  }
  return {
    text: out,
    applied: applied,
    skipped: skipped,
    summary: applied.length
      ? '已应用 ' + applied.length + ' 处修复' + (skipped.length ? '（跳过 ' + skipped.length + ' 处）' : '')
      : (skipped.length ? '未应用修复（跳过 ' + skipped.length + ' 处）' : '无可修复项')
  }
}

// ==================== 方向 B · B3 章节连续性 6 维检测（additive，2026-08-30） ====================
// 新 2 维纯函数：consistencyCheckScene（相邻块场景连续性）+ consistencyCheckDetail（细节回呼一致性）
// 入口 continuity6DCheck 组合既有 4 检查器（consistencyCheckCharacter/World/Timeline/Logic 原函数不动）+ 新 2 维。
const SCENE_LOCATION_WORDS = ['房间', '客厅', '卧室', '厨房', '书房', '走廊', '楼梯', '门口', '院子', '花园', '街道', '广场', '公园', '森林', '河边', '海边', '山顶', '山脚', '村', '镇', '城', '皇宫', '宫殿', '军营', '马车', '船舱', '酒楼', '茶馆', '客栈', '桥', '树下', '崖边']
const SCENE_TIME_WORDS = ['清晨', '早晨', '上午', '中午', '下午', '傍晚', '黄昏', '晚上', '夜晚', '深夜', '凌晨', '第二天', '次日', '翌日', '当晚', '当天', '三日后', '数日后', '一周后', '一个月后', '一年后', '十年后']
const SCENE_TRANSITION_WORDS = ['转身', '离开', '来到', '走进', '走出', '前往', '回到', '赶往', '奔向', '穿过', '经过', '抵达', '到达', '推开', '打开', '出了', '进了', '上楼', '下楼', '出发', '启程']

function sceneWordHits(words, content) {
  const hits = []
  for (const w of words) { if (content.indexOf(w) >= 0) hits.push(w) }
  return hits
}

export function consistencyCheckScene(blocks) {
  blocks = Array.isArray(blocks) ? blocks : []
  const issues = []
  const evidence = []
  let worst = 'passed'
  for (let i = 0; i < blocks.length - 1; i++) {
    const cur = String((blocks[i] && blocks[i].content) || '')
    const next = String((blocks[i + 1] && blocks[i + 1].content) || '')
    if (!cur.trim() || !next.trim()) continue
    const labelA = analyzeBlockPacingSingle(cur).sceneType
    const labelB = analyzeBlockPacingSingle(next).sceneType
    const hardSwitch = (labelA === 'action' && labelB === 'description') || (labelA === 'description' && labelB === 'action')
    const dialogueSwitch = (labelA === 'dialogue' && labelB === 'action') || (labelA === 'action' && labelB === 'dialogue')
    const hasTransition = SCENE_TRANSITION_WORDS.some(function (w) { return cur.indexOf(w) >= 0 || next.indexOf(w) >= 0 })
    if ((hardSwitch || dialogueSwitch) && !hasTransition) {
      issues.push('第 ' + (i + 1) + '→' + (i + 2) + ' 块场景类型突变（' + labelA + '→' + labelB + '），缺少过渡描写')
      if (worst === 'passed') worst = 'warning'
    }
    const locA = sceneWordHits(SCENE_LOCATION_WORDS, cur)
    const locB = sceneWordHits(SCENE_LOCATION_WORDS, next)
    if (locA.length && locB.length) {
      const lastA = locA[locA.length - 1]
      const lastB = locB[locB.length - 1]
      if (lastA !== lastB && !hasTransition) {
        issues.push('第 ' + (i + 1) + '→' + (i + 2) + ' 块地点突变（' + lastA + '→' + lastB + '），缺少过渡')
        if (worst === 'passed') worst = 'warning'
      }
    }
    const timeA = sceneWordHits(SCENE_TIME_WORDS, cur)
    const timeB = sceneWordHits(SCENE_TIME_WORDS, next)
    if (timeA.length && timeB.length && timeA[timeA.length - 1] !== timeB[timeB.length - 1]) {
      issues.push('第 ' + (i + 1) + '→' + (i + 2) + ' 块时间跳跃（' + timeA[timeA.length - 1] + '→' + timeB[timeB.length - 1] + '）')
      if (worst === 'passed') worst = 'warning'
    }
  }
  if (!blocks.length) {
    return {
      checkId: 'scene_' + Math.random().toString(36).substr(2, 9),
      checkType: 'scene',
      target: '场景连续性',
      status: 'passed',
      details: '无文本块可检查',
      evidence: evidence
    }
  }
  return {
    checkId: 'scene_' + Math.random().toString(36).substr(2, 9),
    checkType: 'scene',
    target: '场景连续性',
    status: worst,
    details: issues.length ? issues.join('; ') : '相邻场景衔接一致',
    evidence: evidence,
    suggestion: worst === 'warning' ? '建议在场景切换处补充过渡描写（地点/时间/动作衔接）' : undefined
  }
}

// consistencyCheckDetail(content, detailFacts)：道具/称呼/数字回呼一致性
// detailFacts: [{fact, occurrences?(默认1), negation?}] —— 正文缺回呼(<occurrences)→warning；出现 negation 内容→failed
export function consistencyCheckDetail(content, detailFacts) {
  content = String(content || '')
  const list = Array.isArray(detailFacts) ? detailFacts : []
  const issues = []
  const evidence = []
  let worst = 'passed'
  for (const d of list) {
    if (!d || typeof d !== 'object') continue
    const fact = String(d.fact || '')
    if (!fact) continue
    const expected = Math.max(1, Number(d.occurrences) || 1)
    const neg = String(d.negation || '')
    const re = new RegExp(escapeRe(fact), 'g')
    const count = (content.match(re) || []).length
    if (neg && content.indexOf(neg) >= 0) {
      issues.push('细节矛盾：正文出现「' + neg + '」，与设定「' + fact + '」冲突')
      worst = 'failed'
    } else if (count < expected) {
      issues.push('细节回呼缺失：设定「' + fact + '」应出现≥' + expected + ' 次，正文仅 ' + count + ' 次')
      if (worst !== 'failed') worst = 'warning'
    } else {
      evidence.push('细节回呼完整：' + fact + '（' + count + ' 次）')
    }
  }
  return {
    checkId: 'detail_' + Math.random().toString(36).substr(2, 9),
    checkType: 'detail',
    target: '细节一致性',
    status: worst,
    details: issues.length ? issues.join('; ') : (list.length ? '道具/称呼/数字回呼一致' : '未提供 detailFacts，跳过'),
    evidence: evidence,
    suggestion: worst === 'failed' ? '建议修正正文中的细节矛盾' : (worst === 'warning' ? '建议补充缺失的细节回呼' : undefined)
  }
}

// continuity6DCheck(input)：6 维连续性入口 = 既有 4 维（角色/世界观/时间线/逻辑）+ 新 2 维（场景/细节）
// input: {content(必填), characters?, worldRules?, facts?, events?, newEvent?, blocks?, detailFacts?}
// 输出与 consistencyBatchCheck 同构：{checks(6 类), summary, passedCount, failedCount, warningCount, dimensions}
export function continuity6DCheck(input) {
  input = input || {}
  const content = String(input.content || '')
  const checks = []
  if (Array.isArray(input.characters)) {
    for (const c of input.characters) {
      checks.push(consistencyCheckCharacter(c && c.name, c && c.attributes, content))
    }
  }
  if (input.worldRules !== undefined && input.worldRules !== null) {
    checks.push(consistencyCheckWorld(input.worldRules, content))
  }
  if (Array.isArray(input.facts)) {
    checks.push(consistencyCheckLogic(input.facts, content))
  }
  if (input.newEvent !== undefined && input.newEvent !== null) {
    checks.push(consistencyCheckTimeline(Array.isArray(input.events) ? input.events : [], input.newEvent))
  }
  const blocks = Array.isArray(input.blocks) ? input.blocks : normalizeBlocks({ text: content })
  checks.push(consistencyCheckScene(blocks))
  checks.push(consistencyCheckDetail(content, input.detailFacts))
  const passedCount = checks.filter(function (c) { return c.status === 'passed' }).length
  const failedCount = checks.filter(function (c) { return c.status === 'failed' }).length
  const warningCount = checks.filter(function (c) { return c.status === 'warning' }).length
  const summary = failedCount
    ? '6 维连续性检查：' + failedCount + ' 项实锤矛盾（failed），' + warningCount + ' 项待复核（warning）'
    : (warningCount ? '6 维连续性检查：未发现实锤矛盾，但有 ' + warningCount + ' 项待复核（warning）' : '6 维连续性检查全部通过')
  return { checks: checks, summary: summary, passedCount: passedCount, failedCount: failedCount, warningCount: warningCount, dimensions: 6 }
}
