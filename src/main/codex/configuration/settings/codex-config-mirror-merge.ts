import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { readMcpServerTomlOwnership } from '../toml/config-toml-mcp-servers'
import {
  deduplicateProjectTomlSections,
  getHookTrustTomlSectionKeys,
  getMcpServerTomlSectionName,
  getProjectTrustLevel,
  getRevocationTomlSectionHeaderKey,
  getTomlSectionHeaderKey,
  getTomlSections,
  definesCodexTuiBookkeepingOnlyAsTable,
  isCodexTuiBookkeepingTomlSection,
  isRuntimePreservedTomlSection,
  isRuntimeProjectTomlSection,
  joinTomlBlocks,
  stripRuntimeOwnedTomlSections
} from '../toml/config-toml-runtime-owned-sections'

/** Ordinary settings and shared hook trust from ~/.codex plus the tables the managed home owns. */
export function mergeSystemCodexConfigIntoRuntime(
  runtimeConfig: string,
  systemConfig: string,
  systemConfigDir: string,
  mirroredMcpServerNames: ReadonlySet<string> = new Set(),
  mirroredMcpServerRoot = false
): string {
  const systemSections = deduplicateProjectTomlSections(getTomlSections(systemConfig))
  // Another spelling in ~/.codex (a [tui] key or inline table) would define the table twice.
  const keepsTuiBookkeeping = definesCodexTuiBookkeepingOnlyAsTable(systemConfig)
  const runtimeSections = deduplicateProjectTomlSections(getTomlSections(runtimeConfig)).filter(
    (section) => keepsTuiBookkeeping || !isCodexTuiBookkeepingTomlSection(section)
  )
  const runtimeOwnedHeaders = new Set(
    runtimeSections
      .filter(
        (section) =>
          isRuntimeProjectTomlSection(section) || isCodexTuiBookkeepingTomlSection(section)
      )
      .map((section) => getTomlSectionHeaderKey(section))
  )
  const systemProjectSections = systemSections.filter((section) =>
    isRuntimeProjectTomlSection(section)
  )
  const systemUntrustedProjectHeaders = new Set(
    systemProjectSections
      .filter((section) => getProjectTrustLevel(section.block) === 'untrusted')
      .map((section) => getRevocationTomlSectionHeaderKey(section))
  )
  // Exact-cased re-grants must override legacy case-drifted revocations or each mirror reverts trust.
  const systemTrustedProjectHeaders = new Set(
    systemProjectSections
      .filter((section) => getProjectTrustLevel(section.block) === 'trusted')
      .map((section) => getTomlSectionHeaderKey(section))
  )
  const systemMcpServers = readMcpServerTomlOwnership(systemConfig)
  // Mirror ordinary settings while retaining runtime trust, subject to explicit system project revocations.
  return joinTomlBlocks([
    stripRuntimeOwnedTomlSections(systemConfig, runtimeOwnedHeaders, {
      systemHomeDir: systemConfigDir,
      runtimeHookTrustKeys: getHookTrustTomlSectionKeys(runtimeSections)
    }),
    ...runtimeSections
      .filter((section) => {
        if (isRuntimePreservedTomlSection(section)) {
          return true
        }
        const mcpServerName = getMcpServerTomlSectionName(section)
        return (
          mcpServerName !== null &&
          !systemMcpServers.ownsRoot &&
          !mirroredMcpServerRoot &&
          !systemMcpServers.names.has(mcpServerName) &&
          !mirroredMcpServerNames.has(mcpServerName)
        )
      })
      .filter(
        (section) =>
          !isRuntimeProjectTomlSection(section) ||
          !systemUntrustedProjectHeaders.has(getRevocationTomlSectionHeaderKey(section)) ||
          systemTrustedProjectHeaders.has(getTomlSectionHeaderKey(section))
      )
      .map((section) => section.block)
  ])
}

/** A managed copy the user owns takes no source edits except explicit project revocations. */
export function applySystemProjectRevocations(runtimeConfig: string, systemConfig: string): string {
  const revocations = new Map<string, string>()
  const regranted = new Set<string>()
  for (const section of deduplicateProjectTomlSections(getTomlSections(systemConfig))) {
    if (!isRuntimeProjectTomlSection(section)) {
      continue
    }
    const level = getProjectTrustLevel(section.block)
    if (level === 'untrusted') {
      revocations.set(getRevocationTomlSectionHeaderKey(section), section.block)
    } else if (level === 'trusted') {
      regranted.add(getTomlSectionHeaderKey(section))
    }
  }
  if (revocations.size === 0) {
    return runtimeConfig
  }
  const expanded = expandInlineProjectTrust(runtimeConfig)
  const lines = expanded.split('\n')
  const runtimeSections = getTomlSections(expanded)
  // An alias already marked untrusted carries the revocation; the trusted spellings just go.
  const inserted = new Set(
    runtimeSections
      .filter(
        (section) =>
          isRuntimeProjectTomlSection(section) &&
          getProjectTrustLevel(section.block) === 'untrusted'
      )
      .map((section) => getRevocationTomlSectionHeaderKey(section))
  )
  // Bottom-up so earlier section start lines stay valid after each splice.
  for (const section of runtimeSections.toReversed()) {
    const revocation = revocations.get(getRevocationTomlSectionHeaderKey(section))
    if (
      revocation === undefined ||
      !isRuntimeProjectTomlSection(section) ||
      getProjectTrustLevel(section.block) !== 'trusted' ||
      regranted.has(getTomlSectionHeaderKey(section))
    ) {
      continue
    }
    const revocationKey = getRevocationTomlSectionHeaderKey(section)
    // Case-drifted spellings share one revocation; a second copy would define the table twice.
    const replacement = inserted.has(revocationKey) ? [] : revocation.split('\n')
    inserted.add(revocationKey)
    lines.splice(section.start, section.block.split('\n').length, ...replacement)
  }
  const revoked = lines.join('\n')
  // Keep the user's inline spelling when no revocation applied to it.
  return revoked === expanded ? runtimeConfig : revoked
}

/** An inline `projects = {...}` map can't take a revocation in place, so it becomes tables. */
function expandInlineProjectTrust(config: string): string {
  const lines = config.split('\n')
  const firstHeader = getTomlSections(config)[0]?.start ?? lines.length
  const index = lines.slice(0, firstHeader).findIndex((line) => /^\s*projects\s*=\s*\{/.test(line))
  if (index === -1) {
    return config
  }
  let projects: unknown
  try {
    projects = parseToml(lines[index] ?? '').projects
  } catch {
    return config
  }
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) {
    return config
  }
  lines.splice(index, 1)
  return joinTomlBlocks([lines.join('\n'), stringifyToml({ projects })])
}
