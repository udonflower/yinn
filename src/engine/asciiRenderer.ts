import { ColorPaletteMode, GlyphDensity } from '../types/bouquet';
import { BouquetBuffer, SurfaceKind } from './bouquetGeometry';

const RAMP = ' .,:;~-=+*oxcnuvO08MWB%#$@';
const VASE_RAMP = ' .,:~-=+*oO0M#W%@';

const RAMP_CODES = Uint16Array.from(RAMP, (ch) => ch.charCodeAt(0));
const VASE_RAMP_CODES = Uint16Array.from(VASE_RAMP, (ch) => ch.charCodeAt(0));
const LIGHT_GLYPH_CODES = Uint16Array.from(['*', '+', ':', '.', "'"], (ch) => ch.charCodeAt(0));
const ASCII_CHARS: string[] = Array.from({ length: 128 }, (_, i) => String.fromCharCode(i));

const CODE_SPACE = 32;
const CODE_STAR = 42; // '*'
const CODE_PLUS = 43; // '+'
const CODE_DASH = 45; // '-'
const CODE_DOT = 46; // '.'
const CODE_COLON = 58; // ':'
const CODE_O = 111; // 'o'
const CODE_TILDE = 126; // '~'

const colorCache = new Map<number, string>();

function getCachedRgb(key: number, rq: number, gq: number, bq: number): string {
  let str = colorCache.get(key);
  if (!str) {
    str = `rgb(${rq},${gq},${bq})`;
    if (colorCache.size > 8000) colorCache.clear();
    colorCache.set(key, str);
  }
  return str;
}

function hueToRgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 0.5) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export interface RenderParams {
  buffer: BouquetBuffer;
  width: number;
  height: number;
  dpr: number;
  yaw: number;
  pitch: number;
  timeline: number; // 0..1
  elapsed: number; // continuous seconds for gentle sway/shimmer
  waterStrength: number; // 0..1 watering stream intensity
  palette: ColorPaletteMode;
  density: GlyphDensity;
  bloomIntensity: number; // 0..2 controls petal radiance & emitted ASCII light characters
  reducedMotion: boolean;
}

export class AsciiFrameEngine {
  private cols = 0;
  private rows = 0;
  private zBuf = new Float32Array(0);
  private ptBuf = new Int32Array(0);
  private rxBuf = new Float32Array(0);
  private ryBuf = new Float32Array(0);
  private rBuf = new Uint8Array(0);
  private gBuf = new Uint8Array(0);
  private bBuf = new Uint8Array(0);
  private charBuf = new Uint16Array(0); // charCodeAt
  private glowCanvas: HTMLCanvasElement;
  private glowCtx: CanvasRenderingContext2D | null;

  // Scratch RGB fields to eliminate per-cell array allocations
  private tmpR = 0;
  private tmpG = 0;
  private tmpB = 0;

  constructor() {
    this.glowCanvas = document.createElement('canvas');
    this.glowCtx = this.glowCanvas.getContext('2d');
  }

  public getGridDimensions(width: number, height: number, density: GlyphDensity) {
    const isNarrow = width < 640;
    const baseSize =
      density === 'fine'
        ? isNarrow
          ? 8
          : 10
        : density === 'bold'
        ? isNarrow
          ? 12
          : 15
        : isNarrow
        ? 10
        : 12.5;

    const cellH = Math.max(8, Math.round(baseSize * 1.08));
    const cellW = Math.max(5, Math.round(baseSize * 0.6));
    const cols = Math.max(20, Math.floor(width / cellW));
    const rows = Math.max(20, Math.floor(height / cellH));
    return { fontSize: baseSize, cellW, cellH, cols, rows };
  }

  private ensureBuffers(cols: number, rows: number) {
    const total = cols * rows;
    if (cols !== this.cols || rows !== this.rows || this.zBuf.length < total) {
      this.cols = cols;
      this.rows = rows;
      this.zBuf = new Float32Array(total);
      this.ptBuf = new Int32Array(total);
      this.rxBuf = new Float32Array(total);
      this.ryBuf = new Float32Array(total);
      this.rBuf = new Uint8Array(total);
      this.gBuf = new Uint8Array(total);
      this.bBuf = new Uint8Array(total);
      this.charBuf = new Uint16Array(total);
    }
    this.zBuf.fill(1e9);
    this.ptBuf.fill(-1);
    this.charBuf.fill(0);
  }

