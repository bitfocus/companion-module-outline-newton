import type { CompanionStaticUpgradeScript } from '@companion-module/base'
import type { ModuleConfig } from './config.js'

// No upgrades needed yet for the initial version.
export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig>[] = []
