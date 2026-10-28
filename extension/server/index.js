#!/usr/bin/env node
'use strict';

// Switch Remote: an MCP server that lets Claude drive a modded Switch over the LAN.
//   sys-botbase (TCP 6000)  buttons, sticks, touch, screenshots, raw commands
//   ftpsrv sysmodule (FTP)  read/write files on the SD card
//   hbmenu netloader        send and launch .nro builds (nxlink protocol, port 28280)
//   nxlink stdio (28771)    collect printf output from launched homebrew
// No dependencies: only Node built-ins.

const net = require('net');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const os = require('os');

const VERSION = '0.2.0';
const NETLOADER_PORT = 28280;
const NXLINK_STDIO_PORT = 28771;

function intEnv(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function cleanEnv(name) {
  let v = (process.env[name] || '').trim();
  // Folder placeholders can arrive unexpanded, e.g. "${HOME}/Documents".
  const home = os.homedir();
  const dirs = { HOME: home, DOCUMENTS: path.join(home, 'Documents'), DOWNLOADS: path.join(home, 'Downloads'), DESKTOP: path.join(home, 'Desktop') };
  v = v.replace(/\$\{(HOME|DOCUMENTS|DOWNLOADS|DESKTOP)\}/g, (_, k) => dirs[k]);
  // Unfilled manifest placeholders arrive literally; treat them as empty.
  return /^\$\{.*\}$/.test(v) ? '' : v;
}

const CFG = {
  ip: cleanEnv('SWITCH_IP'),
  botbasePort: intEnv('BOTBASE_PORT', 6000),
  ftpPort: intEnv('FTP_PORT', 5000),
  ftpUser: cleanEnv('FTP_USER'),
  ftpPass: cleanEnv('FTP_PASS'),
  workDir: path.resolve(cleanEnv('WORK_DIR') || path.join(os.homedir(), 'Documents')),
  allowBuilds: /^(1|true|yes)$/i.test(cleanEnv('ALLOW_BUILDS')),
  wslDistro: cleanEnv('WSL_DISTRO') || 'Ubuntu-24.04',
};

function log(...a) {
  process.stderr.write('[switch-remote] ' + a.join(' ') + '\n');
}

class UserError extends Error {}

function needIp() {
  if (!CFG.ip) throw new UserError('No Switch IP set. Add it in the extension settings (Settings > Extensions > Switch Remote).');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Simple async mutex so tool calls that share a connection never interleave.
class Lock {
  constructor() { this.p = Promise.resolve(); }
  run(fn) {
    const next = this.p.then(fn, fn);
    this.p = next.catch(() => {});
    return next;
  }
}

// ---------------------------------------------------------------- local paths

function toWindowsIfWsl(p) {
  if (process.platform !== 'win32') return p;
  const m = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(p);
  return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}` : p;
}

function within(child, parent) {
  const c = process.platform === 'win32' ? child.toLowerCase() : child;
  const pa = process.platform === 'win32' ? parent.toLowerCase() : parent;
  return c === pa || c.startsWith(pa.endsWith(path.sep) ? pa : pa + path.sep);
}

// Resolve a local path and make sure it stays inside the work folder.
async function localPath(p, { mustExist = false } = {}) {
  if (!p || typeof p !== 'string') throw new UserError('A local path is required.');
  const resolved = path.resolve(CFG.workDir, toWindowsIfWsl(p.trim()));
  let real = resolved;
  try {
    real = await fsp.realpath(resolved);
  } catch {
    if (mustExist) throw new UserError(`Local file not found: ${resolved}`);
    try {
      real = path.join(await fsp.realpath(path.dirname(resolved)), path.basename(resolved));
    } catch { /* parent will be created later */ }
  }
  let root = CFG.workDir;
  try { root = await fsp.realpath(CFG.workDir); } catch { /* keep as is */ }
  if (!within(real, root)) {
    throw new UserError(`${resolved} is outside the work folder (${CFG.workDir}). Change "Work folder" in the extension settings to allow it.`);
  }
  return real;
}

function stamp() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

// ---------------------------------------------------------------- sys-botbase

const RESPONDING = new Set([
  'peek', 'peekMulti', 'peekAbsolute', 'peekAbsoluteMulti', 'peekMain', 'peekMainMulti',
  'game', 'getTitleID', 'getTitleVersion', 'getSystemLanguage', 'getMainNsoBase', 'getBuildID',
  'getHeapBase', 'isProgramRunning', 'pixelPeek', 'getVersion', 'pointer', 'pointerAll',
  'pointerRelative', 'pointerPeek', 'pointerPeekMulti', 'charge', 'fdCount', 'freezeCount',
]);

class Botbase {
  constructor() {
    this.sock = null;
    this.buf = '';
    this.waiters = [];
    this.lock = new Lock();
  }

  async connect() {
    needIp();
    if (this.sock && !this.sock.destroyed) return;
    this.sock = await new Promise((resolve, reject) => {
      const s = net.createConnection({ host: CFG.ip, port: CFG.botbasePort });
      const t = setTimeout(() => {
        s.destroy();
        reject(new UserError(`Can't reach sys-botbase at ${CFG.ip}:${CFG.botbasePort}. Is the Switch awake, on Wi-Fi, and was it rebooted after installing sys-botbase?`));
      }, 4000);
      s.once('connect', () => { clearTimeout(t); resolve(s); });
      s.once('error', (e) => {
        clearTimeout(t);
        reject(new UserError(`Can't reach sys-botbase at ${CFG.ip}:${CFG.botbasePort} (${e.code || e.message}). Is the Switch awake and on Wi-Fi?`));
      });
    });
    this.sock.setNoDelay(true);
    this.sock.setKeepAlive(true, 10000);
    this.buf = '';
    this.sock.on('data', (chunk) => {
      this.buf += chunk.toString('latin1');
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        const w = this.waiters.shift();
        if (w) w.resolve(line);
      }
    });
    const drop = (err) => {
      for (const w of this.waiters.splice(0)) w.reject(err || new UserError('Connection to sys-botbase closed.'));
      this.sock = null;
    };
    this.sock.on('error', (e) => drop(new UserError(`sys-botbase connection error: ${e.code || e.message}`)));
    this.sock.on('close', () => drop());
  }

  async send(cmd) {
    await this.connect();
    this.sock.write(cmd + '\r\n');
  }

  async query(cmd, timeoutMs = 5000) {
    await this.connect();
    return new Promise((resolve, reject) => {
      const w = {};
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        // The reply may still arrive later and desync the stream, so start fresh.
        if (this.sock) this.sock.destroy();
        reject(new UserError(`sys-botbase did not answer "${cmd.split(' ')[0]}" within ${timeoutMs} ms.`));
      }, timeoutMs);
      w.resolve = (v) => { clearTimeout(t); resolve(v); };
      w.reject = (e) => { clearTimeout(t); reject(e); };
      this.waiters.push(w);
      this.sock.write(cmd + '\r\n');
    });
  }

  // Round trip so every earlier command has finished on the console.
  sync() { return this.query('getVersion', 8000); }
}

