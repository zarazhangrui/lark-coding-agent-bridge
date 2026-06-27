import { Command } from 'commander';
import pkg from '../../package.json';
import { formatAgentPreflightDiagnostic, getAgentPreflightDiagnostic } from '../agent/preflight';
import { runMigrate } from './commands/migrate';
import { runKillCli, runPs } from './commands/ps';
import {
  runSecretsGet,
  runSecretsList,
  runSecretsRemove,
  runSecretsSet,
} from './commands/secrets';
import {
  runProfileCreate,
  runProfileExport,
  runProfileList,
  runProfileRemove,
  runProfileUse,
} from './commands/profile';
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
  .option('--profile <name>', 'profile name to run')
  .option('--agent <kind>', 'agent kind for a new profile (claude, codex, or pi)')
  .option('--workspace <path>', 'initial working directory for first-run profile bootstrap')
  .option('--app-id <id>', 'use an existing Lark/Feishu app instead of QR app creation')
  .option('--app-secret <secret>', 'App Secret for --app-id; prefer interactive input on shared machines')
  .option('--tenant <tenant>', 'tenant for --app-id (feishu or lark; default feishu)')
  .option('--skip-check-lark-cli', 'skip lark-cli pre-flight check (auto-install + bind)')
  .action(async (opts: {
    config?: string;
    profile?: string;
    agent?: string;
    workspace?: string;
    appId?: string;
    appSecret?: string;
    tenant?: string;
    skipCheckLarkCli?: boolean;
  }) => {
    await runStart(opts);
  });

program
  .command('migrate')
  .description('Migrate legacy bridge config/state into the current profile layout')
  .option('-c, --config <path>', 'path to config file')
  .option('--profile <name>', 'target profile name for legacy v1 config migration')
  .option('--agent <kind>', 'agent kind for legacy v1 profile migration (claude, codex, or pi)')
  .action(async (opts: { config?: string; profile?: string; agent?: string }) => {
    await runMigrate(opts);
  });

const profile = program
  .command('profile')
  .description('Manage local bridge profiles');

profile
  .command('list')
  .description('List configured profiles')
  .action(async () => {
    await runProfileList();
  });

profile
  .command('create <name>')
  .description('Create a profile from QR registration or existing app credentials')
  .option('--agent <kind>', 'agent kind (claude, codex, or pi)')
  .option('--workspace <path>', 'initial working directory for this profile')
  .option('--app-id <id>', 'use an existing Lark/Feishu app instead of QR app creation')
  .option('--app-secret <secret>', 'App Secret for --app-id; prefer interactive input on shared machines')
  .option('--tenant <tenant>', 'tenant for --app-id (feishu or lark; default feishu)')
  .action(async (name: string, opts: {
    agent?: string;
    workspace?: string;
    appId?: string;
    appSecret?: string;
    tenant?: string;
  }) => {
    await runProfileCreate(name, opts);
  });

profile
  .command('use <name>')
  .description('Set the active profile')
  .action(async (name: string) => {
    await runProfileUse(name);
  });

profile
  .command('remove <name>')
  .description('Archive a profile and its local state')
  .option('--purge', 'permanently delete profile state instead of archiving')
  .option('--yes', 'confirm destructive profile deletion')
  .action(async (name: string, opts: { purge?: boolean; yes?: boolean }) => {
    await runProfileRemove(name, { purge: opts.purge, yes: opts.yes });
  });

profile
  .command('export <name>')
  .description('Export one profile as JSON')
  .option('--output <path>', 'write export JSON to a file instead of stdout')
  .option('--force', 'overwrite an existing output file')
  .option('--include-secrets', 'include secret provider configuration and app secret values')
  .option('--yes', 'confirm exporting secrets')
  .action(async (name: string, opts: {
    output?: string;
    force?: boolean;
    includeSecrets?: boolean;
    yes?: boolean;
  }) => {
    await runProfileExport(name, {
      output: opts.output,
      force: opts.force,
      includeSecrets: opts.includeSecrets,
      yes: opts.yes,
    });
  });

program
  .command('ps')
  .description('List running bridge processes on this machine')
  .action(() => {
    runPs();
  });

program
  .command('kill <target>')
  .description('Kill a running bridge process by short id or list index (SIGTERM, then SIGKILL after 2s). Was `stop <target>` in older versions.')
  .action(async (target: string) => {
    await runKillCli(target);
  });

// === service-level commands (OS-managed daemon: launchd/systemd/schtasks) ===

program
  .command('start')
  .description('Install (if needed) and start the bridge as an OS-managed daemon')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--agent <kind>', 'agent kind for first-run profile bootstrap (claude, codex, or pi)')
  .option('--workspace <path>', 'initial working directory for first-run profile bootstrap')
  .option('--app-id <id>', 'use an existing Lark/Feishu app instead of QR app creation')
  .option('--app-secret <secret>', 'App Secret for --app-id; prefer interactive input on shared machines')
  .option('--tenant <tenant>', 'tenant for --app-id (feishu or lark; default feishu)')
  .option('--skip-check-lark-cli', 'skip lark-cli pre-flight check (auto-install + bind)')
  .action(async (opts: {
    profile?: string;
    agent?: string;
    workspace?: string;
    appId?: string;
    appSecret?: string;
    tenant?: string;
    skipCheckLarkCli?: boolean;
  }) => {
    await runServiceStart(opts);
  });

program
  .command('stop')
  .description('Stop the OS-managed daemon (unload from launchd; plist stays)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .action(async (opts: { profile?: string }) => {
    await runServiceStop({ profile: opts.profile });
  });

program
  .command('restart')
  .description('Restart the OS-managed daemon')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .action(async (opts: { profile?: string }) => {
    await runServiceRestart({ profile: opts.profile });
  });

program
  .command('status')
  .description('Show OS service status (pid, last exit, log paths)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .action(async (opts: { profile?: string }) => {
    await runServiceStatus({ profile: opts.profile });
  });

program
  .command('unregister')
  .description('Remove the OS service registration (bootout + delete plist)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .action(async (opts: { profile?: string }) => {
    await runServiceUnregister({ profile: opts.profile });
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
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .action(async (opts: { appId: string; profile?: string }) => {
    await runSecretsSet(opts.appId, { profile: opts.profile });
  });

secrets
  .command('list')
  .description('List the IDs of secrets in the encrypted keystore (no secrets shown)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .action(async (opts: { profile?: string }) => {
    await runSecretsList({ profile: opts.profile });
  });

secrets
  .command('remove')
  .description('Delete an entry from the encrypted keystore')
  .requiredOption('--app-id <id>', 'App ID to remove')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .action(async (opts: { appId: string; profile?: string }) => {
    await runSecretsRemove(opts.appId, { profile: opts.profile });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const diagnostic = getAgentPreflightDiagnostic(err);
  if (diagnostic) {
    console.error(formatAgentPreflightDiagnostic(diagnostic));
    process.exit(1);
  }
  if (err instanceof Error) {
    if (err.name === 'UserCancelledError') {
      console.log(err.message);
      process.exit(0);
    }
    console.error(`Error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
