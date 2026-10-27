# Quip Clash 🎤

A Jackbox-style party game. One shared screen (TV, laptop, or a Discord screen-share) shows the game, and everyone plays on their phone. No app to install.

**How it plays (3–10 players):**
1. **Rounds 1 & 2.** Everyone gets 2 prompts. Each prompt goes to two players, and their answers go head-to-head.
2. **Voting.** Everyone else votes for the funnier answer. Points depend on your share of the vote, and round 2 is worth double. Win every vote (with 2+ voters) and you get a **QUIP SMASH** bonus.
3. **Final round.** Everyone answers the same prompt and everyone votes. Each vote is worth 500.

Stuck? Hit **Safety quip 🛟** for a canned answer.

## Run it

```bash
cd party-game
npm install
npm start
```

- Open **http://localhost:3000/host** on the big screen and click **Start a room**.
- Players on the same Wi-Fi scan the QR code, or go to the address shown on screen and type the room code.
- The first player to join is the 👑 VIP and can start the game from their phone.

### Playing with friends who aren't in the room

Everyone needs to reach your server, so you need a public URL. Then share the host screen on Discord or Zoom.

**Quickest option, from your own computer:**
```bash
npm start
npx cloudflared tunnel --url http://localhost:3000   # prints https://something.trycloudflare.com
```
Open `https://<that-url>/host` yourself (so the on-screen join link and QR code are correct) and send friends the same URL.

**Always-on option:** deploy to any host that supports WebSockets (Render, Railway, Fly.io). Set the start command to `npm start`, the root directory to `party-game`, and let it use the `PORT` env var. (Vercel/Netlify serverless won't work because the game needs a long-running WebSocket server.)

### Testing solo

```bash
npm run bots -- ABCD 3      # drop 3 bot players into room ABCD
npm test                    # plays a full game at 20x speed with bots
TIME_SCALE=0.3 npm start    # make every timer 3x faster
```

## Make it yours

- **Prompts:** edit `prompts.js`. Inside jokes about your friend group work best.
- **Timers, points, player limits:** `CONFIG` at the top of `game.js`.
- **Look:** `public/style.css` (colors at the top), `public/host.css` (TV), `public/play.css` (phone).

## How it's built

- `server.js`: a plain Node HTTP server plus a WebSocket (`ws`) server. Rooms live in memory.
- `game.js`: the `Room` class, i.e. the game's state machine (lobby → answer → vote → reveal → scores → final → end).
- `public/`: no-build vanilla JS. `host.*` is the TV screen and `play.*` is the phone controller.

Refreshing a phone or losing signal is fine: players rejoin their seat automatically. The host screen can be refreshed too.
