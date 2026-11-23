import { observeAgentStateFile } from '../codex-path-observation'
import type { TopLevelSettingValue } from '../toml/config-toml-promoted-setting-values'
import { writeCodexSettingsBaseline, type CodexSettingsBaseline } from './config-settings-baseline'
import { hasCodexRegistrationUserEdits } from './config-plugin-registration-promotion'
import type { CodexSettingsPromotionPlan } from './config-settings-promotion'

export type GuestForkCheck = {
  runtimeHomePath: string
  runtimeConfig: string
  guestConfigPath: string
  settingsEdited: boolean
  baseline: CodexSettingsBaseline | null
  plan: CodexSettingsPromotionPlan
}

/** Orca can't write a WSL guest's config back, so a user edit makes the managed copy the user's own. */
export function forkOnUserEdits(check: GuestForkCheck): CodexSettingsPromotionPlan {
  if (!check.settingsEdited) {
    const guest = observeAgentStateFile(check.guestConfigPath)
    if (guest.kind === 'indeterminate') {
      throw guest.error
    }
    const guestConfig = guest.kind === 'present' ? guest.value : ''
    const registrations = check.baseline?.registrations ?? new Map()
    if (!hasCodexRegistrationUserEdits(check.runtimeConfig, guestConfig, registrations)) {
      return check.plan
    }
  }
  // Keep the ancestry so an older build reading this baseline still sees what was mirrored.
  writeCodexSettingsBaseline(check.runtimeHomePath, {
    settings: check.baseline?.settings ?? new Map(),
    conflicts: check.baseline?.conflicts ?? new Map(),
    registrations: check.baseline?.registrations ?? new Map(),
    mcpServers: check.baseline?.mcpServers ?? new Set(),
    mcpServerRoot: check.baseline?.mcpServerRoot ?? false,
    multilineSettings: check.baseline?.multilineSettings,
    forked: true
  })
  return { ...check.plan, conflicts: new Map(), runtimeValuesToPreserve: new Map(), forked: true }
}

/** Any change to a mirrored value, deletions included, even where a later source edit would win. */
export function hasTrackedSettingEdits(
  baseline: CodexSettingsBaseline,
  runtimeValues: ReadonlyMap<string, TopLevelSettingValue>,
  runtimeMultilineDigests: ReadonlyMap<string, string>
): boolean {
  for (const [key, mirroredRaw] of baseline.settings) {
    // The baseline's single-line values never match a multiline one, so that is an edit too.
    if (!baseline.conflicts.has(key) && getComparableRaw(runtimeValues.get(key)) !== mirroredRaw) {
      return true
    }
  }
  for (const [key, mirroredDigest] of baseline.multilineSettings ?? []) {
    if (!baseline.conflicts.has(key) && runtimeMultilineDigests.get(key) !== mirroredDigest) {
      return true
    }
  }
  return false
}

export function getComparableRaw(
  value: TopLevelSettingValue | undefined
): string | null | undefined {
  if (!value) {
    return null
  }
  return value.multiline ? undefined : value.raw
}
