import type { Readable, Writable } from 'node:stream';
import type { SandboxMode } from '../../config/profile-schema';
import {
  mergeProcessEnv,
  spawnProcess,
  type SpawnedProcessByStdio,
} from '../../platform/spawn';
import type { AgentBotIdentity, AgentRun, AgentRunOptions } from '../types';
import { normalizeUserInputRequest } from './app-server-normalizer';
import { AppServerSession } from './app-server-session';

type AppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

interface AppServerRunOptions {
  binary: string;
  env: NodeJS.ProcessEnv;
  run: Omit<AgentRunOptions, 'sandbox' | 'userInput'> & {
    sandbox: SandboxMode;
    userInput: Extract<AgentRunOptions['userInput'], { kind: 'interactive' }>;
  };
  botIdentity?: AgentBotIdentity;
  stopGraceMs: number;
}

export function runCodexAppServer(options: AppServerRunOptions): AgentRun {
  const child = spawnProcess(
    options.binary,
    [
      'app-server',
      '--listen',
      'stdio://',
      '-c',
      'shell_environment_policy.inherit="all"',
      '-c',
      'features.default_mode_request_user_input=true',
    ],
    {
      cwd: options.run.cwd,
      env: mergeProcessEnv(process.env, options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ) as AppServerChild;
  return new AppServerSession(child, options).agentRun();
}

export { normalizeUserInputRequest };
