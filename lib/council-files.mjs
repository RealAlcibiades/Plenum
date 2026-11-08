// The files that go with a council question (DECISIONS item 84). A council takes what a chat message takes: pictures, text and
// code, and PDFs, from the attach button, a drop or a paste, and files named with @path. Each file is checked by the same rules as
// in chat (lib/attachments.mjs, lib/images.mjs, lib/files.mjs) before anything is stored or any seat starts, so a file the chat
// would refuse is refused here with the same words.
//
// A council seat cannot open files, so every file goes to every seat and the moderator in the prompt itself, and again in every
// critique round, because each round is a fresh request:
//   - text and code: their FILE blocks (and the "--- file:" blocks of an @path file), in every seat's and the moderator's message;
//   - pictures: to each participant whose model takes them (imagesFor in lib/council.mjs), with a line for the others;
//   - PDFs: Claude through an API key gets the PDF itself (a document block); every other model gets the text Plenum reads out of
//     it (lib/pdf-text.mjs). When any participant needs that text it is read once here, before the run, so a PDF that has no text (a
//     scan) or too many pages is refused before the question is stored, and a council of several seats and rounds does not read the
//     same PDF again and again. When every participant is Claude through an API key, nothing reads the PDF here: Anthropic judges it,
//     as it does a chat message's, and a PDF it refuses (over 100 pages, say) fails the seats with Anthropic's words.
// Like a chat message's, the bytes live only for this one request: the question keeps the names and sizes (describeUploads).

import { MAX_IMAGES, checkImages } from './images.mjs';
import { checkMessageTotals, describeUploads, fileBlock, nativePdf, sortAttachments, splitUploads } from './attachments.mjs';
import { expandFileMentions } from './files.mjs';
import { pdfTexts } from './pdf-text.mjs';
import { splitRef } from './providers.mjs';

// What came with the question in the request body ({ images, attachments }, as /api/chat takes them) and the @path files the
// question names. refs are the seats' and the moderator's models, and route is claudeRoute(): the PDF's text is read only when
// one of them does not take a PDF itself. Returns
//   { images, blocks, documents, kept, attached }
//   images     the checked pictures, each { name, mime, data }
//   blocks     the text of each text file and @path file, as it goes into a prompt
//   documents  each PDF { name, mime, size, data }, with `text` when some participant needs the text
//   kept       what the stored question keeps: names and sizes (and kinds), never bytes
//   attached   the @path files named in the question
// Throws an Error with a plain message for a file that cannot go, as the chat refuses it. readPdf is for tests.
export async function councilUploads(body, question, { root, refs = [], route = null, signal, readPdf = pdfTexts } = {}) {
  const uploads = splitUploads(body);
  const sent = Array.isArray(uploads.images) ? uploads.images : [];
  const got = sortAttachments(uploads.files, { counted: sent });
  // A seat reads nothing on its own, so a file named with @path goes into the prompt for every model (inline), as it does for an
  // API model in chat. The checks are the chat's: credential folders, the project once links are followed, and the sizes.
  const expanded = root
    ? await expandFileMentions(String(question ?? ''), root, { inline: true, imageRoom: Math.max(0, MAX_IMAGES - sent.length - got.images.length), takesPdf: true })
    : { blocks: [], attached: [], images: [], documents: [], refused: [], refusedDocuments: [] };
  const problems = [...expanded.refused, ...expanded.refusedDocuments, ...got.refused];
  if (problems.length) throw new Error(problems.join(' '));
  const images = checkImages({ sent: uploads.images, named: [...got.images, ...expanded.images] });
  let documents = [...got.documents, ...expanded.documents];
  const tooMuch = checkMessageTotals({ images, inline: got.inline, documents });
  if (tooMuch) throw new Error(tooMuch);
  if (documents.length && refs.some(ref => !nativePdf(splitRef(ref).provider, route))) {
    const texts = await readPdf(documents, { signal });
    documents = documents.map((doc, i) => {
      if (typeof texts?.[i]?.text !== 'string') throw new Error(`Plenum could not read the text of "${doc.name}".`);
      return { ...doc, text: texts[i].text };
    });
  }
  return {
    images,
    blocks: [...got.inline.map(file => file.block), ...expanded.blocks],
    documents,
    kept: describeUploads(images, { inline: got.inline, documents }),
    attached: expanded.attached,
  };
}

// What one seat or the moderator gets of the files: every text block, and each PDF either as a document (Claude through an API
// key, or a PDF whose text was not read here, which streamChat then reads itself) or as the text read above, in a FILE block of
// type pdf-text, as chat sends it. names lists every file, pictures included, so a model that gets a PDF as a document or cannot
// take a picture still knows what the person attached. Returns { blocks, documents, names }.
export function filesFor(ref, { blocks = [], documents = [], names = [] } = {}, route = null) {
  const native = nativePdf(splitRef(ref).provider, route);
  const asText = native ? [] : documents.filter(doc => typeof doc.text === 'string');
  return {
    blocks: [...blocks, ...asText.map(doc => fileBlock(`${doc.name} (text extracted by Plenum)`, doc.text, doc.size ?? 0, 'pdf-text'))],
    documents: documents.filter(doc => !asText.includes(doc)).map(({ text, ...doc }) => doc),
    names,
  };
}
