import { h, connect, countdown } from '/common.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const PHASE_TITLES = {
  answer: 'Answer on your phones!',
  'final-answer': 'Final round!',
};

let code = sessionStorage.getItem('hostCode');
let state = null;
let lastKey = null;
let joinBase = location.origin;

// ---------- sound (tiny synth, no assets) ----------

const sound = { ctx: null, on: true };
function tone(freq, { at = 0, dur = 0.14, type = 'square', vol = 0.06 } = {}) {
  if (!sound.on) return;
  sound.ctx ??= new AudioContext();
  const ctx = sound.ctx;
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur);
}
const jingle = (notes, step = 0.1, opts) => notes.forEach((f, i) => tone(f, { at: i * step, ...opts }));
const SFX = {
  join: () => jingle([660, 880], 0.07),
  phase: () => jingle([523, 659, 784, 1046], 0.09),
  reveal: () => jingle([392, 523, 659], 0.08, { type: 'triangle', vol: 0.1 }),
  smash: () => jingle([523, 659, 784, 1046, 1318, 1568], 0.06, { vol: 0.08 }),
  tick: () => tone(1200, { dur: 0.05, vol: 0.04 }),
  end: () => jingle([523, 523, 523, 698, 880, 784, 1046], 0.13, { type: 'triangle', vol: 0.12 }),
};

// ---------- connection ----------

const conn = connect({
  onOpen: () => code && conn.send({ t: 'host:join', code }),
  onStatus: (ok) => $('status').classList.toggle('off', !ok),
  onMessage: (msg) => {
    if (msg.t === 'host:ok') {
      code = msg.code;
      sessionStorage.setItem('hostCode', code);
    } else if (msg.t === 'state') {
      onState(msg.state);
    } else if (msg.t === 'error' && msg.fatal) {
      sessionStorage.removeItem('hostCode');
      code = null;
      renderSplash(msg.message);
    }
  },
});

const syncTimer = countdown($('timer'), (secs) => {
  if (secs > 0 && secs <= 5) SFX.tick();
});

// If the host opened localhost, phones can't use that, so show the LAN address instead.
if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  fetch('/info')
    .then((r) => r.json())
    .then(({ lanUrls }) => {
      if (lanUrls[0]) joinBase = lanUrls[0];
      if (state) render(true);
    })
    .catch(() => {});
}

$('btn-skip').onclick = () => conn.send({ t: 'skip' });
$('btn-full').onclick = () =>
  document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
$('btn-sound').onclick = (e) => {
  sound.on = !sound.on;
  e.currentTarget.textContent = sound.on ? '🔊' : '🔇';
};

if (!code) renderSplash();

// ---------- rendering ----------

function renderSplash(error) {
  $('top').hidden = true;
  $('controls').hidden = true;
  stage.className = 'splash fresh';
  stage.replaceChildren(
    h('div', { class: 'logo big pop' }, h('span', { class: 'a' }, 'Quip'), h('span', { class: 'b' }, 'Clash')),
    h('p', { class: 'tagline' }, 'The party game where the funniest answer wins.'),
    error && h('p', { class: 'error' }, error),
    h('button', {
      class: 'huge',
      onclick: () => {
        sound.ctx ??= new AudioContext(); // unlock audio on a user gesture
        conn.send({ t: 'host:create' });
      },
    }, 'Start a room'),
    h('p', { class: 'muted' }, 'Put this screen on the TV (or share it on Discord). Everyone else plays on their phone.'),
  );
}

function onState(next) {
  const prev = state;
  state = next;
  if (prev && prev.phase !== next.phase) {
    if (['answer', 'final-answer', 'vote', 'final-vote'].includes(next.phase)) SFX.phase();
    else if (next.phase === 'reveal') next.matchup?.answers.some((a) => a.smash) ? SFX.smash() : SFX.reveal();
    else if (next.phase === 'final-reveal' || next.phase === 'scores') SFX.reveal();
    else if (next.phase === 'end') SFX.end();
  }
  if (prev && next.phase === 'lobby' && next.players.length > prev.players.length) SFX.join();
  render();
}

