export type BouquetPreset = 'peony' | 'lotus' | 'wildflower' | 'roses';

export type ColorPaletteMode = 'iridescent' | 'botanical' | 'moonlight' | 'phosphor';

export type GlyphDensity = 'fine' | 'classic' | 'bold';

export interface BouquetConfig {
  preset: BouquetPreset;
  palette: ColorPaletteMode;
  density: GlyphDensity;
  bloomIntensity: number;
  autoRotate: boolean;
  rotationSpeed: number;
  isPlaying: boolean;
  soundEnabled: boolean;
  showHud: boolean;
}

