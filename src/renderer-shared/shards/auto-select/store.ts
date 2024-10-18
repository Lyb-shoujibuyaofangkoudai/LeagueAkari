import { ChampSelectTeam } from '@shared/types/league-client/champ-select'
import { defineStore } from 'pinia'
import { shallowReactive, shallowRef } from 'vue'

// copied from main shard
interface UpcomingBanPick {
  championId: number
  isActingNow: boolean
  action: {
    id: number
    isInProgress: boolean
    completed: boolean
  }
}

export const useAutoSelectStore = defineStore('shard:auto-select-renderer', () => {
  const settings = shallowReactive({
    normalModeEnabled: false,
    expectedChampions: {
      top: [],
      jungle: [],
      middle: [],
      bottom: [],
      utility: [],
      default: []
    },
    selectTeammateIntendedChampion: false,
    showIntent: false,
    completed: false,
    benchModeEnabled: false,
    benchSelectFirstAvailableChampion: false,
    benchExpectedChampions: [],
    grabDelaySeconds: 1,
    banEnabled: false,
    bannedChampions: {
      top: [],
      jungle: [],
      middle: [],
      bottom: [],
      utility: [],
      default: []
    },
    banTeammateIntendedChampion: false
  })

  const upcomingPick = shallowRef<UpcomingBanPick | null>(null)
  const upcomingBan = shallowRef<UpcomingBanPick | null>(null)
  const upcomingGrab = shallowRef<{ championId: number; willGrabAt: number } | null>(null)
  const memberMe = shallowRef<ChampSelectTeam | null>(null)

  return {
    settings,

    upcomingPick,
    upcomingBan,
    upcomingGrab,
    memberMe
  }
})
