import { IAkariShardInitDispose } from '@shared/akari-shard/interface'
import { EMPTY_PUUID } from '@shared/constants/common'
import {
  MatchHistoryGamesAnalysisAll,
  MatchHistoryGamesAnalysisTeamSide,
  analyzeMatchHistory,
  analyzeTeamMatchHistory
} from '@shared/utils/analysis'
import { calculateTogetherTimes, removeOverlappingSubsets } from '@shared/utils/team-up-calc'
import _ from 'lodash'
import { comparer, computed, toJS } from 'mobx'
import PQueue from 'p-queue'

import { AkariIpcMain } from '../ipc'
import { LeagueClientMain } from '../league-client'
import { AkariLogger, LoggerFactoryMain } from '../logger-factory'
import { MobxUtilsMain } from '../mobx-utils'
import { SavedPlayerMain } from '../saved-player'
import { SettingFactoryMain } from '../setting-factory'
import { SetterSettingService } from '../setting-factory/setter-setting-service'
import { SgpMain } from '../sgp'
import { OngoingGameSettings, OngoingGameState } from './state'

/**
 * 用于游戏过程中的对局分析, 包括在此期间的战绩查询, 计算等
 */
export class OngoingGameMain implements IAkariShardInitDispose {
  static id = 'ongoing-game-main'
  static dependencies = [
    'logger-factory-main',
    'setting-factory-main',
    'league-client-main',
    'akari-ipc-main',
    'mobx-utils-main',
    'sgp-main',
    'saved-player-main'
  ]

  static LOADING_PRIORITY = {
    SUMMONER: 1,
    MATCH_HISTORY: 2,
    SAVED_INFO: 3,
    RANKED_STATS: 4,
    CHAMPION_MASTERY: 5
  }

  /**
   * 目前已知的可用队列, 这是为了避免查询不支持队列时返回为空的情况
   */
  static SAFE_TAGS = new Set([
    `q_420`,
    `q_430`,
    `q_440`,
    `q_450`, // ARAM
    `q_490`,
    `q_900`, // URF
    `q_1400`, // ULTBOOK
    `q_1700`,
    `q_1900`
  ])

  private readonly _loggerFactory: LoggerFactoryMain
  private readonly _settingFactory: SettingFactoryMain
  private readonly _log: AkariLogger
  private readonly _lc: LeagueClientMain
  private readonly _setting: SetterSettingService
  private readonly _mobx: MobxUtilsMain
  private readonly _ipc: AkariIpcMain
  private readonly _sgp: SgpMain
  private readonly _saved: SavedPlayerMain

  public readonly settings = new OngoingGameSettings()
  public readonly state: OngoingGameState

  /** 为**加载战绩**设置的特例 */
  private readonly _mhQueue = new PQueue()
  /** 为**加载战绩**设置的特例 */
  private _mhController: AbortController | null = null

  /**
   * 其他 API 的并发控制
   */
  private readonly _queue = new PQueue()
  private _controller: AbortController | null = null

  private _debouncedUpdateMatchHistoryFn = _.debounce(() => this._updateMatchHistory(), 500)

  constructor(deps: any) {
    this._loggerFactory = deps['logger-factory-main']
    this._log = this._loggerFactory.create(OngoingGameMain.id)
    this._lc = deps['league-client-main']
    this._mobx = deps['mobx-utils-main']
    this._ipc = deps['akari-ipc-main']
    this._settingFactory = deps['setting-factory-main']
    this._sgp = deps['sgp-main']
    this._saved = deps['saved-player-main']
    this._setting = this._settingFactory.create(
      OngoingGameMain.id,
      {
        concurrency: { default: this.settings.concurrency },
        enabled: { default: this.settings.enabled },
        matchHistoryLoadCount: { default: this.settings.matchHistoryLoadCount },
        premadeTeamThreshold: { default: this.settings.premadeTeamThreshold },
        matchHistoryUseSgpApi: { default: this.settings.matchHistoryUseSgpApi },
        matchHistoryTagPreference: { default: this.settings.matchHistoryTagPreference }
      },
      this.settings
    )
    this.state = new OngoingGameState(this._lc.data)
  }

