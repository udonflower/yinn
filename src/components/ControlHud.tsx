import {
  Eye,
  Pause,
  Play,
  RotateCcw,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import {
  BouquetConfig,
  BouquetPreset,
} from '../types/bouquet';

interface ControlHudProps {
  config: BouquetConfig;
  timeline: number;
  onUpdateConfig: (patch: Partial<BouquetConfig>) => void;
  onReplay: () => void;
  onSeekTimeline: (value: number) => void;
}

const PRESETS: { id: BouquetPreset; label: string }[] = [
  { id: 'roses', label: 'White Roses' },
  { id: 'peony', label: 'Peony' },
  { id: 'lotus', label: 'Lotus' },
  { id: 'wildflower', label: 'Wildflower' },
];

function getPhaseLabel(timeline: number): string {
  if (timeline < 0.25) return 'Sprouting';
  if (timeline < 0.94) return 'Blooming';
  return 'Full Bloom';
}

export function ControlHud({
  config,
  timeline,
  onUpdateConfig,
  onReplay,
  onSeekTimeline,
}: ControlHudProps) {
  const pct = Math.round(timeline * 100);
  const phase = getPhaseLabel(timeline);

  if (!config.showHud) {
    return (
      <div className="pointer-events-none fixed inset-0 z-10 flex items-start justify-end p-4 sm:p-6">
        <button
          type="button"
          onClick={() => onUpdateConfig({ showHud: true })}
          aria-label="Show controls"
          className="pointer-events-auto inline-flex items-center gap-2 rounded-lg border border-white/15 bg-black/60 px-3.5 py-2 text-xs font-medium text-zinc-200 backdrop-blur-md transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 whitespace-nowrap shrink-0"
        >
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Show Controls</span>
        </button>
      </div>
    );
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-10 flex flex-col justify-end p-4 sm:p-6">
      {/* Bottom Floating Studio Control Dock */}
      <div className="flex justify-center">
        <section
          aria-label="Bouquet controls"
          className="pointer-events-auto w-full max-w-3xl rounded-2xl border border-white/10 bg-black/65 p-3 sm:p-4 backdrop-blur-md"
        >
          {/* Row 1: Replay, Play/Pause, Scrubber, Spin */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={onReplay}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-white/15 bg-white/10 px-3.5 py-2 text-xs font-medium text-zinc-100 transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 whitespace-nowrap shrink-0"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Grow</span>
              </button>

              <button
                type="button"
                onClick={() => onUpdateConfig({ isPlaying: !config.isPlaying })}
                aria-label={config.isPlaying ? 'Pause animation' : 'Play animation'}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 whitespace-nowrap shrink-0"
              >
                {config.isPlaying ? (
                  <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Play className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                <span>{config.isPlaying ? 'Pause' : 'Play'}</span>
              </button>
            </div>

            {/* Timeline Scrubber */}
            <div className="flex flex-1 min-w-[160px] items-center gap-3 px-1">
              <label htmlFor="bloom-scrubber" className="sr-only">
                Bloom stage
              </label>
              <input
                id="bloom-scrubber"
                type="range"
                min={0}
                max={1}
                step={0.005}
                value={timeline}
                onChange={(e) => onSeekTimeline(parseFloat(e.target.value))}
                className="bloom-slider w-full"
              />
              <div className="flex items-center gap-2 text-xs text-zinc-400 whitespace-nowrap shrink-0">
                <span className="hidden sm:inline text-zinc-300">{phase}</span>
                <span aria-hidden="true" className="hidden sm:inline text-zinc-600">
                  ·
                </span>
                <span className="font-mono tabular-nums text-zinc-300 w-9 text-right">
                  {pct}%
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => onUpdateConfig({ autoRotate: !config.autoRotate })}
              aria-pressed={config.autoRotate}
              className={`inline-flex min-h-10 items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 whitespace-nowrap shrink-0 ${
                config.autoRotate
                  ? 'border-white/20 bg-white/12 text-white'
                  : 'border-white/10 bg-transparent text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Auto-Spin</span>
            </button>
          </div>

          {/* Hairline Divider */}
          <div className="my-2.5 h-px w-full bg-white/10" />

          {/* Row 2: Bouquet Arrangement & Bloom Intensity */}
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex flex-wrap items-center justify-center gap-1 rounded-lg bg-white/5 p-1">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onUpdateConfig({ preset: p.id })}
                  className={`rounded-md px-3 py-1 font-medium transition-colors whitespace-nowrap shrink-0 ${
                    config.preset === p.id
                      ? 'bg-white/15 text-white'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div className="flex flex-1 min-w-[190px] max-w-xs items-center gap-2.5 px-1">
              <Sparkles className="h-3.5 w-3.5 text-zinc-400 shrink-0" aria-hidden="true" />
              <label
                htmlFor="bloom-intensity-slider"
                className="text-zinc-400 whitespace-nowrap shrink-0"
              >
                Bloom Intensity
              </label>
              <input
                id="bloom-intensity-slider"
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={config.bloomIntensity}
                onChange={(e) =>
                  onUpdateConfig({ bloomIntensity: parseFloat(e.target.value) })
                }
                className="bloom-slider w-full"
              />
              <span className="font-mono tabular-nums text-zinc-300 w-10 text-right shrink-0">
                {Math.round(config.bloomIntensity * 100)}%
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
