// Plays a whole game against a real server with bot players, at high speed.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { runBot } from '../bots.js';

const PORT = 3900 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;

const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT: String(PORT), TIME_SCALE: '0.05' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve) => server.stdout.once('data', resolve));

const fail = (err) => {
  console.error('FAIL:', err);
  server.kill();
  process.exit(1);
};
const timeout = setTimeout(() => fail('timed out'), 30_000);

try {
  const host = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
  const phases = [];
  let last;
  const code = await new Promise((resolve) => {
    host.on('open', () => host.send(JSON.stringify({ t: 'host:create' })));
    host.on('message', (d) => {
      const msg = JSON.parse(d);
      if (msg.t === 'host:ok') resolve(msg.code);
      if (msg.t === 'state') {
        last = msg.state;
        if (phases.at(-1) !== msg.state.phase) phases.push(msg.state.phase);
      }
    });
  });
  assert.match(code, /^[A-Z]{4}$/);

  const bots = [];
  for (const name of ['Ann', 'Ben', 'Cat', 'Dan']) bots.push(await runBot(BASE, code, name, { delay: [10, 40] }));

  // Duplicate names are refused; reconnecting by id is not.
  await assert.rejects(runBot(BASE, code, 'ann'), /taken/);

  host.send(JSON.stringify({ t: 'start' }));

  // A late joiner should be able to vote and play the final round.
  await new Promise((r) => setTimeout(r, 300));
  bots.push(await runBot(BASE, code, 'Late', { delay: [10, 40] }));

  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (last?.phase === 'end') {
        clearInterval(check);
        resolve();
      }
    }, 50);
  });

  for (const p of ['lobby', 'answer', 'vote', 'reveal', 'scores', 'final-answer', 'final-vote', 'final-reveal', 'end']) {
    assert.ok(phases.includes(p), `phase ${p} was visited (saw ${phases.join(' > ')})`);
  }
  const total = last.leaderboard.reduce((sum, p) => sum + p.score, 0);
  assert.ok(total > 0, 'points were awarded');
  assert.equal(last.leaderboard.length, 5);

  // Authors must never be identifiable during voting.
  for (const bot of bots) {
    for (const s of bot.states) {
      if (s.phase === 'vote' && s.task.type === 'vote') {
        for (const o of s.task.options) assert.deepEqual(Object.keys(o).sort(), ['index', 'text']);
      }
    }
  }

  // Play again resets to the lobby with scores cleared.
  host.send(JSON.stringify({ t: 'again' }));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(last.phase, 'lobby');
  assert.ok(last.leaderboard.every((p) => p.score === 0));

  console.log('PASS: full game played —', phases.join(' > '));
  console.log('Final scores:', last.leaderboard.map((p) => `${p.name} ${p.score}`).join(', '));
  clearTimeout(timeout);
  for (const b of bots) b.ws.close();
  host.close();
  server.kill();
} catch (err) {
  fail(err);
}
