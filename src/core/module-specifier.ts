/** Normalize module URLs before passing them to dynamic import(). */
export function normalizeModuleSpecifier(specifier: string): string {
  return specifier.startsWith('file:') ? specifier.replace(/%7E/gi, '~') : specifier;
}