function render(force = false) {
  const s = state;
  syncTimer(s);
  $('top').hidden = false;
  $('controls').hidden = false;
  $('btn-skip').hidden = !s.endsAt;
  $('code-badge').replaceChildren(h('small', {}, 'Room'), s.code);
  $('round').textContent =
    s.phase === 'lobby' || s.phase === 'end'
      ? ''
      : s.round > s.totalRounds - 1
        ? 'Final Round'
        : `Round ${s.round} of ${s.totalRounds}`;

  const key = `${s.phase}:${s.round}:${s.matchup?.index ?? ''}`;
  const fresh = force || key !== lastKey;
  lastKey = key;
  stage.className = `phase-${s.phase}${fresh ? ' fresh' : ''}`;

  const view = {
    lobby: renderLobby,
    answer: renderWaiting,
    'final-answer': renderWaiting,
    vote: renderMatchup,
    reveal: renderMatchup,
    scores: renderScores,
    'final-vote': renderFinalVote,
    'final-reveal': renderFinalReveal,
    end: renderEnd,
  }[s.phase];
  stage.replaceChildren(...[view(s)].flat());
}

function avatar(p, extra) {
  return h(
    'div',
    { class: `avatar${p.connected === false ? ' offline' : ''}`, style: { '--c': p.color } },
    h('span', { class: 'initial' }, p.name[0]?.toUpperCase()),
    h('span', { class: 'name' }, p.name),
    p.vip && h('span', { class: 'crown', title: 'VIP' }, '👑'),
    extra,
  );
}

