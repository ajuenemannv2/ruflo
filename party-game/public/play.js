import { h, connect, countdown, storage } from '/common.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
const params = new URLSearchParams(location.search);

let session = {
  playerId: storage.get('qc.playerId'),
  code: storage.get('qc.code'),
  name: storage.get('qc.name') ?? '',
};
// A QR/link for a different room means a fresh join, not a rejoin.
const urlCode = params.get('code')?.toUpperCase();
if (urlCode && urlCode !== session.code) session = { ...session, playerId: null, code: urlCode };

let joined = false;
let state = null;
let taskKey = null;

const conn = connect({
  onOpen: () => {
    if (session.playerId && session.code) {
      conn.send({ t: 'join', code: session.code, playerId: session.playerId, name: session.name });
    }
  },
  onStatus: (ok) => $('status').classList.toggle('off', !ok),
  onMessage: (msg) => {
    if (msg.t === 'joined') {
      joined = true;
      session = { playerId: msg.playerId, code: msg.code, name: msg.name };
      storage.set('qc.playerId', msg.playerId);
      storage.set('qc.code', msg.code);
      storage.set('qc.name', msg.name);
    } else if (msg.t === 'state') {
      if (!joined) return;
      if (msg.state.kicked) return leave('You were removed from the room.');
      state = msg.state;
      render();
    } else if (msg.t === 'safety') {
      const box = document.querySelector('#answer-box');
      if (box) {
        box.value = msg.text;
        box.dispatchEvent(new Event('input'));
      }
    } else if (msg.t === 'error' && msg.fatal) {
      if (joined || session.playerId) leave(msg.message);
      else renderJoin(msg.message);
    }
  },
});

const syncTimer = countdown($('timer'), (secs) => {
  if (secs > 0 && secs <= 3) navigator.vibrate?.(30);
});

function leave(message) {
  joined = false;
  state = null;
  taskKey = null;
  session.playerId = null;
  storage.del('qc.playerId');
  renderJoin(message);
}

if (!session.playerId) renderJoin();
else app.replaceChildren(h('p', { class: 'center muted' }, 'Reconnecting…'));

// ---------- join ----------

function renderJoin(error) {
  $('bar').hidden = true;
  syncTimer({ endsAt: null, serverNow: Date.now() });
  taskKey = null;

  const code = h('input', {
    id: 'code',
    placeholder: 'ABCD',
    maxlength: 4,
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    value: session.code ?? '',
    oninput: (e) => (e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '')),
  });
  const name = h('input', { id: 'name', placeholder: 'Your name', maxlength: 12, autocomplete: 'nickname', value: session.name });
  const submit = h('button', { type: 'submit' }, 'Play');

  const form = h(
    'form',
    {
      class: 'join',
      onsubmit: (e) => {
        e.preventDefault();
        session.code = code.value;
        session.name = name.value.trim();
        if (code.value.length !== 4) return renderJoin('Room codes are 4 letters.');
        if (!session.name) return renderJoin('Pick a name!');
        submit.disabled = true;
        submit.textContent = 'Joining…';
        conn.send({ t: 'join', code: session.code, name: session.name });
      },
    },
    h('label', { for: 'code' }, 'Room code'),
    code,
    h('label', { for: 'name' }, 'Name'),
    name,
    error && h('p', { class: 'error pop' }, error),
    submit,
  );

  app.replaceChildren(
    h('div', { class: 'logo pop' }, h('span', { class: 'a' }, 'Quip'), h('span', { class: 'b' }, 'Clash')),
    form,
    h('p', { class: 'center muted host-link' }, 'Got the big screen? ', h('a', { href: '/host' }, 'Host a game')),
  );
  (code.value ? name : code).focus();
}

// ---------- in game ----------

