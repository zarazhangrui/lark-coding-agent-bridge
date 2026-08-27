import { platform } from 'node:os';
import { t } from '../../i18n';
import { resolveAppPaths } from '../../config/app-paths';
import { isAlive } from '../../runtime/registry';
import { spawnProcess } from '../../platform/spawn';
import { readUiSidecar } from '../../ui/sidecar';

export interface RunUiOptions {
  /** Accepted for compatibility; the console is a single machine-wide process. */
  profile?: string;
  /** Print the URL instead of launching a browser. */
  print?: boolean;
}

/**
 * Open the running supervisor's management console in the browser. The console
 * is hosted by the single supervisor process (one per machine) and advertises
 * its URL + token in a host-level sidecar. If no supervisor is running, guide
 * the user to start one.
 */
export async function runUi(opts: RunUiOptions = {}): Promise<void> {
  const rootDir = process.env.LARK_CHANNEL_HOME;
  const appPaths = resolveAppPaths({ rootDir });

  const sidecar = await readUiSidecar(appPaths.hostUiFile);
  if (sidecar && isAlive(sidecar.pid)) {
    if (opts.print) {
      console.log(sidecar.url);
      return;
    }
    console.log(t('ui.opening', { url: sidecar.url }));
    openBrowser(sidecar.url);
    return;
  }

  console.error(t('ui.noConsole'));
  process.exitCode = 1;
}

/** Best-effort cross-platform "open this URL in the default browser". */
function openBrowser(url: string): void {
  const os = platform();
  const [cmd, args] =
    os === 'darwin'
      ? ['open', [url]]
      : os === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawnProcess(cmd as string, args as string[], { stdio: 'ignore' });
    child.on('error', () => {
      console.log(t('ui.browserNotOpened'));
    });
    child.unref?.();
  } catch {
    console.log(t('ui.browserOpenFailed'));
  }
}
