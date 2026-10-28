'use strict';
// Drives the switch-remote MCP server over stdio and prints each result.
const { spawn } = require('child_process');
const fs = require('fs');

const server = process.argv[2];
const calls = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const env = Object.assign({}, process.env, JSON.parse(process.argv[4] || '{}'));

const p = spawn(process.execPath, [server], { env, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
p.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const msg = JSON.parse(line);
    const r = pending.get(msg.id); pending.delete(msg.id); r && r(msg);
  }
});
let id = 0;
const rpc = (method, params) => new Promise((r) => { const n = ++id; pending.set(n, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });

(async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  console.log('INIT', JSON.stringify(init.result.serverInfo), init.result.protocolVersion);
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await rpc('tools/list', {});
  console.log('TOOLS', list.result.tools.map((t) => t.name).join(', '));
  for (const [name, args] of calls) {
    const r = await rpc('tools/call', { name, arguments: args });
    const res = r.result || r.error;
    const parts = (res.content || []).map((c) => (c.type === 'image' ? `[image ${c.mimeType} ${Buffer.from(c.data, 'base64').length} bytes]` : c.text));
    console.log(`\n=== ${name} ${JSON.stringify(args)}${res.isError ? ' (ERROR)' : ''}\n${parts.join('\n') || JSON.stringify(res)}`);
  }
  p.stdin.end();
  setTimeout(() => process.exit(0), 300);
})();