function render() {
  const s = state;
  syncTimer(s);
  $('bar').hidden = false;
  $('me').replaceChildren(
    h('span', { class: 'swatch', style: { '--c': s.me.color } }, s.me.name[0]?.toUpperCase()),
    h('span', { class: 'me-name' }, s.me.name, s.me.vip ? ' 👑' : ''),
    h('span', { class: 'me-score' }, s.me.score.toLocaleString()),
  );

  const t = s.task;
  // Don't rebuild an input the player is typing into just because someone else did something.
  if (t.key === taskKey && t.type !== 'wait') return;
  taskKey = t.key;

  const view = { answer: renderAnswer, vote: renderVote, end: renderEnd, wait: renderWait }[t.type];
  app.replaceChildren(view(t, s));
}

function renderWait(t, s) {
  const lobby = s.phase === 'lobby';
  const need = s.minPlayers - s.playerCount;
  return h(
    'div',
    { class: 'wait' },
    h('div', { class: 'blob', style: { '--c': s.me.color } }),
    h('p', { class: 'wait-msg' }, t.message),
    lobby && s.me.vip &&
      h(
        'div',
        { class: 'stack' },
        h('button', { disabled: !s.canStart, onclick: () => conn.send({ t: 'start' }) }, 'Everybody\'s in!'),
        !s.canStart && h('p', { class: 'muted center' }, need > 0 ? `Need ${need} more player${need === 1 ? '' : 's'}.` : ''),
      ),
    lobby && h('p', { class: 'muted center' }, `${s.playerCount} player${s.playerCount === 1 ? '' : 's'} in room ${s.code}`),
  );
}

function renderAnswer(t, s) {
  const counter = h('span', { class: 'counter' }, `0/${s.maxAnswer}`);
  const submit = h('button', { type: 'submit', disabled: true }, 'Send it');
  const box = h('textarea', {
    id: 'answer-box',
    maxlength: s.maxAnswer,
    placeholder: 'Type something funny…',
    rows: 3,
    oninput: () => {
      counter.textContent = `${box.value.length}/${s.maxAnswer}`;
      submit.disabled = !box.value.trim();
    },
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    },
  });
  const form = h(
    'form',
    {
      class: 'answer slide-up',
      onsubmit: (e) => {
        e.preventDefault();
        if (!box.value.trim()) return;
        submit.disabled = true;
        conn.send({ t: 'answer', matchupId: t.matchupId, text: box.value });
      },
    },
    h('p', { class: 'step' }, t.final ? 'Final round' : `Prompt ${t.index} of ${t.of}`),
    h('div', { class: 'prompt' }, t.prompt),
    box,
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'secondary small', onclick: () => conn.send({ t: 'safety' }) }, 'Safety quip 🛟'), counter),
    submit,
  );
  setTimeout(() => box.focus(), 50);
  return form;
}

function renderVote(t) {
  return h(
    'div',
    { class: 'vote slide-up' },
    h('p', { class: 'step' }, t.final ? 'Pick your favorite' : 'Which is funnier?'),
    h('div', { class: 'prompt' }, t.prompt),
    h(
      'div',
      { class: 'options' },
      t.options.map((o) =>
        h(
          'button',
          {
            class: 'option',
            onclick: (e) => {
              e.currentTarget.classList.add('picked');
              app.querySelectorAll('.option').forEach((b) => (b.disabled = true));
              navigator.vibrate?.(40);
              conn.send({ t: 'vote', matchupId: t.matchupId, choice: o.index });
            },
          },
          o.text,
        ),
      ),
    ),
  );
}

function renderEnd(t, s) {
  const medal = ['🥇', '🥈', '🥉'][s.me.rank - 1] ?? '🎉';
  return h(
    'div',
    { class: 'wait' },
    h('p', { class: 'medal pop' }, medal),
    h('p', { class: 'wait-msg' }, `You finished #${s.me.rank} with ${s.me.score.toLocaleString()} points`),
    t.vip && h('button', { onclick: () => conn.send({ t: 'again' }) }, 'Play again'),
    h('button', { class: 'secondary', onclick: () => leave() }, 'Leave room'),
  );
}
