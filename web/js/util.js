// Shared DOM + misc utilities.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const kid of kids) {
    if (kid == null || kid === false) continue;
    if (typeof kid === 'string' || typeof kid === 'number') node.appendChild(document.createTextNode(String(kid)));
    else node.appendChild(kid);
  }
  return node;
}

export function escape(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function toast(message, duration = 2200) {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  node.classList.remove('hide');
  clearTimeout(node._t);
  node._t = setTimeout(() => {
    node.classList.add('hide');
    setTimeout(() => { node.hidden = true; }, 200);
  }, duration);
}

export function copy(text) {
  try { return navigator.clipboard.writeText(text); }
  catch { return Promise.reject(new Error('clipboard unavailable')); }
}

export function linkify(text) {
  const escaped = escape(text);
  return escaped.replace(
    /https?:\/\/[^\s<>"']+/g,
    (m) => `<a href="${m}" target="_blank" rel="noopener">${m}</a>`,
  );
}
