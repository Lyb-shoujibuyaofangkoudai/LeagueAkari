import { IAkariShardInitDispose } from '@shared/akari-shard/interface'
import { GameClientHttpApiAxiosHelper } from '@shared/http-api-axios-helper/game-client'
import axios from 'axios'
import cp from 'child_process'
import https from 'https'
import path from 'node:path'

import toolkit from '@main/native/la-tools-win64.node'
import { ClientInstallationMain } from '../client-installation'
import { AkariIpcMain } from '../ipc'
import { KeyboardShortcutsMain } from '../keyboard-shortcuts'
import { LeagueClientMain } from '../league-client'
import { AkariLogger, LoggerFactoryMain } from '../logger-factory'
import { MobxUtilsMain } from '../mobx-utils'
import { SettingFactoryMain } from '../setting-factory'
import { SetterSettingService } from '../setting-factory/setter-setting-service'
import { GameClientSettings } from './state'

export interface LaunchSpectatorConfig {
  locale?: string
  sgpServerId: string
  observerEncryptionKey: string
  observerServerPort: number
  observerServerIp: string
  gameId: number
  gameMode: string
}

/**
 * 处理游戏端相关的功能
 */
export class GameClientMain implements IAkariShardInitDispose {
  static id = 'game-client-main'
  static dependencies = [
    'akari-ipc-main',
    'logger-factory-main',
    'setting-factory-main',
    'league-client-main',
    'mobx-utils-main',
    'keyboard-shortcuts-main',
    'client-installation-main'
  ]

  static GAME_CLIENT_PROCESS_NAME = 'League of Legends.exe'
  static TERMINATE_DELAY = 200
  static GAME_CLIENT_BASE_URL = 'https://127.0.0.1:2999'

  private readonly _ipc: AkariIpcMain
  private readonly _loggerFactory: LoggerFactoryMain
  private readonly _settingFactory: SettingFactoryMain
  private readonly _log: AkariLogger
  private readonly _setting: SetterSettingService
  private readonly _lc: LeagueClientMain
  private readonly _kbd: KeyboardShortcutsMain
  private readonly _mobx: MobxUtilsMain
  private readonly _ci: ClientInstallationMain

  private readonly _http = axios.create({
    baseURL: GameClientMain.GAME_CLIENT_BASE_URL,
    httpsAgent: new https.Agent({
      rejectUnauthorized: false,
      keepAlive: true,
      maxFreeSockets: 1024,
      maxCachedSessions: 2048
    })
  })
  private readonly _api: GameClientHttpApiAxiosHelper

  public readonly settings = new GameClientSettings()

  constructor(deps: any) {
    this._ipc = deps['akari-ipc-main']
    this._loggerFactory = deps['logger-factory-main']
    this._log = this._loggerFactory.create(GameClientMain.id)
    this._settingFactory = deps['setting-factory-main']
    this._api = new GameClientHttpApiAxiosHelper(this._http)
    this._lc = deps['league-client-main']
    this._kbd = deps['keyboard-shortcuts-main']
    this._mobx = deps['mobx-utils-main']
    this._ci = deps['client-installation-main']

    this._setting = this._settingFactory.create(
      GameClientMain.id,
      {
        terminateGameClientWithShortcut: { default: this.settings.terminateGameClientWithShortcut },
        terminateShortcut: { default: this.settings.terminateShortcut }
      },
      this.settings
    )
  }

  get http() {
    return this._http
  }

  get api() {
    return this._api
  }

  async onInit() {
    await this._setting.applyToState()
    this._mobx.propSync(GameClientMain.id, 'settings', this.settings, [
      'terminateGameClientWithShortcut',
      'terminateShortcut'
    ])
    this._handleIpcCall()
    this._handleShortcuts()
  }

  private _handleShortcuts() {
    if (this.settings.terminateShortcut) {
      try {
        this._kbd.register(
          `${GameClientMain.id}/terminate-game-client`,
          this.settings.terminateShortcut,
          'last-active',
          () => {
            if (this.settings.terminateGameClientWithShortcut) {
              this._terminateGameClient()
            }
          }
        )
      } catch (error) {
        this._log.warn('初始化注册快捷键失败', this.settings.terminateShortcut)
      }
    }

    this._setting.onChange('terminateShortcut', async (value, { setter }) => {
      if (value === null) {
        this._kbd.unregisterByTargetId(`${GameClientMain.id}/terminate-game-client`)
      } else {
        try {
          this._kbd.register(
            `${GameClientMain.id}/terminate-game-client`,
            value,
            'last-active',
            () => {
              if (this.settings.terminateGameClientWithShortcut) {
                this._terminateGameClient()
              }
            }
          )
        } catch (error) {
          this._log.warn('注册快捷键失败', value)
          await setter(null)
        }
      }

      await setter()
    })
  }

