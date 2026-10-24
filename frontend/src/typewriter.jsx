// Typewriter effect: text appears character by character with a blinking caret, like it is being typed.
import { useEffect, useState } from 'react';

const prefersNoMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * How many of `total` characters are showing so far. It goes from 0 to total in about `seconds`, however long the
 * text is, and never slower than `minPerFrame` characters per frame. With animation off (or "reduce motion" set in
 * the system) everything shows at once.
 */
export function useTypewriter(total, enabled = true, { seconds = 2, minPerFrame = 2 } = {}) {
  const instant = !enabled || prefersNoMotion();
  const [shown, setShown] = useState(instant ? total : 0);

  useEffect(() => {
    if (instant) {
      setShown(total);
      return undefined;
    }
    let frame;
    let count = 0;
    setShown(0);
    const perFrame = Math.max(minPerFrame, Math.ceil(total / (seconds * 60)));
    const tick = () => {
      count = Math.min(total, count + perFrame);
      setShown(count);
      if (count < total) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [total, instant, seconds, minPerFrame]);

  return instant ? total : shown;
}

/** The blinking caret shown at the end of text that is still being typed. */
export const Caret = () => <span className="caret" aria-hidden="true" />;

/**
 * One piece of text inside a larger typed block. `start` is how many characters come before it in the block and
 * `shown` is the block's counter from useTypewriter, so pieces are typed one after another.
 */
export function Typed({ text, start = 0, shown }) {
  const visible = Math.max(0, Math.min(text.length, shown - start));
  return (
    <>
      {text.slice(0, visible)}
      {visible > 0 && visible < text.length && <Caret />}
    </>
  );
}

/** A whole line of text typed out on its own. */
export function TypedLine({ text, seconds = 1.2 }) {
  const shown = useTypewriter(text.length, true, { seconds });
  return <Typed text={text} shown={shown} />;
}
