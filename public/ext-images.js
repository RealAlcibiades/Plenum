// Files in the composer. Loaded by ext.js and adds itself through window.MuseUI.
// A file chosen with the attach button, dropped on the message box, or pasted into it becomes a chip above the text with a
// button to take it off again. A picture (PNG, JPEG, GIF or WebP, told by its first bytes) goes as an image. A PDF and any
// other file go as { name, mime, data } too, and the server sorts them by their bytes: text and code are sent inline to every
// model, a PDF only to Claude through an API key, and anything else is refused in plain words. This page only gives an early
// message, going by the file's extension and size; it never decides what a file is.
// The files go with the next chat message in the images field of the POST /api/chat body (data is base64), because that is the
// list app.js sends. The server checks each one again. They stay in this page until the message is sent and are kept nowhere.
// app.js reads the files through window.MuseImages (see sendMessage there).
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;
  const { el } = MuseUI;

  const MB = 1024 * 1024;
  const MAX_FILES = 10;
  const MAX_IMAGES = 4;
  const MAX_IMAGE_BYTES = 5 * MB;
  const MAX_PDF_BYTES = 20 * MB;
  const MAX_TEXT_BYTES = 200 * 1024;
  const MAX_TEXT_TOTAL = 600 * 1024;
  const MAX_TOTAL_BYTES = 25 * MB;
  const IMAGE_REFUSAL = 'This model cannot take images in Plenum yet. Attach the image to a model that can (Claude or Codex).';
  const PDF_REFUSAL = 'Plenum sends a PDF only to Claude through an API key. Claude through the CLI, Codex, Gemini, Muse Code and the OpenAI-compatible models cannot take one yet. Paste the text you need, or ask Claude by API key (Accounts).';
  const ATTACHES = 'Plenum attaches text, code, images (PNG, JPEG, GIF, WebP) and PDF (for Claude by API key).';
  const EXTENSION = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
  const TAKES_IMAGES = new Set(['anthropic', 'codex']);
  // Extensions of files that are plainly not text, so they can be turned away before they are read. Anything else is sent and
  // the server decides.
  const NOT_TEXT = /\.(docx?|dotx?|xlsx?|xlsm|pptx?|odt|ods|odp|zip|7z|rar|tar|gz|tgz|bz2|xz|exe|dll|msi|bin|iso|dmg|jar|apk|class|so|bmp|tiff?|ico|heic|heif|avif|psd|mp3|m4a|wav|flac|ogg|mp4|m4v|mov|avi|mkv|webm|sqlite|db|ttf|otf|woff2?)$/i;
  const PDF_NAME = /\.pdf$/i;

  // The files waiting to be sent: { name, mime, data, size, kind } with kind 'image', 'pdf' or 'file'.
  let picked = [];
  let pastes = 0;
  // The reason the last model check said no: the picture words or the PDF words.
  let lastRefusal = IMAGE_REFUSAL;
  // Files are read one batch at a time, so two quick drops cannot both pass the count check.
  let chain = Promise.resolve();

  const sizeText = n => (n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  // PNG, JPEG, GIF or WebP, told by the first bytes of the file and not by its name or its type.
  function sniff(bytes) {
    const at = (list, from = 0) => list.every((v, i) => bytes[from + i] === v);
    const text = (s, from = 0) => at([...s].map(c => c.charCodeAt(0)), from);
    if (at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (at([0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (text('GIF87a') || text('GIF89a')) return 'image/gif';
    if (text('RIFF') && text('WEBP', 8)) return 'image/webp';
    return null;
  }

  const readBase64 = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  // The provider of a model name or ref ("claude" or "anthropic:claude-opus-5-5"); the selected model when none is given.
  function providerFor(model) {
    const ref = model ? (MuseUI.aliases?.[String(model).toLowerCase()] ?? String(model)) : MuseUI.state.model;
    if (ref?.includes(':')) return ref.slice(0, ref.indexOf(':'));
    return MuseUI.catalog?.find(c => c.id === ref)?.provider ?? '';
  }

  // True when the model takes images. A model this page cannot place is left to the server to judge.
  const takesImages = provider => !provider || TAKES_IMAGES.has(provider);

  // True when the model could take a PDF: Claude, and not through the CLI. When the route is not known yet the server decides.
  function takesPdf(provider) {
    if (!provider) return true;
    if (provider !== 'anthropic') return false;
    const route = MuseUI.providers?.anthropic?.route;
    return !route || route === 'api';
  }

  // app.js asks this before it sends the files it was given. It is false only for files that are waiting here and that the
  // model cannot take; REFUSAL then holds the reason. A file of any other kind is left to the server.
  function takes(model) {
    const provider = providerFor(model);
    if (picked.some(f => f.kind === 'image') && !takesImages(provider)) {
      lastRefusal = IMAGE_REFUSAL;
      return false;
    }
    if (picked.some(f => f.kind === 'pdf') && !takesPdf(provider)) {
      lastRefusal = PDF_REFUSAL;
      return false;
    }
    return true;
  }

  // ---------- the chips above the text ----------

  const row = document.createElement('div');
  row.className = 'chips composer-images';
  row.hidden = true;
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Files to send');
  el.input.before(row);

  function chipFor(file) {
    const chip = MuseUI.span('chip', '');
    chip.title = `${file.name}, ${sizeText(file.size)}`;
    const remove = MuseUI.button('chip-x', '');
    remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.append(MuseUI.icon('x'));
    remove.addEventListener('click', () => {
      picked = picked.filter(p => p !== file);
      paint();
      el.input.focus();
    });
    chip.append(MuseUI.icon('file'), MuseUI.span('img-name', file.name), MuseUI.span('img-size', sizeText(file.size)), remove);
    return chip;
  }

  function paint() {
    row.hidden = picked.length === 0;
    row.replaceChildren(...picked.map(chipFor));
  }

  // ---------- adding files ----------

  const sum = (list, pick) => list.reduce((n, f) => n + pick(f), 0);

  // Checks one file and adds it, or says why not. Returns false when the rest of the batch should stop.
  async function addOne(file) {
    const label = file.name || 'That file';
    const bad = text => MuseUI.toast(text, 'bad');
    if (picked.length >= MAX_FILES) {
      bad(`At most ${MAX_FILES} files can go with one message.`);
      return false;
    }
    if (!file.size) {
      bad(`"${label}" is empty.`);
      return true;
    }
    if (sum(picked, f => f.size) + file.size > MAX_TOTAL_BYTES) {
      bad(`"${label}" would take the message over ${sizeText(MAX_TOTAL_BYTES)} of files.`);
      return true;
    }
    const mime = sniff(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
    const provider = providerFor();
    let kind = 'file';
    if (mime) {
      kind = 'image';
      if (picked.filter(f => f.kind === 'image').length >= MAX_IMAGES) {
        bad(`At most ${MAX_IMAGES} images can go with one message.`);
        return false;
      }
      if (!takesImages(provider)) {
        bad(IMAGE_REFUSAL);
        return true;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        bad(`"${label}" is ${sizeText(file.size)}. Images can be at most ${sizeText(MAX_IMAGE_BYTES)}.`);
        return true;
      }
    } else if (PDF_NAME.test(file.name)) {
      kind = 'pdf';
      if (!takesPdf(provider)) {
        bad(PDF_REFUSAL);
        return true;
      }
      if (file.size > MAX_PDF_BYTES) {
        bad(`"${label}" is ${sizeText(file.size)}. A PDF can be at most ${sizeText(MAX_PDF_BYTES)}.`);
        return true;
      }
    } else {
      if (NOT_TEXT.test(file.name)) {
        bad(`"${label}" is not a file type Plenum can attach yet. ${ATTACHES}`);
        return true;
      }
      if (file.size > MAX_TEXT_BYTES) {
        bad(`"${label}" is ${sizeText(file.size)}. Text can be at most ${sizeText(MAX_TEXT_BYTES)}, images ${sizeText(MAX_IMAGE_BYTES)} and PDFs ${sizeText(MAX_PDF_BYTES)}.`);
        return true;
      }
      if (sum(picked.filter(f => f.kind === 'file'), f => f.size) + file.size > MAX_TEXT_TOTAL) {
        bad(`"${label}" would take the text of this message over ${sizeText(MAX_TEXT_TOTAL)}. Attach fewer or smaller files.`);
        return true;
      }
    }
    // A pasted screenshot is called image.png by the browser, so it gets a name of its own.
    const plain = !file.name || (kind === 'image' && /^image\.\w+$/i.test(file.name));
    const name = plain ? (kind === 'image' ? `pasted-image-${++pastes}.${EXTENSION[mime]}` : `pasted-file-${++pastes}`) : file.name;
    // The type tells the server which rules to start with; it judges every file by its bytes either way.
    picked.push({ name, mime: kind === 'image' ? mime : kind === 'pdf' ? 'application/pdf' : 'application/octet-stream', data: await readBase64(file), size: file.size, kind });
    return true;
  }

  function addFiles(files) {
    if (!files.length) return;
    chain = chain.then(async () => {
      for (const file of files) {
        try {
          if (!(await addOne(file))) break;
        } catch {
          // A folder dropped on the box arrives as a file that cannot be read.
          MuseUI.toast(`"${file.name || 'That file'}" could not be read. A folder cannot be attached.`, 'bad');
        }
      }
      paint();
    }).catch(err => MuseUI.toast(`The files could not be read: ${err.message}`, 'bad'));
  }

  // ---------- the attach button ----------

  const picker = document.createElement('input');
  picker.type = 'file';
  picker.multiple = true;
  picker.hidden = true;
  picker.tabIndex = -1;
  picker.setAttribute('aria-hidden', 'true');
  el.form.append(picker);
  picker.addEventListener('change', () => {
    addFiles([...picker.files]);
    // Cleared, so choosing the same file again still counts as a change.
    picker.value = '';
  });

  const attach = MuseUI.button('icon-btn attach-btn', '');
  attach.title = 'Attach files: text, code, images and PDF';
  attach.setAttribute('aria-label', 'Attach files');
  attach.append(MuseUI.icon('file-plus'));
  attach.addEventListener('click', () => picker.click());
  el.form.querySelector('.composer-bar')?.prepend(attach);

  // ---------- paste and drop ----------

  const hasFiles = e => [...(e.dataTransfer?.types ?? [])].includes('Files');

  el.input.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files ?? [])];
    // Text pastes as it always did. Only a clipboard with a file in it is taken over.
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });

  let depth = 0;
  el.form.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    el.form.classList.add('drop-ready');
  });
  el.form.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  el.form.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) el.form.classList.remove('drop-ready');
  });
  el.form.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    el.form.classList.remove('drop-ready');
    addFiles([...e.dataTransfer.files]);
  });

  // A file dropped anywhere else must not make the window open it in place of the app.
  document.addEventListener('dragover', e => {
    if (!hasFiles(e) || el.form.contains(e.target)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  });
  document.addEventListener('drop', e => {
    if (hasFiles(e) && !el.form.contains(e.target)) e.preventDefault();
  });

  window.MuseImages = {
    // The reason takes() last said no, in the server's words.
    get REFUSAL() {
      return lastRefusal;
    },
    // The files waiting to go, each { name, mime, data, size, kind }.
    list: () => picked.map(file => ({ ...file })),
    clear() {
      picked = [];
      paint();
    },
    takes,
  };
})();
