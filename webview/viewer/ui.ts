let toastTimer: number | null = null;
/** Small transient toast for user-facing validation messages. */
export function showToast(text: string): void {
  let el = document.getElementById('ns-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ns-toast';
    el.style.cssText =
      'position:fixed;left:50%;bottom:56px;transform:translateX(-50%);' +
      'background:rgba(40,40,40,0.92);color:#fff;padding:8px 14px;border-radius:6px;' +
      'font-size:12px;z-index:9999;box-shadow:0 2px 8px rgba(0,0,0,0.35);' +
      'pointer-events:none;opacity:0;transition:opacity 0.2s';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.opacity = '1';
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.style.opacity = '0';
  }, 2400);
}
let tooltipHideTimer: number | null = null;

export function initTooltipSystem() {
  const el = document.createElement('div');
  el.className = 'ns-tooltip';
  document.body.appendChild(el);

  document.addEventListener('mouseover', (e) => {
    const target = (e.target as HTMLElement).closest('[data-tip]') as HTMLElement | null;
    if (!target) return;
    const tip = target.getAttribute('data-tip');
    if (!tip) return;
    if (tooltipHideTimer) {
      clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;
    }
    const pos = target.getAttribute('data-tip-pos') || 'top';
    const rect = target.getBoundingClientRect();
    el.textContent = tip;
    el.style.left = '0px';
    el.style.top = '0px';
    el.classList.add('visible');
    const tipRect = el.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    let top: number;
    if (pos === 'bottom') {
      top = rect.bottom + 6;
    } else {
      top = rect.top - tipRect.height - 6;
    }
    // Viewport clamping
    if (left < 4) left = 4;
    if (left + tipRect.width > window.innerWidth - 4) left = window.innerWidth - tipRect.width - 4;
    if (top < 4) top = rect.bottom + 6;
    if (top + tipRect.height > window.innerHeight - 4) top = rect.top - tipRect.height - 6;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });

  document.addEventListener('mouseout', (e) => {
    const target = (e.target as HTMLElement).closest('[data-tip]') as HTMLElement | null;
    if (!target) return;
    if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
    tooltipHideTimer = window.setTimeout(() => {
      el.classList.remove('visible');
    }, 80);
  });
}
