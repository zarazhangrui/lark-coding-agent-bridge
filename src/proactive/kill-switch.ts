const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

/** Process-wide emergency stop for every proactive observer profile. */
export function isProactiveObserverGloballyDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return TRUE_VALUES.has((env.LARK_PROACTIVE_OBSERVER_DISABLED ?? '').trim().toLowerCase());
}
