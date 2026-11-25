// Human-like input. Everything goes through webContents.sendInputEvent, which
// Chromium treats as real OS input: events are `isTrusted`, there is no
// DevTools protocol / webdriver attached, and timing + paths vary like a person.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random()) / 3; // ~normal in [0,1]

const lastPos = new WeakMap();

class Human {
  constructor(getSpeed = () => 1) {
    this.getSpeed = getSpeed;
  }

  wait(a, b) { return sleep(rand(a, b) * this.getSpeed()); }

  async moveTo(wc, x, y) {
    const from = lastPos.get(wc) || { x: rand(50, 300), y: rand(50, 200) };
    const dist = Math.hypot(x - from.x, y - from.y);
    const steps = Math.max(8, Math.min(45, Math.round(dist / rand(12, 22))));
    // cubic bezier with two random control points -> curved, non-linear path
    const c1 = { x: from.x + (x - from.x) * rand(0.2, 0.4) + rand(-80, 80), y: from.y + (y - from.y) * rand(0.1, 0.3) + rand(-60, 60) };
    const c2 = { x: from.x + (x - from.x) * rand(0.6, 0.8) + rand(-40, 40), y: from.y + (y - from.y) * rand(0.7, 0.9) + rand(-30, 30) };
    for (let i = 1; i <= steps; i++) {
      const lin = i / steps;
      const t = lin < 0.5 ? 2 * lin * lin : 1 - Math.pow(-2 * lin + 2, 2) / 2; // ease in-out
      const mt = 1 - t;
      const px = mt ** 3 * from.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t ** 3 * x;
      const py = mt ** 3 * from.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t ** 3 * y;
      wc.sendInputEvent({ type: 'mouseMove', x: Math.round(px), y: Math.round(py) });
      await sleep(rand(6, 16) * this.getSpeed());
    }
    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
    lastPos.set(wc, { x, y });
  }

  // Click somewhere inside the element box, not dead centre.
  async click(wc, box, { button = 'left', clickCount = 1 } = {}) {
    const w = Math.max(2, (box.w || 10) * 0.5);
    const h = Math.max(2, (box.h || 10) * 0.5);
    const x = Math.round(box.x + (gauss() - 0.5) * w);
    const y = Math.round(box.y + (gauss() - 0.5) * h);
    await this.moveTo(wc, x, y);
    await this.wait(40, 140);
    for (let n = 1; n <= clickCount; n++) {
      wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: n });
      await sleep(rand(45, 120) * this.getSpeed());
      wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: n });
      if (n < clickCount) await sleep(rand(60, 110));
    }
  }

  async key(wc, keyCode, modifiers = []) {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1 && !modifiers.some((m) => m === 'control' || m === 'meta')) {
      wc.sendInputEvent({ type: 'char', keyCode, modifiers });
    } else if (keyCode === 'Enter') {
      wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    }
    await sleep(rand(30, 90) * this.getSpeed());
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }

  async selectAllAndDelete(wc) {
    const mod = process.platform === 'darwin' ? 'meta' : 'control';
    await this.key(wc, 'a', [mod]);
    await this.wait(30, 80);
    await this.key(wc, 'Backspace');
  }

  async type(wc, text) {
    let i = 0;
    for (const ch of String(text)) {
      if (ch === '\n') await this.key(wc, 'Enter');
      else {
        const shift = ch !== ch.toLowerCase() || '~!@#$%^&*()_+{}|:"<>?'.includes(ch);
        await this.key(wc, ch, shift ? ['shift'] : []);
      }
      i++;
      // bursty rhythm with occasional "thinking" pauses
      let d = rand(35, 140);
      if (i % Math.round(rand(5, 11)) === 0) d += rand(120, 380);
      await sleep(d * this.getSpeed());
    }
  }

  async scroll(wc, dy, at = { x: 400, y: 300 }) {
    const ticks = Math.max(1, Math.round(Math.abs(dy) / 100));
    for (let i = 0; i < ticks; i++) {
      wc.sendInputEvent({ type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: dy > 0 ? -100 : 100, canScroll: true });
      await sleep(rand(30, 90) * this.getSpeed());
    }
  }
}

module.exports = { Human, sleep, rand };