  private async _handleState() {
    await this._setting.applyToState()
    this._mobx.propSync(OngoingGameMain.id, 'settings', this.settings, [
      'concurrency',
      'enabled',
      'matchHistoryLoadCount',
      'premadeTeamThreshold',
      'matchHistoryUseSgpApi',
      'matchHistoryTagPreference'
    ])
    this._mobx.propSync(OngoingGameMain.id, 'state', this.state, [
      'championSelections',
      'gameInfo',
      'positionAssignments',
      'premadeTeams',
      'queryStage',
      'teams',
      'matchHistoryTag'
    ])
  }

  async onInit() {
    await this._handleState()
    this._handlePQueue()
    this._handleLoad()
    this._handleIpcCall()
    this._handleCalculation()

    // for better control
    this._setting.onChange('matchHistoryLoadCount', async (value, { setter }) => {
      if (value >= 1 && value <= 200) {
        await setter(value)
        this._debouncedUpdateMatchHistoryFn()
      }
    })

    this._setting.onChange('matchHistoryUseSgpApi', async (value, { setter }) => {
      await setter(value)
      this._debouncedUpdateMatchHistoryFn()
    })

    this._setting.onChange('premadeTeamThreshold', async (value, { setter }) => {
      if (value >= 3) {
        await setter(value)
      }
    })
  }

  private _handlePQueue() {
    this._mhQueue.on('active', () => {
      this._log.debug(
        `更新队列: 并发=${this._mhQueue.concurrency}, 当前数量=${this._mhQueue.size}, 等待中=${this._mhQueue.pending}`
      )
    })

    this._queue.on('active', () => {
      this._log.debug(
        `更新队列: 并发=${this._mhQueue.concurrency}, 当前数量=${this._mhQueue.size}, 等待中=${this._mhQueue.pending}`
      )
    })

    this._mobx.reaction(
      () => this.settings.concurrency,
      (concurrency) => {
        this._mhQueue.concurrency = concurrency
        this._queue.concurrency = concurrency
      },
      { fireImmediately: true }
    )
  }

  private _handleLoad() {
    this._mobx.reaction(
      () => [this.state.queryStage, this.settings.enabled] as const,
      ([stage, enabled]) => {
        if (this._controller) {
          this._controller.abort()
          this._controller = null
        }

        if (this._mhController) {
          this._mhController.abort()
          this._mhController = null
        }

        this._debouncedUpdateMatchHistoryFn.cancel()

        if (stage.phase === 'unavailable' || !enabled) {
          this.state.clear()
          this.state.setMatchHistoryTag('all')
          this._ipc.sendEvent(OngoingGameMain.id, 'clear')
          return
        }

        this._controller = new AbortController()
        this._mhController = new AbortController()

        if (this.state.queryStage.phase === 'champ-select') {
          this._champSelect({
            mhSignal: this._mhController.signal,
            signal: this._controller.signal,
            force: false
          })
        } else if (this.state.queryStage.phase === 'in-game') {
          this._inGame({
            mhSignal: this._mhController.signal,
            signal: this._controller.signal,
            force: false
          })
        }
      },
      { equals: comparer.shallow }
    )
  }

  private _updateMatchHistory() {
    if (!this.settings.enabled) {
      return
    }

    if (this.state.queryStage.phase === 'unavailable') {
      return
    }

    if (this._mhController) {
      this._mhController.abort()
      this._mhController = null
    }

    const controller = new AbortController()
    this._mhController = controller

    const puuids = this.getPuuidsToLoadForPlayers()
    puuids.forEach((puuid) => {
      this._loadPlayerMatchHistory(puuid, {
        signal: controller.signal,
        count: this.settings.matchHistoryLoadCount,
        tag: this.state.matchHistoryTag,
        force: false,
        useSgpApi: this.settings.matchHistoryUseSgpApi
      })
    })
  }