  private setHsl(hDeg: number, s: number, l: number): void {
    if (s === 0) {
      const v = Math.round(l * 255);
      this.tmpR = v;
      this.tmpG = v;
      this.tmpB = v;
      return;
    }
    const h = (((hDeg % 360) + 360) % 360) / 360;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    this.tmpR = Math.round(hueToRgb(p, q, h + 1 / 3) * 255);
    this.tmpG = Math.round(hueToRgb(p, q, h) * 255);
    this.tmpB = Math.round(hueToRgb(p, q, h - 1 / 3) * 255);
  }

  private writeColor(
    kind: SurfaceKind,
    hueSeed: number,
    lum: number,
    fresnel: number,
    spec: number,
    rx: number,
    ry: number,
    elapsed: number,
    palette: ColorPaletteMode,
    cupDepth = 1,
    petalEdge = 0
  ): void {
    if (palette === 'phosphor') {
      const hue = kind === SurfaceKind.Stamen ? 46 : kind === SurfaceKind.Vase ? 132 : 138;
      const sat = kind === SurfaceKind.Vase ? 0.55 : 0.85;
      const lit = clamp(lum * 0.72 + spec * 0.26, 0.08, 0.94);
      this.setHsl(hue, sat, lit);
      return;
    }

    if (palette === 'moonlight') {
      let hue = 212 + hueSeed * 55 + fresnel * 24;
      let sat = 0.42 + fresnel * 0.28;
      if (kind === SurfaceKind.Leaf || kind === SurfaceKind.Stem) {
        hue = 186 + fresnel * 18;
        sat = 0.38;
      } else if (kind === SurfaceKind.Stamen) {
        hue = 48;
        sat = 0.55;
      } else if (kind === SurfaceKind.Vase) {
        hue = 224;
        sat = 0.3;
      }
      const lit = clamp(0.14 + lum * 0.62 + spec * 0.3, 0.1, 0.96);
      this.setHsl(hue, sat, lit);
      return;
    }

    if (palette === 'botanical') {
      if (kind === SurfaceKind.Ground) {
        const lit = clamp(0.14 - hueSeed * 0.06, 0.05, 0.16);
        this.setHsl(215, 0.22, lit);
        return;
      }
      if (kind === SurfaceKind.Vase) {
        const hue = 214 + Math.sin(rx * 2.5) * 14;
        this.setHsl(hue, 0.45, clamp(0.14 + lum * 0.56 + spec * 0.34, 0.08, 0.92));
        return;
      }
      if (kind === SurfaceKind.Stem || kind === SurfaceKind.Leaf) {
        const hue = 142 + fresnel * 22 + Math.sin(ry * 3) * 8;
        this.setHsl(
          hue,
          0.68,
          clamp(0.12 + lum * 0.5 + spec * 0.16 + petalEdge * 0.08, 0.07, 0.84)
        );
        return;
      }
      if (kind === SurfaceKind.Stamen) {
        this.setHsl(43, 0.95, clamp(0.38 + lum * 0.5, 0.3, 0.94));
        return;
      }
      if (kind === SurfaceKind.WhitePetal) {
        // Four shades of white with slightly darker petal edges for crisp separation
        const edgeDarken = petalEdge * 0.13;
        if (hueSeed < 0.25) {
          const inner = 1 - clamp(hueSeed / 0.16, 0, 1);
          const sat = clamp(0.12 * (1 - lum * 0.8) + inner * 0.05 + petalEdge * 0.04, 0.01, 0.2);
          const lit = clamp(0.42 + lum * 0.48 + spec * 0.08 - edgeDarken, 0.28, 0.98);
          this.setHsl(214, sat, lit);
          return;
        }
        if (hueSeed < 0.5) {
          const inner = 1 - clamp((hueSeed - 0.25) / 0.16, 0, 1);
          const sat = clamp(0.25 - lum * 0.15 + inner * 0.07 + petalEdge * 0.06, 0.08, 0.32);
          const lit = clamp(0.39 + lum * 0.48 + spec * 0.08 - edgeDarken, 0.26, 0.95);
          this.setHsl(40, sat, lit);
          return;
        }
        if (hueSeed < 0.75) {
          const inner = 1 - clamp((hueSeed - 0.5) / 0.16, 0, 1);
          const sat = clamp(0.2 - lum * 0.12 + inner * 0.06 + petalEdge * 0.05, 0.05, 0.27);
          const lit = clamp(0.4 + lum * 0.48 + spec * 0.08 - edgeDarken, 0.27, 0.96);
          this.setHsl(340, sat, lit);
          return;
        }
        const inner = 1 - clamp((hueSeed - 0.75) / 0.16, 0, 1);
        const sat = clamp(0.16 - lum * 0.1 + inner * 0.05 + petalEdge * 0.04, 0.04, 0.23);
        const lit = clamp(0.38 + lum * 0.48 + spec * 0.08 - edgeDarken, 0.25, 0.95);
        this.setHsl(168, sat, lit);
        return;
      }
      if (kind === SurfaceKind.PurplePetal) {
        const hue = 262 + hueSeed * 36 + fresnel * 10 - petalEdge * 4;
        const sat = clamp(0.76 - spec * 0.28 + petalEdge * 0.08, 0.36, 0.9);
        const lit = clamp(
          0.2 + lum * 0.56 + spec * 0.22 - petalEdge * 0.11 + (cupDepth - 0.5) * 0.06,
          0.09,
          0.93
        );
        this.setHsl(hue, sat, lit);
        return;
      }
      // Natural rose/crimson/peach/coral botanical tones
      const hue = 335 + hueSeed * 48 + fresnel * 12 - petalEdge * 4;
      const sat = clamp(0.76 - spec * 0.32 + petalEdge * 0.08, 0.32, 0.9);
      const lit = clamp(
        0.16 + lum * 0.56 + spec * 0.24 - petalEdge * 0.11 + (cupDepth - 0.5) * 0.06,
        0.08,
        0.94
      );
      this.setHsl(hue, sat, lit);
      return;
    }

    // 'iridescent'
    if (kind === SurfaceKind.Vase) {
      const hue = 222 + Math.sin(ry * 3.5 + rx * 2.2 + elapsed * 0.25) * 34 + fresnel * 28;
      const sat = 0.58 - spec * 0.4;
      const lit = clamp(0.15 + lum * 0.58 + spec * 0.34, 0.1, 0.95);
      this.setHsl(hue, sat, lit);
      return;
    }
    if (kind === SurfaceKind.Stem || kind === SurfaceKind.Leaf) {
      const hue = 148 + Math.sin(ry * 2.5 + rx * 3 + elapsed * 0.4) * 24 + fresnel * 26;
      const sat = 0.72 - spec * 0.25;
      const lit = clamp(0.16 + lum * 0.54 + spec * 0.24, 0.1, 0.9);
      this.setHsl(hue, sat, lit);
      return;
    }
    if (kind === SurfaceKind.Stamen) {
      const hue = 44 + Math.sin(elapsed + rx * 4) * 10;
      this.setHsl(hue, 0.9, clamp(0.32 + lum * 0.52, 0.25, 0.94));
      return;
    }

    const iridShift = Math.sin(rx * 2.1 + ry * 1.7 + elapsed * 0.32) * 38 + fresnel * 46;
    const baseHue = 332 + hueSeed * 255 + iridShift;
    const sat = clamp(0.76 - spec * 0.48 + fresnel * 0.12, 0.25, 0.92);
    const lit = clamp(0.2 + lum * 0.54 + spec * 0.28, 0.14, 0.95);
    this.setHsl(baseHue, sat, lit);
  }

