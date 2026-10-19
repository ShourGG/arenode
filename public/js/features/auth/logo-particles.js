// Sample the existing SVG so particle and static versions share the same silhouette.
// Only the visible desktop login illustration animates; static SVG is the fallback.
const SAMPLE_SIZE = 192;
const FRAME_MS = 1000 / 30;

export function initLogoParticles(art, stage) {
  const logo = stage.querySelector('.art-logo');
  if (!logo || !window.IntersectionObserver || !window.ResizeObserver) return;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return;
  canvas.className = 'logo-particles';
  canvas.setAttribute('aria-hidden', 'true');

  const desktop = window.matchMedia('(min-width: 1025px)');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const pointer = { x: 0, y: 0, active: false };
  const groups = [[], [], []];
  let particles = [];
  let width = 0, height = 0, side = 0;
  let visible = false, loading = false, failed = false;
  let frame = 0, lastPaint = 0, elapsed = 0, burstAt = -Infinity;
  let color = getComputedStyle(logo).getPropertyValue('--text-2').trim() || '#5b5955';

  const eligible = () => desktop.matches && !reduced.matches && visible && !document.hidden && width > 0 && height > 0;

  function resize() {
    const rect = art.getBoundingClientRect();
    const nextWidth = Math.round(rect.width), nextHeight = Math.round(rect.height);
    if (width !== nextWidth || height !== nextHeight) {
      width = nextWidth; height = nextHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      side = Math.min(width * .8, 720);
      for (const particle of particles) {
        particle.homeX = (width - side) / 2 + particle.u * side;
        particle.homeY = (height - side) / 2 + particle.v * side;
        particle.x = particle.homeX + Math.cos(particle.angle) * particle.spread;
        particle.y = particle.homeY + Math.sin(particle.angle) * particle.spread;
        particle.vx = particle.vy = 0;
      }
      pointer.active = false;
    }
    sync();
  }

  async function loadSilhouette() {
    loading = true;
    try {
      const image = new Image();
      image.src = '/assets/factory-logo.svg';
      await image.decode();
      const mask = document.createElement('canvas');
      mask.width = mask.height = SAMPLE_SIZE;
      const maskContext = mask.getContext('2d', { willReadFrequently: true });
      if (!maskContext) throw new Error('Canvas unavailable');
      maskContext.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      const pixels = maskContext.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
      for (let y = 1; y < SAMPLE_SIZE; y += 2) {
        for (let x = 1; x < SAMPLE_SIZE; x += 2) {
          if (pixels[(y * SAMPLE_SIZE + x) * 4 + 3] < 160) continue;
          const u = (x + (Math.random() - .5) * .7) / SAMPLE_SIZE;
          const v = (y + (Math.random() - .5) * .7) / SAMPLE_SIZE;
          const particle = {
            u, v, homeX: 0, homeY: 0, x: 0, y: 0, vx: 0, vy: 0,
            angle: Math.atan2(v - .5, u - .5) + (Math.random() - .5) * .9,
            spread: 85 + Math.random() * 155,
            phase: Math.random() * Math.PI * 2,
          };
          particles.push(particle);
          groups[Math.floor(Math.random() * groups.length)].push(particle);
        }
      }
      if (!particles.length) throw new Error('Empty silhouette');
      canvas.dataset.particleCount = String(particles.length);
      logo.append(canvas);
      // Force target positions to be recalculated after the asynchronous SVG load.
      width = height = 0;
      resize();
    } catch {
      failed = true;
      particles = [];
      canvas.remove();
      logo.classList.remove('particles-ready');
    } finally {
      loading = false;
    }
  }

  function sync() {
    const active = eligible() && particles.length > 0;
    logo.classList.toggle('particles-ready', Boolean(active));
    if (!active) {
      cancelAnimationFrame(frame);
      frame = lastPaint = 0;
      if (eligible() && !loading && !failed) void loadSilhouette();
      return;
    }
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function draw(now) {
    frame = 0;
    if (!eligible()) { sync(); return; }
    if (lastPaint && now - lastPaint < FRAME_MS - 1) {
      frame = requestAnimationFrame(draw);
      return;
    }
    const delta = lastPaint ? Math.min(now - lastPaint, 50) : FRAME_MS;
    lastPaint = now;
    elapsed += delta;
    const step = delta / (1000 / 60);
    const cycle = elapsed % 12500;
    const automatic = cycle > 8500 ? Math.sin((cycle - 8500) / 4000 * Math.PI) ** 2 : 0;
    const intro = Math.max(0, 1 - elapsed / 1600) ** 2;
    const burstAge = elapsed - burstAt;
    const burst = burstAge < 1900 ? Math.sin(burstAge / 1900 * Math.PI) : 0;
    const scatter = Math.max(intro, automatic, burst);
    const radius = Math.min(125, side * .24);
    const damping = Math.pow(.84, step);
    context.clearRect(0, 0, width, height);
    context.fillStyle = color;

    for (let group = 0; group < groups.length; group++) {
      context.globalAlpha = .52 + group * .16;
      context.beginPath();
      const dotRadius = Math.max(.75, Math.min(1.7, side * .0025)) * (.8 + group * .14);
      for (const particle of groups[group]) {
        const angle = particle.angle + scatter * .35;
        let tx = particle.homeX + Math.cos(angle) * particle.spread * scatter;
        let ty = particle.homeY + Math.sin(angle) * particle.spread * scatter;
        tx += Math.sin(elapsed * .0007 + particle.phase) * 1.4;
        ty += Math.cos(elapsed * .0006 + particle.phase) * 1.4;
        if (pointer.active) {
          const dx = particle.x - pointer.x, dy = particle.y - pointer.y;
          const distance = Math.hypot(dx, dy);
          if (distance < radius) {
            const force = (1 - distance / radius) ** 2 * 100;
            tx += dx / (distance || 1) * force;
            ty += dy / (distance || 1) * force;
          }
        }
        particle.vx = (particle.vx + (tx - particle.x) * .035 * step) * damping;
        particle.vy = (particle.vy + (ty - particle.y) * .035 * step) * damping;
        particle.x += particle.vx * step;
        particle.y += particle.vy * step;
        context.moveTo(particle.x + dotRadius, particle.y);
        context.arc(particle.x, particle.y, dotRadius, 0, Math.PI * 2);
      }
      context.fill();
    }
    frame = requestAnimationFrame(draw);
  }

  art.addEventListener('pointermove', event => {
    const rect = art.getBoundingClientRect();
    pointer.x = event.clientX - rect.left;
    pointer.y = event.clientY - rect.top;
    pointer.active = event.pointerType !== 'touch';
  }, { passive: true });
  art.addEventListener('pointerleave', () => { pointer.active = false; });
  art.addEventListener('pointerdown', event => {
    if (eligible() && event.button === 0) burstAt = elapsed;
  }, { passive: true });
  window.addEventListener('arenode:themechange', () => {
    color = getComputedStyle(logo).getPropertyValue('--text-2').trim() || '#5b5955';
  });
  document.addEventListener('visibilitychange', sync);
  desktop.addEventListener('change', resize);
  reduced.addEventListener('change', sync);
  new ResizeObserver(resize).observe(art);
  new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (!visible) pointer.active = false;
    resize();
  }).observe(art);
}
