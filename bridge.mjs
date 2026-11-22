#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn, spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {ROOT, ORIGIN, id, token, readJSON, save, privateWrite, privateDir, statePath,
  cleanEnv, request, retry, sleep, processRecord, serviceAlive, configureNetwork} from './common.mjs';
import {Ledger, createAgent} from './agent.mjs';

const script = root => path.join(root, 'bridge.mjs');
export async function lock(root, name, fn) {
  const folder = path.join(statePath(root), name + '.lock');
  privateDir(statePath(root));
  const owner = {pid: process.pid, started: processRecord(process.pid), nonce: id()};
  for (;;) {
    try { fs.mkdirSync(folder, {mode: 0o700}); save(path.join(folder, 'owner.json'), owner); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try { const prior = readJSON(path.join(folder, 'owner.json')); stale = !prior.started || processRecord(prior.pid) !== prior.started; }
      catch { try { stale = Date.now() - fs.statSync(folder).mtimeMs > 30000; } catch { continue; } }
      if (stale) {
        const abandoned = folder + '.' + id();
        try { fs.renameSync(folder, abandoned); fs.rmSync(abandoned, {recursive: true, force: true}); } catch {}
      } else await sleep(100);
    }
  }
  try { return await fn(); }
  finally { try { if (readJSON(path.join(folder, 'owner.json')).nonce === owner.nonce) fs.rmSync(folder, {recursive: true}); } catch {} }
}