  public rasterize(params: RenderParams) {
    const {
      buffer,
      width,
      height,
      yaw,
      pitch,
      timeline,
      elapsed,
      waterStrength,
      palette,
      density,
      bloomIntensity,
      reducedMotion,
    } = params;
    const intensity = clamp(bloomIntensity, 0, 2);

    const { fontSize, cellW, cellH, cols, rows } = this.getGridDimensions(
      width,
      height,
      density
    );
    this.ensureBuffers(cols, rows);

    const gridW = cols * cellW;
    const gridH = rows * cellH;
    const offsetX = (width - gridW) * 0.5;
    const offsetY = (height - gridH) * 0.5;
    const halfW = width * 0.5;
    const originY = height * 0.55;

    const bloom = smoothstep(0.02, 0.96, timeline);
    const invBloom = 1 - bloom;
    const wClosed = invBloom * invBloom;
    const wMid = 2 * invBloom * bloom;
    const wOpen = bloom * bloom;

    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);

    const cameraDist = 4.15;
    const fovScale = Math.min(width, height) * 1.04;
    const swayMult = reducedMotion ? 0 : 0.35 + 0.65 * bloom;
    const swayTimeX = elapsed * 1.55;
    const swayTimeY = elapsed * 1.25;

    const l1x = -0.48;
    const l1y = 0.68;
    const l1z = 0.55;
    const l2x = 0.68;
    const l2y = 0.24;
    const l2z = -0.35;