function renderLobby(s) {
  const joinUrl = `${joinBase}/?code=${s.code}`;
  const pretty = joinBase.replace(/^https?:\/\//, '');
  const need = s.minPlayers - s.players.filter((p) => p.connected).length;
  return h(
    'div',
    { class: 'lobby' },
    h(
      'section',
      { class: 'join-card pop' },
      h('p', { class: 'label' }, 'Grab your phone and go to'),
      h('p', { class: 'url' }, pretty),
      h('p', { class: 'label' }, 'Room code'),
      h('p', { class: 'room-code' }, s.code),
      h('img', { class: 'qr', src: `/qr.svg?text=${encodeURIComponent(joinUrl)}`, alt: 'QR code to join' }),
    ),
    h(
      'section',
      { class: 'roster' },
      h('h2', {}, `Players (${s.players.length})`),
      h(
        'div',
        { class: 'avatars' },
        s.players.length === 0 && h('p', { class: 'muted' }, 'Nobody yet… someone be brave.'),
        s.players.map((p) =>
          h('div', { class: 'kickable', title: 'Click to remove', onclick: () => confirm(`Kick ${p.name}?`) && conn.send({ t: 'kick', playerId: p.id }) }, avatar(p)),
        ),
      ),
      h(
        'div',
        { class: 'start-row' },
        h('button', { class: 'huge', disabled: !s.canStart, onclick: () => conn.send({ t: 'start' }) }, 'Everybody\'s in!'),
        h('p', { class: 'muted' }, need > 0 ? `Need ${need} more player${need === 1 ? '' : 's'} (3–10).` : 'The 👑 VIP can also start from their phone.'),
      ),
    ),
  );
}

function renderWaiting(s) {
  const final = s.phase === 'final-answer';
  return h(
    'div',
    { class: 'waiting' },
    h('h1', { class: 'pop' }, PHASE_TITLES[s.phase]),
    h('p', { class: 'sub' }, final ? 'Everyone answers the same prompt. Make it count.' : 'Each of you has 2 prompts. Your answers will go head-to-head.'),
    final && s.final && h('div', { class: 'prompt-card slide-up' }, s.final.prompt),
    h(
      'div',
      { class: 'avatars' },
      s.players.filter((p) => p.connected).map((p) => avatar(p, p.done ? h('span', { class: 'check pop' }, '✔') : h('span', { class: 'dots' }, '…'))),
    ),
  );
}

function renderMatchup(s) {
  const m = s.matchup;
  const revealed = s.phase === 'reveal';
  return h(
    'div',
    { class: 'matchup' },
    h('p', { class: 'progress' }, `Matchup ${m.index + 1} of ${m.total}`),
    h('div', { class: 'prompt-card pop' }, m.prompt),
    h(
      'div',
      { class: 'versus' },
      m.answers.map((a, i) => [
        i === 1 && h('div', { class: 'vs pop' }, 'VS'),
        answerCard(a, i, revealed),
      ]),
    ),
    !revealed &&
      h(
        'div',
        { class: 'voters' },
        h('span', { class: 'muted' }, 'Vote on your phone! '),
        s.players.filter((p) => p.done).map((p) => h('span', { class: 'chip', style: { '--c': p.color } }, p.name)),
      ),
  );
}

function answerCard(a, i, revealed) {
  const cls = ['answer-card', i === 0 ? 'left' : 'right', 'slide-up'];
  if (revealed && a.smash) cls.push('winner');
  return h(
    'div',
    { class: cls.join(' '), style: { animationDelay: `${i * 0.25}s` } },
    h('p', { class: 'answer-text' }, a.text ?? h('em', { class: 'muted' }, 'No answer')),
    revealed &&
      h(
        'div',
        { class: 'reveal pop', style: { animationDelay: `${0.4 + i * 0.2}s` } },
        a.author && h('div', { class: 'author', style: { '--c': a.author.color } }, a.author.name),
        h('div', { class: 'points' }, `+${a.points}`),
        a.smash && h('div', { class: 'banner' }, 'QUIP SMASH!'),
        a.forfeit && h('div', { class: 'banner' }, 'Win by forfeit'),
        h('div', { class: 'vote-chips' }, a.voters.map((n) => h('span', { class: 'chip' }, n))),
      ),
  );
}

function leaderboard(s, { limit } = {}) {
  const top = s.leaderboard[0]?.score || 1;
  return h(
    'ol',
    { class: 'leaderboard' },
    s.leaderboard.slice(0, limit).map((p, i) =>
      h(
        'li',
        { class: 'slide-up', style: { animationDelay: `${i * 0.08}s`, '--c': p.color } },
        h('span', { class: 'rank' }, i + 1),
        h('span', { class: 'lb-name' }, p.name),
        h('span', { class: 'bar' }, h('span', { class: 'fill', style: { width: `${Math.max(4, (p.score / top) * 100)}%` } })),
        h('span', { class: 'lb-score' }, p.score.toLocaleString()),
      ),
    ),
  );
}

function renderScores(s) {
  return h('div', { class: 'scores' }, h('h1', { class: 'pop' }, 'Scoreboard'), leaderboard(s));
}

function renderFinalVote(s) {
  return h(
    'div',
    { class: 'final' },
    h('div', { class: 'prompt-card pop' }, s.final.prompt),
    h('p', { class: 'sub' }, 'Vote for your favorite on your phone!'),
    h(
      'div',
      { class: 'final-grid' },
      s.final.options.map((o, i) => h('div', { class: 'answer-card slide-up', style: { animationDelay: `${i * 0.12}s` } }, h('p', { class: 'answer-text' }, o.text))),
    ),
  );
}

function renderFinalReveal(s) {
  return h(
    'div',
    { class: 'final' },
    h('div', { class: 'prompt-card' }, s.final.prompt),
    h(
      'div',
      { class: 'final-grid' },
      (s.final.results ?? []).map((r, i) =>
        h(
          'div',
          { class: `answer-card slide-up${i === 0 && r.voters.length ? ' winner' : ''}`, style: { animationDelay: `${i * 0.2}s` } },
          h('p', { class: 'answer-text' }, r.text),
          h(
            'div',
            { class: 'reveal' },
            r.author && h('div', { class: 'author', style: { '--c': r.author.color } }, r.author.name),
            h('div', { class: 'points' }, `+${r.points}`),
            h('div', { class: 'vote-chips' }, r.voters.map((n) => h('span', { class: 'chip' }, n))),
          ),
        ),
      ),
    ),
  );
}

function renderEnd(s) {
  const winner = s.leaderboard[0];
  const tied = s.leaderboard.filter((p) => p.score === winner?.score);
  return h(
    'div',
    { class: 'end' },
    h('p', { class: 'label' }, tied.length > 1 ? 'It\'s a tie!' : 'The winner is'),
    h('h1', { class: 'winner-name pop', style: { color: winner?.color } }, tied.map((p) => p.name).join(' & ')),
    leaderboard(s),
    h('button', { class: 'huge', onclick: () => conn.send({ t: 'again' }) }, 'Play again'),
    confetti(),
  );
}

function confetti() {
  const colors = ['#ff4d6d', '#ffd23f', '#06d6a0', '#4cc9f0', '#b388ff'];
  return h(
    'div',
    { class: 'confetti', 'aria-hidden': 'true' },
    Array.from({ length: 80 }, (_, i) =>
      h('i', {
        style: {
          left: `${Math.random() * 100}%`,
          background: colors[i % colors.length],
          animationDelay: `${Math.random() * 3}s`,
          animationDuration: `${3 + Math.random() * 3}s`,
        },
      }),
    ),
  );
}