const bot = new Botbase();

const BUTTON_ALIASES = {
  A: 'A', B: 'B', X: 'X', Y: 'Y', L: 'L', R: 'R', ZL: 'ZL', ZR: 'ZR',
  PLUS: 'PLUS', START: 'PLUS', '+': 'PLUS', MINUS: 'MINUS', SELECT: 'MINUS',
  HOME: 'HOME', CAPTURE: 'CAPTURE', LSTICK: 'LSTICK', RSTICK: 'RSTICK', L3: 'LSTICK', R3: 'RSTICK',
  DUP: 'DUP', DU: 'DUP', UP: 'DUP', DDOWN: 'DDOWN', DD: 'DDOWN', DOWN: 'DDOWN',
  DLEFT: 'DLEFT', DL: 'DLEFT', LEFT: 'DLEFT', DRIGHT: 'DRIGHT', DR: 'DRIGHT', RIGHT: 'DRIGHT',
};

function button(name) {
  const b = BUTTON_ALIASES[String(name).toUpperCase()];
  if (!b) throw new UserError(`Unknown button "${name}". Use A B X Y L R ZL ZR PLUS MINUS HOME CAPTURE LSTICK RSTICK DUP DDOWN DLEFT DRIGHT.`);
  return b;
}

const STICK_DIRS = {
  CENTER: [0, 0], NEUTRAL: [0, 0], UP: [0, 32767], DOWN: [0, -32768], LEFT: [-32768, 0], RIGHT: [32767, 0],
  UPLEFT: [-23170, 23170], UPRIGHT: [23170, 23170], DOWNLEFT: [-23170, -23170], DOWNRIGHT: [23170, -23170],
};

function clampStick(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) throw new UserError(`Bad stick value "${v}".`);
  return Math.max(-32768, Math.min(32767, n));
}

// Turn "A, W500, +R, A, -R, stick L up, W300, stick L center, touch 640 360" into steps.
function parseSequence(seq) {
  const steps = [];
  for (const raw of String(seq).split(/[,;\n]+/)) {
    const tok = raw.trim();
    if (!tok) continue;
    let m;
    if ((m = /^(?:w|wait)\s*(\d+(?:\.\d+)?)\s*(ms|s)?$/i.exec(tok))) {
      const ms = m[2] && m[2].toLowerCase() === 's' ? Number(m[1]) * 1000 : Number(m[1]);
      steps.push({ op: 'wait', ms: Math.min(ms, 600000) });
    } else if ((m = /^(?:\+|hold\s+)(\w+)$/i.exec(tok))) {
      steps.push({ op: 'press', b: button(m[1]) });
    } else if ((m = /^(?:-|release\s+)(\w+)$/i.exec(tok))) {
      steps.push({ op: 'release', b: button(m[1]) });
    } else if ((m = /^stick\s*(l|r|left|right)\s+(.+)$/i.exec(tok))) {
      const side = m[1][0].toUpperCase() === 'L' ? 'LEFT' : 'RIGHT';
      const arg = m[2].trim().toUpperCase().replace(/[\s_-]+/g, '');
      let xy = STICK_DIRS[arg];
      if (!xy) {
        const nums = m[2].trim().split(/\s+/);
        if (nums.length !== 2) throw new UserError(`Bad stick step "${tok}". Use e.g. "stick L up" or "stick L 0 32767".`);
        xy = [clampStick(nums[0]), clampStick(nums[1])];
      }
      steps.push({ op: 'stick', side, x: xy[0], y: xy[1] });
    } else if ((m = /^touch\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/i.exec(tok))) {
      const x = Math.min(1279, Number(m[1]));
      const y = Math.min(719, Number(m[2]));
      steps.push(m[3] ? { op: 'touchHold', x, y, ms: Math.max(15, Number(m[3])) } : { op: 'touch', x, y });
    } else if ((m = /^([\w+]+)(?:\s*[x*]\s*(\d+))?$/i.exec(tok))) {
      const b = button(m[1]);
      const n = Math.min(Number(m[2] || 1), 100);
      for (let i = 0; i < n; i++) steps.push({ op: 'click', b });
    } else {
      throw new UserError(`Can't read step "${tok}".`);
    }
  }
  if (!steps.length) throw new UserError('The sequence is empty.');
  return steps;
}

async function runSequence(seq, gapMs, holdMs) {
  const steps = parseSequence(seq);
  const held = new Set();
  return bot.lock.run(async () => {
    if (holdMs) await bot.send(`configure buttonClickSleepTime ${Math.max(10, Math.min(2000, holdMs))}`);
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      switch (s.op) {
        case 'wait':
          await bot.sync();
          await sleep(s.ms);
          break;
        case 'click': await bot.send(`click ${s.b}`); break;
        case 'press': await bot.send(`press ${s.b}`); held.add(s.b); break;
        case 'release': await bot.send(`release ${s.b}`); held.delete(s.b); break;
        case 'stick': await bot.send(`setStick ${s.side} ${s.x} ${s.y}`); break;
        case 'touch': await bot.send(`touch ${s.x} ${s.y}`); break;
        case 'touchHold': await bot.send(`touchHold ${s.x} ${s.y} ${s.ms}`); break;
      }
      const next = steps[i + 1];
      if (gapMs && next && s.op !== 'wait' && next.op !== 'wait') {
        await bot.sync();
        await sleep(gapMs);
      }
    }
    await bot.sync();
    if (holdMs) await bot.send('configure buttonClickSleepTime 50');
    return { count: steps.length, held: [...held] };
  });
}

// ---------------------------------------------------------------- FTP client

class Ftp {
  constructor() {
    this.sock = null;
    this.buf = '';
    this.lines = [];
    this.wait = null;
  }

  static async open() {
    needIp();
    const f = new Ftp();
    await f.connect();
    return f;
  }

