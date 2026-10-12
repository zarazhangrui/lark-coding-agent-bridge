import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildCodexArgs } from '../../src/agent/codex/argv';

// Opt-in policy probe against an installed real binary, using a local fake API
// and a fresh home. It never sends user data or credentials to a model service.
it.skipIf(!process.env.BRIDGE_CODEX_POLICY_PROBE)('blocks writes and removes shell/apps/image tools in the real Codex runtime', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-policy-probe-'));
  await mkdir(join(cwd, 'codex'));
  let receive!: (value: unknown) => void;
  const received = new Promise<unknown>((resolve) => { receive = resolve; });
  let calls = 0;
  let toolOutput = '';
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url?.endsWith('/responses')) {
        if (calls++ === 0) {
          receive(data);
          const patch = `*** Begin Patch\n*** Add File: ${cwd}/forbidden.txt\n+must-not-exist\n*** End Patch`;
          const item = { type: 'custom_tool_call', id: 'ctc_probe', call_id: 'call_probe', name: 'exec', namespace: 'functions', input: `text(await tools.apply_patch(${JSON.stringify(patch)}));` };
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          for (const event of [{ type: 'response.output_item.done', output_index: 0, item },
            { type: 'response.completed', response: { id: 'probe', status: 'completed', output: [item] } }]) {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          }
          res.end(); return;
        }
        toolOutput = JSON.stringify((data.input ?? []).filter((i: { type: string }) => i.type.endsWith('_output')));
      }
    } catch { res.writeHead(426); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"probe","status":"completed","output":[]}}\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const args = buildCodexArgs({ cwd, sandbox: 'read-only', restrictedTask: { research: true } });
  args.splice(args.length - 1, 0, '-c', `openai_base_url="http://127.0.0.1:${address.port}/v1"`);
  const child = spawn(process.env.BRIDGE_CODEX_POLICY_PROBE_BINARY ?? 'codex', args, {
    cwd, env: { PATH: process.env.PATH, HOME: cwd, CODEX_HOME: join(cwd, 'codex'), OPENAI_API_KEY: 'local-fake-key', OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end('Say hello without using any tools.');
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data.toString(); });
  const exited = new Promise<never>((_, reject) => {
    child.on('exit', (code) => reject(new Error(`probe exited ${code}: ${stderr}`)));
    child.on('error', reject);
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const data = await Promise.race([received, exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`probe timed out: ${stderr}`)), 20_000);
    })]) as { tools?: Tool[]; input?: Array<{ tools?: Tool[] }> };
    interface Tool { type: string; name?: string; description?: string; function?: { name?: string }; tools?: Tool[] }
    const flatten = (tools: Tool[]): string[] => tools.flatMap((t) => t.tools ? flatten(t.tools) :
      [t.name ?? t.function?.name ?? t.type, ...[...(t.description ?? '').matchAll(/declare const tools: \{ ([A-Za-z0-9_]+)/g)].map((m) => m[1]!)]);
    const names = flatten([...(data.tools ?? []), ...(data.input ?? []).flatMap((i) => i.tools ?? [])]);
    console.log('Restricted Codex tool inventory:', names);
    expect(names.some((name) => /exec_command|shell|view_image|mcp__|spawn_agent|imagegen/.test(name))).toBe(false);
    expect(names.some((name) => /web_search|web__run/.test(name))).toBe(true);
    await exited.catch(() => undefined);
    expect(calls).toBeGreaterThan(1);
    expect(toolOutput).toContain('call_probe');
    console.log('patch denial evidence:', toolOutput);
    expect(toolOutput).toMatch(/rejected|denied|read.only|not.*permitted/i);
    await expect(access(join(cwd, 'forbidden.txt'))).rejects.toThrow();
  } finally {
    clearTimeout(timer); child.kill('SIGTERM'); server.closeAllConnections(); server.close();
    await exited.catch(() => undefined);
  }
}, 30_000);