  /**
   *
   * @param options 其中的 force, 用于标识是否强制刷新. 若为 false, 在查询条件未发生变动时不会重新加载
   */
  private _champSelect(options: { mhSignal: AbortSignal; signal: AbortSignal; force: boolean }) {
    const { mhSignal, signal, force } = options

    const puuids = this.getPuuidsToLoadForPlayers()
    puuids.forEach((puuid) => {
      this._loadPlayerMatchHistory(puuid, {
        signal: mhSignal,
        force,
        count: this.settings.matchHistoryLoadCount,
        useSgpApi: this.settings.matchHistoryUseSgpApi
      })
      this._loadPlayerSummoner(puuid, { signal, force })
      this._loadPlayerRankedStats(puuid, { signal, force })
      this._loadPlayerSavedInfo(puuid, { signal, force })
      this._loadPlayerChampionMasteries(puuid, { signal, force })
    })
  }

  /** 目前实现同 #._champSelect */
  private _inGame(options: { mhSignal: AbortSignal; signal: AbortSignal; force: boolean }) {
    const { mhSignal, signal, force } = options

    const puuids = this.getPuuidsToLoadForPlayers()
    puuids.forEach((puuid) => {
      this._loadPlayerMatchHistory(puuid, {
        signal: mhSignal,
        force,
        count: this.settings.matchHistoryLoadCount,
        useSgpApi: this.settings.matchHistoryUseSgpApi
      })
      this._loadPlayerSummoner(puuid, { signal, force })
      this._loadPlayerRankedStats(puuid, { signal, force })
      this._loadPlayerSavedInfo(puuid, { signal, force })
      this._loadPlayerChampionMasteries(puuid, { signal, force })
    })
  }

  private _clearAndReload() {
    if (this._controller) {
      this._controller.abort()
      this._controller = null
    }

    if (this._mhController) {
      this._mhController.abort()
      this._mhController = null
    }

    this.state.clear()
    this._ipc.sendEvent(OngoingGameMain.id, 'clear')

    this._controller = new AbortController()
    this._mhController = new AbortController()

    if (this.state.queryStage.phase === 'champ-select') {
      this._champSelect({
        mhSignal: this._mhController.signal,
        signal: this._controller.signal,
        force: true
      })
    } else if (this.state.queryStage.phase === 'in-game') {
      this._inGame({
        mhSignal: this._mhController.signal,
        signal: this._controller.signal,
        force: true
      })
    }
  }

  private getPuuidsToLoadForPlayers() {
    if (this.state.queryStage.phase === 'unavailable') {
      return []
    }

    if (this.state.queryStage.phase === 'champ-select') {
      const session = this._lc.data.champSelect.session
      if (!session) {
        return []
      }

      const m = session.myTeam.filter((p) => p.puuid && p.puuid !== EMPTY_PUUID).map((t) => t.puuid)

      const t = session.theirTeam
        .filter((p) => p.puuid && p.puuid !== EMPTY_PUUID)
        .map((t) => t.puuid)

      return [...m, ...t]
    } else if (this.state.queryStage.phase === 'in-game') {
      const session = this._lc.data.gameflow.session

      if (!session) {
        return []
      }

      const m = session.gameData.teamOne
        .filter((p) => p.puuid && p.puuid !== EMPTY_PUUID)
        .map((t) => t.puuid)

      const t = session.gameData.teamTwo
        .filter((p) => p.puuid && p.puuid !== EMPTY_PUUID)
        .map((t) => t.puuid)

      return [...m, ...t]
    }

    return []
  }

