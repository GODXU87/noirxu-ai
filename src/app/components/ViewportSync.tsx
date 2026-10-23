'use client';

import { useEffect } from 'react';

/**
 * iPhone Safari: when the keyboard opens, Safari scrolls the page under fixed elements, so a
 * fixed header slides out of view and the composer hides behind the keyboard. This keeps two
 * CSS variables in step with the visible area:
 *   --vv-top  how far the visible area has been scrolled down (the header follows it)
 *   --kb      how much of the bottom the keyboard covers (the composer sits above it)
 */
export function ViewportSync() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement.style;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        root.setProperty('--vv-top', `${Math.max(0, vv.offsetTop)}px`);
        root.setProperty('--kb', `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`);
      });
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => { cancelAnimationFrame(frame); vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
  }, []);
  return null;
}