  async connect() {
    this.sock = await new Promise((resolve, reject) => {
      const s = net.createConnection({ host: CFG.ip, port: CFG.ftpPort });
      const t = setTimeout(() => { s.destroy(); reject(new UserError(`Can't reach the FTP sysmodule at ${CFG.ip}:${CFG.ftpPort}. Is ftpsrv installed and the Switch awake?`)); }, 5000);
      s.once('connect', () => { clearTimeout(t); resolve(s); });
      s.once('error', (e) => { clearTimeout(t); reject(new UserError(`Can't reach the FTP sysmodule at ${CFG.ip}:${CFG.ftpPort} (${e.code || e.message}).`)); });
    });
    this.sock.on('data', (c) => {
      this.buf += c.toString('utf8');
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        this.lines.push(this.buf.slice(0, i).replace(/\r$/, ''));
        this.buf = this.buf.slice(i + 1);
      }
      this.pump();
    });
    this.sock.on('error', () => {});
    this.sock.on('close', () => { if (this.wait) { const w = this.wait; this.wait = null; w.reject(new UserError('FTP connection closed.')); } });
    await this.reply(220);
    if (!CFG.ftpUser && !CFG.ftpPass) {
      await this.cmd('USER anonymous', [230, 331]).then((r) => (r.code === 331 ? this.cmd('PASS anonymous', 230) : r));
    } else {
      const r = await this.cmd(`USER ${CFG.ftpUser}`, [230, 331]);
      if (r.code === 331) await this.cmd(`PASS ${CFG.ftpPass}`, 230, 'FTP login failed. Check the FTP user and password in the extension settings match config.ini on the SD card.');
    }
    await this.cmd('TYPE I', 200);
  }

  // Collect one full reply (handles "123-" multi-line replies).
  pump() {
    if (!this.wait) return;
    let first = null;
    for (let i = 0; i < this.lines.length; i++) {
      const l = this.lines[i];
      if (first === null) {
        const m = /^(\d{3})([ -])/.exec(l);
        if (!m) continue;
        if (m[2] === ' ') {
          const lines = this.lines.splice(0, i + 1);
          const w = this.wait; this.wait = null;
          return w.resolve({ code: Number(m[1]), text: lines.join('\n') });
        }
        first = m[1];
      } else if (l.startsWith(first + ' ')) {
        const lines = this.lines.splice(0, i + 1);
        const w = this.wait; this.wait = null;
        return w.resolve({ code: Number(first), text: lines.join('\n') });
      }
    }
  }

  reply(expect, hint, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.wait = null; reject(new UserError('FTP server stopped answering.')); }, timeoutMs);
      this.wait = {
        resolve: (r) => {
          clearTimeout(t);
          const ok = expect == null || (Array.isArray(expect) ? expect.includes(r.code) : r.code === expect);
          if (ok) resolve(r);
          else reject(new UserError(hint ? `${hint} (${r.text.trim()})` : `FTP error: ${r.text.trim()}`));
        },
        reject: (e) => { clearTimeout(t); reject(e); },
      };
      this.pump();
    });
  }

  cmd(line, expect, hint) {
    const p = this.reply(expect, hint);
    this.sock.write(line + '\r\n');
    return p;
  }

  async dataSocket() {
    const r = await this.cmd('PASV', 227);
    const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(r.text);
    if (!m) throw new UserError(`Unexpected PASV reply: ${r.text}`);
    const port = Number(m[5]) * 256 + Number(m[6]);
    // Use the configured IP, not the one in the reply (servers sometimes report 0.0.0.0).
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: CFG.ip, port });
      const t = setTimeout(() => { s.destroy(); reject(new UserError('FTP data connection timed out.')); }, 8000);
      s.once('connect', () => { clearTimeout(t); resolve(s); });
      s.once('error', (e) => { clearTimeout(t); reject(new UserError(`FTP data connection failed (${e.code || e.message}).`)); });
    });
  }

  async download(remote) {
    const ds = await this.dataSocket();
    const chunks = [];
    const done = new Promise((resolve) => { ds.on('data', (c) => chunks.push(c)); ds.on('close', resolve); ds.on('error', resolve); });
    try {
      await this.cmd(`RETR ${remote}`, [125, 150], `Couldn't read ${remote}`);
    } catch (e) { ds.destroy(); throw e; }
    await done;
    await this.reply([226, 250]);
    return Buffer.concat(chunks);
  }

  async upload(remote, data) {
    const ds = await this.dataSocket();
    const closed = new Promise((resolve) => { ds.on('close', resolve); ds.on('error', resolve); });
    try {
      await this.cmd(`STOR ${remote}`, [125, 150], `Couldn't write ${remote}`);
    } catch (e) { ds.destroy(); throw e; }
    ds.end(data);
    await closed;
    await this.reply([226, 250]);
  }

  async list(dir) {
    const run = async (verb) => {
      const ds = await this.dataSocket();
      const chunks = [];
      const done = new Promise((resolve) => { ds.on('data', (c) => chunks.push(c)); ds.on('close', resolve); ds.on('error', resolve); });
      try {
        await this.cmd(`${verb} ${dir}`, [125, 150], `Couldn't list ${dir}`);
      } catch (e) { ds.destroy(); throw e; }
      await done;
      await this.reply([226, 250]);
      return Buffer.concat(chunks).toString('utf8').split(/\r?\n/).filter(Boolean);
    };
    try {
      return (await run('MLSD')).map((l) => {
        const sp = l.indexOf(' ');
        const facts = {};
        for (const f of l.slice(0, sp).split(';')) {
          const [k, v] = f.split('=');
          if (k) facts[k.toLowerCase()] = v;
        }
        return { name: l.slice(sp + 1), type: facts.type === 'dir' ? 'dir' : 'file', size: Number(facts.size || 0), modified: facts.modify || '' };
      }).filter((e) => e.name !== '.' && e.name !== '..');
    } catch (e) {
      if (!/MLSD|500|502|504/.test(String(e.message))) throw e;
      return (await run('LIST')).map((l) => {
        const parts = l.trim().split(/\s+/);
        return { name: parts.slice(8).join(' '), type: l[0] === 'd' ? 'dir' : 'file', size: Number(parts[4] || 0), modified: parts.slice(5, 8).join(' ') };
      }).filter((e) => e.name && e.name !== '.' && e.name !== '..');
    }
  }

  async mkdirs(dir) {
    let cur = '';
    for (const part of dir.split('/').filter(Boolean)) {
      cur += '/' + part;
      try { await this.cmd(`MKD ${cur}`, [257, 250, 550, 521]); } catch { /* exists or not allowed: STOR will say */ }
    }
  }

  async remove(remote) { await this.cmd(`DELE ${remote}`, [250, 200]); }

  async rename(from, to) {
    await this.cmd(`RNFR ${from}`, 350, `Couldn't find ${from}`);
    await this.cmd(`RNTO ${to}`, [250, 200], `Couldn't rename to ${to} (does it already exist?)`);
  }

  async exists(p) {
    try { await this.cmd(`MLST ${p}`, 250); return true; } catch { /* fall back */ }
    const parent = path.posix.dirname(p);
    try { return (await this.list(parent)).some((e) => e.name === path.posix.basename(p)); } catch { return false; }
  }

  // Every file under dir, as paths relative to it.
  async walk(dir, rel = '', out = [], depth = 0) {
    if (depth > 12) return out;
    for (const e of await this.list(dir + rel)) {
      const r = `${rel}/${e.name}`;
      if (e.type === 'dir') await this.walk(dir, r, out, depth + 1);
      else out.push({ rel: r.slice(1), size: e.size });
    }
    return out;
  }

  async close() {
    try { await Promise.race([this.cmd('QUIT', null), sleep(1500)]); } catch { /* ignore */ }
    if (this.sock) this.sock.destroy();
  }
}

