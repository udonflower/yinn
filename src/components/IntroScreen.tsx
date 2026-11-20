import { useCallback, useEffect, useState } from 'react';

interface IntroScreenProps {
  onStartReveal: () => void;
  onFinishReveal: () => void;
}

export function IntroScreen({ onStartReveal, onFinishReveal }: IntroScreenProps) {
  const [leaving, setLeaving] = useState(false);

  const triggerEnter = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    onStartReveal();
  }, [leaving, onStartReveal]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(onFinishReveal, 700);
    return () => window.clearTimeout(timer);
  }, [leaving, onFinishReveal]);

  useEffect(() => {
    if (leaving) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      triggerEnter();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [leaving, triggerEnter]);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Made especially for Yinn. Press anywhere to view the flowers."
      onClick={triggerEnter}
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-black px-6 text-center select-none transition-opacity duration-700 ease-out focus:outline-none ${
        leaving ? 'pointer-events-none opacity-0' : 'cursor-pointer opacity-100'
      }`}
    >
      {/* Subtle warm radial ambient glow behind dedication */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute h-72 w-72 rounded-full bg-rose-200/[0.04] blur-3xl"
      />

      <div className="relative flex flex-col items-center gap-4">
        <p className="font-display text-3xl sm:text-5xl font-medium italic tracking-wide text-zinc-100">
          Made especially for Yinn
        </p>
        <p className="text-xs sm:text-sm tracking-[0.22em] lowercase text-zinc-400 motion-safe:animate-pulse">
          press anywhere
        </p>
      </div>
    </div>
  );
}
