export const tierTextMap: Record<string, string> = {
  IRON: '坚韧黑铁',
  BRONZE: '英勇黄铜',
  SILVER: '不屈白银',
  GOLD: '荣耀黄金',
  PLATINUM: '华贵铂金',
  EMERALD: '流光翡翠',
  DIAMOND: '璀璨钻石',
  MASTER: '超凡大师',
  GRANDMASTER: '傲世宗师',
  CHALLENGER: '最强王者'
}

export const queueTypeTextMap: Record<string, string> = {
  RANKED_SOLO_5x5: '单排 / 双排',
  RANKED_FLEX_SR: '灵活组排',
  CHERRY: '斗魂竞技场',
  RANKED_TFT: '云顶之弈',
  RANKED_TFT_TURBO: '云顶之弈 (狂暴模式)',
  RANKED_TFT_DOUBLE_UP: '云顶之弈 (双人作战)'
}

// assignmentReason: PRIMARY, SECONDARY, FILL_SECONDARY, FILL_PRIMARY, AUTO_FILL
// NONE, UNSELECTED
// TOP, MIDDLE, JUNGLE, BOTTOM, UTILITY
export function parseSelectedRole(role: string) {
  const segments = role.split('.')
  if (segments.length !== 4) {
    return {
      current: 'NONE',
      assignmentReason: 'NONE',
      primary: 'NONE',
      secondary: 'NONE'
    }
  }

  const [p1, p2, p3, p4] = segments

  return {
    current: p1,
    assignmentReason: p2,
    primary: p3,
    secondary: p4
  }
}
