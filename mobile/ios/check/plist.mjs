// Minimal reader for XML property lists (the Info.plist files Xcode uses), with no dependencies.
// It handles dict, array, key, string, integer, real, true, false, data and date, which is all
// the iOS project uses. parsePlist(xml) returns plain JS values: dict -> object, array -> array,
// true/false -> boolean, integer/real -> number, everything else -> string.
// Used by ios-project.test.mjs, so the checks run on Windows without a Mac or plutil.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text) {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[name];
  });
}

export function parsePlist(xml) {
  const src = String(xml)
    .replace(/<\?xml[\s\S]*?\?>/, '')
    .replace(/<!DOCTYPE[\s\S]*?>/, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const tokens = [];
  const re = /<(\/?)([A-Za-z]+)(?:\s[^<>]*?)?(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[4] !== undefined) {
      const text = m[4].trim();
      if (text) tokens.push({ text: decode(text) });
    } else {
      tokens.push({ close: m[1] === '/', name: m[2], selfClosing: m[3] === '/' });
    }
  }
  let i = 0;

  function expectClose(name) {
    const t = tokens[i++];
    if (!t || !t.close || t.name !== name) throw new Error(`plist: expected </${name}> at token ${i - 1}`);
  }

  function leafText(name) {
    const t = tokens[i];
    if (t && t.close && t.name === name) { i++; return ''; }
    let value = '';
    if (t && t.text !== undefined) { value = t.text; i++; }
    expectClose(name);
    return value;
  }

  function value() {
    const t = tokens[i++];
    if (!t || t.text !== undefined || t.close) throw new Error(`plist: expected a value at token ${i - 1}`);
    switch (t.name) {
      case 'true': return true;
      case 'false': return false;
      case 'dict': {
        const out = {};
        if (t.selfClosing) return out;
        while (!(tokens[i] && tokens[i].close && tokens[i].name === 'dict')) {
          const k = tokens[i++];
          if (!k || k.name !== 'key' || k.close) throw new Error(`plist: expected <key> at token ${i - 1}`);
          const key = leafText('key');
          out[key] = value();
        }
        i++;
        return out;
      }
      case 'array': {
        const out = [];
        if (t.selfClosing) return out;
        while (!(tokens[i] && tokens[i].close && tokens[i].name === 'array')) out.push(value());
        i++;
        return out;
      }
      case 'integer':
      case 'real': {
        const raw = t.selfClosing ? '' : leafText(t.name);
        return Number(raw);
      }
      case 'string':
      case 'data':
      case 'date': {
        if (t.selfClosing) return '';
        return leafText(t.name);
      }
      default:
        throw new Error(`plist: unsupported element <${t.name}>`);
    }
  }

  // The root is <plist version="1.0"> wrapping one value.
  const root = tokens[i++];
  if (!root || root.name !== 'plist') throw new Error('plist: missing <plist> root');
  const result = value();
  expectClose('plist');
  return result;
}
