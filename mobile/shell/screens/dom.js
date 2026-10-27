// Small DOM helpers for the shell screens (mob-10, wave 106). Nodes are built with createElement, attributes with setAttribute and
// text with textContent: no innerHTML, no inline script, no style attribute (strict CSP, MOBILE-UI 16.3 S-08 and the wave brief).
// Nothing here touches the document at import time, so the Node suites can import the screen modules.

let doc = globalThis.document ?? null;

export function setDocument(d) {
  doc = d;
}

export function currentDocument() {
  return doc;
}

// el('button', { class: 'x', type: 'button', on: { click } , hidden: true }, 'Label', childNode)
// A null, undefined or false prop is skipped; true becomes a bare attribute; `text` sets textContent.
export function el(tag, props = {}, ...children) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'on') {
      for (const [type, fn] of Object.entries(value)) node.addEventListener(type, fn);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'class') {
      node.className = String(value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : doc.createTextNode(String(child)));
  }
  return node;
}

// A 48 px button. kind: primary | ghost | danger | link. A disabled button stays focusable (aria-disabled) and does nothing.
export function button(label, { kind = 'ghost', onClick = null, disabled = false, id = null, name = null } = {}) {
  const cls = kind === 'link' ? 'sh-link' : `sh-btn sh-btn-${kind}${disabled ? ' sh-btn-off' : ''}`;
  return el('button', {
    type: 'button',
    class: cls,
    id,
    'aria-label': name,
    'aria-disabled': disabled ? 'true' : null,
    on: { click: event => { if (!disabled && onClick) onClick(event); } },
  }, label);
}

export function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}
