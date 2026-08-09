/* Small DOM/UI toolkit — element builder, icons, toasts, modals.
 * Deliberately tiny: this app has no framework and no build step, so the
 * primitives here are what every view is written in terms of.
 */

/**
 * Build an element.
 *   el('div.task', { onclick: fn }, 'text', childEl)
 * The tag string supports CSS-ish shorthand: 'button.btn.btn-primary#save'.
 */
export function el(tag, props = null, ...children) {
  let tagName = 'div';
  const classes = [];
  let id = null;

  const match = tag.match(/^([a-zA-Z0-9-]+)?((?:[.#][\w-]+)*)$/);
  if (match) {
    if (match[1]) tagName = match[1];
    const rest = match[2] || '';
    for (const token of rest.match(/[.#][\w-]+/g) || []) {
      if (token[0] === '.') classes.push(token.slice(1));
      else id = token.slice(1);
    }
  } else {
    tagName = tag;
  }

  const node = document.createElement(tagName);
  if (classes.length) node.className = classes.join(' ');
  if (id) node.id = id;

  if (props && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props)) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = [node.className, value].filter(Boolean).join(' ');
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'html') node.innerHTML = value;
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in node && key !== 'list' && key !== 'title') {
        node[key] = value;
      } else {
        node.setAttribute(key, value === true ? '' : value);
      }
    }
  } else if (props != null) {
    children.unshift(props);
  }

  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) append(node, child);
    else if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ------------------------------------------------------------------ */
/* Icons — inline so the app works fully offline with no icon font.    */
/* ------------------------------------------------------------------ */

/* Icon set.
 *
 * Drawn on a consistent 24px grid with a 1.75 stroke, rounded joins, and
 * geometry that lines up between glyphs — matched corner radii, matched
 * optical weight, no glyph noticeably heavier than its neighbours. The
 * previous set was assembled ad hoc: the gear was a tangle of arcs that turned
 * to mush under 18px, and Home borrowed the inbox tray, which meant the most
 * important destination in the app had a glyph that said something else.
 */
const ICONS = {
  home: '<path d="M3.5 10.4 12 3.6l8.5 6.8"/><path d="M5.5 9v10.4a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9"/><path d="M9.75 20.4v-6h4.5v6"/>',
  calendar: '<rect x="3.25" y="5" width="17.5" height="15.75" rx="2.5"/><path d="M3.25 9.75h17.5"/><path d="M8 3.25v3.5M16 3.25v3.5"/>',
  today: '<rect x="3.25" y="5" width="17.5" height="15.75" rx="2.5"/><path d="M3.25 9.75h17.5"/><path d="M8 3.25v3.5M16 3.25v3.5"/><circle cx="12" cy="15.25" r="2" fill="currentColor" stroke="none"/>',
  check: '<path d="M4.75 12.5 9.5 17.25 19.25 7"/>',
  list: '<path d="M9 6.5h11.25M9 12h11.25M9 17.5h11.25"/><circle cx="4.25" cy="6.5" r="1.15" fill="currentColor" stroke="none"/><circle cx="4.25" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="4.25" cy="17.5" r="1.15" fill="currentColor" stroke="none"/>',
  inbox: '<path d="M3.25 13.5h4.5l1.4 2.75h5.7l1.4-2.75h4.5"/><path d="M6.1 4.5h11.8a1 1 0 0 1 .93.64l2.02 7.6v4.51a2.5 2.5 0 0 1-2.5 2.5H5.75a2.5 2.5 0 0 1-2.5-2.5v-4.5l2.02-7.61a1 1 0 0 1 .83-.64Z"/>',
  chart: '<path d="M21 12a9 9 0 1 1-9-9"/><path d="M12 3a9 9 0 0 1 9 9h-9V3Z" fill="currentColor" stroke="none" opacity=".35"/><path d="M12 3a9 9 0 0 1 9 9h-9V3Z"/>',
  plus: '<path d="M12 5.25v13.5M5.25 12h13.5"/>',
  settings: '<circle cx="12" cy="12" r="3.1"/><path d="M12 2.75h0a2 2 0 0 1 1.94 1.5l.2.78a7.6 7.6 0 0 1 1.6.93l.77-.24a2 2 0 0 1 2.34.9l.35.6a2 2 0 0 1-.4 2.47l-.58.53a7.7 7.7 0 0 1 0 1.86l.58.53a2 2 0 0 1 .4 2.47l-.35.6a2 2 0 0 1-2.34.9l-.77-.24a7.6 7.6 0 0 1-1.6.93l-.2.78a2 2 0 0 1-1.94 1.5h-.7a2 2 0 0 1-1.94-1.5l-.2-.78a7.6 7.6 0 0 1-1.6-.93l-.77.24a2 2 0 0 1-2.34-.9l-.35-.6a2 2 0 0 1 .4-2.47l.58-.53a7.7 7.7 0 0 1 0-1.86l-.58-.53a2 2 0 0 1-.4-2.47l.35-.6a2 2 0 0 1 2.34-.9l.77.24a7.6 7.6 0 0 1 1.6-.93l.2-.78a2 2 0 0 1 1.94-1.5Z"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  chevronLeft: '<path d="M14.75 5.5 8.25 12l6.5 6.5"/>',
  chevronRight: '<path d="M9.25 5.5 15.75 12l-6.5 6.5"/>',
  menu: '<path d="M3.75 7h16.5M3.75 12h16.5M3.75 17h16.5"/>',
  trash: '<path d="M3.75 6.75h16.5"/><path d="M9.5 6.75V4.9a1.15 1.15 0 0 1 1.15-1.15h2.7A1.15 1.15 0 0 1 14.5 4.9v1.85"/><path d="M6.5 6.75l.85 12.4a2 2 0 0 0 2 1.85h5.3a2 2 0 0 0 2-1.85l.85-12.4"/><path d="M10.25 11v5.5M13.75 11v5.5"/>',
  edit: '<path d="M4 20h4.2L20 8.2a2.26 2.26 0 0 0-3.2-3.2L5 16.8V20Z"/><path d="M15.5 6.3 18.7 9.5"/>',
  clock: '<circle cx="12" cy="12" r="8.75"/><path d="M12 6.75V12l3.6 2.1"/>',
  repeat: '<path d="M16.75 2.75 20.25 6.25 16.75 9.75"/><path d="M3.75 12.5v-2.25a4 4 0 0 1 4-4h12.5"/><path d="M7.25 21.25 3.75 17.75l3.5-3.5"/><path d="M20.25 11.5v2.25a4 4 0 0 1-4 4H3.75"/>',
  bell: '<path d="M18.25 9a6.25 6.25 0 1 0-12.5 0c0 5.6-2.25 7.25-2.25 7.25h17S18.25 14.6 18.25 9Z"/><path d="M13.85 20.25a2.15 2.15 0 0 1-3.7 0"/>',
  cloud: '<path d="M17.25 19.25a4.75 4.75 0 0 0 .4-9.48 6.75 6.75 0 0 0-12.86 1.1A4.25 4.25 0 0 0 5.5 19.25Z"/>',
  sun: '<circle cx="12" cy="12" r="4.1"/><path d="M12 2.75v2M12 19.25v2M2.75 12h2M19.25 12h2M5.4 5.4l1.4 1.4M17.2 17.2l1.4 1.4M18.6 5.4l-1.4 1.4M6.8 17.2l-1.4 1.4"/>',
  moon: '<path d="M20.5 14.6A8.75 8.75 0 0 1 9.4 3.5a8.75 8.75 0 1 0 11.1 11.1Z"/>',
  undo: '<path d="M3.75 8.75h10.75a5.25 5.25 0 0 1 0 10.5H8.25"/><path d="M7.25 4.75 3.25 8.75l4 4"/>',
  drag: '<circle cx="9.25" cy="6" r="1.35" fill="currentColor" stroke="none"/><circle cx="14.75" cy="6" r="1.35" fill="currentColor" stroke="none"/><circle cx="9.25" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="14.75" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="9.25" cy="18" r="1.35" fill="currentColor" stroke="none"/><circle cx="14.75" cy="18" r="1.35" fill="currentColor" stroke="none"/>',
  warning: '<path d="M10.6 4.1 2.85 17.6A1.6 1.6 0 0 0 4.24 20h15.52a1.6 1.6 0 0 0 1.39-2.4L13.4 4.1a1.6 1.6 0 0 0-2.8 0Z"/><path d="M12 9.5v4.25M12 17.35h.01"/>',
  mic: '<rect x="9.25" y="2.75" width="5.5" height="11" rx="2.75"/><path d="M5.75 11.25a6.25 6.25 0 0 0 12.5 0M12 17.5v3.75M8.75 21.25h6.5"/>',
};

export function icon(name, cls = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

let toastHost = null;

function ensureToastHost() {
  if (!toastHost) {
    toastHost = el('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  return toastHost;
}

/**
 * Show a transient message. `action` renders a button (used for Undo).
 * Returns a function that dismisses it early.
 */
export function toast(message, { action = null, onAction = null, duration = 4000, error = false } = {}) {
  const host = ensureToastHost();
  const node = el(error ? 'div.toast.is-error' : 'div.toast',
    el('span', message),
    action && el('button', {
      onclick: () => { onAction?.(); dismiss(); },
    }, action),
  );
  host.appendChild(node);

  let timer = setTimeout(dismiss, duration);
  function dismiss() {
    clearTimeout(timer);
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    node.style.transition = 'opacity .15s, transform .15s';
    setTimeout(() => node.remove(), 160);
  }
  return dismiss;
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

let activeModal = null;

/**
 * Open a modal. `render(close)` returns the body content; `footer(close)`
 * returns the button row. Escape and backdrop click both close.
 */
export function openModal({ title, render, footer = null, onClose = null, width = null }) {
  closeModal();

  const overlay = el('div.overlay', {
    onclick: (e) => { if (e.target === overlay) close(); },
  });
  const modal = el('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  if (width) modal.style.width = width;

  const body = el('div.modal-body');
  const head = el('div.modal-head',
    el('h2', title),
    el('button.btn.btn-ghost.btn-icon', { onclick: close, 'aria-label': 'Close' }, icon('close')),
  );

  modal.append(head, body);
  const content = render(close);
  if (content) body.append(...(Array.isArray(content) ? content : [content]));

  if (footer) {
    const foot = el('div.modal-foot');
    const f = footer(close);
    foot.append(...(Array.isArray(f) ? f : [f]));
    modal.appendChild(foot);
  }

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey, true);

  // Focus the first meaningful control so keyboard users land in the right place.
  requestAnimationFrame(() => {
    const target = modal.querySelector('input, textarea, select, button.btn-primary');
    target?.focus();
    if (target?.select) target.select();
  });

  function close() {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    activeModal = null;
    onClose?.();
  }

  activeModal = { close, modal, body };
  return activeModal;
}

export function closeModal() {
  activeModal?.close();
}

/** Yes/no dialog. Resolves true when confirmed. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    openModal({
      title,
      render: () => el('p', { style: { margin: 0, lineHeight: '1.55' } }, message),
      footer: (close) => [
        el('button.btn', { onclick: () => { settled = true; close(); resolve(false); } }, 'Cancel'),
        el(danger ? 'button.btn.btn-primary' : 'button.btn.btn-primary', {
          style: danger ? { background: 'var(--danger)', color: '#fff' } : null,
          onclick: () => { settled = true; close(); resolve(true); },
        }, confirmLabel),
      ],
      onClose: () => { if (!settled) resolve(false); },
    });
  });
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

/** Debounce — used for search boxes and resize handlers. */
export function debounce(fn, ms = 150) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function isMobile() {
  return window.matchMedia('(max-width: 760px)').matches;
}

export function isTablet() {
  return window.matchMedia('(max-width: 1180px)').matches;
}

/** Short haptic tick on supporting devices — used on completion. */
export function haptic(ms = 12) {
  try { navigator.vibrate?.(ms); } catch { /* not supported */ }
}
