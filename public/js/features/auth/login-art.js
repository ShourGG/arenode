import { initLogoParticles } from './logo-particles.js?v=particles-perf-20261019';

// 登录页徽标：粒子聚散 + 3D 视差倾斜 + 光标探照灯；重复调用幂等。
const TILT_DEG = 6;

export function initLoginArtFx() {
  const art = document.querySelector('.login-art');
  const stage = document.querySelector('.art-stage');
  if (!art || !stage || stage.dataset.artBoot === '1') return;
  stage.dataset.artBoot = '1';
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  // Decorative effects must never prevent the login form from booting.
  try { initLogoParticles(art, stage); } catch {}

  let pointerFrame = 0, clientX = 0, clientY = 0;
  const updateTilt = () => {
    pointerFrame = 0;
    if (reduced.matches || document.hidden) return;
    const r = art.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const nx = ((clientX - r.left) / r.width) * 2 - 1;
    const ny = ((clientY - r.top) / r.height) * 2 - 1;
    stage.style.setProperty('--tilt-x', `${(-ny * TILT_DEG).toFixed(2)}deg`);
    stage.style.setProperty('--tilt-y', `${(nx * TILT_DEG).toFixed(2)}deg`);
    art.style.setProperty('--glow-x', `${(clientX - r.left).toFixed(1)}px`);
    art.style.setProperty('--glow-y', `${(clientY - r.top).toFixed(1)}px`);
  };
  art.addEventListener('pointermove', event => {
    if (reduced.matches || event.pointerType === 'touch') return;
    clientX = event.clientX; clientY = event.clientY;
    if (!pointerFrame) pointerFrame = requestAnimationFrame(updateTilt);
  }, { passive: true });
  const resetTilt = () => {
    cancelAnimationFrame(pointerFrame);
    pointerFrame = 0;
    stage.style.setProperty('--tilt-x', '0deg');
    stage.style.setProperty('--tilt-y', '0deg');
  };
  art.addEventListener('pointerleave', resetTilt);
  reduced.addEventListener('change', resetTilt);
  document.addEventListener('visibilitychange', () => { if (document.hidden) resetTilt(); });
}
