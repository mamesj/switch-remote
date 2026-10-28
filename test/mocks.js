'use strict';
// Mock sys-botbase (6000) and hbmenu netloader (28280) for testing switch-remote.
const net = require('net');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SD = process.argv[2];
const PEEK_MODE = process.argv[3] || 'ok'; // ok | refuse
const log = [];
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7), Buffer.from([0xff, 0xd9])]);

net.createServer((s) => {
  let buf = '';
  s.on('data', (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      log.push(line);
      fs.appendFileSync(path.join(SD, '..', 'botbase.log'), line + '\n');
      const [verb, ...args] = line.split(' ');
      if (verb === 'getVersion') s.write('2.5\n');
      else if (verb === 'getTitleID') s.write('0100000000001000\n');
      else if (verb === 'charge') s.write('87\n');
      else if (verb === 'pixelPeek') s.write(PEEK_MODE === 'ok' ? jpg.toString('hex').toUpperCase() + '\n' : '\n');
      else if (verb === 'isProgramRunning') s.write('1\n');
      else if (verb === 'click' && args[0] === 'CAPTURE') {
        const day = path.join(SD, 'emuMMC/RAW1/Nintendo/Album/2026/10/28');
        fs.mkdirSync(day, { recursive: true });
        setTimeout(() => fs.writeFileSync(path.join(day, `20261028103000${String(Date.now() % 100).padStart(2, '0')}-ABCDEF.jpg`), jpg), 400);
      }
    }
  });
  s.on('error', () => {});
}).listen(6000, '127.0.0.1');

// netloader: same wire format as nx-hbmenu loadnro()
net.createServer((s) => {
  let buf = Buffer.alloc(0);
  let stage = 0, namelen = 0, name = '', filelen = 0, inflate = null, out = [];
  const need = async (n) => {
    while (buf.length < n) await new Promise((r) => s.once('data', (c) => { buf = Buffer.concat([buf, c]); r(); }));
    const v = buf.subarray(0, n); buf = buf.subarray(n); return v;
  };
  (async () => {
    namelen = (await need(4)).readInt32LE(0);
    name = (await need(namelen)).toString();
    filelen = (await need(4)).readInt32LE(0);
    s.write(Buffer.from([0, 0, 0, 0]));
    const parts = [];
    let got = 0;
    // read chunks until the inflated size matches
    const zchunks = [];
    while (true) {
      const len = (await need(4)).readInt32LE(0);
      if (len > 16384) throw new Error('chunk too big ' + len);
      zchunks.push(await need(len));
      try { const d = zlib.inflateSync(Buffer.concat(zchunks)); if (d.length === filelen) { parts.push(d); break; } } catch { /* incomplete */ }
    }
    const data = parts[0];
    const dest = path.join(SD, 'switch', name);
    if (!fs.existsSync(path.dirname(dest))) { /* real hbmenu fails here */ }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    s.write(Buffer.from([0, 0, 0, 0]));
    const cmdlen = (await need(4)).readInt32LE(0);
    const args = cmdlen ? (await need(cmdlen)).toString().split('\0').filter(Boolean) : [];
    fs.writeFileSync(path.join(SD, '..', 'netloader.json'), JSON.stringify({ name, filelen, args, ok: data.length === filelen }));
    s.end();
    // the launched app connects back for stdio
    setTimeout(() => {
      const c = net.createConnection({ host: '127.0.0.1', port: 28771 }, () => {
        c.write('hello from the switch\n');
        setTimeout(() => { c.write('frame 60 ok\n'); c.end(); }, 300);
      });
      c.on('error', (e) => fs.writeFileSync(path.join(SD, '..', 'stdio-err.txt'), String(e)));
    }, 200);
  })().catch((e) => { fs.writeFileSync(path.join(SD, '..', 'netloader-err.txt'), String(e.stack)); s.destroy(); });
  s.on('error', () => {});
}).listen(28280, '127.0.0.1');

console.log('mocks up');
