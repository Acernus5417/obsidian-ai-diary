import { safePath } from '../domain/util';
// Model output is always text, never HTML. Wiki links use host navigation.
export function reading(parent: HTMLElement, markdown: string, openFile: (path: string) => void): void {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let paragraph: string[] = [], list: HTMLUListElement | HTMLOListElement | undefined;
  const append = (tag: string, text: string): HTMLElement => {
    const node = document.createElement(tag); inline(node, text, openFile); parent.append(node); return node;
  };
  const flush = () => { if (paragraph.length) append('p', paragraph.join('\n')); paragraph = []; list = undefined; };
  for (const line of lines) {
    if (!line.trim()) { flush(); continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { flush(); append(`h${Math.min(6, heading[1]!.length + 1)}`, heading[2]!); continue; }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { flush(); append('blockquote', quote[1]!); continue; }
    const bullet = /^\s*(?:([-*+])|\d+[.)])\s+(.+)$/.exec(line);
    if (bullet) {
      if (paragraph.length) { append('p', paragraph.join('\n')); paragraph = []; }
      const tag = bullet[1] ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== tag) { list = document.createElement(tag); parent.append(list); }
      const li = document.createElement('li'); inline(li, bullet[2]!, openFile); list.append(li); continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { flush(); parent.append(document.createElement('hr')); continue; }
    list = undefined; paragraph.push(line);
  }
  flush();
}
function inline(parent: HTMLElement, text: string, openFile: (path: string) => void): void {
  const tokens = /\[\[([^\]\n]+)\]\]|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
  let start = 0;
  for (const match of text.matchAll(tokens)) {
    parent.append(document.createTextNode(text.slice(start, match.index)));
    if (match[1]) {
      const [path, label] = match[1].split('|');
      let target: string | undefined;
      try {
        const [file, ...anchors] = (path ?? '').split('#');
        const normalized = safePath(file!);
        if (anchors.some(a => !a || /[\x00-\x1f<>]/.test(a))) throw new Error('invalid anchor');
        // Also reject encoded traversal or URI schemes before host resolution.
        if (normalized.includes('%')) safePath(decodeURIComponent(normalized));
        target = [normalized, ...anchors].join('#');
      } catch { /* Invalid vault destinations remain ordinary visible text. */ }
      if (target) {
        const a = document.createElement('a'); a.textContent = label || path || '';
        a.href = '#'; a.addEventListener('click', e => { e.preventDefault(); openFile(target); }); parent.append(a);
      } else parent.append(document.createTextNode(match[0]));
    } else if (match[2] && match[3]) {
      const a = document.createElement('a'); a.textContent = match[2]; a.href = match[3];
      a.target = '_blank'; a.rel = 'noopener noreferrer'; parent.append(a);
    } else {
      const node = document.createElement(match[4] ? 'strong' : 'code'); node.textContent = match[4] || match[5] || ''; parent.append(node);
    }
    start = match.index! + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(start)));
}
