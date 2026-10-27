import { randomUUID } from 'node:crypto';
import { PROMPTS, SAFETY_QUIPS } from './prompts.js';

export const CONFIG = {
  MIN_PLAYERS: 3,
  MAX_PLAYERS: 10,
  HEAD_TO_HEAD_ROUNDS: 2, // followed by one final round
  ANSWER_TIME: 90,
  FINAL_ANSWER_TIME: 60,
  VOTE_TIME: 20,
  FINAL_VOTE_TIME: 30,
  REVEAL_TIME: 8,
  FINAL_REVEAL_TIME: 12,
  SCORES_TIME: 8,
  MAX_ANSWER: 80,
  MAX_NAME: 12,
  POINTS_PER_ROUND: 1000,
  SMASH_BONUS: 250,
  FINAL_VOTE_POINTS: 500,
};

const COLORS = [
  '#ff4d6d', '#ffb703', '#06d6a0', '#4cc9f0', '#b388ff',
  '#ff8fab', '#90be6d', '#f8961e', '#43aa8b', '#e0e0e0',
];

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const clean = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * One game room. Holds all state and runs the phase machine; knows nothing about sockets.
 * Calls `onChange()` whenever connected clients should be re-synced.
 */
export class Room {
  constructor(code, { onChange = () => {}, timeScale = 1 } = {}) {
    this.code = code;
    this.onChange = onChange;
    this.timeScale = timeScale;
    this.players = new Map();
    this.vip = null;
    this.usedPrompts = new Set();
    this.lastActivity = Date.now();
    this.resetGame();
  }

  resetGame() {
    this.clearTimer();
    this.phase = 'lobby';
    this.round = 0;
    this.matchups = [];
    this.current = -1;
    this.final = null;
    for (const p of this.players.values()) p.score = 0;
  }

  get totalRounds() {
    return CONFIG.HEAD_TO_HEAD_ROUNDS + 1;
  }

  connectedPlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  touch() {
    this.lastActivity = Date.now();
  }

  // ---------- players ----------

  join(rawName, playerId) {
    this.touch();
    const existing = playerId && this.players.get(playerId);
    if (existing) {
      existing.connected = true;
      this.ensureVip();
      this.changed();
      return { player: existing };
    }

    const name = clean(rawName, CONFIG.MAX_NAME);
    if (!name) return { error: 'Enter a name' };

    // Lost their saved id (new browser, cleared storage)? Let them reclaim a disconnected seat by name.
    const sameName = [...this.players.values()].find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (sameName) {
      if (sameName.connected) return { error: 'That name is taken' };
      sameName.connected = true;
      this.ensureVip();
      this.changed();
      return { player: sameName };
    }

    if (this.players.size >= CONFIG.MAX_PLAYERS) return { error: 'Room is full' };

    const player = {
      id: randomUUID(),
      name,
      score: 0,
      connected: true,
      color: COLORS[this.players.size % COLORS.length],
    };
    this.players.set(player.id, player);
    this.ensureVip();
    this.changed();
    return { player };
  }

  disconnect(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connected = false;
    if (this.vip === playerId) this.vip = null;
    this.ensureVip();
    this.checkProgress();
    this.changed();
  }

  kick(playerId) {
    if (this.phase !== 'lobby') return;
    this.players.delete(playerId);
    if (this.vip === playerId) this.vip = null;
    this.ensureVip();
    this.changed();
  }

  ensureVip() {
    if (this.vip && this.players.get(this.vip)?.connected) return;
    this.vip = this.connectedPlayers()[0]?.id ?? null;
  }

  // ---------- timers ----------

