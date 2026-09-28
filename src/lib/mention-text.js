/** Text-only projection for literal brand detection, never for citation extraction.
 * Keep human-readable link labels. Discard destinations, reference definitions,
 * image metadata and HTML attributes. A URL alone is citation evidence, not a
 * recommendation/name. Ordinary written names, aliases and bare domains retain
 * their existing matching rules. No model or network call is involved.
 */
export function mentionText(value) {
  let text = String(value || '');
  const refs = new Set();
  text = text.replace(/^ {0,3}\[([^\]\n]+)\]:[^\n]*(?:\n[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^\n]*\))[ \t]*)?/gm, (_, id) => {
    refs.add(id.trim().toLowerCase());
    return '\n';
  });
  text = text.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const escaped = (s, i) => {
    let n = 0; while (i > 0 && s[--i] === '\\') n++;
    return n % 2 === 1;
  };
  const closing = (s, start, open, close) => {
    let depth = 0, quote = null;
    for (let i = start; i < s.length; i++) {
      if (escaped(s, i)) continue;
      if (quote) { if (s[i] === quote) quote = null; continue; }
      if (open === '(' && depth === 1 && /[\s]/.test(s[i - 1] || '') && /[\"']/.test(s[i])) { quote = s[i]; continue; }
      if (s[i] === open) depth++;
      if (s[i] === close && --depth === 0) return i;
    }
    return -1;
  };
  let out = '';
  for (let i = 0; i < text.length;) {
    const image = text[i] === '!' && text[i + 1] === '[' && !escaped(text, i);
    const start = image ? i + 1 : i;
    if (text[start] !== '[' || escaped(text, start)) { out += text[i++]; continue; }
    const end = closing(text, start, '[', ']');
    if (end < 0) { out += text[i++]; continue; }
    const label = text.slice(start + 1, end);
    let finish = end;
    let linked = false;
    if (text[end + 1] === '(') {
      const last = closing(text, end + 1, '(', ')');
      // Incomplete provider markdown: discard an unfinished destination too.
      finish = last < 0 ? text.length - 1 : last;
      linked = true;
    } else if (text[end + 1] === '[') {
      const last = text.indexOf(']', end + 2);
      const id = last < 0 ? '' : text.slice(end + 2, last) || label;
      if (last >= 0 && refs.has(id.trim().toLowerCase())) { finish = last; linked = true; }
    } else if (refs.has(label.trim().toLowerCase())) linked = true;
    if (linked) {
      // Domain-only labels are still links, not explicit business names.
      const domainLabel = /^(?:https?:\/\/|www\.)?[^\s/]+\.[a-z]{2,}(?:\/\S*)?$/i.test(label.trim());
      out += image || domainLabel ? ' ' : ` ${label} `;
      i = finish + 1;
    } else { out += text[i++]; }
  }
  return out.replace(/<(?:"[^"]*"|'[^']*'|[^'">])*>/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>]+/gi, ' ')
    .replace(/\b[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\/[^\s<>]*/gi, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
