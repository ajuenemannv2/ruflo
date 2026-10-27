// Fill a room with bot players so you can try the game solo.
//   npm run bots -- ABCD 3            (3 bots into room ABCD on localhost:3000)
//   npm run bots -- ABCD 3 https://your-game.example.com
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';

const BOT_NAMES = ['Botrick', 'Chatbert', 'Roboris', 'Clanky', 'Beep', 'Sir Byte', 'Glitch', 'Toaster'];
const BOT_ANSWERS = [
  'A sentient lasagna',
  'Error 404: joke not found',
  'My cousin Greg',
  'Three goats in a hoodie',
  'Taxes, but spicy',
  'A really angry goose',
  'Whatever my mom says',
  'Beans. Just beans.',
  'The ghost of Abraham Lincoln',
  'Free real estate',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * Connects one bot that answers and votes at random.
 * @returns {Promise<{ ws: WebSocket, states: object[] }>} resolves once joined
 */
export function runBot(baseUrl, code, name, { delay = [300, 1500] } = {}) {
  const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/ws');
  const states = [];
  const done = new Set();
  const later = (fn) => setTimeout(fn, delay[0] + Math.random() * (delay[1] - delay[0]));

  return new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', code, name })));
    ws.on('error', reject);
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.t === 'joined') resolve({ ws, states });
      if (msg.t === 'error') reject(new Error(msg.message));
      if (msg.t !== 'state') return;
      states.push(msg.state);
      const task = msg.state.task;
      if (!task || done.has(task.key)) return;
      if (task.type === 'answer') {
        done.add(task.key);
        later(() => ws.send(JSON.stringify({ t: 'answer', matchupId: task.matchupId, text: pick(BOT_ANSWERS) })));
      } else if (task.type === 'vote') {
        done.add(task.key);
        later(() => ws.send(JSON.stringify({ t: 'vote', matchupId: task.matchupId, choice: pick(task.options).index })));
      }
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [code, count = '3', base = 'http://localhost:3000'] = process.argv.slice(2);
  if (!code) {
    console.error('Usage: npm run bots -- <ROOM CODE> [count] [server url]');
    process.exit(1);
  }
  const names = BOT_NAMES.slice(0, Number(count));
  for (const name of names) {
    runBot(base, code.toUpperCase(), name, { delay: [2000, 8000] })
      .then(() => console.log(`${name} joined ${code.toUpperCase()}`))
      .catch((err) => console.error(`${name}: ${err.message}`));
  }
}
