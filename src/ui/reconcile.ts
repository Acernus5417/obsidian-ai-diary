// Keep text controls and their containing DOM attached while applying a new
// view. Restoring focus after removing a textarea can dismiss a mobile keyboard.
// Controls whose handlers capture current drafts/settings are replaced instead.
export function reconcile(parent: HTMLElement, next: HTMLElement): void {
  const available = [...parent.childNodes];
  const pairs = [...next.childNodes].map(fresh => {
    const prior = available.find(old => reusable(old, fresh));
    if (prior) available.splice(available.indexOf(prior), 1);
    return { fresh, prior };
  });
  // Remove obsolete siblings first so a surviving editor never has to move
  // merely because a notice or another control before it disappeared.
  available.forEach(node => node.remove());
  let cursor = parent.firstChild;
  for (const { fresh, prior } of pairs) {
    const node = prior ?? fresh;
    if (node !== cursor) parent.insertBefore(node, cursor);
    if (prior && prior instanceof HTMLElement && fresh instanceof HTMLElement) {
      syncAttributes(prior, fresh);
      if (prior instanceof HTMLTextAreaElement && fresh instanceof HTMLTextAreaElement) {
        if (prior.value !== fresh.value) prior.value = fresh.value;
      } else reconcile(prior, fresh);
    } else if (prior && prior.nodeType === Node.TEXT_NODE && prior.textContent !== fresh.textContent) {
      prior.textContent = fresh.textContent;
    }
    cursor = node.nextSibling;
  }
}

function reusable(old: Node, fresh: Node): boolean {
  if (old.nodeType === Node.TEXT_NODE || fresh.nodeType === Node.TEXT_NODE) return old.nodeType === fresh.nodeType;
  if (!(old instanceof HTMLElement) || !(fresh instanceof HTMLElement) || old.tagName !== fresh.tagName) return false;
  if (['BUTTON', 'A', 'SELECT', 'INPUT'].includes(old.tagName)) return false;
  if (old instanceof HTMLTextAreaElement) return !!old.dataset.focus && old.dataset.focus === fresh.dataset.focus;
  if (old.dataset.disclosure || fresh.dataset.disclosure) return old.dataset.disclosure === fresh.dataset.disclosure;
  return old.className === fresh.className && old.getAttribute('aria-label') === fresh.getAttribute('aria-label');
}

function syncAttributes(old: HTMLElement, fresh: HTMLElement): void {
  [...old.attributes].forEach(attr => { if (!fresh.hasAttribute(attr.name)) old.removeAttribute(attr.name); });
  [...fresh.attributes].forEach(attr => { if (old.getAttribute(attr.name) !== attr.value) old.setAttribute(attr.name, attr.value); });
}
