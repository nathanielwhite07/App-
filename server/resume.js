'use strict';
const path = require('node:path');

/** Extract plain text from an uploaded resume buffer (PDF, DOCX or plain text). */
async function extractResumeText(buffer, filename = '', mimetype = '') {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf' || mimetype === 'application/pdf') {
    // Require the implementation directly: pdf-parse's index.js runs a debug harness when loaded.
    const pdf = require('pdf-parse/lib/pdf-parse.js');
    return (await pdf(buffer)).text;
  }
  if (ext === '.docx' || mimetype.includes('wordprocessingml')) {
    const mammoth = require('mammoth');
    return (await mammoth.extractRawText({ buffer })).value;
  }
  if (['.txt', '.md', ''].includes(ext) || mimetype.startsWith('text/')) return buffer.toString('utf8');
  const err = new Error('Unsupported resume format. Upload a PDF, DOCX or TXT file.');
  err.status = 400;
  throw err;
}

module.exports = { extractResumeText };