    const {
      count,
      closedPos,
      midPos,
      openPos,
      closedNorm,
      openNorm,
      kind,
      hueSeed,
      swayPhase,
      swayAmp,
      cupDepth,
      petalEdge,
      petalIndices,
    } = buffer;

    const zBuf = this.zBuf;
    const ptBuf = this.ptBuf;
    const rxBuf = this.rxBuf;
    const ryBuf = this.ryBuf;

    // 1A. Pass 1: Project 3D positions & Z-buffer winning point index per cell
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;

      let px = wClosed * closedPos[i3] + wMid * midPos[i3] + wOpen * openPos[i3];
      let py = wClosed * closedPos[i3 + 1] + wMid * midPos[i3 + 1] + wOpen * openPos[i3 + 1];
      let pz = wClosed * closedPos[i3 + 2] + wMid * midPos[i3 + 2] + wOpen * openPos[i3 + 2];

      const amp = swayAmp[i] * swayMult;
      if (amp > 0) {
        const sp = swayPhase[i];
        px += Math.sin(swayTimeX + sp) * amp * 0.7;
        py += Math.cos(swayTimeY + sp) * amp * 0.4;
      }

      const x1 = px * cosY - pz * sinY;
      const z1 = px * sinY + pz * cosY;
      const y2 = py * cosP - z1 * sinP;
      const z2 = py * sinP + z1 * cosP;

      const depth = cameraDist - z2;
      if (depth <= 0.35) continue;

      const proj = fovScale / depth;
      const sx = halfW + x1 * proj;
      const sy = originY - y2 * proj;

      const col = Math.floor((sx - offsetX) / cellW);
      if (col < 0 || col >= cols) continue;
      const row = Math.floor((sy - offsetY) / cellH);
      if (row < 0 || row >= rows) continue;

