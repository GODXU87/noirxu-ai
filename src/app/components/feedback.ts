/** Brief success / error state on a button after an action finishes (styled in globals.css). */
export function flash(element: HTMLElement | null | undefined, state: 'success' | 'error') {
  if (!element) return;
  element.setAttribute('data-state', state);
  window.setTimeout(() => element.removeAttribute('data-state'), state === 'success' ? 900 : 1400);
}