  private _handleIpcCall() {
    this._ipc.onCall(GameClientMain.id, 'terminateGameClient', () => {
      this._terminateGameClient()
    })

    this._ipc.onCall(GameClientMain.id, 'launchSpectator', (config: LaunchSpectatorConfig) => {
      return this.launchSpectator(config)
    })
  }

  private _terminateGameClient() {
    toolkit.getPidsByName(GameClientMain.GAME_CLIENT_PROCESS_NAME).forEach((pid) => {
      if (!toolkit.isProcessForeground(pid)) {
        return
      }

      this._log.info(`终止游戏客户端进程 ${pid}`)

      // 这里设置 200 ms，用于使客户端消耗 Alt+F4 事件，避免穿透
      setTimeout(() => {
        toolkit.terminateProcess(pid)
      }, GameClientMain.TERMINATE_DELAY)
    })
  }

  /**
   * 已连接的情况下, 可通过 API 当场获取观战凭据
   * 未连接的情况下, 需要传入观战凭据
   * 已连接且请求失败的情况下, 会尝试一次未连接的应对方式
   * @param config
   * @returns
   */
  private async _completeSpectatorCredential(config: LaunchSpectatorConfig) {
    const {
      sgpServerId,
      gameId,
      gameMode,
      locale = 'zh_CN',
      observerEncryptionKey,
      observerServerIp,
      observerServerPort
    } = config

    if (this._ci.state.tencentInstallationPath) {
      const gameExecutablePath = path.resolve(
        this._ci.state.tencentInstallationPath,
        'Game',
        GameClientMain.GAME_CLIENT_PROCESS_NAME
      )

      const gameInstallRoot = path.resolve(this._ci.state.tencentInstallationPath, 'Game')

      return {
        sgpServerId,
        gameId,
        gameMode,
        locale,
        observerEncryptionKey,
        observerServerIp,
        observerServerPort,
        gameInstallRoot,
        gameExecutablePath
      }
    } else {
      if (this._lc.state.connectionState === 'connected') {
        try {
          const { data: location } = await this._lc.http.get<{
            gameExecutablePath: string
            gameInstallRoot: string
          }>('/lol-patch/v1/products/league_of_legends/install-location')

          return {
            sgpServerId,
            gameId,
            gameMode,
            locale,
            observerEncryptionKey,
            observerServerIp,
            observerServerPort,
            gameInstallRoot: location.gameInstallRoot,
            gameExecutablePath: location.gameExecutablePath
          }
        } catch (error) {
          const err = new Error('Cannot get game installation path')
          err.name = 'CannotGetGameInstallationPath'
          throw err
        }
      } else {
        const err = new Error('No Tencent Installation Path')
        err.name = 'NoTencentInstallationPath'
        throw err
      }
    }
  }

  async launchSpectator(config: LaunchSpectatorConfig) {
    const {
      gameExecutablePath,
      gameInstallRoot,
      gameId,
      gameMode,
      locale,
      observerEncryptionKey,
      observerServerIp,
      observerServerPort,
      sgpServerId
    } = await this._completeSpectatorCredential(config)

    const [region, rsoPlatformId] = sgpServerId.split('_')

    const cmds = [
      `spectator ${observerServerIp}:${observerServerPort} ${observerEncryptionKey} ${gameId} ${region}`,
      `-GameBaseDir=${gameInstallRoot}`,
      `-Locale=${locale || 'zh_CN'}`,
      `-GameID=${gameId}`,
      `-Region=${region}`,
      `-UseNewX3D=1`,
      '-PlayerNameMode=ALIAS',
      '-UseNewX3DFramebuffers=1'
    ]

    if (gameMode === 'TFT') {
      cmds.push('-Product=TFT')
    } else {
      cmds.push('-Product=LoL')
    }

    if (rsoPlatformId) {
      cmds.push(`-PlatformId=${rsoPlatformId}`)
    }

    const p = cp.spawn(gameExecutablePath, cmds, {
      cwd: gameInstallRoot,
      detached: true
    })

    p.unref()
  }

  static isGameClientForeground() {
    return toolkit
      .getPidsByName(GameClientMain.GAME_CLIENT_PROCESS_NAME)
      .some((pid) => toolkit.isProcessForeground(pid))
  }
}
