"use strict";

/**
 * For the few tests that check how a source file wires things together (which
 * handler sits on which channel, which transport a service is given): the
 * text with its layout taken out. No whitespace, one kind of quote, no
 * trailing commas, no parentheses around a lone arrow parameter, no semicolon
 * before a closing brace. The file and the expected snippet both go through
 * it, so re-wrapping or re-quoting either one never fails such a test — only
 * a change of what the code says does.
 */
function shape(source) {
  return String(source)
    .replace(/\s+/g, "")
    .replace(/"/g, "'")
    .replace(/,(?=[)\]}])/g, "")
    .replace(/;(?=})/g, "")
    .replace(/\((\w+)\)=>/g, "$1=>");
}

/** `source` contains `snippet`, whatever the layout of either. */
function wires(source, snippet) {
  return shape(source).includes(shape(snippet));
}

module.exports = { shape, wires };
