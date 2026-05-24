import { Command } from 'commander';
import pkg from '../../package.json';
import { runMigrate } from './commands/migrate';
import { runKillCli, runPs } from './commands/ps';
import {
  runSecretsGet,
  runSecretsList,
  runSecretsRemove,
  runSecretsSet,
} from './commands/secrets';
import {
  runServiceRestart,
  runServiceStart,
  runServiceStatus,
  runServiceStop,
  runServiceUnregister,
} from './commands/service';
import { runStart } from './commands/start';

const program = new Command();

program
  .name('lark-channel-bridge')
  .description('Bridge Feishu/Lark messenger with local CLI coding agents')
  .version(pkg.version, '-v, --version');

// === process-level commands (work directly on bridge processes) ===

program
  .command('run')
  .description('Run the bridge in the foreground (was `start` in older versions)')
  .option('-c, --config <path>', 'path to config file')
  .option('--claude', 'use Claude Code agent (default)')
  .option('--codex', 'use Codex CLI agent and ~/.lark-codex by default')
  .option('--skip-check-lark-cli', 'skip lark-cli pre-flight check (auto-install + bind)')
  .action(async (opts: { config?: string; claude?: boolean; codex?: boolean; skipCheckLarkCli?: boolean }) => {
    await runStart({
      config: opts.config,
      agent: resolveAgentFlag(opts),
      skipCheckLarkCli: opts.skipCheckLarkCli,
    });
  });

program
  .command('ps')
  .description('List running bridge processes on this machine')
  .option('-c, --config <path>', 'path to config file')
  .option('--claude', 'use Claude Code agent (default)')
  .option('--codex', 'use Codex CLI agent and ~/.lark-codex by default')
  .action((opts: { config?: string; claude?: boolean; codex?: boolean }) => {
    runPs({ config: opts.config, agent: resolveAgentFlag(opts) });
  });

program
  .command('kill <target>')
  .description('Kill a running bridge process by short id or list index (SIGTERM, then SIGKILL after 2s). Was `stop <target>` in older versions.')
  .option('-c, --config <path>', 'path to config file')
  .option('--claude', 'use Claude Code agent (default)')
  .option('--codex', 'use Codex CLI agent and ~/.lark-codex by default')
  .action(async (target: string, opts: { config?: string; claude?: boolean; codex?: boolean }) => {
    await runKillCli(target, { config: opts.config, agent: resolveAgentFlag(opts) });
  });

// === service-level commands (OS-managed daemon: launchd/systemd/schtasks) ===

program
  .command('start')
  .description('Install (if needed) and start the bridge as an OS-managed daemon')
  .option('-c, --config <path>', 'path to config file')
  .option('--claude', 'use Claude Code agent (default)')
  .option('--codex', 'use Codex CLI agent and ~/.lark-codex by default')
  .option('--skip-check-lark-cli', 'skip lark-cli pre-flight check (auto-install + bind)')
  .action(async (opts: { config?: string; claude?: boolean; codex?: boolean; skipCheckLarkCli?: boolean }) => {
    await runServiceStart({
      config: opts.config,
      agent: resolveAgentFlag(opts),
      skipCheckLarkCli: opts.skipCheckLarkCli,
    });
  });

program
  .command('stop')
  .description('Stop the OS-managed daemon (unload from launchd; plist stays)')
  .option('-c, --config <path>', 'path to config file')
  .option('--claude', 'use Claude Code agent (default)')
  .option('--codex', 'use Codex CLI agent and ~/.lark-codex by default')
  .action(async (opts: { config?: string; claude?: boolean; codex?: boolean }) => {
    await runServiceStop({ config: opts.config, agent: resolveAgentFlag(opts) });
  });

program
  .command('restart')
  .description('Restart the OS-managed daemon')
  .option('-c, --config <path>', 'path to config file')
  .option('--claude', 'use Claude Code agent (default)')
  .option('--codex', 'use Codex CLI agent and ~/.lark-codex by default')
  .action(async (opts: { config?: string; claude?: boolean; codex?: boolean }) => {
    await runServiceRestart({ config: opts.config, agent: resolveAgentFlag(opts) });
  });

program
  .command('status')
  .description('Show OS service status (pid, last exit, log paths)')
  .option('-c, --config <path>', 'path to config file')
  .option('--claude', 'use Claude Code agent (default)')
  .option('--codex', 'use Codex CLI agent and ~/.lark-codex by default')
  .action(async (opts: { config?: string; claude?: boolean; codex?: boolean }) => {
    await runServiceStatus({ config: opts.config, agent: resolveAgentFlag(opts) });
  });

program
  .command('unregister')
  .description('Remove the OS service registration (bootout + delete plist)')
  .option('-c, --config <path>', 'path to config file')
  .option('--claude', 'use Claude Code agent (default)')
  .option('--codex', 'use Codex CLI agent and ~/.lark-codex by default')
  .action(async (opts: { config?: string; claude?: boolean; codex?: boolean }) => {
    await runServiceUnregister({ config: opts.config, agent: resolveAgentFlag(opts) });
  });

const secrets = program
  .command('secrets')
  .description('Manage the bridge\'s encrypted secret keystore (~/.lark-channel/secrets.enc)');

secrets
  .command('get')
  .description('Exec-provider protocol: read JSON request from stdin, write JSON response to stdout. Used by lark-cli config bind --source lark-channel.')
  .action(async () => {
    await runSecretsGet();
  });

secrets
  .command('set')
  .description('Encrypt and store an App Secret. Prompts for the secret without echoing.')
  .requiredOption('--app-id <id>', 'App ID (e.g. cli_xxxxxxxxxxxx)')
  .action(async (opts: { appId: string }) => {
    await runSecretsSet(opts.appId);
  });

secrets
  .command('list')
  .description('List the IDs of secrets in the encrypted keystore (no secrets shown)')
  .action(async () => {
    await runSecretsList();
  });

secrets
  .command('remove')
  .description('Delete an entry from the encrypted keystore')
  .requiredOption('--app-id <id>', 'App ID to remove')
  .action(async (opts: { appId: string }) => {
    await runSecretsRemove(opts.appId);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

function resolveAgentFlag(opts: { claude?: boolean; codex?: boolean }): 'claude' | 'codex' | undefined {
  if (opts.claude && opts.codex) {
    console.error('✗ --claude 和 --codex 不能同时指定');
    process.exit(1);
  }
  if (opts.codex) return 'codex';
  if (opts.claude) return 'claude';
  return undefined;
}