async function withFtp(fn) {
  const f = await Ftp.open();
  try { return await fn(f); } finally { await f.close(); }
}

function sdPath(p) {
  if (!p || typeof p !== 'string') throw new UserError('An SD card path is required, e.g. /switch/my-app/game.log');
  let s = p.trim().replace(/\\/g, '/').replace(/^sdmc:/i, '');
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/$/, '');
  if (s.split('/').includes('..')) throw new UserError('".." is not allowed in SD card paths.');
  return s;
}

// Changes on the SD card stay inside /switch, where homebrew lives, so nothing
// here can touch Atmosphere, the bootloader or the emuMMC.
function sdWritable(p) {
  const s = sdPath(p);
  if (!/^\/switch\/[^/]/i.test(s)) throw new UserError(`${s}: changes are only allowed inside /switch on the SD card.`);
  return s;
}

// ---------------------------------------------------------------- screenshots

const ftpLock = new Lock();

async function albumRoot(f) {
  try {
    const ini = (await f.download('/emummc/emummc.ini')).toString('utf8');
    if (/^\s*enabled\s*=\s*1/m.test(ini)) {
      const m = /^\s*nintendo_path\s*=\s*(.+)$/m.exec(ini);
      if (m) return '/' + m[1].trim().replace(/^\/+|\/+$/g, '') + '/Album';
    }
  } catch { /* no emummc.ini: sysMMC */ }
  return '/Nintendo/Album';
}

async function newestChild(f, dir) {
  try {
    const dirs = (await f.list(dir)).filter((e) => e.type === 'dir' && /^\d+$/.test(e.name)).map((e) => e.name).sort();
    return dirs.length ? `${dir}/${dirs[dirs.length - 1]}` : null;
  } catch { return null; }
}

async function latestDay(f, root) {
  let d = root;
  for (let i = 0; i < 3; i++) {
    d = await newestChild(f, d);
    if (!d) return null;
  }
  return d;
}

async function jpgsIn(f, dir) {
  if (!dir) return [];
  try { return (await f.list(dir)).filter((e) => e.type === 'file' && /\.jpg$/i.test(e.name)).map((e) => `${dir}/${e.name}`); } catch { return []; }
}

async function captureViaAlbum() {
  return ftpLock.run(() => withFtp(async (f) => {
    const root = await albumRoot(f);
    const before = new Set(await jpgsIn(f, await latestDay(f, root)));
    await bot.lock.run(async () => { await bot.send('click CAPTURE'); await bot.sync(); });
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await sleep(700);
      const fresh = (await jpgsIn(f, await latestDay(f, root))).filter((p) => !before.has(p)).sort();
      if (fresh.length) {
        const file = fresh[fresh.length - 1];
        await sleep(300); // let the album finish writing
        const data = await f.download(file);
        let cleaned = true;
        try { await f.remove(file); } catch { cleaned = false; }
        return { data, note: cleaned ? 'taken with CAPTURE and removed from the album' : `taken with CAPTURE; could not remove ${file} from the album` };
      }
    }
    throw new UserError('Pressed CAPTURE but no new screenshot appeared in the album. Captures are refused on some screens (homebrew opened from the album, or before a game has drawn its first frame).');
  }));
}

async function screenshot(method) {
  let peekNote = '';
  if (method !== 'capture') {
    try {
      const hex = await bot.lock.run(() => bot.query('pixelPeek', 20000));
      if (hex && hex.length > 2000 && /^[0-9A-Fa-f]+$/.test(hex)) return { data: Buffer.from(hex, 'hex'), note: 'taken with pixelPeek' };
      peekNote = 'pixelPeek was refused by the console';
    } catch (e) {
      peekNote = `pixelPeek failed: ${e.message}`;
    }
    if (method === 'pixelpeek') throw new UserError(peekNote);
  }
  const r = await captureViaAlbum();
  return { data: r.data, note: peekNote ? `${r.note}; ${peekNote}` : r.note };
}

// ---------------------------------------------------------------- nxlink output

class StdioCollector {
  constructor() {
    this.server = null;
    this.chunks = [];
    this.cursor = 0;
    this.active = 0;
    this.logFile = null;
  }

