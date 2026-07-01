export interface BuildOpenCodeArgsInput {
  cwd: string;
}

export function buildOpenCodeArgs(input: BuildOpenCodeArgsInput): string[] {
  return [
    'run',
    '--format',
    'json',
    '--dir',
    input.cwd,
    '-',
  ];
}
