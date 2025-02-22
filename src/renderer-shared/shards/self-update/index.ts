import { IAkariShardInitDispose } from '@shared/akari-shard/interface'

import { AkariIpcRenderer } from '../ipc'
import { PiniaMobxUtilsRenderer } from '../pinia-mobx-utils'
import { SettingUtilsRenderer } from '../setting-utils'
import { useSelfUpdateStore } from './store'

const MAIN_SHARD_NAMESPACE = 'self-update-main'

export class SelfUpdateRenderer implements IAkariShardInitDispose {
  static id = 'self-update-renderer'

  static dependencies = [
    'akari-ipc-renderer',
    'pinia-mobx-utils-renderer',
    'setting-utils-renderer'
  ]

  private readonly _ipc: AkariIpcRenderer
  private readonly _pm: PiniaMobxUtilsRenderer
  private readonly _setting: SettingUtilsRenderer

  constructor(deps: any) {
    this._ipc = deps['akari-ipc-renderer']
    this._pm = deps['pinia-mobx-utils-renderer']
    this._setting = deps['setting-utils-renderer']

    // @ts-ignore
    window.selfUpdateShard = this
  }

  checkUpdates() {
    return this._ipc.call(MAIN_SHARD_NAMESPACE, 'checkUpdates')
  }

  checkUpdatesDebug() {
    return this._ipc.call(MAIN_SHARD_NAMESPACE, 'checkUpdatesDebug')
  }

  startUpdate() {
    return this._ipc.call(MAIN_SHARD_NAMESPACE, 'startUpdate')
  }

  cancelUpdate() {
    return this._ipc.call(MAIN_SHARD_NAMESPACE, 'cancelUpdate')
  }

  setAnnouncementRead(md5: string) {
    return this._ipc.call(MAIN_SHARD_NAMESPACE, 'setAnnouncementRead', md5)
  }

  openNewUpdatesDir() {
    return this._ipc.call(MAIN_SHARD_NAMESPACE, 'openNewUpdatesDir')
  }

  setAutoCheckUpdates(enabled: boolean) {
    return this._setting.set(MAIN_SHARD_NAMESPACE, 'autoCheckUpdates', enabled)
  }

  setAutoDownloadUpdates(enabled: boolean) {
    return this._setting.set(MAIN_SHARD_NAMESPACE, 'autoDownloadUpdates', enabled)
  }

  setDownloadSource(source: 'gitee' | 'github') {
    return this._setting.set(MAIN_SHARD_NAMESPACE, 'downloadSource', source)
  }

  onStartUpdate(cb: () => void) {
    this._ipc.onEventVue(MAIN_SHARD_NAMESPACE, 'start-update', cb)
  }

  async onInit() {
    const store = useSelfUpdateStore()

    await this._pm.sync(MAIN_SHARD_NAMESPACE, 'settings', store.settings)
    await this._pm.sync(MAIN_SHARD_NAMESPACE, 'state', store)
  }
}