  private async _loadPlayerMatchHistory(
    puuid: string,
    options: {
      signal?: AbortSignal
      tag?: string
      count?: number
      force?: boolean
      useSgpApi?: boolean
    } = {}
  ) {
    let { count = 20, signal, tag, force, useSgpApi } = options

    const isAbleToUseSgpApi =
      useSgpApi && this._sgp.state.availability.serversSupported.matchHistory

    const current = this.state.matchHistory[puuid]
    if (
      !force && // 在不强制更新的情况下
      current && // 在存在值的情况下
      current.targetCount === count && // 必要条件之一: 加载数量没有变化
      current.source === (isAbleToUseSgpApi ? 'sgp' : 'lcu') && // 必要条件之一: 数据来源没有变化
      (!isAbleToUseSgpApi || current.tag === tag) // 必要条件之一: SGP API 时, tag 也必须一致 (LCU API 将忽略 tag, 本来也没用)
    ) {
      // 以上不需要重新加载的前提, 是假设在一个对局期间, 这些数据都不会发生变化
      // ) 事实上在一个对局期间, 大部分情况是不会发生变化的
      return
    }

    if (isAbleToUseSgpApi) {
      // SGP API 可以筛选战绩
      // 在未设置筛选条件的情况下, 会根据设置的偏好来决定是否筛选
      if (tag === undefined || tag === 'all') {
        if (this.settings.matchHistoryTagPreference === 'all') {
          this.state.setMatchHistoryTag('all')
        } else if (
          this.settings.matchHistoryTagPreference === 'current' &&
          this.state.queryStage.gameInfo &&
          OngoingGameMain.SAFE_TAGS.has(`q_${this.state.queryStage.gameInfo.queueId}`)
        ) {
          tag = `q_${this.state.queryStage.gameInfo.queueId}`
          this.state.setMatchHistoryTag(`q_${this.state.queryStage.gameInfo.queueId}`)
        }
      } else {
        // 对于已经设置 tag 偏好的情况, 会检测是否是安全队列, 否则重置
        if (!OngoingGameMain.SAFE_TAGS.has(tag)) {
          tag = undefined
          this.state.setMatchHistoryTag('all')
        }
      }

      const data = await this._mhQueue
        .add(() => this._sgp.getMatchHistoryLcuFormat(puuid, 0, count, tag), {
          signal,
          priority: OngoingGameMain.LOADING_PRIORITY.MATCH_HISTORY
        })
        .catch((error) => this._handleAbortError(error))

      if (!data) {
        return
      }

      const toBeLoaded = {
        data: data.games.games,
        targetCount: count,
        source: 'sgp' as 'sgp' | 'lcu',
        tag
      }

      this.state.matchHistory[puuid] = toBeLoaded
      this._ipc.sendEvent(OngoingGameMain.id, 'match-history-loaded', puuid, toBeLoaded)
    } else {
      const res = await this._queue
        .add(() => this._lc.api.matchHistory.getMatchHistory(puuid, 0, count - 1), {
          signal,
          priority: OngoingGameMain.LOADING_PRIORITY.MATCH_HISTORY
        })
        .catch((error) => this._handleAbortError(error))

      if (!res) {
        return
      }

      const data = res.data

      const toBeLoaded = {
        data: data.games.games,
        targetCount: count,
        source: 'lcu' as 'sgp' | 'lcu'
      }

      this.state.matchHistory[puuid] = toBeLoaded
      this._ipc.sendEvent(OngoingGameMain.id, 'match-history-loaded', puuid, toBeLoaded)
    }
  }

  private async _loadPlayerSummoner(
    puuid: string,
    options: {
      signal?: AbortSignal
      force?: boolean
    } = {}
  ) {
    const { signal, force } = options

    // 如果不是强制更新, 并且已经有数据, 那么就不再加载
    if (!force && this.state.summoner[puuid]) {
      return
    }

    const res = await this._queue
      .add(() => this._lc.api.summoner.getSummonerByPuuid(puuid), {
        signal,
        priority: OngoingGameMain.LOADING_PRIORITY.SUMMONER
      })
      .catch((error) => this._handleAbortError(error))

    if (!res) {
      return
    }

    const data = res.data

    const toBeLoaded = { data, source: 'lcu' as 'sgp' | 'lcu' }
    this.state.summoner[puuid] = toBeLoaded
    this._ipc.sendEvent(OngoingGameMain.id, 'summoner-loaded', puuid, toBeLoaded)
  }

  private async _loadPlayerSavedInfo(
    puuid: string,
    options: {
      signal?: AbortSignal
      force?: boolean
    } = {}
  ) {
    // just used to suppress ts error
    if (!this._lc.state.auth || !this._lc.data.summoner.me) {
      return
    }

    const query = {
      puuid,
      selfPuuid: this._lc.data.summoner.me.puuid,
      region: this._lc.state.auth.region,
      rsoPlatformId: this._lc.state.auth.rsoPlatformId
    }

    const { signal, force } = options

    if (!force && this.state.savedInfo[puuid]) {
      return
    }

    const res = await this._queue
      .add(() => this._saved.querySavedPlayerWithGames(query), {
        signal,
        priority: OngoingGameMain.LOADING_PRIORITY.SAVED_INFO
      })
      .catch((error) => this._handleAbortError(error))

    if (!res) {
      return
    }

    this.state.savedInfo[puuid] = res
    this._ipc.sendEvent(OngoingGameMain.id, 'saved-info-loaded', puuid, res)
  }