export function identity(root, options = {}) {
  const port = options.port ?? 3001, origin = options.origin ?? ORIGIN;
  privateDir(statePath(root));
  const file = path.join(statePath(root), 'identity.json'), database = path.join(statePath(root), 'execution.sqlite3');
  if (fs.existsSync(file) !== fs.existsSync(database)) throw new Error('Identity or ledger is missing. Restore the existing state; do not create an empty replacement ledger.');
  if (fs.existsSync(file)) {
    const cfg = readJSON(file);
    if (cfg.version !== 2) throw new Error('Unsupported identity version.');
    new Ledger(database, cfg.instance_id).close();
    if (options.origin && options.origin !== cfg.origin) throw new Error('Existing identity remains pinned to its original relay.');
    if (options.port !== undefined && options.port !== cfg.port) {
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port.');
      if (serviceAlive(root, 'agent') || serviceAlive(root, 'worker')) throw new Error('Stop bridge services before changing their local port.');
      cfg.port = port; save(file, cfg);
    }
    return cfg;
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose an unprivileged local port between 1024 and 65535.');
  const destination = new URL(origin);
  if ((destination.protocol !== 'https:' && !(destination.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(destination.hostname))) || destination.origin !== origin) throw new Error('Use an HTTPS relay origin.');
  const cfg = {version: 2, origin, vm_id: id(), instance_id: id(), vm_token: token(), local_token: token(), operator_token: token(),
    name: os.hostname().slice(0, 100), cwd: fs.existsSync('/workspace') ? '/workspace' : os.homedir(), port};
  // Persist the identity before creating the ledger or registering remotely.
  // A partial write is refused on retry, never repaired by rotating an ID.
  save(file, cfg);
  new Ledger(database, cfg.instance_id, {create: true}).close();
  return cfg;
}
export function loadIdentity(root) {
  const cfg = readJSON(path.join(statePath(root), 'identity.json'));
  if (cfg.version !== 2) throw new Error('Unsupported identity version.');
  new Ledger(path.join(statePath(root), 'execution.sqlite3'), cfg.instance_id).close();
  return cfg;
}
export const operatorAPI = (cfg, route, body) => request(cfg.origin + route, cfg.admin_token || cfg.operator_token, body);
export async function enroll(cfg) {
  const result = await retry(() => request(cfg.origin + '/api/enroll', null, {
    id: cfg.vm_id, instance_id: cfg.instance_id, name: cfg.name, vm_token: cfg.vm_token, operator_token: cfg.operator_token}));
  if (result.id !== cfg.vm_id) throw new Error('Relay returned another machine identity.');
}

function owned(root, name, record) {
  if (!record?.started || processRecord(record.pid) !== record.started) return false;
  try {
    const args = fs.readFileSync(`/proc/${record.pid}/cmdline`).toString().split('\0').filter(Boolean);
    const expected = [process.execPath, script(root), name === 'agent' ? '_agent' : '_worker'];
    const group = fs.readFileSync(`/proc/${record.pid}/stat`, 'utf8').split(') ').slice(1).join(') ').split(' ')[2];
    return group === String(record.pid) && fs.statSync(`/proc/${record.pid}`).uid === process.getuid() && JSON.stringify(args) === JSON.stringify(expected);
  } catch { return false; }
}
export async function startService(root, name) {
  const file = path.join(statePath(root), name + '.pid.json');
  if (fs.existsSync(file) && owned(root, name, readJSON(file))) return;
  // Reattach an exact detached service if its PID record was lost.
  for (const entry of fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
    const record = {pid: Number(entry), started: processRecord(entry)};
    if (owned(root, name, record)) { save(file, record); return; }
  }
  const log = fs.openSync(path.join(statePath(root), name + '.log'), 'a', 0o600);
  const child = spawn(process.execPath, [script(root), name === 'agent' ? '_agent' : '_worker'],
    {cwd: root, detached: true, stdio: ['ignore', log, log], env: cleanEnv()});
  fs.closeSync(log);
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  save(file, {pid: child.pid, started: processRecord(child.pid)});
  child.unref();
  await sleep(250);
  if (!serviceAlive(root, name)) throw new Error(name + ' did not start. Inspect its private .state log.');
}
export async function stopService(root, name) {
  const file = path.join(statePath(root), name + '.pid.json');
  if (!fs.existsSync(file)) return;
  const record = readJSON(file);
  if (owned(root, name, record)) {
    try { process.kill(-record.pid, 'SIGTERM'); } catch {}
    for (let n = 0; n < 30 && processRecord(record.pid) === record.started; n++) await sleep(100);
    if (processRecord(record.pid) === record.started) { try { process.kill(-record.pid, 'SIGKILL'); } catch {} }
  } else if (serviceAlive(root, name)) throw new Error('Refusing to signal an unrelated process.');
  fs.rmSync(file, {force: true});
}

export class Worker {
  constructor(root, cfg) { this.root = root; this.cfg = cfg; this.stopped = false; this.pendingFile = path.join(statePath(root), 'pending-result.json'); }
  remote(action, data = {}) { return request(`${this.cfg.origin}/api/vms/${this.cfg.vm_id}/${action}`, this.cfg.vm_token, {instance_id: this.cfg.instance_id, ...data}, {timeout: 25000}); }
  local(route, data) { return request(`http://127.0.0.1:${this.cfg.port}${route}`, this.cfg.local_token, data, {timeout: 65000}); }
  async checkAgent() { if ((await this.local('/api/identity')).instance_id !== this.cfg.instance_id) throw Object.assign(new Error('Execution ledger changed.'), {status: 409}); }
  failure(error) {
    if ([401, 403, 404, 409].includes(error.status)) { this.stopped = true; console.error('Bridge access or identity rejected; state was preserved.'); }
    else console.error('Connection interrupted; retaining original job IDs (' + (error.status || error.name) + ').');
  }
  async pause(ms) { for (let waited = 0; !this.stopped && waited < ms; waited += 100) await sleep(Math.min(100, ms - waited)); }
  async heartbeat() {
    while (!this.stopped) {
      try { await this.checkAgent(); await this.remote('heartbeat'); save(path.join(statePath(this.root), 'ready.json'), {instance_id: this.cfg.instance_id, time: Date.now()}); }
      catch (error) { this.failure(error); }
      await this.pause(8000);
    }
  }
  async run() {
    await this.checkAgent();
    let pending = fs.existsSync(this.pendingFile) ? readJSON(this.pendingFile) : null;
    if (pending && (pending.vm_id !== this.cfg.vm_id || pending.instance_id !== this.cfg.instance_id)) throw new Error('Pending result belongs to another identity.');
    const heartbeat = this.heartbeat();
    let delay = 1000;
    try {
      while (!this.stopped) {
        try {
          await this.checkAgent();
          if (pending) { await this.remote('result', {id: pending.id, result: pending.result}); fs.rmSync(this.pendingFile, {force: true}); pending = null; }
          if (this.stopped) break;
          const job = (await this.remote('poll')).job;
          if (job) {
            if (job.instance_id !== this.cfg.instance_id) throw Object.assign(new Error('Delivered job belongs to another ledger.'), {status: 409});
            let result;
            try { result = await this.local('/exec/', job); }
            catch (error) { if (error.status !== 400) throw error; result = {stdout: '', stderr: '', exit_code: -1, error: error.message}; }
            pending = {vm_id: this.cfg.vm_id, instance_id: this.cfg.instance_id, id: job.id, result};
            save(this.pendingFile, pending);
          } else await this.pause(1000);
          delay = 1000;
        } catch (error) { this.failure(error); await this.pause(delay); delay = Math.min(10000, delay * 2); }
      }
    } finally { this.stopped = true; await heartbeat; fs.rmSync(path.join(statePath(this.root), 'ready.json'), {force: true}); }
  }
}

export async function submit(root, cfg, command, {cwd = null, timeout = 30} = {}) {
  const payload = {id: id(), command, cwd, timeout};
  save(path.join(statePath(root), 'job-' + payload.id + '.json'), {vm_id: cfg.vm_id, origin: cfg.origin, payload});
  await retry(() => operatorAPI(cfg, `/api/vms/${cfg.vm_id}/jobs`, payload));
  return payload.id;
}
export async function result(cfg, ident, wait = 120000) {
  const deadline = Date.now() + wait;
  while (Date.now() < deadline) {
    const job = await retry(() => operatorAPI(cfg, `/api/vms/${cfg.vm_id}/jobs/${ident}`));
    if (job.state === 'done') return job.result;
    await sleep(500);
  }
  throw new Error('Result unconfirmed. Retrieve original job ' + ident + '; do not resubmit under a new ID.');
}
export async function verify(root, cfg) {
  const nonce = 'bridge-' + id();
  const command = `hostname; id -u; printf '${nonce}'; printf bridge-stderr >&2; exit 7`;
  const ident = await submit(root, cfg, command, {timeout: 20});
  const value = await result(cfg, ident);
  if (value.stdout !== `${os.hostname()}\n${process.getuid()}\n${nonce}` || value.stderr !== 'bridge-stderr' || value.exit_code !== 7 || value.error !== null) throw new Error('End-to-end command did not match this machine.');
  const proof = {vm_id: cfg.vm_id, instance_id: cfg.instance_id, job_id: ident, origin: cfg.origin, verified_at: Date.now()};
  save(path.join(statePath(root), 'verification.json'), proof);
  return proof;
}
export async function setup(root, options = {}) {
  return lock(root, 'setup', async () => {
    const cfg = identity(root, options);
    await enroll(cfg);
    privateWrite(path.join(statePath(root), 'controller-url'), cfg.origin + '/#key=' + cfg.operator_token + '\n');
    await startService(root, 'agent');
    const deadline = Date.now() + 10000;
    const worker = new Worker(root, cfg);
    for (;;) { try { await worker.checkAgent(); break; } catch (error) { if (Date.now() > deadline) throw error; await sleep(100); } }
    await startService(root, 'worker');
    await verify(root, cfg);
    console.log('Bridge deployed and verified: ' + cfg.origin);
    console.log('Machine: ' + cfg.vm_id);
    return cfg;
  });
}

export async function createInstallLink(root, options) {
  if (!options['controller-config']) throw new Error('Provide --controller-config pointing to an existing administrator profile (read only).');
  const cfg = readJSON(path.resolve(options['controller-config'])); cfg.origin ||= ORIGIN;
  const created = await operatorAPI(cfg, '/api/install-links', {});
  const command = 'curl -fsSL ' + created.url + ' | bash';
  const destination = path.join(statePath(root), 'install-link.sh');
  privateWrite(destination, command + '\n');
  save(path.join(statePath(root), 'install-link.json'), {expires: created.expires, command});
  if (options.copy) {
    const which = spawnSync('/bin/sh', ['-c', 'command -v wl-copy || command -v xclip'], {encoding: 'utf8'});
    if (which.status !== 0) throw new Error('Clipboard unavailable; command saved privately at ' + destination);
    const binary = which.stdout.trim().split('\n')[0];
    const copied = spawn(binary, path.basename(binary) === 'xclip' ? ['-selection', 'clipboard'] : ['--sensitive'],
      {detached: true, stdio: ['pipe', 'ignore', 'ignore']});
    await new Promise((resolve, reject) => {
      copied.once('error', reject);
      copied.stdin.once('error', reject);
      copied.stdin.end(command, resolve);
    }).catch(() => { throw new Error('Clipboard failed; private command is saved at ' + destination); });
    copied.unref();
    console.log('Credential-free install command copied. Single use, valid for five minutes.');
  } else console.log('Private credential-free install command saved at ' + destination + ' (five minutes, single use).');
}

async function main() {
  process.umask(0o077); configureNetwork();
  const mode = process.argv[2] || 'setup';
  const {values, positionals} = parseArgs({args: process.argv.slice(3), allowPositionals: true, options: {
    port: {type: 'string'}, origin: {type: 'string'}, vm: {type: 'string'}, cwd: {type: 'string'}, timeout: {type: 'string'},
    wait: {type: 'string'}, json: {type: 'boolean'}, 'controller-config': {type: 'string'}, agent: {type: 'string'},
    'auth-file': {type: 'string'}, copy: {type: 'boolean'}}});
  if (mode === '_agent') {
    const cfg = loadIdentity(ROOT), ledger = new Ledger(path.join(statePath(ROOT), 'execution.sqlite3'), cfg.instance_id);
    const server = createAgent(cfg, ledger);
    server.listen(cfg.port, '127.0.0.1');
    server.on('error', () => { console.error('Local agent could not bind its port.'); process.exit(1); });
    process.on('SIGTERM', () => { server.stopExecution(); server.close(() => { ledger.close(); process.exit(0); }); });
    return;
  }
  if (mode === '_worker') {
    return lock(ROOT, 'worker-instance', async () => { const worker = new Worker(ROOT, loadIdentity(ROOT));
      process.on('SIGTERM', () => { worker.stopped = true; }); process.on('SIGINT', () => { worker.stopped = true; }); await worker.run(); });
  }
  if (mode === 'setup') return setup(ROOT, {...(values.port ? {port: Number(values.port)} : {}), ...(values.origin ? {origin: values.origin} : {})});
  if (mode === 'install') {
    if (values.agent || process.env.NEOFETCH || process.env.NEOFETCH_FILE) { const {installWithAgent} = await import('./coding.mjs'); return installWithAgent(ROOT, values); }
    return setup(ROOT, values.port ? {port: Number(values.port)} : {});
  }
  if (mode === 'stop') { await stopService(ROOT, 'worker'); await stopService(ROOT, 'agent'); console.log('Stopped this bridge installation.'); return; }
  if (mode === 'install-link') return createInstallLink(ROOT, values);
  if (mode === 'agent-link') { const {createLink} = await import('./coding.mjs'); return createLink(ROOT, values); }
  const cfg = values['controller-config'] ? readJSON(path.resolve(values['controller-config'])) : loadIdentity(ROOT);
  cfg.origin ||= ORIGIN; cfg.vm_id = values.vm || cfg.vm_id;
  if (mode === 'status') { console.log(JSON.stringify(await operatorAPI(cfg, '/api/vms'), null, 2)); return; }
  if (!['run', 'result'].includes(mode)) throw new Error('Use setup, install, stop, status, run, result, install-link or agent-link.');
  if (values['controller-config'] && !values.vm) throw new Error('Select --vm explicitly when using an existing controller profile.');
  let ident;
  if (mode === 'run') {
    if (!positionals[0]) throw new Error('Provide a quoted command.');
    ident = await submit(ROOT, cfg, positionals[0], {cwd: values.cwd || null, timeout: Number(values.timeout || 30)});
    console.error('Job: ' + ident);
  } else {
    ident = positionals[0];
    if (!/^[a-f0-9]{32}$/.test(ident || '')) throw new Error('Valid original job ID required.');
    const file = path.join(statePath(ROOT), 'job-' + ident + '.json');
    if (fs.existsSync(file)) {
      const saved = readJSON(file);
      if (saved.vm_id !== cfg.vm_id || saved.origin !== cfg.origin) throw new Error('Job belongs to another machine or relay.');
      await retry(() => operatorAPI(cfg, `/api/vms/${cfg.vm_id}/jobs`, saved.payload));
    }
  }
  const value = await result(cfg, ident, Number(values.wait || 120) * 1000);
  if (values.json) console.log(JSON.stringify({id: ident, ...value}));
  else { process.stdout.write(value.stdout); process.stderr.write(value.stderr); if (value.error) console.error(value.error); }
  process.exitCode = value.exit_code >= 0 && value.exit_code <= 255 ? value.exit_code : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.status ? `Request failed (HTTP ${error.status}): ${error.message}` : error.message); process.exitCode = 1; });
