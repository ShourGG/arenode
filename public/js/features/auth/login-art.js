import { initLogoParticles } from './logo-particles.js?v=particles-20261019';

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

  art.addEventListener('mousemove', (e) => {
    if (reduced.matches) return;
    const r = art.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
    stage.style.setProperty('--tilt-x', `${(-ny * TILT_DEG).toFixed(2)}deg`);
    stage.style.setProperty('--tilt-y', `${(nx * TILT_DEG).toFixed(2)}deg`);
    art.style.setProperty('--glow-x', `${(e.clientX - r.left).toFixed(1)}px`);
    art.style.setProperty('--glow-y', `${(e.clientY - r.top).toFixed(1)}px`);
  });
  const resetTilt = () => {
    stage.style.setProperty('--tilt-x', '0deg');
    stage.style.setProperty('--tilt-y', '0deg');
  };
  art.addEventListener('mouseleave', resetTilt);
  reduced.addEventListener('change', resetTilt);
}
