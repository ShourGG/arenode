// 登录页右侧花朵鼠标互动：A 视差倾斜/探照灯 + C 点阵物理涟漪。
// 点阵布局在运行时解析 /assets/login-halftone.svg，与静态降级视觉完全一致；
// 物理模型 = 弹簧回位 + 光标排斥 + 点击爆发，悬停点阵变橙并放大。
// 无 JS / prefers-reduced-motion / 初始化失败时，保留 .art-dots 静态 SVG 遮罩降级。

const SVG_URL = '/assets/login-halftone.svg';
const TAU = Math.PI * 2;
const SPIN_MS = 60000;      // 与 art-spin 一致：60s 一圈
const BREATHE_MS = 9000;    // 与 art-breathe 一致：9s ±4.5%
const SPRING = 0.075;       // 弹簧回位强度
const DAMPING = 0.88;       // 速度阻尼
const REPEL_R = 170;        // 排斥半径（SVG 坐标单位）
const REPEL_F = 3.6;        // 排斥力度
const HOVER_R = 185;        // 橙色渲染半径
const BURST_R = 260;        // 点击爆发半径
const BURST_F = 16;         // 点击爆发冲量
const TILT_DEG = 6;         // 3D 倾斜最大角度

function parseColor(value) {
  const text = (value || '').trim();
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(text);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const hex = /^#([0-9a-f]{6})$/i.exec(text);
  if (hex) { const v = parseInt(hex[1], 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
  return null;
}

async function loadDots() {
  if (typeof fetch !== 'function' || typeof DOMParser !== 'function') return [];
  const response = await fetch(SVG_URL, { credentials: 'same-origin' });
  if (!response.ok) return [];
  const doc = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
  const dots = [];
  for (const circle of doc.querySelectorAll('circle')) {
    const cx = Number(circle.getAttribute('cx')) - 500;
    const cy = Number(circle.getAttribute('cy')) - 500;
    const r = Number(circle.getAttribute('r'));
    if (!Number.isFinite(cx + cy + r) || r <= 0) continue;
    dots.push({
      angle: Math.atan2(cy, cx), dist: Math.hypot(cx, cy), r,
      x: (Math.random() - 0.5) * 60, y: (Math.random() - 0.5) * 60, vx: 0, vy: 0,
    });
  }
  return dots;
}

export function initLoginArtFx() {
  try {
    const art = document.querySelector('.login-art');
    const stage = document.querySelector('.art-stage');
    const canvas = document.querySelector('.art-canvas');
    const shell = document.querySelector('.login-shell');
    if (!art || !stage || !canvas || !shell || stage.dataset.artBoot === '1') return;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;
    const ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return;
    stage.dataset.artBoot = '1';
    boot(art, stage, canvas, shell, ctx).catch(() => {});
  } catch {}
}

async function boot(art, stage, canvas, shell, ctx) {
  const dots = await loadDots();
  if (!dots.length) return;
  stage.classList.add('art-live'); // 接管成功，隐藏静态降级点阵

  let scale = 0.6, originX = 0, originY = 0;
  const resize = () => {
    const rect = art.getBoundingClientRect();
    const dpr = Math.min(2, (window.devicePixelRatio || 1));
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scale = Math.min(rect.width * 0.88, 820) / 1000; // 与 mask-size: min(88%, 820px) 对齐
    originX = rect.width / 2; originY = rect.height / 2;
  };
  resize();
  if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(art);
  else window.addEventListener('resize', resize);

  let base = [140, 136, 130], accent = [255, 77, 0];
  const readPalette = () => {
    try {
      base = parseColor(getComputedStyle(stage).getPropertyValue('--text-2')) || base;
      accent = parseColor(getComputedStyle(shell).getPropertyValue('--accent')) || accent;
    } catch {}
  };
  readPalette();
  window.addEventListener('arenode:themechange', readPalette);

  const cursor = { x: 0, y: 0, active: false }; // SVG 坐标
  art.addEventListener('mousemove', event => {
    const rect = art.getBoundingClientRect();
    cursor.x = (event.clientX - rect.left - rect.width / 2) / scale;
    cursor.y = (event.clientY - rect.top - rect.height / 2) / scale;
    cursor.active = true;
    // A：探照灯柔光跟随（CSS 像素）
    art.style.setProperty('--glow-x', `${event.clientX - rect.left}px`);
    art.style.setProperty('--glow-y', `${event.clientY - rect.top}px`);
    // A：舞台 3D 视差倾斜
    const nx = Math.max(-1, Math.min(1, (event.clientX - rect.left - rect.width / 2) / (rect.width / 2)));
    const ny = Math.max(-1, Math.min(1, (event.clientY - rect.top - rect.height / 2) / (rect.height / 2)));
    stage.style.setProperty('--tilt-x', `${(-ny * TILT_DEG).toFixed(2)}deg`);
    stage.style.setProperty('--tilt-y', `${(nx * TILT_DEG).toFixed(2)}deg`);
  });
  art.addEventListener('mouseleave', () => {
    cursor.active = false;
    stage.style.setProperty('--tilt-x', '0deg');
    stage.style.setProperty('--tilt-y', '0deg');
  });
  // C：点击爆发，点阵向外炸开后弹簧收回
  art.addEventListener('mousedown', event => {
    const rect = art.getBoundingClientRect();
    const bx = (event.clientX - rect.left - rect.width / 2) / scale;
    const by = (event.clientY - rect.top - rect.height / 2) / scale;
    for (const dot of dots) {
      const dx = dot.x - bx, dy = dot.y - by;
      const d = Math.hypot(dx, dy) || 1;
      if (d > BURST_R) continue;
      const f = (1 - d / BURST_R) * BURST_F;
      dot.vx += (dx / d) * f; dot.vy += (dy / d) * f;
    }
  });

  let theta = 0, last = performance.now();
  const frame = now => {
    requestAnimationFrame(frame);
    const dt = Math.min(50, now - last); last = now;
    if (shell.classList.contains('hidden')) return; // 登录页不可见时休眠
    const step = dt / 16.667;
    theta += (dt / SPIN_MS) * TAU;
    const breathe = 1 + 0.045 * Math.sin((now / BREATHE_MS) * TAU);

    for (const dot of dots) {
      const homeAngle = dot.angle + theta;
      const homeDist = dot.dist * breathe;
      const hx = Math.cos(homeAngle) * homeDist, hy = Math.sin(homeAngle) * homeDist;
      dot.vx += (hx - dot.x) * SPRING * step;
      dot.vy += (hy - dot.y) * SPRING * step;
      if (cursor.active) {
        const dx = dot.x - cursor.x, dy = dot.y - cursor.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < REPEL_R) {
          const f = (1 - d / REPEL_R) ** 2 * REPEL_F * step;
          dot.vx += (dx / d) * f; dot.vy += (dy / d) * f;
        }
      }
      dot.vx *= DAMPING; dot.vy *= DAMPING;
      dot.x += dot.vx * step; dot.y += dot.vy * step;
    }

    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    // 第一遍：整花基色（单次填充，批量路径）
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
    ctx.beginPath();
    for (const dot of dots) {
      const px = originX + dot.x * scale, py = originY + dot.y * scale;
      const pr = Math.max(0.4, dot.r * breathe * scale);
      ctx.moveTo(px + pr, py);
      ctx.arc(px, py, pr, 0, TAU);
    }
    ctx.fill();
    // 第二遍：光标附近的点染橙并微微放大（探照灯透镜）
    if (cursor.active) {
      ctx.fillStyle = `rgb(${accent[0]},${accent[1]},${accent[2]})`;
      for (const dot of dots) {
        const dx = dot.x - cursor.x, dy = dot.y - cursor.y;
        const d = Math.hypot(dx, dy);
        if (d > HOVER_R) continue;
        const glow = (1 - d / HOVER_R) ** 1.5;
        ctx.globalAlpha = Math.min(0.95, 0.2 + glow);
        const px = originX + dot.x * scale, py = originY + dot.y * scale;
        const pr = Math.max(0.4, dot.r * breathe * (1 + 0.35 * glow) * scale);
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, TAU);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  };
  requestAnimationFrame(frame);
}
