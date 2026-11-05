// Gentle falling snow on a canvas over the page (pointer-events none, so it
// never gets in the way). On by default for everyone; people who asked their
// system for reduced motion get fewer, slower flakes. The button turns it off.
let canvas = null;
let raf = 0;
let flakes = [];
const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function resize() {
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
}

function makeFlake(top = false) {
  return {
    x: Math.random() * window.innerWidth,
    y: top ? -10 : Math.random() * window.innerHeight,
    r: 1 + Math.random() * 2.6,
    s: (0.3 + Math.random() * 0.9) * (calm() ? 0.35 : 1),
    drift: Math.random() * Math.PI * 2,
    o: 0.35 + Math.random() * 0.5,
  };
}

function frame() {
  const ctx = canvas.getContext('2d');
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);
  const dark = getComputedStyle(document.documentElement).colorScheme === 'dark';
  for (const f of flakes) {
    f.drift += 0.01;
    f.y += f.s;
    f.x += Math.sin(f.drift) * 0.4;
    if (f.y > h + 10) Object.assign(f, makeFlake(true));
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
    ctx.fillStyle = dark ? `rgba(255,255,255,${f.o})` : `rgba(160,190,215,${f.o})`;
    ctx.fill();
  }
  raf = requestAnimationFrame(frame);
}

export function setSnow(on) {
  if (on && !canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'snow';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    resize();
    const n = Math.min(110, Math.round(window.innerWidth / 14));
    flakes = Array.from({ length: calm() ? Math.round(n / 3) : n }, () => makeFlake());
    window.addEventListener('resize', resize);
    raf = requestAnimationFrame(frame);
  } else if (!on && canvas) {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
    canvas.remove();
    canvas = null;
  }
}

export function snowPreference() {
  try {
    const v = localStorage.getItem('santa.snow');
    if (v === 'on' || v === 'off') return v === 'on';
  } catch { /* storage unavailable */ }
  return true;
}

export function saveSnow(on) {
  try { localStorage.setItem('santa.snow', on ? 'on' : 'off'); } catch { /* ignore */ }
}
