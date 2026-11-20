import { useCallback, useEffect, useRef, useState } from 'react';
import { BloomAudioEngine } from './audio/bloomAudio';
import { AsciiCanvas, AsciiCanvasHandle } from './components/AsciiCanvas';
import { ControlHud } from './components/ControlHud';
import { IntroScreen } from './components/IntroScreen';
import { BouquetConfig } from './types/bouquet';

const INITIAL_CONFIG: BouquetConfig = {
  preset: 'roses',
  palette: 'botanical',
  density: 'fine',
  bloomIntensity: 2.0,
  autoRotate: true,
  rotationSpeed: 0.42,
  isPlaying: true,
  soundEnabled: false,
  showHud: true,
};

export default function App() {
  const [config, setConfig] = useState<BouquetConfig>(INITIAL_CONFIG);
  const [timeline, setTimeline] = useState(0);
  const [hasEntered, setHasEntered] = useState(false);
  const [showIntro, setShowIntro] = useState(true);

  const canvasHandleRef = useRef<AsciiCanvasHandle | null>(null);
  const audioRef = useRef<BloomAudioEngine | null>(null);

  useEffect(() => {
    const audio = new BloomAudioEngine();
    audioRef.current = audio;
    return () => {
      audio.dispose();
    };
  }, []);

  const updateConfig = useCallback((patch: Partial<BouquetConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleToggleSound = useCallback(() => {
    setConfig((prev) => {
      const next = !prev.soundEnabled;
      if (next) {
        audioRef.current?.start();
      } else {
        audioRef.current?.stop();
      }
      return { ...prev, soundEnabled: next };
    });
  }, []);

  const handleReplay = useCallback(() => {
    setConfig((prev) => {
      if (prev.soundEnabled) {
        audioRef.current?.resetPhrase();
        audioRef.current?.start();
      }
      return { ...prev, isPlaying: true };
    });
    canvasHandleRef.current?.replay();
  }, []);

  const handleSeekTimeline = useCallback((value: number) => {
    canvasHandleRef.current?.seekTimeline(value);
  }, []);

  // Keyboard shortcuts for comfortable desktop control (active once flower page is shown)
  useEffect(() => {
    if (!hasEntered) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        setConfig((prev) => ({ ...prev, isPlaying: !prev.isPlaying }));
      } else if (e.key === 'r' || e.key === 'R') {
        handleReplay();
      } else if (e.key === 'm' || e.key === 'M') {
        handleToggleSound();
      } else if (e.key === 'h' || e.key === 'H') {
        setConfig((prev) => ({ ...prev, showHud: !prev.showHud }));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hasEntered, handleReplay, handleToggleSound]);

  const handleStartReveal = useCallback(() => {
    setHasEntered(true);
  }, []);

  const handleFinishReveal = useCallback(() => {
    setShowIntro(false);
  }, []);

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-black">
      {hasEntered && (
        <>
          <AsciiCanvas
            ref={canvasHandleRef}
            config={config}
            onTimelineChange={setTimeline}
          />
          <ControlHud
            config={config}
            timeline={timeline}
            onUpdateConfig={updateConfig}
            onReplay={handleReplay}
            onSeekTimeline={handleSeekTimeline}
          />
        </>
      )}
      {showIntro && (
        <IntroScreen
          onStartReveal={handleStartReveal}
          onFinishReveal={handleFinishReveal}
        />
      )}
    </main>
  );
}
