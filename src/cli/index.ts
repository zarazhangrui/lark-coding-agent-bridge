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
import { runUi } from './commands/ui';
import {
  runCodexTaskCreate,
  runCodexTaskInit,
  runCodexTaskList,
  runCodexTaskRead,
  runCodexTaskSend,
} from './commands/codex-task';

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
  .option('--web-ui', 'run the machine-wide supervisor + local web console (hosts all profiles); default is a single-profile headless run')
  .option('--agent <kind>', 'agent kind for a new profile (claude or codex)')
  .option('--codex-transport <transport>', 'Codex transport for a new profile (exec or app-server; default exec)')
  .option('--workspace <path>', 'initial working directory for first-run profile bootstrap')
  .option('--app-id <id>', 'use an existing Lark/Feishu app instead of QR app creation')
  .option('--app-secret <secret>', 'App Secret for --app-id; prefer interactive input on shared machines')
  .option('--tenant <tenant>', 'tenant for --app-id (feishu or lark; default feishu)')
  .option('--skip-check-lark-cli', 'skip lark-cli pre-flight check (auto-install + bind)')
  .action(async (opts: {
    config?: string;
    profile?: string;
    webUi?: boolean;
    agent?: string;
    codexTransport?: string;
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
  .option('--agent <kind>', 'agent kind for legacy v1 profile migration (claude or codex)')
  .option('--codex-transport <transport>', 'Codex transport for the migrated profile (exec or app-server; default exec)')
  .action(async (opts: { config?: string; profile?: string; agent?: string; codexTransport?: string }) => {
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

const codexTask = program
  .command('codex-task')
  .description('Manage persistent Codex worker tasks for a controller workspace');

codexTask
  .command('init')
  .description('Install the controller AGENTS.md and repo-scoped Skill into a workspace')
  .option('-c, --config <path>', 'path to Bridge root config file')
  .option('--profile <name>', 'Codex profile (defaults to LARK_CHANNEL_PROFILE or active profile)')
  .option('--workspace <path>', 'controller workspace (defaults to the profile workspace)')
  .option('--force', 'overwrite existing controller AGENTS.md and Skill')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { config?: string; profile?: string; workspace?: string; force?: boolean; json?: boolean }) => {
    await runCodexTaskInit(opts);
  });

codexTask
  .command('list')
  .description('List worker tasks registered by this profile')
  .option('-c, --config <path>', 'path to Bridge root config file')
  .option('--profile <name>', 'Codex profile (defaults to LARK_CHANNEL_PROFILE or active profile)')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: { config?: string; profile?: string; json?: boolean }) => {
    await runCodexTaskList(opts);
  });

codexTask
  .command('create')
  .description('Reserve a Codex worker task and optionally run its first turn')
  .requiredOption('--title <title>', 'user-facing task title')
  .requiredOption('--cwd <path>', 'absolute worker working directory')
  .option('-c, --config <path>', 'path to Bridge root config file')
  .option('--model <slug>', 'per-task model override')
  .option('--message <text>', 'optional first instruction; waits for the turn to finish')
  .option('--profile <name>', 'Codex profile (defaults to LARK_CHANNEL_PROFILE or active profile)')
  .option('--json', 'print machine-readable JSON')
  .action(async (opts: {
    title: string;
    cwd: string;
    model?: string;
    message?: string;
    config?: string;
    profile?: string;
    json?: boolean;
  }) => {
    await runCodexTaskCreate(opts);
  });

codexTask
  .command('read <handle>')
  .description('Read a registered task without resuming it')
  .option('-c, --config <path>', 'path to Bridge root config file')
  .option('--limit <count>', 'maximum recent conversation messages to print (1-50)', '5')
  .option('--profile <name>', 'Codex profile (defaults to LARK_CHANNEL_PROFILE or active profile)')
  .option('--json', 'print filtered machine-readable task metadata and conversation text')
  .action(async (handle: string, opts: { config?: string; limit?: string; profile?: string; json?: boolean }) => {
    await runCodexTaskRead(handle, opts);
  });

codexTask
  .command('send <handle>')
  .description('Materialize or resume a registered task and wait for completion')
  .option('-c, --config <path>', 'path to Bridge root config file')
  .requiredOption('--message <text>', 'instruction to send')
  .option('--model <slug>', 'per-turn model override, persisted for later sends')
  .option('--profile <name>', 'Codex profile (defaults to LARK_CHANNEL_PROFILE or active profile)')
  .option('--json', 'print machine-readable JSON')
  .action(async (handle: string, opts: {
    message: string;
    model?: string;
    config?: string;
    profile?: string;
    json?: boolean;
  }) => {
    await runCodexTaskSend(handle, opts);
  });

profile
  .command('create <name>')
  .description('Create a profile from QR registration or existing app credentials')
  .option('--agent <kind>', 'agent kind (claude or codex)')
  .option('--codex-transport <transport>', 'Codex transport (exec or app-server; default exec)')
  .option('--workspace <path>', 'initial working directory for this profile')
  .option('--app-id <id>', 'use an existing Lark/Feishu app instead of QR app creation')
  .option('--app-secret <secret>', 'App Secret for --app-id; prefer interactive input on shared machines')
  .option('--tenant <tenant>', 'tenant for --app-id (feishu or lark; default feishu)')
  .action(async (name: string, opts: {
    agent?: string;
    codexTransport?: string;
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
  .command('ui')
  .description('Open the local web console (config, profiles, online bots) in your browser')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--print', 'print the URL instead of opening a browser')
  .action(async (opts: { profile?: string; print?: boolean }) => {
    await runUi(opts);
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
  .option('--web-ui', 'run the supervisor + web console as the background service (hosts all profiles) instead of a single profile')
  .option('--agent <kind>', 'agent kind for first-run profile bootstrap (claude or codex)')
  .option('--codex-transport <transport>', 'Codex transport for first-run profile bootstrap (exec or app-server; default exec)')
  .option('--workspace <path>', 'initial working directory for first-run profile bootstrap')
  .option('--app-id <id>', 'use an existing Lark/Feishu app instead of QR app creation')
  .option('--app-secret <secret>', 'App Secret for --app-id; prefer interactive input on shared machines')
  .option('--tenant <tenant>', 'tenant for --app-id (feishu or lark; default feishu)')
  .option('--skip-check-lark-cli', 'skip lark-cli pre-flight check (auto-install + bind)')
  .action(async (opts: {
    profile?: string;
    webUi?: boolean;
    agent?: string;
    codexTransport?: string;
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
  .description('Stop the OS-managed daemon and disable autostart (service definition stays)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--web-ui', 'target the supervisor service (auto-detected when no per-profile service exists)')
  .action(async (opts: { profile?: string; webUi?: boolean }) => {
    await runServiceStop({ profile: opts.profile, webUi: opts.webUi });
  });

program
  .command('restart')
  .description('Restart the OS-managed daemon')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--web-ui', 'target the supervisor service instead of a per-profile one')
  .action(async (opts: { profile?: string; webUi?: boolean }) => {
    await runServiceRestart({ profile: opts.profile, webUi: opts.webUi });
  });

program
  .command('status')
  .description('Show OS service status (pid, last exit, log paths)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--web-ui', 'target the supervisor service instead of a per-profile one')
  .action(async (opts: { profile?: string; webUi?: boolean }) => {
    await runServiceStatus({ profile: opts.profile, webUi: opts.webUi });
  });

program
  .command('unregister')
  .description('Remove the OS service registration (bootout + delete plist)')
  .option('--profile <name>', 'profile name (defaults to active profile)')
  .option('--web-ui', 'target the supervisor service instead of a per-profile one')
  .action(async (opts: { profile?: string; webUi?: boolean }) => {
    await runServiceUnregister({ profile: opts.profile, webUi: opts.webUi });
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
    process.exit(process.exitCode && process.exitCode !== 0 ? process.exitCode : 1);
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
  process.exit(process.exitCode && process.exitCode !== 0 ? process.exitCode : 1);
});
