// 兄弟插件清单 —— 只在本仓内使用，不 import 任何兄弟包。
// 名字与包名要和各自仓库的 package.json 一致（test/siblings.test.mjs 会在本仓核对）。
export const SIBLINGS = [
  {
    pkg: 'dsh-persona-distill',
    name: '鱼的人格',
    desc: '把每天刷到的原料蒸馏成会自己长大的人格：原料天天攒，人格每周长。',
  },
  {
    pkg: 'dsh-yu-memory',
    name: '鱼的记忆',
    desc: '全局长期记忆 + 会淡忘的对话记忆：按提问召回，反复想起的才提示提拔。',
  },
  {
    pkg: 'dsh-yu-bili',
    name: '刷B站',
    desc: '谷时刷片、写台账与手账，把说话样本和判断接进人格。',
  },
  {
    pkg: 'dsh-yu-zhihu',
    name: '刷知乎',
    desc: '只读刷推荐流与热榜，把表达样本接进人格。',
  },
  {
    pkg: 'dsh-yu-weibo',
    name: '刷微博',
    desc: '谷时读时间线或关键词搜索，把表达样本接进人格。',
  },
  {
    pkg: 'dsh-yu-mood',
    name: '鱼的心情',
    desc: '每轮判断心情涨跌，按会话分房间注入，有起伏也会自己平复。',
  },
  {
    pkg: 'dsh-yu-qq',
    name: 'QQ大肥鱼',
    desc: 'QQ 群与私信双向：点名立刻接、其余掷骰，群和私信各一间会话。',
  },
  {
    pkg: 'dsh-yu-speak',
    name: '主动说话',
    desc: '定时掷骰，命中才自己开口找你，不用你一直盯着。',
  },
]

/** 除自己之外的七个（设置页推荐用）。 */
export function otherSiblings(selfPkg) {
  const 自己 = String(selfPkg || '')
  return SIBLINGS.filter((x) => x.pkg !== 自己)
}
