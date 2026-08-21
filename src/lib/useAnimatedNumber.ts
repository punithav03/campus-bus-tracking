'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Eases a number toward its target instead of snapping.
 *
 * An ETA that jumps 9 → 8 reads as a glitch; one that rolls there reads as a
 * countdown you can trust. Uses a spring rather than a fixed duration so a big
 * correction still settles quickly while small ticks stay gentle.
 */
export function useAnimatedNumber(target: number | null, stiffness = 0.13): number | null {
  const [shown, setShown] = useState<number | null>(target);
  const value = useRef<number | null>(target);
  const goal = useRef<number | null>(target);
  goal.current = target;

  useEffect(() => {
    if (target == null) { value.current = null; setShown(null); return; }
    if (value.current == null) { value.current = target; setShown(target); return; }

    let raf = 0;
    const step = () => {
      const g = goal.current;
      if (g == null || value.current == null) return;
      const delta = g - value.current;
      if (Math.abs(delta) < 0.4) {
        value.current = g;
        setShown(g);
        return;
      }
      value.current += delta * stiffness;
      setShown(value.current);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, stiffness]);

  return shown;
}

/** True for one render whenever `key` changes — drives one-shot flourishes. */
export function useFlash(key: unknown, ms = 620): boolean {
  const [on, setOn] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setOn(true);
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [key, ms]);
  return on;
}
