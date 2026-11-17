// mcp-client.mjs — start an Axona MCP server as a child and call its tools.
// Newline-delimited JSON-RPC over stdio. Used by the test runner.
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

export function startMcp(script, env, { log = () => {}, onExit = () => {} } = {}) {
  const srv = spawn(process.execPath, [script], { cwd: dirname(dirname(script)), env: { ...process.env, MCP_INBOX: 'off', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 0, buf = ''; const pending = new Map();
  srv.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } } catch { log({ nonJson: line.slice(0, 160) }); }
    }
  });
  srv.stderr.on('data', (d) => { const s = String(d); if (!s.includes('ice-pair')) log({ server: s.slice(0, 300) }); });
  srv.on('exit', (code, signal) => onExit(code, signal));
  const rpc = (method, params, ms = 90_000) => new Promise((res, rej) => {
    const id = ++nextId;
    const t = setTimeout(() => { pending.delete(id); rej(new Error('rpc timeout ' + method)); }, ms);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const callTool = async (name, args) => {
    const m = await rpc('tools/call', { name, arguments: args || {} });
    return m.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(m.error ?? m.result ?? {});
  };
  const init = async (clientName, version) => {
    const r = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: clientName, version } });
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return r.result?.serverInfo ?? null;
  };
  return { rpc, callTool, init, stop: () => { try { srv.kill('SIGTERM'); } catch { /* gone */ } } };
}