  setTimer(seconds, fn) {
    this.clearTimer();
    const ms = seconds * 1000 * this.timeScale;
    this.endsAt = Date.now() + ms;
    this.timerFn = fn;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerFn = null;
      fn();
    }, ms);
  }

  clearTimer() {
    clearTimeout(this.timer);
    this.timer = null;
    this.timerFn = null;
    this.endsAt = null;
  }

  /** Host "skip" button: run whatever the current timer would have run. */
  skip() {
    const fn = this.timerFn;
    if (!fn) return;
    this.clearTimer();
    fn();
  }

  changed() {
    this.onChange();
  }

  // ---------- flow ----------

  canStart() {
    return this.phase === 'lobby' && this.connectedPlayers().length >= CONFIG.MIN_PLAYERS;
  }

  start() {
    if (!this.canStart()) return false;
    this.touch();
    // Anyone who wandered off in the lobby doesn't get a seat.
    for (const p of [...this.players.values()]) if (!p.connected) this.players.delete(p.id);
    this.resetGame();
    this.round = 1;
    this.beginRound();
    return true;
  }

  playAgain() {
    if (this.phase !== 'end') return;
    this.resetGame();
    this.changed();
  }

  drawPrompt() {
    let pool = PROMPTS.filter((p) => !this.usedPrompts.has(p));
    if (pool.length === 0) {
      this.usedPrompts.clear();
      pool = PROMPTS;
    }
    const prompt = pool[Math.floor(Math.random() * pool.length)];
    this.usedPrompts.add(prompt);
    return prompt;
  }

  beginRound() {
    this.matchups = [];
    this.current = -1;
    this.final = null;

    if (this.round > CONFIG.HEAD_TO_HEAD_ROUNDS) {
      this.final = { prompt: this.drawPrompt(), answers: new Map(), votes: new Map(), options: [], result: null };
      this.phase = 'final-answer';
      this.setTimer(CONFIG.FINAL_ANSWER_TIME, () => this.endFinalAnswers());
      this.changed();
      return;
    }

    // Each player gets two prompts, each prompt goes to two players: prompt k -> players k and k+1.
    const seats = shuffle(this.connectedPlayers().map((p) => p.id));
    const n = seats.length;
    for (let k = 0; k < n; k++) {
      this.matchups.push({
        id: randomUUID(),
        prompt: this.drawPrompt(),
        authors: [seats[k], seats[(k + 1) % n]],
        answers: new Map(),
        votes: new Map(), // voterId -> author index
        result: null,
      });
    }
    this.phase = 'answer';
    this.setTimer(CONFIG.ANSWER_TIME, () => this.endAnswers());
    this.changed();
  }

  pendingPromptsFor(playerId) {
    return this.matchups.filter((m) => m.authors.includes(playerId) && !m.answers.has(playerId));
  }

  submitAnswer(playerId, matchupId, rawText) {
    this.touch();
    const text = clean(rawText, CONFIG.MAX_ANSWER);
    if (!text) return;

    if (this.phase === 'answer') {
      const m = this.matchups.find((x) => x.id === matchupId);
      if (!m || !m.authors.includes(playerId) || m.answers.has(playerId)) return;
      m.answers.set(playerId, text);
    } else if (this.phase === 'final-answer') {
      if (!this.players.has(playerId) || this.final.answers.has(playerId)) return;
      this.final.answers.set(playerId, text);
    } else {
      return;
    }
    if (!this.checkProgress()) this.changed();
  }

  safetyQuip() {
    return SAFETY_QUIPS[Math.floor(Math.random() * SAFETY_QUIPS.length)];
  }

  /** Advances early once everyone who can act has acted. Returns true if it advanced. */
  checkProgress() {
    if (this.phase === 'answer') {
      const waiting = this.connectedPlayers().some((p) => this.pendingPromptsFor(p.id).length > 0);
      if (!waiting) {
        this.endAnswers();
        return true;
      }
    } else if (this.phase === 'vote') {
      const m = this.matchups[this.current];
      if (this.eligibleVoters(m).every((p) => m.votes.has(p.id))) {
        this.reveal();
        return true;
      }
    } else if (this.phase === 'final-answer') {
      if (this.connectedPlayers().every((p) => this.final.answers.has(p.id))) {
        this.endFinalAnswers();
        return true;
      }
    } else if (this.phase === 'final-vote') {
      if (this.finalVoters().every((p) => this.final.votes.has(p.id))) {
        this.finalReveal();
        return true;
      }
    }
    return false;
  }

  endAnswers() {
    this.clearTimer();
    this.current = -1;
    this.nextMatchup();
  }

  nextMatchup() {
    this.current++;
    const m = this.matchups[this.current];
    if (!m) {
      this.showScores();
      return;
    }
    const answered = m.authors.filter((id) => m.answers.has(id));
    if (answered.length === 0) {
      this.nextMatchup();
      return;
    }
    if (answered.length === 1) {
      this.reveal();
      return;
    }
    this.phase = 'vote';
    if (this.eligibleVoters(m).length === 0) {
      this.reveal();
      return;
    }
    this.setTimer(CONFIG.VOTE_TIME, () => this.reveal());
    this.changed();
  }

  eligibleVoters(m) {
    return this.connectedPlayers().filter((p) => !m.authors.includes(p.id));
  }

  vote(playerId, matchupId, choice) {
    this.touch();
    if (this.phase === 'vote') {
      const m = this.matchups[this.current];
      if (!m || m.id !== matchupId || m.authors.includes(playerId) || m.votes.has(playerId)) return;
      if (choice !== 0 && choice !== 1) return;
      if (!this.players.has(playerId)) return;
      m.votes.set(playerId, choice);
    } else if (this.phase === 'final-vote') {
      const opt = this.final.options[choice];
      if (!opt || opt === playerId || this.final.votes.has(playerId) || !this.players.has(playerId)) return;
      this.final.votes.set(playerId, opt);
    } else {
      return;
    }
    if (!this.checkProgress()) this.changed();
  }

  reveal() {
    this.clearTimer();
    const m = this.matchups[this.current];
    const r = this.round;
    const votes = [0, 0];
    const voters = [[], []];
    for (const [voterId, idx] of m.votes) {
      votes[idx]++;
      voters[idx].push(this.players.get(voterId)?.name ?? '?');
    }
    const total = votes[0] + votes[1];
    const points = [0, 0];
    let smash = null;
    let forfeit = null;

    const answered = m.authors.map((id) => m.answers.has(id));
    if (answered[0] !== answered[1]) {
      forfeit = answered[0] ? 0 : 1;
      points[forfeit] = (CONFIG.POINTS_PER_ROUND / 2) * r;
    } else if (total > 0) {
      for (const i of [0, 1]) points[i] = Math.round((CONFIG.POINTS_PER_ROUND * r * votes[i]) / total / 10) * 10;
      const winner = votes[0] === total ? 0 : votes[1] === total ? 1 : null;
      if (winner !== null && total >= 2) {
        smash = winner;
        points[winner] += CONFIG.SMASH_BONUS * r;
      }
    }

    m.authors.forEach((id, i) => {
      const p = this.players.get(id);
      if (p) p.score += points[i];
    });
    m.result = { votes, voters, points, smash, forfeit };
    this.phase = 'reveal';
    this.setTimer(CONFIG.REVEAL_TIME, () => this.nextMatchup());
    this.changed();
  }

  showScores() {
    this.phase = 'scores';
    this.setTimer(CONFIG.SCORES_TIME, () => {
      this.round++;
      this.beginRound();
    });
    this.changed();
  }

  endFinalAnswers() {
    this.clearTimer();
    this.final.options = shuffle([...this.final.answers.keys()]);
    if (this.final.options.length < 2) {
      this.finalReveal();
      return;
    }
    this.phase = 'final-vote';
    if (this.finalVoters().length === 0) {
      this.finalReveal();
      return;
    }
    this.setTimer(CONFIG.FINAL_VOTE_TIME, () => this.finalReveal());
    this.changed();
  }

  finalVoters() {
    // Anyone with at least one answer that isn't their own to vote for.
    return this.connectedPlayers().filter((p) => this.final.options.some((o) => o !== p.id));
  }

  finalReveal() {
    this.clearTimer();
    const tally = new Map(this.final.options.map((id) => [id, []]));
    for (const [voterId, authorId] of this.final.votes) {
      tally.get(authorId)?.push(this.players.get(voterId)?.name ?? '?');
    }
    this.final.result = this.final.options
      .map((id) => {
        const voters = tally.get(id);
        const points = voters.length * CONFIG.FINAL_VOTE_POINTS;
        const p = this.players.get(id);
        if (p) p.score += points;
        return { authorId: id, voters, points };
      })
      .sort((a, b) => b.voters.length - a.voters.length);
    this.phase = 'final-reveal';
    this.setTimer(CONFIG.FINAL_REVEAL_TIME, () => this.end());
    this.changed();
  }

  end() {
    this.clearTimer();
    this.phase = 'end';
    this.changed();
  }

  destroy() {
    this.clearTimer();
  }

  // ---------- views sent to clients ----------

  leaderboard() {
    return [...this.players.values()]
      .sort((a, b) => b.score - a.score)
      .map((p) => this.publicPlayer(p));
  }

  publicPlayer(p) {
    return { id: p.id, name: p.name, score: p.score, color: p.color, connected: p.connected, vip: p.id === this.vip };
  }

  isDone(playerId) {
    switch (this.phase) {
      case 'answer':
        return this.pendingPromptsFor(playerId).length === 0;
      case 'vote':
        // Not true for authors: that would reveal who wrote what.
        return this.matchups[this.current].votes.has(playerId);
      case 'final-answer':
        return this.final.answers.has(playerId);
      case 'final-vote':
        return this.final.votes.has(playerId) || !this.final.options.some((o) => o !== playerId);
      default:
        return false;
    }
  }

  matchupView() {
    const m = this.matchups[this.current];
    if (!m || !['vote', 'reveal'].includes(this.phase)) return null;
    const answers = m.authors.map((id, i) => {
      const a = { text: m.answers.get(id) ?? null };
      if (this.phase === 'reveal') {
        const p = this.players.get(id);
        Object.assign(a, {
          author: p ? this.publicPlayer(p) : null,
          votes: m.result.votes[i],
          voters: m.result.voters[i],
          points: m.result.points[i],
          smash: m.result.smash === i,
          forfeit: m.result.forfeit === i,
        });
      }
      return a;
    });
    return { id: m.id, prompt: m.prompt, answers, index: this.current, total: this.matchups.length };
  }

  finalView() {
    if (!this.final) return null;
    const view = { prompt: this.final.prompt };
    if (this.phase === 'final-vote') {
      view.options = this.final.options.map((id) => ({ text: this.final.answers.get(id) }));
    }
    if (this.phase === 'final-reveal' && this.final.result) {
      view.results = this.final.result.map((r) => {
        const p = this.players.get(r.authorId);
        return {
          text: this.final.answers.get(r.authorId),
          author: p ? this.publicPlayer(p) : null,
          voters: r.voters,
          points: r.points,
        };
      });
    }
    return view;
  }

  base() {
    return {
      code: this.code,
      phase: this.phase,
      round: this.round,
      totalRounds: this.totalRounds,
      endsAt: this.endsAt,
      serverNow: Date.now(),
      minPlayers: CONFIG.MIN_PLAYERS,
      maxAnswer: CONFIG.MAX_ANSWER,
    };
  }

  hostView() {
    return {
      ...this.base(),
      role: 'host',
      canStart: this.canStart(),
      players: [...this.players.values()].map((p) => ({ ...this.publicPlayer(p), done: this.isDone(p.id) })),
      leaderboard: this.leaderboard(),
      matchup: this.matchupView(),
      final: this.finalView(),
    };
  }

  playerView(playerId) {
    const p = this.players.get(playerId);
    if (!p) return { ...this.base(), role: 'player', kicked: true };
    const rank = this.leaderboard().findIndex((x) => x.id === playerId) + 1;
    return {
      ...this.base(),
      role: 'player',
      me: { ...this.publicPlayer(p), rank },
      playerCount: this.players.size,
      canStart: this.vip === playerId && this.canStart(),
      task: this.taskFor(playerId),
    };
  }

  taskFor(playerId) {
    const wait = (message) => ({ type: 'wait', key: `${this.phase}:${this.round}:${this.current}`, message });

    switch (this.phase) {
      case 'lobby':
        return wait(this.vip === playerId ? 'You\'re the VIP — start when everyone\'s in.' : 'Waiting for the VIP to start…');
      case 'answer': {
        const mine = this.matchups.filter((m) => m.authors.includes(playerId));
        const pending = this.pendingPromptsFor(playerId);
        if (mine.length === 0) return wait('You joined mid-round. You can vote once answers are in!');
        if (pending.length === 0) return wait('Answers locked in. Waiting on the slowpokes…');
        const m = pending[0];
        return {
          type: 'answer',
          key: `answer:${m.id}`,
          matchupId: m.id,
          prompt: m.prompt,
          index: mine.length - pending.length + 1,
          of: mine.length,
        };
      }
      case 'vote': {
        const m = this.matchups[this.current];
        if (m.authors.includes(playerId)) return wait('That\'s YOUR answer up there. Look innocent.');
        if (m.votes.has(playerId)) return wait('Vote locked in.');
        return {
          type: 'vote',
          key: `vote:${m.id}`,
          matchupId: m.id,
          prompt: m.prompt,
          options: m.authors.map((id, i) => ({ index: i, text: m.answers.get(id) })),
        };
      }
      case 'final-answer':
        if (this.final.answers.has(playerId)) return wait('Locked in. Waiting for everyone else…');
        return { type: 'answer', key: `final:${this.round}`, matchupId: 'final', prompt: this.final.prompt, final: true };
      case 'final-vote': {
        if (this.final.votes.has(playerId)) return wait('Vote locked in.');
        const options = this.final.options
          .map((id, i) => ({ index: i, text: this.final.answers.get(id), mine: id === playerId }))
          .filter((o) => !o.mine);
        if (options.length === 0) return wait('Sit tight…');
        return { type: 'vote', key: `final-vote:${this.round}`, matchupId: 'final', prompt: this.final.prompt, options, final: true };
      }
      case 'end':
        return { type: 'end', key: `end:${playerId}`, vip: this.vip === playerId };
      default:
        return wait('Eyes on the big screen!');
    }
  }
}
