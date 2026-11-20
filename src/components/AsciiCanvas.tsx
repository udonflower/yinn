import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { AsciiFrameEngine } from '../engine/asciiRenderer';
import { BouquetBuffer, generateBouquetBuffer } from '../engine/bouquetGeometry';
import { BouquetConfig } from '../types/bouquet';

export interface AsciiCanvasHandle {
  replay: () => void;
  seekTimeline: (value: number) => void;
  resetView: () => void;
}

interface AsciiCanvasProps {
  config: BouquetConfig;
  onTimelineChange: (timeline: number) => void;
  onFirstInteract?: () => void;
}

const BLOOM_DURATION_SECONDS = 11.5;

export const AsciiCanvas = forwardRef<AsciiCanvasHandle, AsciiCanvasProps>(
  function AsciiCanvas({ config, onTimelineChange, onFirstInteract }, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const engineRef = useRef<AsciiFrameEngine | null>(null);
    const bufferRef = useRef<BouquetBuffer | null>(null);
    const configRef = useRef(config);
    configRef.current = config;

    // Camera & animation state stored in refs for zero-React-re-render 60fps loop
    const stateRef = useRef({
      yaw: 0.15,
      pitch: 0.18,
      velYaw: 0,
      velPitch: 0,
      timeline: 0.0,
      elapsed: 0.0,
      dragging: false,
      lastX: 0,
      lastY: 0,
      width: 0,
      height: 0,
      dpr: 1,
      lastReportedTimeline: -1,
    });

    const reducedMotionRef = useRef(false);

    useImperativeHandle(ref, () => ({
      replay() {
        stateRef.current.timeline = 0;
        stateRef.current.velYaw = 0;
        stateRef.current.velPitch = 0;
        onTimelineChange(0);
      },
      seekTimeline(value: number) {
        const clamped = Math.max(0, Math.min(1, value));
        stateRef.current.timeline = clamped;
        onTimelineChange(clamped);
      },
      resetView() {
        stateRef.current.yaw = 0.15;
        stateRef.current.pitch = 0.18;
        stateRef.current.velYaw = 0;
        stateRef.current.velPitch = 0;
      },
    }));

    // Rebuild 3D geometry only when preset changes
    useEffect(() => {
      bufferRef.current = generateBouquetBuffer(config.preset);
    }, [config.preset]);

    // Check prefers-reduced-motion
    useEffect(() => {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      const update = () => {
        reducedMotionRef.current = mq.matches;
        if (mq.matches && stateRef.current.timeline < 0.9) {
          stateRef.current.timeline = 1.0;
          onTimelineChange(1.0);
        }
      };
      update();
      mq.addEventListener('change', update);
      return () => mq.removeEventListener('change', update);
    }, [onTimelineChange]);

    // ResizeObserver + main 60fps animation loop
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;

      if (!engineRef.current) {
        engineRef.current = new AsciiFrameEngine();
      }
      if (!bufferRef.current) {
        bufferRef.current = generateBouquetBuffer(configRef.current.preset);
      }

      const updateSize = () => {
        const rect = canvas.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.floor(rect.width));
        const h = Math.max(1, Math.floor(rect.height));
        stateRef.current.width = w;
        stateRef.current.height = h;
        stateRef.current.dpr = dpr;
        if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
          canvas.width = Math.floor(w * dpr);
          canvas.height = Math.floor(h * dpr);
        }
      };

      updateSize();
      const ro = new ResizeObserver(updateSize);
      ro.observe(canvas);

      let rafId = 0;
      let lastTime = performance.now();

      const frame = (now: number) => {
        const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
        lastTime = now;

        const st = stateRef.current;
        const cfg = configRef.current;
        const reduced = reducedMotionRef.current;

        if (cfg.isPlaying && !reduced) {
          st.elapsed += dt;
          if (st.timeline < 1) {
            st.timeline = Math.min(1, st.timeline + dt / BLOOM_DURATION_SECONDS);
          }
          if (cfg.autoRotate && !st.dragging) {
            st.yaw += dt * cfg.rotationSpeed;
          }
        }

        // Apply pointer drag inertia
        if (!st.dragging) {
          st.yaw += st.velYaw;
          st.pitch = Math.max(-0.85, Math.min(1.05, st.pitch + st.velPitch));
          st.velYaw *= 0.92;
          st.velPitch *= 0.92;
        }

        // Throttle React timeline HUD updates to ~20fps when changing
        if (Math.abs(st.timeline - st.lastReportedTimeline) > 0.006) {
          st.lastReportedTimeline = st.timeline;
          onTimelineChange(st.timeline);
        }

        // Water pours continuously while the flowers grow and fades away as they reach full bloom
        const waterFadeIn = Math.min(1, 0.25 + st.timeline / 0.05);
        const waterFadeOut =
          st.timeline < 0.88 ? 1 : Math.max(0, 1 - (st.timeline - 0.88) / 0.115);
        const waterStrength = st.timeline >= 0.995 ? 0 : waterFadeIn * waterFadeOut;

        if (engineRef.current && bufferRef.current && st.width > 0 && st.height > 0) {
          engineRef.current.drawToCanvas(ctx, {
            buffer: bufferRef.current,
            width: st.width,
            height: st.height,
            dpr: st.dpr,
            yaw: st.yaw,
            pitch: st.pitch,
            timeline: st.timeline,
            elapsed: st.elapsed,
            waterStrength,
            palette: cfg.palette,
            density: cfg.density,
            bloomIntensity: cfg.bloomIntensity,
            reducedMotion: reduced,
          });
        }

        rafId = requestAnimationFrame(frame);
      };

      rafId = requestAnimationFrame(frame);

      return () => {
        cancelAnimationFrame(rafId);
        ro.disconnect();
      };
    }, [onTimelineChange]);

    const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      onFirstInteract?.();
      const st = stateRef.current;
      st.dragging = true;
      st.lastX = e.clientX;
      st.lastY = e.clientY;
      st.velYaw = 0;
      st.velPitch = 0;
      e.currentTarget.setPointerCapture(e.pointerId);
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const st = stateRef.current;
      if (!st.dragging) return;
      const dx = e.clientX - st.lastX;
      const dy = e.clientY - st.lastY;
      st.lastX = e.clientX;
      st.lastY = e.clientY;

      const dYaw = dx * 0.0075;
      const dPitch = dy * 0.006;
      st.yaw += dYaw;
      st.pitch = Math.max(-0.85, Math.min(1.05, st.pitch + dPitch));
      st.velYaw = dYaw * 0.55;
      st.velPitch = dPitch * 0.55;
    };

    const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      stateRef.current.dragging = false;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    };

    const handleDoubleClick = () => {
      stateRef.current.yaw = 0.15;
      stateRef.current.pitch = 0.18;
      stateRef.current.velYaw = 0;
      stateRef.current.velPitch = 0;
    };

    return (
      <canvas
        ref={canvasRef}
        aria-label="Interactive 3D blooming ASCII flower bouquet in a vase"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        className="block w-full h-full cursor-grab active:cursor-grabbing touch-none select-none"
      />
    );
  }
);
