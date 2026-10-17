// 登录页右侧 Factory 徽标鼠标互动（A 层）：3D 视差倾斜 + 光标探照灯。
// 只写 CSS 变量，渲染完全交给 CSS transform / radial-gradient，零 canvas 零 rAF。
// prefers-reduced-motion 或节点缺失时跳过（徽标保持静态）；重复调用幂等。
const TILT_DEG = 6;

export function initLoginArtFx() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const art = document.querySelector('.login-art');
  const stage = document.querySelector('.art-stage');
  if (!art || !stage || stage.dataset.artBoot === '1') return;
  stage.dataset.artBoot = '1';

  art.addEventListener('mousemove', (e) => {
    const r = art.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
    stage.style.setProperty('--tilt-x', `${(-ny * TILT_DEG).toFixed(2)}deg`);
    stage.style.setProperty('--tilt-y', `${(nx * TILT_DEG).toFixed(2)}deg`);
    art.style.setProperty('--glow-x', `${(e.clientX - r.left).toFixed(1)}px`);
    art.style.setProperty('--glow-y', `${(e.clientY - r.top).toFixed(1)}px`);
  });
  art.addEventListener('mouseleave', () => {
    stage.style.setProperty('--tilt-x', '0deg');
    stage.style.setProperty('--tilt-y', '0deg');
  });
}
