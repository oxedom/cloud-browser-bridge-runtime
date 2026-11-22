import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {cleanEnv, privateDir, sameSecret, RequestError} from './common.mjs';

export const MAX_OUTPUT = 1024 * 1024;
const pattern = /^[a-f0-9]{32}$/;
export class Ledger {
  constructor(file, instance, {create = false} = {}) {
    if (!create && !fs.existsSync(file)) throw new Error('Execution ledger is missing; restore it rather than reusing the identity.');
    privateDir(path.dirname(file));
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL,result TEXT);');
    const pinned = this.db.prepare("SELECT value FROM metadata WHERE key='instance'").get();
    if (pinned ? pinned.value !== instance : !create) { this.db.close(); throw new Error('Execution ledger identity does not match.'); }
    if (!pinned) this.db.prepare("INSERT INTO metadata VALUES('instance',?)").run(instance);
  }
  get(ident) { const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(ident); return row ? {...row, result: row.result ? JSON.parse(row.result) : null} : null; }
  claim(ident, payload) { this.db.prepare("INSERT INTO jobs(id,payload,state) VALUES(?,?,'running')").run(ident, payload); }
  complete(ident, result) { this.db.prepare("UPDATE jobs SET state='done',result=? WHERE id=? AND state!='done'").run(JSON.stringify(result), ident); return this.get(ident).result; }
  close() { this.db.close(); }
}

export function execute(command, cwd, seconds, {onSpawn} = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawn('/bin/bash', ['-lc', command], {cwd, env: cleanEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe']}); }
    catch { resolve({stdout: '', stderr: '', exit_code: -1, error: 'Could not start command.'}); return; }
    let reason = null, count = 0, finished = false;
    const output = {stdout: [], stderr: []};
    const kill = message => {
      reason ||= message;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    };
    const timer = setTimeout(() => kill('Command timed out'), seconds * 1000);
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      const remaining = Math.max(0, MAX_OUTPUT - count);
      if (remaining) output[stream].push(chunk.subarray(0, remaining));
      count += chunk.length;
      if (count > MAX_OUTPUT) kill('Output exceeded 1 MiB');
    });
    const done = (code, signal, error) => {
      if (finished) return; finished = true; clearTimeout(timer);
      resolve({stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8'),
        exit_code: Number.isInteger(code) ? code : signal ? -(os.constants.signals[signal] || 1) : -1,
        error: error ? 'Could not start command.' : reason});
    };
    child.once('error', error => done(-1, null, error));
    child.once('close', (code, signal) => done(code, signal));
    if (child.pid) onSpawn?.(child, kill);
  });
}

export function createAgent(config, ledger) {
  let queue = Promise.resolve();
  let cancelActive = null;
  const server = http.createServer(async (req, res) => {
    const reply = (status, value) => {
      if (res.destroyed) return;
      const body = JSON.stringify(value);
      res.writeHead(status, {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}); res.end(body);
    };
    try {
      const hosts = [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];
      if (!hosts.includes(req.headers.host)) throw new RequestError(403, 'Wrong host.');
      if (!sameSecret(req.headers.authorization, 'Bearer ' + config.local_token)) throw new RequestError(401, 'Local authentication required.');
      if (req.method === 'GET' && req.url === '/api/identity') return reply(200, {instance_id: config.instance_id});
      if (req.method !== 'POST' || req.url !== '/exec/') throw new RequestError(404, 'Unknown endpoint.');
      let size = 0, chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new RequestError(413, 'Request too large.'); chunks.push(chunk); }
      let job;
      try { job = JSON.parse(Buffer.concat(chunks)); } catch { throw new RequestError(400, 'Invalid JSON.'); }
      if (!job || !pattern.test(job.id) || typeof job.command !== 'string' || !job.command.length || job.command.length > 8192 ||
          !Number.isFinite(job.timeout ?? 30) || (job.timeout ?? 30) <= 0 || (job.timeout ?? 30) > 60 || !(job.cwd == null || typeof job.cwd === 'string')) {
        throw new RequestError(400, 'Invalid command, ID, directory or timeout.');
      }
      if (job.instance_id !== config.instance_id) throw new RequestError(409, 'Execution ledger changed; command was not executed.');
      const payload = JSON.stringify({command: job.command, cwd: job.cwd || null, timeout: job.timeout ?? 30});
      const run = async () => {
        if (server.stopping) throw new RequestError(503, 'Agent is stopping.');
        const known = ledger.get(job.id);
        if (known) {
          if (known.payload !== payload) throw new RequestError(409, 'Job ID already belongs to another command.');
          return known.state === 'done' ? known.result : ledger.complete(job.id, {stdout: '', stderr: '', exit_code: -1,
            error: 'Interrupted before completion; command was not replayed.'});
        }
        ledger.claim(job.id, payload);
        let result;
        let cwd = job.cwd || config.cwd;
        if (cwd === '~' || cwd.startsWith('~/')) cwd = path.join(os.homedir(), cwd.slice(1));
        cwd = path.resolve(cwd);
        try {
          if (!fs.statSync(cwd).isDirectory()) throw new Error();
          result = await execute(job.command, cwd, job.timeout ?? 30, {onSpawn: (_child, cancel) => { cancelActive = cancel; }});
        } catch { result = {stdout: '', stderr: '', exit_code: -1, error: 'Working directory does not exist. Enter a folder path, such as /.'}; }
        finally { cancelActive = null; }
        return ledger.complete(job.id, result);
      };
      const pending = queue.then(run);
      queue = pending.catch(() => {});
      reply(200, await pending);
    } catch (error) { reply(error.status || 500, {error: error.status ? error.message : 'Local agent unavailable.'}); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.stopExecution = () => { server.stopping = true; cancelActive?.('Agent stopped'); };
  return server;
}