      const idx = row * cols + col;
      if (depth < zBuf[idx]) {
        zBuf[idx] = depth;
        ptBuf[idx] = i;
        rxBuf[idx] = x1;
        ryBuf[idx] = y2;
      }
    }

    // 1B. Pass 2: Deferred shading — evaluate normals, lighting, glyph & color ONLY on visible winning cells
    const total = cols * rows;
    const rampMax = RAMP_CODES.length - 1;
    const vaseRampMax = VASE_RAMP_CODES.length - 1;
    const petalIntensityScale = 0.45 + 0.55 * intensity;
    const petalIntensityOffset = (intensity - 1) * 0.14;
    const stamenIntensityScale = 0.55 + 0.45 * intensity;
    const stamenIntensityOffset = (intensity - 1) * 0.1;

    for (let idx = 0; idx < total; idx++) {
      const i = ptBuf[idx];
      if (i < 0) continue;

      const i3 = i * 3;
      const k = kind[i] as SurfaceKind;

      const nx0 = closedNorm[i3] * invBloom + openNorm[i3] * bloom;
      const ny0 = closedNorm[i3 + 1] * invBloom + openNorm[i3 + 1] * bloom;
      const nz0 = closedNorm[i3 + 2] * invBloom + openNorm[i3 + 2] * bloom;

      const nx1 = nx0 * cosY - nz0 * sinY;
      const nz1 = nx0 * sinY + nz0 * cosY;
      const ny2 = ny0 * cosP - nz1 * sinP;
      const nz2 = ny0 * sinP + nz1 * cosP;

      const nLen = Math.hypot(nx1, ny2, nz2) || 1;
      const nx = nx1 / nLen;
      const ny = ny2 / nLen;
      const nz = nz2 / nLen;

      const isPetal =
        k === SurfaceKind.Petal ||
        k === SurfaceKind.WhitePetal ||
        k === SurfaceKind.PurplePetal;
      const faceSign = nz < 0 && isPetal ? -0.65 : 1;
      const nd1 = Math.max(0, (nx * l1x + ny * l1y + nz * l1z) * faceSign);
      const nd2 = Math.max(0, (nx * l2x + ny * l2y + nz * l2z) * faceSign);

      const oneMinusAbsNz = 1 - (nz < 0 ? -nz : nz);
      const fresnel = oneMinusAbsNz * oneMinusAbsNz;

      const specBase = nz * 0.85 + ny * 0.32 - nx * 0.25;
      let spec = 0;
      if (specBase > 0) {
        const s2 = specBase * specBase;
        const s4 = s2 * s2;
        const s8 = s4 * s4;
        spec = s8 * s4 * s2;
      }

      const cDepth = cupDepth[i];
      const pEdge = petalEdge[i];

      let baseLum =
        0.16 + nd1 * 0.58 + nd2 * 0.22 + fresnel * (isPetal ? 0.16 : 0.34) + spec * 0.42;
      if (isPetal) {
        const ao = 0.54 + 0.46 * cDepth;
        baseLum = (baseLum * ao - pEdge * 0.17) * petalIntensityScale + petalIntensityOffset;
      } else if (k === SurfaceKind.Stamen) {
        baseLum = baseLum * stamenIntensityScale + stamenIntensityOffset;
      } else if (k === SurfaceKind.Leaf) {
        baseLum = baseLum * (0.68 + 0.32 * cDepth) - pEdge * 0.07;
      }

      const lum = clamp(baseLum, 0.06, 1.0);
      const seedVal = hueSeed[i];

      let chCode: number;
      if (k === SurfaceKind.Ground) {
        chCode = seedVal > 0.4 ? CODE_DOT : CODE_DASH;
      } else if (k === SurfaceKind.Vase && Math.abs(ny) < 0.35 && lum < 0.52 && lum > 0.22) {
        const vIdx = Math.min(vaseRampMax, Math.floor(lum * vaseRampMax));
        chCode = VASE_RAMP_CODES[vIdx];
      } else {
        const rIdx = Math.min(rampMax, Math.floor(lum * rampMax));
        chCode = RAMP_CODES[rIdx];
      }

      this.writeColor(
        k,
        seedVal,
        lum,
        fresnel,
        spec,
        rxBuf[idx],
        ryBuf[idx],
        elapsed,
        palette,
        cDepth,
        pEdge
      );

      this.charBuf[idx] = chCode;
      this.rBuf[idx] = this.tmpR;
      this.gBuf[idx] = this.tmpG;
      this.bBuf[idx] = this.tmpB;
    }

    // 2. ASCII Watering Effect (deep-blue cascading water dissolving on blooms)
    if (waterStrength > 0.01 && !reducedMotion) {
      this.drawWateringEffect(
        halfW,
        originY,
        fovScale,
        cameraDist,
        offsetX,
        offsetY,
        cellW,
        cellH,
        cols,
        rows,
        elapsed,
        bloom,
        waterStrength
      );
    }

    // 3. Emitted ASCII 'light' characters drifting outward from petals (O(1) lookup via petalIndices)
    if (!reducedMotion && intensity > 0.02 && petalIndices.length > 0) {
      const pLen = petalIndices.length;
      const emitTotal = Math.round(intensity * 115 * (0.28 + 0.72 * bloom));
      const lightGlyphLen = LIGHT_GLYPH_CODES.length;
      const driftScale = 0.14 + 0.18 * intensity;
      const brightFactor = 0.55 + 0.4 * intensity;
      const lumScale = Math.min(1.4, intensity);

      for (let e = 0; e < emitTotal; e++) {
        const life = (elapsed * (0.28 + (e % 5) * 0.05) + e * 0.173) % 1;
        const fade = Math.sin(life * Math.PI);
        if (fade < 0.12) continue;

        const idxPt = petalIndices[Math.floor(((e * 0.61803398875) % 1) * pLen)];
        const i3 = idxPt * 3;
        const bx = wClosed * closedPos[i3] + wMid * midPos[i3] + wOpen * openPos[i3];
        const by = wClosed * closedPos[i3 + 1] + wMid * midPos[i3 + 1] + wOpen * openPos[i3 + 1];
        const bz = wClosed * closedPos[i3 + 2] + wMid * midPos[i3 + 2] + wOpen * openPos[i3 + 2];

        const nx0 = closedNorm[i3] * invBloom + openNorm[i3] * bloom;
        const ny0 = closedNorm[i3 + 1] * invBloom + openNorm[i3 + 1] * bloom;
        const nz0 = closedNorm[i3 + 2] * invBloom + openNorm[i3 + 2] * bloom;

        const drift = life * driftScale;
        const px = bx + nx0 * drift * 0.7 + Math.sin(elapsed * 1.4 + e) * 0.03 * life;
        const py = by + (Math.abs(ny0) * 0.45 + 0.55) * drift;
        const pz = bz + nz0 * drift * 0.7 + Math.cos(elapsed * 1.1 + e) * 0.03 * life;

        const x1 = px * cosY - pz * sinY;
        const z1 = px * sinY + pz * cosY;
        const y2 = py * cosP - z1 * sinP;
        const z2 = py * sinP + z1 * cosP;

        const depth = cameraDist - z2;
        if (depth <= 0.35) continue;

        const proj = fovScale / depth;
        const sx = halfW + x1 * proj;
        const sy = originY - y2 * proj;
        const col = Math.floor((sx - offsetX) / cellW);
        if (col < 0 || col >= cols) continue;
        const row = Math.floor((sy - offsetY) / cellH);
        if (row < 0 || row >= rows) continue;

        const cellIdx = row * cols + col;
        if (this.charBuf[cellIdx] === 0) {
          const glyphIdx = Math.floor(life * lightGlyphLen + (e % 2)) % lightGlyphLen;
          const lumVal = clamp(0.45 + 0.45 * fade * lumScale, 0.2, 1.0);
          this.writeColor(
            kind[idxPt] as SurfaceKind,
            hueSeed[idxPt],
            lumVal,
            0.55,
            0.35,
            x1,
            y2,
            elapsed,
            palette,
            1,
            1
          );
          const brightMult = clamp(fade * brightFactor, 0.15, 1.0);
          this.charBuf[cellIdx] = LIGHT_GLYPH_CODES[glyphIdx];
          this.rBuf[cellIdx] = Math.round(this.tmpR * brightMult);
          this.gBuf[cellIdx] = Math.round(this.tmpG * brightMult);
          this.bBuf[cellIdx] = Math.round(this.tmpB * brightMult);
        }
      }
    }

    // 4. Subtle 3D floating pollen drifting slowly across the background for spatial depth
    if (!reducedMotion) {
      const pollenCount = 54;
      const cosParY = Math.cos(yaw * 0.35);
      const sinParY = Math.sin(yaw * 0.35);
      const cosParP = Math.cos(pitch * 0.25);
      const sinParP = Math.sin(pitch * 0.25);
      const xSpan = 6.8;
      const ySpan = 4.6;

      for (let m = 0; m < pollenCount; m++) {
        const seed = m * 1.6180339887;
        const depthNorm = (m % 9) / 8;
        const zWorld = -2.2 + depthNorm * 3.6;

        const speedX = 0.045 + (m % 5) * 0.014 + depthNorm * 0.035;
        const speedY = 0.016 + (m % 3) * 0.009;
        const rawX = (((seed * 19.7) % 1) * xSpan + elapsed * speedX) % xSpan - xSpan * 0.5;
        const rawY =
          ((((seed * 41.3) % 1) * ySpan - elapsed * speedY + ySpan * 10) % ySpan) - ySpan * 0.5;

        const edgeFadeX = Math.min(1, (xSpan * 0.5 - Math.abs(rawX)) / 0.6);
        const edgeFadeY = Math.min(1, (ySpan * 0.5 - Math.abs(rawY)) / 0.5);
        const twinkle = 0.68 + 0.32 * Math.sin(elapsed * 1.4 + seed * 11.3);
        const depthVis = (0.24 + 0.42 * depthNorm) * twinkle * edgeFadeX * edgeFadeY;
        if (depthVis < 0.1) continue;

        const wx = rawX + Math.sin(elapsed * 0.42 + seed * 6.1) * 0.16;
        const wy = rawY + Math.cos(elapsed * 0.36 + seed * 4.7) * 0.18;

        const x1 = wx * cosParY - zWorld * sinParY;
        const z1 = wx * sinParY + zWorld * cosParY;
        const y2 = wy * cosParP - z1 * sinParP;
        const z2 = wy * sinParP + z1 * cosParP;

        const depth = cameraDist - z2;
        if (depth <= 0.6) continue;

        const proj = fovScale / depth;
        const sx = halfW + x1 * proj;
        const sy = originY - y2 * proj;

        const col = Math.floor((sx - offsetX) / cellW);
        if (col < 0 || col >= cols) continue;
        const row = Math.floor((sy - offsetY) / cellH);
        if (row < 0 || row >= rows) continue;

        const idx = row * cols + col;
        if (this.charBuf[idx] === 0) {
          const chCode =
            depthNorm > 0.78 && twinkle > 0.85
              ? CODE_PLUS
              : depthNorm > 0.52
              ? CODE_STAR
              : depthNorm > 0.28
              ? CODE_COLON
              : CODE_DOT;

          const hue = 40 + (m % 4) * 5;
          this.setHsl(hue, 0.55 + depthNorm * 0.25, 0.52 + depthNorm * 0.22);
          this.charBuf[idx] = chCode;
          this.rBuf[idx] = Math.round(this.tmpR * depthVis);
          this.gBuf[idx] = Math.round(this.tmpG * depthVis);
          this.bBuf[idx] = Math.round(this.tmpB * depthVis);
        }
      }
    }

    return { fontSize, cellW, cellH, cols, rows, offsetX, offsetY };
  }

  private drawWateringEffect(
    halfW: number,
    originY: number,
    fovScale: number,
    cameraDist: number,
    offsetX: number,
    offsetY: number,
    cellW: number,
    cellH: number,
    cols: number,
    rows: number,
    elapsed: number,
    bloom: number,
    strength: number
  ) {
    const topY = 2.25;
    const crownStopY = -0.2 + bloom * 0.24;
    const strandCount = 27;
    const steps = 150;
    const maxDissolveSteps = 48;
    const invCellW = 1 / cellW;
    const invCellH = 1 / cellH;

    for (let s = 0; s < strandCount; s++) {
      const frac = s / (strandCount - 1) - 0.5;
      const radialFalloff = 1 - Math.abs(frac) * 0.82;
      const isCore = Math.abs(frac) <= 0.3;
      const wz = 0.36 + (1 - Math.abs(frac) * 2) * 0.14;
      const depth = cameraDist - wz;
      const proj = fovScale / (depth > 0.5 ? depth : 0.5);

      let dissolveSteps = -1;

      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const wy = topY - t * (topY - crownStopY);
        const topFade = smoothstep(0.0, 0.07, t);
        const bottomFade = smoothstep(crownStopY - 0.04, crownStopY + 0.56, wy);
        if (bottomFade <= 0.02) break;

        const halfWidth = (0.37 - t * 0.06) * (0.9 + 0.1 * Math.sin(t * 4.0 - elapsed * 1.1));
        const wobble = Math.sin(wy * 2.1 + elapsed * 0.95 + s * 0.65) * 0.024;
        const wx = frac * 2 * halfWidth + wobble;

        const flowWave = 0.5 + 0.5 * Math.sin(wy * 4.5 + elapsed * 1.6 + s * 0.95);
        if (!isCore && flowWave < 0.24) continue;

        const sx = halfW + wx * proj;
        const sy = originY - wy * proj;
        const col = Math.round((sx - offsetX) * invCellW);
        if (col < 0 || col >= cols) continue;
        const row = Math.round((sy - offsetY) * invCellH);
        if (row < 0 || row >= rows) continue;

        const cellIdx = row * cols + col;
        const touchedFlower = this.charBuf[cellIdx] !== 0;

        if (touchedFlower && dissolveSteps < 0) {
          dissolveSteps = 0;
        }

        if (dissolveSteps >= 0) {
          if (dissolveSteps >= maxDissolveSteps) break;
          const progress = dissolveSteps / maxDissolveSteps;
          const contactFade = Math.pow(1 - progress, 1.35);
          const mistFade = clamp(
            radialFalloff * (0.76 + 0.24 * flowWave) * contactFade * bottomFade,
            0.0,
            1.0
          );
          if (mistFade < 0.08) break;

          const dChar =
            progress < 0.32
              ? flowWave > 0.55
                ? CODE_TILDE
                : CODE_COLON
              : progress < 0.68
              ? CODE_COLON
              : CODE_DOT;

          const mistScale = mistFade * strength;
          this.zBuf[cellIdx] = Math.min(this.zBuf[cellIdx], depth - 0.06);
          this.charBuf[cellIdx] = dChar;
          this.rBuf[cellIdx] = Math.round((isCore ? 92 : 60) * mistScale);
          this.gBuf[cellIdx] = Math.round((isCore ? 172 : 132) * mistScale);
          this.bBuf[cellIdx] = Math.round(255 * mistScale);
          dissolveSteps++;
          continue;
        }

        const softFade = clamp(
          radialFalloff * (0.78 + 0.22 * flowWave) * topFade * bottomFade,
          0.0,
          1.0
        );
        if (softFade < 0.1) continue;

        const glyph =
          bottomFade < 0.3
            ? CODE_DOT
            : flowWave > 0.72
            ? CODE_COLON
            : flowWave > 0.45
            ? CODE_TILDE
            : flowWave > 0.28
            ? CODE_O
            : CODE_DOT;

        const rainScale = softFade * strength;
        this.zBuf[cellIdx] = Math.min(this.zBuf[cellIdx], depth - 0.04);
        this.charBuf[cellIdx] = glyph;
        this.rBuf[cellIdx] = Math.round((isCore ? 95 : 58) * rainScale);
        this.gBuf[cellIdx] = Math.round((isCore ? 175 : 128) * rainScale);
        this.bBuf[cellIdx] = Math.round(255 * rainScale);
      }
    }
  }

  public drawToCanvas(ctx: CanvasRenderingContext2D, params: RenderParams) {
    const { width, height, dpr } = params;
    const layout = this.rasterize(params);
    const { fontSize, cellW, cellH, cols, rows, offsetX, offsetY } = layout;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    ctx.font = `500 ${fontSize}px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    let lastColorKey = -1;
    const charBuf = this.charBuf;
    const rBuf = this.rBuf;
    const gBuf = this.gBuf;
    const bBuf = this.bBuf;

    for (let r = 0; r < rows; r++) {
      const rowOffset = r * cols;
      const py = offsetY + r * cellH;
      for (let c = 0; c < cols; c++) {
        const idx = rowOffset + c;
        const code = charBuf[idx];
        if (code === 0 || code === CODE_SPACE) continue;

        const rq = rBuf[idx] & 0xfc;
        const gq = gBuf[idx] & 0xfc;
        const bq = bBuf[idx] & 0xfc;
        const key = (rq << 16) | (gq << 8) | bq;
        if (key !== lastColorKey) {
          lastColorKey = key;
          ctx.fillStyle = getCachedRgb(key, rq, gq, bq);
        }
        ctx.fillText(ASCII_CHARS[code] ?? ' ', offsetX + c * cellW, py);
      }
    }

    // Subtle optical CRT/phosphor glow pass via tiny downsampled offscreen buffer
    const gw = Math.max(64, Math.floor(width * 0.25));
    const gh = Math.max(64, Math.floor(height * 0.25));
    if (this.glowCanvas.width !== gw || this.glowCanvas.height !== gh) {
      this.glowCanvas.width = gw;
      this.glowCanvas.height = gh;
    }
    if (this.glowCtx) {
      this.glowCtx.clearRect(0, 0, gw, gh);
      this.glowCtx.drawImage(ctx.canvas, 0, 0, gw, gh);
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = clamp(0.16 + 0.26 * params.bloomIntensity, 0.12, 0.72);
      ctx.filter = 'blur(8px)';
      ctx.drawImage(this.glowCanvas, 0, 0, width, height);
      ctx.restore();
    }

    ctx.restore();
  }
}