  private async _loadPlayerRankedStats(
    puuid: string,
    options: {
      signal?: AbortSignal
      force?: boolean
    } = {}
  ) {
    const { signal, force } = options

    if (!force && this.state.rankedStats[puuid]) {
      return
    }

    const res = await this._mhQueue
      .add(() => this._lc.api.ranked.getRankedStats(puuid), {
        signal,
        priority: OngoingGameMain.LOADING_PRIORITY.RANKED_STATS
      })
      .catch((error) => this._handleAbortError(error))

    if (!res) {
      return
    }

    const data = res.data

    const toBeLoaded = { data, source: 'lcu' as 'sgp' | 'lcu' }
    this.state.rankedStats[puuid] = toBeLoaded
    this._ipc.sendEvent(OngoingGameMain.id, 'ranked-stats-loaded', puuid, toBeLoaded)
  }

  private async _loadPlayerChampionMasteries(
    puuid: string,
    options: {
      signal?: AbortSignal
      force?: boolean
    } = {}
  ) {
    const { signal, force } = options

    if (!force && this.state.championMastery[puuid]) {
      return
    }

    const res = await this._mhQueue
      .add(() => this._lc.api.championMastery.getPlayerChampionMastery(puuid), {
        signal,
        priority: OngoingGameMain.LOADING_PRIORITY.CHAMPION_MASTERY
      })
      .catch((error) => this._handleAbortError(error))

    if (!res) {
      return
    }

    const data = res.data

    const simplifiedMastery = data
      .map((m) => ({
        championId: m.championId,
        championLevel: m.championLevel,
        championPoints: m.championPoints,
        milestoneGrades: m.milestoneGrades
      }))
      .reduce((obj, cur) => {
        obj[cur.championId] = cur
        return obj
      }, {} as any)

    const toBeLoaded = { data: simplifiedMastery, source: 'lcu' as 'sgp' | 'lcu' }
    this.state.championMastery[puuid] = toBeLoaded
    this._ipc.sendEvent(OngoingGameMain.id, 'champion-mastery-loaded', puuid, toBeLoaded)
  }

  private _handleIpcCall() {
    this._ipc.onCall(OngoingGameMain.id, 'getAll', () => {
      const matchHistory = toJS(this.state.matchHistory)
      const summoner = toJS(this.state.summoner)
      const rankedStats = toJS(this.state.rankedStats)
      const savedInfo = toJS(this.state.savedInfo)
      const championMastery = toJS(this.state.championMastery)

      return { matchHistory, summoner, rankedStats, savedInfo, championMastery }
    })

    this._ipc.onCall(OngoingGameMain.id, 'setMatchHistoryTag', (tag: string) => {
      if (OngoingGameMain.SAFE_TAGS.has(tag) || tag === 'all') {
        this.state.setMatchHistoryTag(tag)
        this._debouncedUpdateMatchHistoryFn()
      }
    })

    this._ipc.onCall(OngoingGameMain.id, 'reload', () => {
      this._clearAndReload()
    })
  }