  async start() {
    if (this.server) return;
    this.server = net.createServer((s) => {
      const from = (s.remoteAddress || '').replace(/^::ffff:/, '');
      if (CFG.ip && from !== CFG.ip) { s.destroy(); return; }
      this.active++;
      this.push(`\n[connected ${new Date().toLocaleTimeString()}]\n`);
      s.on('data', (c) => this.push(c.toString('utf8')));
      s.on('close', () => { this.active--; this.push(`\n[disconnected ${new Date().toLocaleTimeString()}]\n`); });
      s.on('error', () => {});
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', (e) => {
        this.server = null;
        reject(new UserError(`Can't listen for nxlink output on port ${NXLINK_STDIO_PORT} (${e.code}). Close any nxlink -s still running on this PC.`));
      });
      this.server.listen(NXLINK_STDIO_PORT, '0.0.0.0', resolve);
    });
  }

  newLog(name) {
    this.logFile = path.join(CFG.workDir, 'switch-remote', 'logs', `${stamp()}-${name.replace(/[^\w.-]+/g, '_')}.log`);
    try { fs.mkdirSync(path.dirname(this.logFile), { recursive: true }); } catch { this.logFile = null; }
  }

  push(text) {
    this.chunks.push(text);
    if (this.logFile) fs.appendFile(this.logFile, text, () => {});
    // keep memory bounded
    let total = this.chunks.reduce((n, c) => n + c.length, 0);
    while (total > 2_000_000 && this.chunks.length > 1) {
      total -= this.chunks.shift().length;
      this.cursor = Math.max(0, this.cursor - 1);
    }
  }

  readNew() {
    const out = this.chunks.slice(this.cursor).join('');
    this.cursor = this.chunks.length;
    return out;
  }
}

const stdio = new StdioCollector();

function readExact(sock, n, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => { cleanup(); reject(new UserError('The netloader stopped answering.')); }, timeoutMs);
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length >= n) {
        cleanup();
        if (buf.length > n) sock.unshift(buf.subarray(n));
        resolve(buf.subarray(0, n));
      }
    };
    const onEnd = () => { cleanup(); reject(new UserError('The netloader closed the connection.')); };
    const cleanup = () => { clearTimeout(t); sock.off('data', onData); sock.off('close', onEnd); sock.off('error', onEnd); };
    sock.on('data', onData);
    sock.on('close', onEnd);
    sock.on('error', onEnd);
  });
}

function int32(n) { const b = Buffer.alloc(4); b.writeInt32LE(n, 0); return b; }

const NETLOADER_ERRORS = { '-1': 'the Switch could not create the file (does the folder exist?)', '-2': 'not enough space on the SD card', '-3': 'not enough memory on the Switch' };

async function nxlinkSend(file, remoteName, args) {
  needIp();
  const data = await fsp.readFile(file);
  const sock = await new Promise((resolve, reject) => {
    const s = net.createConnection({ host: CFG.ip, port: NETLOADER_PORT });
    const t = setTimeout(() => { s.destroy(); reject(new UserError('The homebrew menu netloader is not listening. Open the homebrew menu (hold R while starting a game for full RAM) and press Y, then try again.')); }, 4000);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', (e) => { clearTimeout(t); reject(new UserError(`The homebrew menu netloader is not listening (${e.code}). Open the homebrew menu and press Y, then try again.`)); });
  });
  sock.setNoDelay(true);
  sock.on('error', () => {});
  try {
    const name = Buffer.from(remoteName, 'utf8');
    sock.write(Buffer.concat([int32(name.length), name, int32(data.length)]));
    const r1 = (await readExact(sock, 4, 10000)).readInt32LE(0);
    if (r1 !== 0) throw new UserError(`Netloader refused the file: ${NETLOADER_ERRORS[r1] || 'error ' + r1}.`);
    const z = zlib.deflateSync(data);
    const CH = 16 * 1024;
    for (let i = 0; i < z.length; i += CH) {
      const part = z.subarray(i, i + CH);
      if (!sock.write(Buffer.concat([int32(part.length), part]))) await new Promise((r) => sock.once('drain', r));
    }
    const r2 = (await readExact(sock, 4, 60000)).readInt32LE(0);
    if (r2 !== 0) throw new UserError(`Netloader reported error ${r2} after the transfer.`);
    const argBuf = Buffer.concat((args || []).map((a) => Buffer.from(String(a) + '\0', 'utf8')));
    sock.end(Buffer.concat([int32(argBuf.length), argBuf]));
    return { bytes: data.length, compressed: z.length };
  } finally {
    setTimeout(() => sock.destroy(), 2000);
  }
}

// ---------------------------------------------------------------- build scripts (opt-in)

const build = { proc: null, script: '', started: 0, exit: null, logFile: null, tail: [] };

