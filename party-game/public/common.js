/** Tiny DOM helper: h('div', { class: 'x', onclick }, 'text', childEl) */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** WebSocket that reconnects on its own and re-runs `onOpen` each time (to rejoin). */
export function connect({ onOpen, onMessage, onStatus }) {
  let ws;
  let retry = 0;
  let retryTimer = null;
  const queue = [];

  const open = () => {
    clearTimeout(retryTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/ws`);
    ws = sock;
    sock.onopen = () => {
      retry = 0;
      onStatus?.(true);
      onOpen?.();
      while (queue.length) sock.send(queue.shift());
    };
    sock.onmessage = (e) => onMessage(JSON.parse(e.data));
    sock.onclose = () => {
      if (sock !== ws) return;
      onStatus?.(false);
      retryTimer = setTimeout(open, Math.min(500 * 2 ** retry++, 5000));
    };
  };
  open();

  // Phones sleep and drop sockets; reconnect as soon as the tab is visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ws.readyState === WebSocket.CLOSED) open();
  });

  return {
    send(msg) {
      const data = JSON.stringify(msg);
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
      else queue.push(data);
    },
  };
}

/** Keeps a countdown element in sync with the server's `endsAt`. */
export function countdown(el, onTick) {
  let endsAt = null;
  let offset = 0;
  let last = null;
  setInterval(() => {
    if (!endsAt) {
      el.hidden = true;
      return;
    }
    const secs = Math.max(0, Math.ceil((endsAt - (Date.now() + offset)) / 1000));
    el.hidden = false;
    el.textContent = secs;
    el.classList.toggle('urgent', secs <= 5);
    if (secs !== last) onTick?.(secs);
    last = secs;
  }, 200);
  return (state) => {
    endsAt = state.endsAt;
    offset = state.serverNow - Date.now();
  };
}

export const storage = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};