  private _calcTeamUp() {
    if (!this.state.teams) {
      return null
    }

    const games = Object.values(this.state.matchHistory)
      .map((m) => m.data)
      .flat()

    if (!games.length) {
      return null
    }

    // 统计所有目前游戏中的每个队伍，并且将这些队伍分别视为一个独立的个体，使用 `${游戏ID}|${队伍ID}` 进行唯一区分
    const teamSides = new Map<string, string[]>()
    for (const game of games) {
      const mode = game.gameMode

      // participantId -> puuid
      const participantsMap = game.participantIdentities.reduce(
        (obj, current) => {
          obj[current.participantId] = current.player.puuid
          return obj
        },
        {} as Record<string, string>
      )

      let grouped: { teamId: number; puuid: string }[]

      // 对于竞技场模式，在战绩接口中只有一个队伍。如果要区分小队，需要使用 subteamPlacement 或 subteamId 字段
      if (mode === 'CHERRY') {
        grouped = game.participants.map((p) => ({
          teamId: p.stats.subteamPlacement, // 取值范围是 1, 2, 3, 4, 这个实际上也是最终队伍排名
          puuid: participantsMap[p.participantId]
        }))
      } else {
        // 对于其他模式，按照两队式计算
        grouped = game.participants.map((p) => ({
          teamId: p.teamId,
          puuid: participantsMap[p.participantId]
        }))
      }

      // teamId -> puuid[]，这个记录的是这条战绩中的
      const teamPlayersMap = grouped.reduce(
        (obj, current) => {
          if (obj[current.teamId]) {
            obj[current.teamId].push(current.puuid)
          } else {
            obj[current.teamId] = [current.puuid]
          }
          return obj
        },
        {} as Record<string, string[]>
      )

      // sideId -> puuid[]，按照队伍区分。
      Object.entries(teamPlayersMap).forEach(([teamId, players]) => {
        const sideId = `${game.gameId}|${teamId}`
        if (teamSides.has(sideId)) {
          return
        }
        teamSides.set(sideId, players)
      })
    }

    const matches = Array.from(teamSides).map(([id /* sideId */, players]) => ({ id, players }))

    // key: teamSide, values: { players: string[], times: number }[]
    const result = Object.entries(this.state.teams).reduce(
      (obj, [team, teamPlayers]) => {
        obj[team] = calculateTogetherTimes(matches, teamPlayers, this.settings.premadeTeamThreshold)

        return obj
      },
      {} as Record<
        string,
        {
          players: string[]
          times: number
        }[]
      >
    )

    // teamSide -> players[][]
    const combinedGroups: Record<string, string[][]> = {}

    for (const [team, playerGroups] of Object.entries(result)) {
      const groups = playerGroups.map((pg) => pg.players)
      combinedGroups[team] = removeOverlappingSubsets(groups) as string[][]
    }

    return combinedGroups
  }

  private _calcAnalysis() {
    if (!this.state.teams) {
      return null
    }

    const playerAnalyses: Record<string, MatchHistoryGamesAnalysisAll> = {}

    for (const [puuid, matchHistory] of Object.entries(this.state.matchHistory)) {
      if (!matchHistory) {
        continue
      }

      const analysis = analyzeMatchHistory(
        matchHistory.data.map((mh) => ({ game: mh, isDetailed: true })), // for compatibility
        puuid
      )
      if (analysis) {
        playerAnalyses[puuid] = analysis
      }
    }

    const teamAnalyses: Record<string, MatchHistoryGamesAnalysisTeamSide> = {}

    for (const [sideId, puuids] of Object.entries(this.state.teams)) {
      const teamPlayerAnalyses = puuids.map((p) => playerAnalyses[p]).filter(Boolean)
      const teamAnalysis = analyzeTeamMatchHistory(teamPlayerAnalyses)
      if (teamAnalysis) {
        teamAnalyses[sideId] = teamAnalysis
      }
    }

    return {
      players: playerAnalyses,
      teams: teamAnalyses
    }
  }

  private _handleCalculation() {
    // 重新计算战绩信息
    this._mobx.reaction(
      () => Object.values(this.state.matchHistory),
      (_changedV) => {
        this.state.setPlayerStats(this._calcAnalysis())
      },
      { delay: 200, equals: comparer.shallow }
    )

    // 重新计算预组队
    this._mobx.reaction(
      () => [Object.values(this.state.matchHistory), this.settings.premadeTeamThreshold] as const,
      ([_changedV, _threshold]) => {
        this.state.setPremadeTeams(this._calcTeamUp())
      },
      { delay: 200, equals: comparer.shallow }
    )
  }

  private _handleAbortError(e: any) {
    if (e instanceof Error && e.name === 'AbortError') {
      return
    }
    return Promise.reject(e)
  }
}