function toWslPath(winPath) {
  const m = /^([a-zA-Z]):[\\/](.*)$/.exec(winPath);
  if (!m) throw new UserError(`Can't turn ${winPath} into a WSL path.`);
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

function buildSummary(lines = 40) {
  const secs = Math.round(((build.exit ? build.exit.at : Date.now()) - build.started) / 1000);
  const state = build.proc ? `still running (${secs}s so far)` : build.exit ? `finished in ${secs}s with exit code ${build.exit.code}` : 'not started';
  return [`Build ${path.basename(build.script)}: ${state}.`, build.logFile ? `Full output: ${build.logFile}` : '', '----', build.tail.slice(-lines).join('\n')].filter(Boolean).join('\n');
}

async function startBuild(script) {
  if (!CFG.allowBuilds) throw new UserError('Running build scripts is off. Turn on "Allow build scripts" in the extension settings to use this.');
  if (process.platform !== 'win32') throw new UserError('Build scripts run through WSL, so this only works on Windows.');
  if (build.proc) throw new UserError(`A build is already running (${path.basename(build.script)}). Check it with switch_build_status.`);
  const file = await localPath(script, { mustExist: true });
  if (!/\.sh$/i.test(file)) throw new UserError('Only .sh build scripts can be run.');
  const { spawn } = require('child_process');
  build.script = file;
  build.started = Date.now();
  build.exit = null;
  build.tail = [];
  build.logFile = path.join(CFG.workDir, 'switch-remote', 'logs', `${stamp()}-build-${path.basename(file, '.sh')}.log`);
  try { fs.mkdirSync(path.dirname(build.logFile), { recursive: true }); } catch { build.logFile = null; }
  toWslPath(file); // validate
  const p = spawn('wsl.exe', ['-d', CFG.wslDistro, '--cd', path.dirname(file), '-e', 'bash', path.basename(file)], { windowsHide: true });
  build.proc = p;
  let partial = '';
  const onOut = (c) => {
    const s = c.toString('utf8');
    if (build.logFile) fs.appendFile(build.logFile, s, () => {});
    partial += s;
    const parts = partial.split(/\r?\n/);
    partial = parts.pop();
    build.tail.push(...parts);
    if (build.tail.length > 400) build.tail.splice(0, build.tail.length - 400);
  };
  p.stdout.on('data', onOut);
  p.stderr.on('data', onOut);
  await new Promise((resolve, reject) => {
    p.once('spawn', resolve);
    p.once('error', (e) => { build.proc = null; reject(new UserError(`Couldn't start WSL (${e.message}).`)); });
  });
  p.once('close', (code) => {
    if (partial) build.tail.push(partial);
    build.exit = { code, at: Date.now() };
    build.proc = null;
  });
}

async function waitForBuild(seconds) {
  const end = Date.now() + seconds * 1000;
  while (build.proc && Date.now() < end) await sleep(500);
}

// ---------------------------------------------------------------- tools

function text(t) { return { content: [{ type: 'text', text: t }] }; }

const TOOLS = [
  {
    name: 'switch_status',
    description: 'Check the connection to the Switch: sys-botbase version, running title ID, battery, and whether the FTP sysmodule answers. Call this first in a session.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const lines = [`Switch ${CFG.ip || '(no IP set)'}`];
      try {
        const info = await bot.lock.run(async () => ({
          ver: await bot.query('getVersion'),
          title: await bot.query('getTitleID'),
          charge: await bot.query('charge'),
        }));
        lines.push(`sys-botbase ${info.ver} on port ${CFG.botbasePort}: OK`);
        lines.push(`Running title: ${info.title || 'none (HOME menu, or homebrew without a title)'}`);
        lines.push(`Battery: ${info.charge}%`);
      } catch (e) {
        lines.push(`sys-botbase: ${e.message}`);
      }
      try {
        const n = await ftpLock.run(() => withFtp(async (f) => (await f.list('/')).length));
        lines.push(`FTP on port ${CFG.ftpPort}: OK (${n} entries at SD root)`);
      } catch (e) {
        lines.push(`FTP: ${e.message}`);
      }
      lines.push(`Netloader output listener: ${stdio.server ? `listening on ${NXLINK_STDIO_PORT}` : 'not started yet'}`);
      lines.push(`Local work folder: ${CFG.workDir}`);
      lines.push(`Build scripts: ${CFG.allowBuilds ? `allowed (WSL distro ${CFG.wslDistro})` : 'off ("Allow build scripts" in the extension settings)'}`);
      return text(lines.join('\n'));
    },
  },
  {
    name: 'switch_press',
    description: [
      'Send controller input to the Switch as a comma-separated sequence. Steps:',
      '"A" click a button (A B X Y L R ZL ZR PLUS MINUS HOME CAPTURE LSTICK RSTICK, d-pad DUP DDOWN DLEFT DRIGHT or UP DOWN LEFT RIGHT);',
      '"A x3" click three times; "+R" hold, "-R" release; "W500" or "wait 2s" pause;',
      '"stick L up" / "stick R 0 -32768" / "stick L center" set a stick (range -32768..32767, y up is positive, stays until changed);',
      '"touch 640 360" tap the screen (1280x720 coordinates), "touch 640 360 800" press for 800 ms.',
      'Example: "HOME, W1500, +R, A, W300, -R" holds R while starting the selected game, which opens the homebrew menu with full RAM.',
      'Returns once every step has run on the console. Take a screenshot afterwards to see the result.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        sequence: { type: 'string', description: 'Steps separated by commas.' },
        gap_ms: { type: 'number', description: 'Pause between steps that have no explicit wait. Default 120.' },
        click_ms: { type: 'number', description: 'How long each click holds the button down. Default 50.' },
      },
      required: ['sequence'],
      additionalProperties: false,
    },
    async run({ sequence, gap_ms, click_ms }) {
      const r = await runSequence(sequence, gap_ms == null ? 120 : Math.max(0, Number(gap_ms)), click_ms ? Number(click_ms) : 0);
      return text(`Ran ${r.count} step${r.count === 1 ? '' : 's'}.${r.held.length ? ` Still holding: ${r.held.join(', ')}.` : ''}`);
    },
  },
  {
    name: 'switch_screenshot',
    description: 'Take a screenshot of what the Switch is showing (1280x720 JPEG). Tries sys-botbase pixelPeek first, then falls back to pressing CAPTURE and fetching the picture from the album over FTP (and deleting it from the album). Some screens refuse captures.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['auto', 'pixelpeek', 'capture'], description: 'Default auto.' },
        save_as: { type: 'string', description: 'Optional local path (relative to the work folder) to also save the JPEG.' },
      },
      additionalProperties: false,
    },
    async run({ method = 'auto', save_as }) {
      const r = await screenshot(method);
      let saved = '';
      if (save_as) {
        const p = await localPath(save_as);
        await fsp.mkdir(path.dirname(p), { recursive: true });
        await fsp.writeFile(p, r.data);
        saved = ` Saved to ${p}.`;
      }
      return { content: [{ type: 'image', data: r.data.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: `Screenshot ${Math.round(r.data.length / 1024)} KB, ${r.note}.${saved}` }] };
    },
  },
  {
    name: 'switch_list_files',
    description: 'List a folder on the Switch SD card over FTP, e.g. /switch/my-game',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    async run({ path: p }) {
      const dir = sdPath(p);
      const entries = await ftpLock.run(() => withFtp((f) => f.list(dir)));
      if (!entries.length) return text(`${dir} is empty.`);
      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      return text([`${dir}:`, ...entries.map((e) => (e.type === 'dir' ? `  [dir]  ${e.name}/` : `  ${String(e.size).padStart(10)}  ${e.modified}  ${e.name}`))].join('\n'));
    },
  },
  {
    name: 'switch_read_file',
    description: 'Read a file from the Switch SD card over FTP, e.g. a game.log. Text is returned (optionally only the last N lines); use save_to to keep a copy on the PC. Binary files must use save_to.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'SD card path, e.g. /switch/my-game/game.log' },
        tail_lines: { type: 'number', description: 'Only return the last N lines.' },
        save_to: { type: 'string', description: 'Optional local path (relative to the work folder) to save the file.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run({ path: p, tail_lines, save_to }) {
      const remote = sdPath(p);
      const data = await ftpLock.run(() => withFtp((f) => f.download(remote)));
      let saved = '';
      if (save_to) {
        const lp = await localPath(save_to);
        await fsp.mkdir(path.dirname(lp), { recursive: true });
        await fsp.writeFile(lp, data);
        saved = `Saved ${data.length} bytes to ${lp}.`;
      }
      let body = null;
      if (!data.includes(0)) {
        try { body = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { body = null; }
      }
      if (body === null) return text(saved || `${remote} is a binary file (${data.length} bytes). Use save_to to copy it to the PC.`);
      let note = `${remote}, ${data.length} bytes`;
      if (tail_lines) {
        const lines = body.split(/\r?\n/);
        if (lines[lines.length - 1] === '') lines.pop();
        body = lines.slice(-Math.max(1, Number(tail_lines))).join('\n');
        note += `, last ${Math.min(lines.length, Number(tail_lines))} of ${lines.length} lines`;
      } else if (body.length > 200_000) {
        body = body.slice(-200_000);
        note += ', showing the last 200 KB';
      }
      return text(`${note}${saved ? '. ' + saved : ''}\n----\n${body}`);
    },
  },
  {
    name: 'switch_write_file',
    description: 'Write a file inside /switch on the SD card over FTP, either from text (e.g. a test.txt) or by uploading a local file (e.g. a new .nro or a save state). Creates missing folders and overwrites an existing file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'SD card destination path.' },
        content: { type: 'string', description: 'Text to write.' },
        local_path: { type: 'string', description: 'Local file to upload instead of content (relative to the work folder or absolute inside it).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run({ path: p, content, local_path }) {
      const remote = sdWritable(p);
      if ((content == null) === (local_path == null)) throw new UserError('Give either content or local_path.');
      const data = content != null ? Buffer.from(content, 'utf8') : await fsp.readFile(await localPath(local_path, { mustExist: true }));
      await ftpLock.run(() => withFtp(async (f) => {
        await f.mkdirs(path.posix.dirname(remote));
        await f.upload(remote, data);
      }));
      return text(`Wrote ${data.length} bytes to ${remote}.`);
    },
  },
  {
    name: 'switch_move',
    description: 'Rename or move a file or folder inside /switch on the SD card, e.g. test-done.txt to test.txt, or an old test-results folder out of the way (test-results to test-results-round2) before a new round. The destination must not exist yet.',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    async run({ from, to }) {
      const a = sdWritable(from);
      const b = sdWritable(to);
      await ftpLock.run(() => withFtp(async (f) => {
        await f.mkdirs(path.posix.dirname(b));
        await f.rename(a, b);
      }));
      return text(`Moved ${a} to ${b}.`);
    },
  },
  {
    name: 'switch_download_folder',
    description: 'Copy a whole folder from the SD card to the PC, keeping its layout, e.g. /switch/my-game/test-results into "my-game/test-results", or /atmosphere/crash_reports. If the local folder already exists it is first renamed with a timestamp, unless if_exists is "merge".',
    inputSchema: {
      type: 'object',
      properties: {
        sd_path: { type: 'string' },
        local_path: { type: 'string', description: 'Destination folder, relative to the work folder.' },
        if_exists: { type: 'string', enum: ['rename', 'merge'], description: 'Default rename.' },
      },
      required: ['sd_path', 'local_path'],
      additionalProperties: false,
    },
    async run({ sd_path, local_path, if_exists = 'rename' }) {
      const remote = sdPath(sd_path);
      const dest = await localPath(local_path);
      if (dest === (await fsp.realpath(CFG.workDir).catch(() => CFG.workDir))) throw new UserError('Pick a folder inside the work folder, not the work folder itself.');
      let renamed = '';
      if (if_exists === 'rename' && fs.existsSync(dest) && fs.readdirSync(dest).length) {
        renamed = `${dest}-${stamp()}`;
        await fsp.rename(dest, renamed);
      }
      const r = await ftpLock.run(() => withFtp(async (f) => {
        const files = await f.walk(remote);
        let bytes = 0;
        const failed = [];
        for (const file of files) {
          const out = path.join(dest, ...file.rel.split('/'));
          try {
            const data = await f.download(`${remote}/${file.rel}`);
            await fsp.mkdir(path.dirname(out), { recursive: true });
            await fsp.writeFile(out, data);
            bytes += data.length;
          } catch (e) {
            failed.push(`${file.rel} (${e.message})`);
          }
        }
        return { files, bytes, failed };
      }));
      await fsp.mkdir(dest, { recursive: true });
      return text([
        `Copied ${r.files.length - r.failed.length} of ${r.files.length} files (${Math.round(r.bytes / 1024)} KB) from ${remote} to ${dest}.`,
        renamed ? `The folder that was already there is now ${renamed}.` : '',
        r.failed.length ? `Not copied (a file still open on the Switch can't be read):\n  ${r.failed.join('\n  ')}` : '',
      ].filter(Boolean).join('\n'));
    },
  },
  {
    name: 'switch_wait_for_file',
    description: 'Wait until a file exists on the SD card (and optionally contains some text), checking every 2 seconds. Useful for waiting on a test run, e.g. until test-results/progress.txt mentions the last run. Returns the file content when it matches.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        contains: { type: 'string', description: 'Text the file must contain.' },
        timeout_seconds: { type: 'number', description: 'Default 120, max 900.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run({ path: p, contains, timeout_seconds }) {
      const remote = sdPath(p);
      const end = Date.now() + Math.min(900, Number(timeout_seconds) || 120) * 1000;
      let last = '';
      while (Date.now() < end) {
        try {
          const body = await ftpLock.run(() => withFtp((f) => f.download(remote)));
          last = body.toString('utf8');
          if (!contains || last.includes(contains)) return text(`${remote} is ready.\n----\n${last.slice(-20000)}`);
        } catch (e) {
          if (/reach/i.test(e.message)) last = `(Switch not reachable: ${e.message})`;
        }
        await sleep(2000);
      }
      return { content: [{ type: 'text', text: `Timed out waiting for ${remote}${contains ? ` to contain "${contains}"` : ''}.${last ? `\nLast seen:\n${last.slice(-4000)}` : ''}` }], isError: true };
    },
  },
  {
    name: 'switch_run_build',
    description: 'Run a .sh build script from the work folder through WSL (only when "Allow build scripts" is on in the extension settings), e.g. "my-game/build-switch.sh". Waits up to wait_seconds, then returns the end of the output; check longer builds with switch_build_status.',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Path to the .sh file, relative to the work folder.' },
        wait_seconds: { type: 'number', description: 'Default 600, max 1800.' },
      },
      required: ['script'],
      additionalProperties: false,
    },
    async run({ script, wait_seconds }) {
      await startBuild(script);
      await waitForBuild(Math.min(1800, wait_seconds == null ? 600 : Number(wait_seconds)));
      return text(buildSummary());
    },
  },
  {
    name: 'switch_build_status',
    description: 'Show the state and the last lines of output of the build started with switch_run_build.',
    inputSchema: { type: 'object', properties: { wait_seconds: { type: 'number', description: 'Wait up to this long for it to finish first. Default 0.' }, lines: { type: 'number', description: 'Lines of output to show. Default 40.' } }, additionalProperties: false },
    async run({ wait_seconds, lines }) {
      if (!build.started) return text('No build has been started in this session.');
      if (wait_seconds) await waitForBuild(Math.min(1800, Number(wait_seconds)));
      return text(buildSummary(Math.min(400, Number(lines) || 40)));
    },
  },
  {
    name: 'switch_launch_nro',
    description: 'Send a local .nro build to the Switch and launch it through the homebrew menu netloader (the nxlink protocol). The homebrew menu must be open with the netloader active (press Y in it). The file is written under /switch on the SD card. Output the app prints after calling nxlinkStdio() is collected and returned; read more later with switch_read_output.',
    inputSchema: {
      type: 'object',
      properties: {
        local_path: { type: 'string', description: 'The .nro on this PC (relative to the work folder or absolute inside it; /mnt/c/... WSL paths work).' },
        sd_path: { type: 'string', description: 'Where to put it under /switch, e.g. /switch/my-game/test.nro. Default: /switch/<file name>.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra command-line arguments for the app.' },
        wait_seconds: { type: 'number', description: 'How long to collect output before returning. Default 5, max 120.' },
      },
      required: ['local_path'],
      additionalProperties: false,
    },
    async run({ local_path, sd_path, args, wait_seconds }) {
      const file = await localPath(local_path, { mustExist: true });
      let rel = sd_path ? sdPath(sd_path) : `/switch/${path.basename(file)}`;
      if (!/^\/switch\//i.test(rel)) throw new UserError('sd_path must be inside /switch (the netloader writes relative to it).');
      rel = rel.replace(/^\/switch\//i, '');
      if (rel.includes('/')) {
        try { await ftpLock.run(() => withFtp((f) => f.mkdirs('/switch/' + path.posix.dirname(rel)))); } catch { /* netloader will report if the folder is missing */ }
      }
      await stdio.start();
      stdio.newLog(path.basename(file, '.nro'));
      stdio.readNew();
      const r = await nxlinkSend(file, rel, args);
      const wait = Math.max(0, Math.min(120, wait_seconds == null ? 5 : Number(wait_seconds)));
      await sleep(wait * 1000);
      const out = stdio.readNew();
      return text([
        `Sent ${path.basename(file)} (${Math.round(r.bytes / 1024)} KB) to /switch/${rel} and launched it.`,
        stdio.logFile ? `Output is also being saved to ${stdio.logFile}` : '',
        out.trim() ? `Output in the first ${wait}s:\n${out}` : `No output in the first ${wait}s (the app prints here only if it calls nxlinkStdio()).`,
      ].filter(Boolean).join('\n'));
    },
  },
  {
    name: 'switch_read_output',
    description: 'Return output printed by the homebrew last launched with switch_launch_nro since the previous read.',
    inputSchema: { type: 'object', properties: { wait_seconds: { type: 'number', description: 'Wait this long first. Default 0, max 120.' } }, additionalProperties: false },
    async run({ wait_seconds }) {
      if (!stdio.server) return text('Nothing has been launched with switch_launch_nro yet.');
      if (wait_seconds) await sleep(Math.min(120, Number(wait_seconds)) * 1000);
      const out = stdio.readNew();
      return text(`${stdio.active ? 'App connected.' : 'App not connected.'}\n${out || '(no new output)'}`);
    },
  },
  {
    name: 'switch_botbase_command',
    description: 'Send one raw sys-botbase command and return its reply if it has one, e.g. "isProgramRunning 0x010000000000100D", "getTitleID", "screenOff", "screenOn", "configure controllerType 3". Prefer switch_press for input.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
    async run({ command }) {
      const cmd = String(command).trim().replace(/[\r\n]+/g, ' ');
      if (!cmd) throw new UserError('Empty command.');
      const verb = cmd.split(/\s+/)[0];
      if (verb === 'pixelPeek') throw new UserError('Use switch_screenshot for screenshots.');
      if (RESPONDING.has(verb) || (verb === 'game' && cmd.split(/\s+/)[1])) {
        const reply = await bot.lock.run(() => bot.query(cmd, 15000));
        return text(reply === '' ? '(empty reply: not available on this screen)' : reply.length > 20000 ? reply.slice(0, 20000) + ' ...(truncated)' : reply);
      }
      await bot.lock.run(async () => { await bot.send(cmd); await bot.sync(); });
      return text(`Sent "${cmd}".`);
    },
  },
];

// ---------------------------------------------------------------- MCP stdio

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    let result;
    switch (method) {
      case 'initialize': {
        const want = params && params.protocolVersion;
        result = {
          protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'switch-remote', version: VERSION },
          instructions: [
            'Controls a modded Nintendo Switch on the local network. Start with switch_status, and look with switch_screenshot after input.',
            'A typical homebrew test round: build (switch_run_build if allowed), upload the .nro and test.txt into the game folder under /switch with switch_write_file,',
            'move the previous test-results aside with switch_move, start the game from the homebrew menu with switch_press, wait with switch_wait_for_file on its progress file,',
            'then copy the results to the PC with switch_download_folder. Changes on the SD card are limited to /switch.',
          ].join(' '),
        };
        break;
      }
      case 'ping': result = {}; break;
      case 'tools/list':
        result = { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
        break;
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === (params && params.name));
        if (!tool) throw Object.assign(new Error(`Unknown tool ${params && params.name}`), { rpc: -32602 });
        try {
          result = await tool.run((params && params.arguments) || {});
        } catch (e) {
          if (!(e instanceof UserError)) log(e.stack || e);
          result = { content: [{ type: 'text', text: e.message || String(e) }], isError: true };
        }
        break;
      }
      default:
        if (!isRequest) return; // notifications (initialized, cancelled, ...)
        throw Object.assign(new Error(`Method not found: ${method}`), { rpc: -32601 });
    }
    if (isRequest) send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: e.rpc || -32603, message: e.message } });
  }
}

function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      handle(msg);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  log(`v${VERSION} ready. Switch ${CFG.ip || '(no IP)'}, sys-botbase ${CFG.botbasePort}, FTP ${CFG.ftpPort}, work folder ${CFG.workDir}`);
}

// Always start: Claude may load this file through its own wrapper rather than run it
// directly, so it must not depend on being the main module.
main();
