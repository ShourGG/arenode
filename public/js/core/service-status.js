import { state } from '../state/index.js';
import { api } from '../services/api-client.js';
import { $ } from './dom.js';

let serviceStatusTimer = null;

export function stopServiceStatusTimer() {
  clearInterval(serviceStatusTimer); serviceStatusTimer = null;
}

export function paintServiceStatus(status, { unknown = false } = {}) {
  const top = $('#apiStatus'); const overview = $('#welcomeServiceStatus');
  if (!top) return;
  if (unknown) {
    top.className = 'pending'; top.innerHTML = '<i></i>状态未知';
    if (overview) { overview.textContent = '状态未知'; overview.className = ''; }
    return;
  }
  const healthy = status === 'healthy'; const degraded = status === 'degraded';
  const checking = status === 'checking';
  top.className = checking ? 'pending' : healthy ? 'healthy' : degraded ? 'warning' : 'error';
  top.innerHTML = `<i></i>${checking ? '检测中' : healthy ? '正常' : degraded ? '部分降级' : '部分异常'}`;
  if (overview) {
    overview.textContent = checking ? '检测中' : healthy ? '服务正常' : degraded ? '部分降级' : '部分异常';
    overview.className = checking ? '' : healthy ? 'success-text' : degraded ? 'warning-text' : 'danger-text';
  }
}

export function recalledServiceStatus() {
  if (state.serviceStatus) return state.serviceStatus;
  try { return sessionStorage.getItem('arenode-service-status') || null; } catch { return null; }
}

function rememberServiceStatus(status) {
  state.serviceStatus = status;
  try { sessionStorage.setItem('arenode-service-status', status); } catch {}
}

export async function loadServiceStatus() {
  const top = $('#apiStatus');
  if (!top || !state.me) return;
  const last = recalledServiceStatus();
  if (last) paintServiceStatus(last);
  else paintServiceStatus('checking');
  try {
    const endpoint = state.me.user.role === 'admin' ? '/api/admin/health' : '/api/service-status';
    const result = await api(endpoint); const status = result.status || (result.ok ? 'healthy' : 'unhealthy');
    rememberServiceStatus(status);
    paintServiceStatus(status);
  } catch {
    if (!recalledServiceStatus()) paintServiceStatus(null, { unknown: true });
  }
  if (!serviceStatusTimer) serviceStatusTimer = setInterval(() => { if (state.me) loadServiceStatus().catch(() => {}); }, 30_000);
}
