import { BouquetPreset } from '../types/bouquet';

export const enum SurfaceKind {
  Vase = 0,
  Stem = 1,
  Leaf = 2,
  Petal = 3,
  Stamen = 4,
  Ground = 5,
  WhitePetal = 6,
  PurplePetal = 7,
}

export interface BouquetBuffer {
  count: number;
  // Closed-bud positions (bloom = 0)
  closedPos: Float32Array;
  // Mid-arc positions (bloom = 0.5) for curved unfurling
  midPos: Float32Array;
  // Full-bloom positions (bloom = 1)
  openPos: Float32Array;
  // Closed normals
  closedNorm: Float32Array;
  // Open normals
  openNorm: Float32Array;
  // Per-point metadata
  kind: Uint8Array;
  hueSeed: Float32Array;
  swayPhase: Float32Array;
  swayAmp: Float32Array;
  cupDepth: Float32Array; // 0 (deep inner cup) -> 1 (open outer tip)
  petalEdge: Float32Array; // 0 (petal interior) -> 1 (crisp petal margin/lip)
  petalIndices: Uint32Array; // Precomputed indices of petal/stamen points for O(1) emission
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface FlowerSpec {
  center: Vec3;
  dir: Vec3;
  scale: number;
  layers: number;
  petalsBase: number;
  petalRoundness: number;
  hueSeed: number;
  openExtra: number;
  style: 'peony' | 'lotus' | 'daisy' | 'rose';
  isWhite?: boolean;
  isPurple?: boolean;
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function buildBasis(dir: Vec3): { right: Vec3; up: Vec3; forward: Vec3 } {
  const up = normalize(dir);
  const ref = Math.abs(up.y) > 0.94 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const right = normalize(cross(ref, up));
  const forward = normalize(cross(up, right));
  return { right, up, forward };
}

// Deterministic pseudo-random for reproducible organic placements
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface DynamicBuilder {
  closedPos: number[];
  midPos: number[];
  openPos: number[];
  closedNorm: number[];
  openNorm: number[];
  kind: number[];
  hueSeed: number[];
  swayPhase: number[];
  swayAmp: number[];
  cupDepth: number[];
  petalEdge: number[];
  petalIndices: number[];
}

function createBuilder(): DynamicBuilder {
  return {
    closedPos: [],
    midPos: [],
    openPos: [],
    closedNorm: [],
    openNorm: [],
    kind: [],
    hueSeed: [],
    swayPhase: [],
    swayAmp: [],
    cupDepth: [],
    petalEdge: [],
    petalIndices: [],
  };
}

function pushPoint(
  b: DynamicBuilder,
  c: Vec3,
  m: Vec3,
  o: Vec3,
  cn: Vec3,
  on: Vec3,
  kind: SurfaceKind,
  hueSeed: number,
  swayPhase: number,
  swayAmp: number,
  cupDepth = 1,
  petalEdge = 0
) {
  const idx = b.kind.length;
  b.closedPos.push(c.x, c.y, c.z);
  b.midPos.push(m.x, m.y, m.z);
  b.openPos.push(o.x, o.y, o.z);
  b.closedNorm.push(cn.x, cn.y, cn.z);
  b.openNorm.push(on.x, on.y, on.z);
  b.kind.push(kind);
  b.hueSeed.push(hueSeed);
  b.swayPhase.push(swayPhase);
  b.swayAmp.push(swayAmp);
  b.cupDepth.push(cupDepth);
  b.petalEdge.push(petalEdge);
  if (
    kind === SurfaceKind.Petal ||
    kind === SurfaceKind.WhitePetal ||
    kind === SurfaceKind.PurplePetal ||
    kind === SurfaceKind.Stamen
  ) {
    b.petalIndices.push(idx);
  }
}

// Sculpted vase profile: returns [radius, dr/dy] for y in [-1.32, -0.22]
function vaseProfile(t: number): { y: number; r: number; dr: number } {
  const y = -1.32 + t * 1.1; // -1.32 bottom -> -0.22 rim
  // Smooth organic amphora/bulbous silhouette matching the video
  const foot = 0.24;
  const belly = 0.26 * Math.sin(Math.pow(t, 0.72) * Math.PI * 1.05);
  const waist = -0.14 * Math.exp(-Math.pow((t - 0.76) / 0.14, 2));
  const rim = 0.15 * Math.pow(Math.max(0, (t - 0.78) / 0.22), 1.7);
  const r = foot + belly + waist + rim;

  const eps = 0.005;
  const t2 = Math.min(1, t + eps);
  const belly2 = 0.26 * Math.sin(Math.pow(t2, 0.72) * Math.PI * 1.05);
  const waist2 = -0.14 * Math.exp(-Math.pow((t2 - 0.76) / 0.14, 2));
  const rim2 = 0.15 * Math.pow(Math.max(0, (t2 - 0.78) / 0.22), 1.7);
  const r2 = foot + belly2 + waist2 + rim2;
  const dr = (r2 - r) / (eps * 1.1);
  return { y, r, dr };
}

function addVase(b: DynamicBuilder) {
  const rings = 84;
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const { y, r, dr } = vaseProfile(t);
    const segs = Math.max(36, Math.round(r * 175));
    for (let j = 0; j < segs; j++) {
      const theta = ((j + (i % 2) * 0.5) / segs) * Math.PI * 2;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);

      // Subtle vertical fluting on vase surface
      const flute = 1 + 0.025 * Math.sin(theta * 14) * Math.sin(t * Math.PI);
      const px = r * flute * cosT;
      const pz = r * flute * sinT;

      const norm = normalize({ x: cosT, y: -dr * 0.65, z: sinT });
      const pos = { x: px, y, z: pz };
      pushPoint(b, pos, pos, pos, norm, norm, SurfaceKind.Vase, (theta / (Math.PI * 2)) * 0.25, theta, 0);
    }
  }

  // Base bottom cap subtle ring
  for (let ir = 0; ir < 6; ir++) {
    const rad = (ir / 6) * 0.24;
    const segs = Math.max(8, Math.round(rad * 70));
    for (let j = 0; j < segs; j++) {
      const theta = (j / segs) * Math.PI * 2;
      const pos = { x: rad * Math.cos(theta), y: -1.32, z: rad * Math.sin(theta) };
      const norm = { x: 0, y: -1, z: 0 };
      pushPoint(b, pos, pos, pos, norm, norm, SurfaceKind.Vase, 0.1, 0, 0);
    }
  }

  // Subtle grounded contact ring under the vase so it reads as sitting firmly still
  for (let ir = 0; ir < 3; ir++) {
    const rad = 0.26 + ir * 0.085;
    const segs = Math.round(rad * 96);
    for (let j = 0; j < segs; j++) {
      const theta = (j / segs) * Math.PI * 2;
      const pos = { x: rad * Math.cos(theta), y: -1.335, z: rad * Math.sin(theta) };
      const norm = { x: 0, y: 1, z: 0 };
      pushPoint(b, pos, pos, pos, norm, norm, SurfaceKind.Ground, ir * 0.35, 0, 0);
    }
  }
}

function addFlower(b: DynamicBuilder, spec: FlowerSpec, flowerIndex: number) {
  const { right, up, forward } = buildBasis(spec.dir);
  const toWorld = (lx: number, ly: number, lz: number, center: Vec3): Vec3 => ({
    x: center.x + right.x * lx + up.x * ly + forward.x * lz,
    y: center.y + right.y * lx + up.y * ly + forward.y * lz,
    z: center.z + right.z * lx + up.z * ly + forward.z * lz,
  });

  // Closed buds sit tucked near the vase neck ready to grow upward when watered
  const neck = { x: 0, y: -0.24, z: 0 };
  const closedCenter: Vec3 = {
    x: neck.x + (spec.center.x - neck.x) * 0.22,
    y: neck.y + (spec.center.y - neck.y) * 0.22,
    z: neck.z + (spec.center.z - neck.z) * 0.22,
  };
  const midCenter: Vec3 = {
    x: (closedCenter.x + spec.center.x) * 0.5,
    y: (closedCenter.y + spec.center.y) * 0.5 + 0.1,
    z: (closedCenter.z + spec.center.z) * 0.5,
  };

  // Add species-distinct golden stamen / receptacle center
  const isRose = spec.style === 'rose';
  const isDaisy = spec.style === 'daisy';
  const isLotus = spec.style === 'lotus';
  const stamenCount = isRose ? 20 : isDaisy ? 56 : isLotus ? 42 : 44;
  for (let s = 0; s < stamenCount; s++) {
    const phi = s * 2.3999632; // golden angle
    const radialNorm = Math.sqrt((s + 0.5) / stamenCount);
    const maxR = isRose ? 0.036 : isDaisy ? 0.115 : isLotus ? 0.088 : 0.095;
    const rr = radialNorm * maxR * spec.scale;
    const lx = rr * Math.cos(phi);
    const lz = rr * Math.sin(phi);
    const ly = isDaisy
      ? (0.068 - radialNorm * radialNorm * 0.055) * spec.scale
      : isLotus
      ? (0.062 - radialNorm * 0.015) * spec.scale
      : isRose
      ? (0.022 - radialNorm * 0.012) * spec.scale
      : (0.048 - rr * 0.32) * spec.scale;

    const cP = toWorld(lx * 0.4, ly * 0.6, lz * 0.4, closedCenter);
    const mP = toWorld(lx * 0.8, ly * 0.9, lz * 0.8, midCenter);
    const oP = toWorld(lx, ly, lz, spec.center);
    const norm = isDaisy
      ? normalize(toWorld(lx * 2.8, 0.25, lz * 2.8, { x: 0, y: 0, z: 0 }))
      : up;
    pushPoint(
      b,
      cP,
      mP,
      oP,
      norm,
      norm,
      SurfaceKind.Stamen,
      spec.hueSeed,
      phi + flowerIndex,
      0.008,
      0.7 + radialNorm * 0.3,
      radialNorm > 0.82 ? 0.5 : 0
    );
  }

  const petalKind = spec.isWhite
    ? SurfaceKind.WhitePetal
    : spec.isPurple
    ? SurfaceKind.PurplePetal
    : SurfaceKind.Petal;

  // Layered 3D petals
  for (let layer = 0; layer < spec.layers; layer++) {
    const layerFrac = layer / Math.max(1, spec.layers - 1);
    const petalsInLayer = Math.round(
      spec.petalsBase + layer * (isDaisy ? 3 : isRose ? 1.5 : 2)
    );
    const petalLen =
      spec.scale *
      (isRose
        ? 0.165 + layerFrac * 0.22
        : isDaisy
        ? 0.23 + layerFrac * 0.14
        : isLotus
        ? 0.2 + layerFrac * 0.21
        : 0.17 + layerFrac * 0.19);
    const petalWidth =
      spec.scale *
      (isDaisy
        ? 0.041 + layerFrac * 0.012
        : isRose
        ? 0.12 + layerFrac * 0.125
        : isLotus
        ? 0.105 + layerFrac * 0.075
        : 0.13 + layerFrac * 0.11);

    // Closed angle: tightly wrapped inward; Open angle: flared distinctly per species
    const closedTilt = isRose ? 0.08 + layerFrac * 0.16 : 0.16 + layerFrac * 0.24;
    const openTilt = isLotus
      ? 0.28 + layerFrac * 0.8 + spec.openExtra
      : isDaisy
      ? 0.92 + layerFrac * 0.36 + spec.openExtra
      : isRose
      ? 0.08 + Math.pow(layerFrac, 1.28) * 0.98 + spec.openExtra
      : 0.3 + layerFrac * 0.94 + spec.openExtra;
    const midTilt = closedTilt + (openTilt - closedTilt) * 0.56;

    const uSteps = isDaisy ? 6 : isLotus ? 10 : 12;
    const vSteps = isDaisy ? 15 : 16;

    for (let p = 0; p < petalsInLayer; p++) {
      const baseTheta = isRose
        ? ((p + layer * 0.38) / petalsInLayer) * Math.PI * 2 + layer * 0.62
        : ((p + (layer % 2) * 0.5) / petalsInLayer) * Math.PI * 2 + layer * 0.41;

      for (let iv = 1; iv <= vSteps; iv++) {
        const v = iv / vSteps;
        // Species-distinct petal width profiles
        const widthProfile = isRose
          ? Math.sin(Math.pow(v, 0.5) * Math.PI) * (0.95 + 0.15 * v) * (1 - 0.1 * Math.pow(v, 5))
          : isLotus
          ? Math.sin(Math.pow(v, 0.78) * Math.PI) * Math.pow(Math.max(0.05, 1 - v * 0.62), 0.45)
          : isDaisy
          ? Math.sin(Math.pow(v, 0.72) * Math.PI) * (0.85 - 0.15 * v)
          : Math.sin(Math.pow(v, 0.58) * Math.PI) * (1 - 0.08 * v);

        for (let iu = 0; iu <= uSteps; iu++) {
          const u = (iu / uSteps) * 2 - 1; // -1 .. 1

          const evalPetal = (tilt: number, scaleMult: number, curlMult: number) => {
            const len = petalLen * scaleMult;
            const w = petalWidth * widthProfile * scaleMult;
            // Cupping + central keel (lotus) + recurved lip (rose) + ruffled edge (peony)
            const cup = isLotus
              ? (1 - Math.abs(u)) * 0.065 * spec.scale * (0.4 + 0.6 * v)
              : (1 - u * u) * (isRose ? 0.058 : 0.045) * spec.scale * (0.4 + 0.6 * v);
            const tipCurl = isRose
              ? Math.pow(v, 2.55) * (0.38 + layerFrac * 0.24) * curlMult
              : isDaisy
              ? Math.pow(v, 2.0) * 0.18 * curlMult
              : Math.pow(v, 2.3) * 0.26 * curlMult;
            const ruffle =
              spec.style === 'peony'
                ? Math.sin(u * Math.PI * 2.4 + layer * 1.7 + p) * 0.024 * v * curlMult
                : isRose
                ? (Math.sin(u * Math.PI * 1.2 + layer * 0.9 + p) * 0.01 -
                    Math.exp(-u * u * 18) * 0.012 * Math.pow(v, 3)) *
                  v *
                  curlMult
                : 0;

            const angle = tilt + tipCurl;
            const radialOffset =
              (isRose ? 0.02 : isDaisy ? 0.075 : 0.03) *
              spec.scale *
              (0.35 + layerFrac * 1.15) *
              scaleMult;
            const rDist = radialOffset + v * len * Math.sin(angle) + cup + ruffle;
            const hDist =
              v * len * Math.cos(angle) +
              (isRose ? (1 - layerFrac) * 0.055 : layerFrac * 0.015) * spec.scale;
            const tang = u * w;

            const cosT = Math.cos(baseTheta);
            const sinT = Math.sin(baseTheta);
            const lx = rDist * cosT - tang * sinT;
            const lz = rDist * sinT + tang * cosT;
            const ly = hDist;

            // Approximate outward-facing petal surface normal
            const nxLocal = Math.cos(angle) * cosT - u * 0.42 * sinT;
            const nzLocal = Math.cos(angle) * sinT + u * 0.42 * cosT;
            const nyLocal = Math.sin(angle) + 0.35;

            return {
              lx,
              ly,
              lz,
              norm: normalize(toWorld(nxLocal, nyLocal, nzLocal, { x: 0, y: 0, z: 0 })),
            };
          };

          const cE = evalPetal(closedTilt, 0.24, 0.04);
          const mE = evalPetal(midTilt, 0.72, 0.62);
          const oE = evalPetal(openTilt, 1.0, 1.0);

          const cPos = toWorld(cE.lx, cE.ly, cE.lz, closedCenter);
          const mPos = toWorld(mE.lx, mE.ly, mE.lz, midCenter);
          const oPos = toWorld(oE.lx, oE.ly, oE.lz, spec.center);

          const phase = baseTheta + flowerIndex * 1.1 + v * 1.5;
          const amp = (0.008 + 0.022 * v * (0.3 + layerFrac)) * spec.scale;

          const pointHueSeed = spec.isWhite
            ? spec.hueSeed + layerFrac * 0.14 + Math.abs(u) * 0.02
            : spec.hueSeed + layerFrac * 0.14 + u * 0.04;

          const cupDepthVal = Math.min(1, 0.16 + layerFrac * 0.48 + v * 0.36);
          const edgeU = Math.pow(Math.abs(u), 3.0);
          const edgeV = Math.pow(v, 4.2) * 0.95;
          const petalEdgeVal = Math.min(1, Math.max(edgeU, edgeV));

          pushPoint(
            b,
            cPos,
            mPos,
            oPos,
            cE.norm,
            oE.norm,
            petalKind,
            pointHueSeed,
            phase,
            amp,
            cupDepthVal,
            petalEdgeVal
          );
        }
      }
    }
  }

  // 5-pointed green sepal calyx framing the base of each flower to separate adjacent blooms
  const sepalCount = 5;
  for (let sp = 0; sp < sepalCount; sp++) {
    const sTheta = (sp / sepalCount) * Math.PI * 2 + flowerIndex * 0.45;
    const cosS = Math.cos(sTheta);
    const sinS = Math.sin(sTheta);
    for (let iv = 1; iv <= 7; iv++) {
      const v = iv / 7;
      const sw = (1 - v) * 0.042 * spec.scale;
      for (let iu = -2; iu <= 2; iu++) {
        const u = iu / 2;
        const sr = (0.04 + v * 0.14) * spec.scale;
        const sy = (-0.018 - v * v * 0.045) * spec.scale;
        const lx = sr * cosS - u * sw * sinS;
        const lz = sr * sinS + u * sw * cosS;
        const oP = toWorld(lx, sy, lz, spec.center);
        const mP = toWorld(lx * 0.65, sy * 0.7, lz * 0.65, midCenter);
        const cP = toWorld(lx * 0.25, sy * 0.4, lz * 0.25, closedCenter);
        const norm = normalize(toWorld(cosS * 0.5, -0.5, sinS * 0.5, { x: 0, y: 0, z: 0 }));
        pushPoint(
          b,
          cP,
          mP,
          oP,
          norm,
          norm,
          SurfaceKind.Leaf,
          0.26 + v * 0.08,
          sTheta + flowerIndex,
          0.005,
          0.5 + v * 0.5,
          Math.abs(u) * 0.6
        );
      }
    }
  }

  // Curved 3D Stem connecting vase interior/neck to flower base
  const stemStart: Vec3 = {
    x: -spec.center.x * 0.15,
    y: -0.58,
    z: -spec.center.z * 0.15,
  };
  const stemCtrlClosed: Vec3 = {
    x: closedCenter.x * 0.35,
    y: -0.28,
    z: closedCenter.z * 0.35,
  };
  const stemCtrlMid: Vec3 = {
    x: midCenter.x * 0.35,
    y: 0.12,
    z: midCenter.z * 0.35,
  };
  const stemCtrlOpen: Vec3 = {
    x: spec.center.x * 0.38,
    y: 0.15,
    z: spec.center.z * 0.38,
  };

  const stemSteps = 22;
  const stemRing = 5;
  for (let i = 0; i <= stemSteps; i++) {
    const t = i / stemSteps;
    const evalBez = (p0: Vec3, p1: Vec3, p2: Vec3): Vec3 => {
      const mt = 1 - t;
      return {
        x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
        y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
        z: mt * mt * p0.z + 2 * mt * t * p1.z + t * t * p2.z,
      };
    };
    const cBase = evalBez(stemStart, stemCtrlClosed, closedCenter);
    const mBase = evalBez(stemStart, stemCtrlMid, midCenter);
    const oBase = evalBez(stemStart, stemCtrlOpen, spec.center);

    for (let j = 0; j < stemRing; j++) {
      const a = (j / stemRing) * Math.PI * 2;
      const rad = 0.021 * (1 - 0.25 * t);
      const ox = Math.cos(a) * rad;
      const oz = Math.sin(a) * rad;
      const norm = normalize({ x: Math.cos(a), y: 0.15, z: Math.sin(a) });
      pushPoint(
        b,
        { x: cBase.x + ox, y: cBase.y, z: cBase.z + oz },
        { x: mBase.x + ox, y: mBase.y, z: mBase.z + oz },
        { x: oBase.x + ox, y: oBase.y, z: oBase.z + oz },
        norm,
        norm,
        SurfaceKind.Stem,
        0.34,
        t * 2 + flowerIndex,
        0.006 * t
      );
    }
  }
}

function addLeaf(
  b: DynamicBuilder,
  base: Vec3,
  azimuth: number,
  length: number,
  width: number,
  pitchOpen: number,
  idx: number
) {
  const cosA = Math.cos(azimuth);
  const sinA = Math.sin(azimuth);

  // Start every leaf tucked inside the vase neck at bloom=0 so foliage grows concurrently with stems & flowers
  const closedBase: Vec3 = {
    x: base.x * 0.2,
    y: -0.25,
    z: base.z * 0.2,
  };
  const midBase: Vec3 = {
    x: (closedBase.x + base.x) * 0.5,
    y: (closedBase.y + base.y) * 0.5 + 0.04,
    z: (closedBase.z + base.z) * 0.5,
  };

  const uSteps = 7;
  const vSteps = 16;

  for (let iv = 1; iv <= vSteps; iv++) {
    const v = iv / vSteps;
    const leafW = Math.sin(Math.pow(v, 0.62) * Math.PI) * width * (1 - 0.15 * v);

    for (let iu = 0; iu <= uSteps; iu++) {
      const u = (iu / uSteps) * 2 - 1;

      const evalLeaf = (anchor: Vec3, pitch: number, scale: number) => {
        const len = length * scale;
        const w = leafW * scale;
        // Graceful outward arch and downward droop at leaf tip
        const archY = Math.sin(pitch) * v * len - Math.pow(v, 2.2) * 0.22 * len;
        const archR = Math.cos(pitch) * v * len + 0.04 * scale;
        const fold = Math.abs(u) * 0.035 * scale * (1 - v * 0.4);

        const lx = archR * cosA - u * w * sinA;
        const lz = archR * sinA + u * w * cosA;
        const ly = archY + fold;

        const norm = normalize({
          x: cosA * 0.35 - u * 0.3 * sinA,
          y: 0.85,
          z: sinA * 0.35 + u * 0.3 * cosA,
        });
        return {
          pos: { x: anchor.x + lx, y: anchor.y + ly, z: anchor.z + lz },
          norm,
        };
      };

      const cL = evalLeaf(closedBase, 1.36, 0.22);
      const mL = evalLeaf(midBase, (1.36 + pitchOpen) * 0.5, 0.68);
      const oL = evalLeaf(base, pitchOpen, 1.0);

      pushPoint(
        b,
        cL.pos,
        mL.pos,
        oL.pos,
        cL.norm,
        oL.norm,
        SurfaceKind.Leaf,
        0.32 + v * 0.08 + u * 0.03,
        azimuth + idx * 0.7,
        0.015 * v,
        0.52 + 0.48 * v,
        Math.pow(Math.abs(u), 2.2)
      );
    }
  }
}

function getPresetSpecs(preset: BouquetPreset): FlowerSpec[] {
  if (preset === 'lotus') {
    return [
      {
        center: { x: 0, y: 0.88, z: 0 },
        dir: { x: 0.03, y: 1, z: 0.02 },
        scale: 1.46,
        layers: 5,
        petalsBase: 6,
        petalRoundness: 0.75,
        hueSeed: 0.88,
        openExtra: 0.14,
        style: 'lotus',
      },
      // Inner 5 lotus blooms
      ...Array.from({ length: 5 }, (_, i) => {
        const a = (i / 5) * Math.PI * 2 + 0.2;
        const r = 0.56;
        return {
          center: { x: Math.cos(a) * r, y: 0.54 + (i % 2) * 0.09, z: Math.sin(a) * r },
          dir: { x: Math.cos(a) * 0.65, y: 0.85, z: Math.sin(a) * 0.65 },
          scale: 1.12,
          layers: 4,
          petalsBase: 6,
          petalRoundness: 0.75,
          hueSeed: 0.52 + i * 0.09,
          openExtra: 0.12,
          style: 'lotus' as const,
        };
      }),
      // Outer 6 lotus & water buds
      ...Array.from({ length: 6 }, (_, i) => {
        const a = (i / 6) * Math.PI * 2 + 0.55;
        const r = 0.9;
        return {
          center: { x: Math.cos(a) * r, y: 0.24 + (i % 2) * 0.08, z: Math.sin(a) * r },
          dir: { x: Math.cos(a) * 0.95, y: 0.55, z: Math.sin(a) * 0.95 },
          scale: 0.96,
          layers: 4,
          petalsBase: 5,
          petalRoundness: 0.75,
          hueSeed: 0.05 + i * 0.12,
          openExtra: 0.08,
          style: 'lotus' as const,
        };
      }),
    ];
  }

  if (preset === 'roses') {
    // Multi-shaded White Roses bouquet: Snow, Warm Ivory, Porcelain Pearl, and Bridal Alabaster
    const whiteShades = [0.02, 0.27, 0.52, 0.77];
    return [
      {
        center: { x: 0.02, y: 0.92, z: -0.02 },
        dir: { x: 0.04, y: 1, z: -0.03 },
        scale: 1.4,
        layers: 6,
        petalsBase: 4,
        petalRoundness: 1,
        hueSeed: 0.02, // Crisp Snow White center hero rose
        openExtra: 0.1,
        style: 'rose',
        isWhite: true,
      },
      ...Array.from({ length: 5 }, (_, i) => {
        const a = (i / 5) * Math.PI * 2 + 0.28;
        const r = 0.62 + (i % 2) * 0.08;
        const y = 0.58 + (i % 2 === 0 ? 0.1 : -0.04);
        return {
          center: { x: Math.cos(a) * r, y, z: Math.sin(a) * r },
          dir: { x: Math.cos(a) * 0.72, y: 0.82, z: Math.sin(a) * 0.72 },
          scale: 1.18 - (i % 2) * 0.08,
          layers: 6,
          petalsBase: 4,
          petalRoundness: 1,
          hueSeed: whiteShades[(i + 1) % whiteShades.length],
          openExtra: 0.08,
          style: 'rose' as const,
          isWhite: true,
        };
      }),
      ...Array.from({ length: 6 }, (_, i) => {
        const a = (i / 6) * Math.PI * 2 + 0.65;
        const r = 0.96 + (i % 2) * 0.08;
        const y = 0.2 + (i % 2) * 0.09;
        return {
          center: { x: Math.cos(a) * r, y, z: Math.sin(a) * r },
          dir: { x: Math.cos(a) * 0.98, y: 0.48, z: Math.sin(a) * 0.98 },
          scale: 1.08,
          layers: 5,
          petalsBase: 4,
          petalRoundness: 1,
          hueSeed: whiteShades[(i + 2) % whiteShades.length],
          openExtra: 0.06,
          style: 'rose' as const,
          isWhite: true,
        };
      }),
      {
        center: { x: -0.4, y: 0.95, z: 0.38 },
        dir: { x: -0.48, y: 0.9, z: 0.44 },
        scale: 0.9,
        layers: 5,
        petalsBase: 3,
        petalRoundness: 1,
        hueSeed: 0.27, // Warm Ivory bud
        openExtra: -0.02,
        style: 'rose',
        isWhite: true,
      },
      {
        center: { x: 0.46, y: 0.93, z: -0.3 },
        dir: { x: 0.52, y: 0.9, z: -0.34 },
        scale: 0.88,
        layers: 5,
        petalsBase: 3,
        petalRoundness: 1,
        hueSeed: 0.52, // Porcelain Pearl bud
        openExtra: -0.02,
        style: 'rose',
        isWhite: true,
      },
    ];
  }

  if (preset === 'wildflower') {
    const whiteShades = [0.02, 0.27, 0.52, 0.77];
    return [
      {
        center: { x: 0, y: 0.98, z: 0 },
        dir: { x: 0.05, y: 1, z: 0.03 },
        scale: 1.32,
        layers: 2,
        petalsBase: 14,
        petalRoundness: 0.6,
        hueSeed: 0.92,
        openExtra: 0.14,
        style: 'daisy',
      },
      ...Array.from({ length: 6 }, (_, i) => {
        const a = (i / 6) * Math.PI * 2 + 0.15;
        const r = 0.6 + (i % 2) * 0.12;
        const isWhiteRose = i === 1 || i === 4;
        return {
          center: { x: Math.cos(a) * r, y: 0.62 + (i % 3) * 0.12, z: Math.sin(a) * r },
          dir: { x: Math.cos(a) * 0.75, y: 0.76, z: Math.sin(a) * 0.75 },
          scale: isWhiteRose ? 1.14 : 1.08,
          layers: isWhiteRose ? 6 : 2,
          petalsBase: isWhiteRose ? 4 : 13,
          petalRoundness: isWhiteRose ? 1 : 0.6,
          hueSeed: isWhiteRose ? whiteShades[i % whiteShades.length] : (i * 0.16 + 0.12) % 1,
          openExtra: isWhiteRose ? 0.08 : 0.12,
          style: isWhiteRose ? ('rose' as const) : ('daisy' as const),
          isWhite: isWhiteRose,
        };
      }),
      ...Array.from({ length: 7 }, (_, i) => {
        const a = (i / 7) * Math.PI * 2 + 0.6;
        const r = 0.94 + (i % 2) * 0.1;
        const isWhiteRose = i === 0 || i === 3;
        return {
          center: { x: Math.cos(a) * r, y: 0.24 + (i % 2) * 0.1, z: Math.sin(a) * r },
          dir: { x: Math.cos(a) * 1.0, y: 0.46, z: Math.sin(a) * 1.0 },
          scale: isWhiteRose ? 1.04 : 0.98,
          layers: isWhiteRose ? 5 : i % 2 === 0 ? 5 : 2,
          petalsBase: isWhiteRose ? 4 : i % 2 === 0 ? 4 : 12,
          petalRoundness: 0.8,
          hueSeed: isWhiteRose ? whiteShades[(i + 2) % whiteShades.length] : (i * 0.14 + 0.48) % 1,
          openExtra: 0.1,
          style: isWhiteRose ? ('rose' as const) : i % 2 === 0 ? ('peony' as const) : ('daisy' as const),
          isWhite: isWhiteRose,
        };
      }),
    ];
  }

  // Default: 'peony' — lush dome bouquet mixing crimson/coral peonies with rich purple peonies
  const purpleShades = [0.06, 0.34, 0.64, 0.92];
  return [
    // Center crown hero peony
    {
      center: { x: 0.03, y: 0.9, z: -0.02 },
      dir: { x: 0.05, y: 1, z: -0.04 },
      scale: 1.4,
      layers: 5,
      petalsBase: 4,
      petalRoundness: 1,
      hueSeed: 0.94,
      openExtra: 0.14,
      style: 'peony',
    },
    // Upper ring (crimson/coral peonies + royal violet & amethyst purple peonies)
    ...Array.from({ length: 5 }, (_, i) => {
      const a = (i / 5) * Math.PI * 2 + 0.28;
      const r = 0.61 + (i % 2) * 0.08;
      const y = 0.58 + (i % 2 === 0 ? 0.1 : -0.04);
      const isPurplePeony = i === 1 || i === 3;
      return {
        center: { x: Math.cos(a) * r, y, z: Math.sin(a) * r },
        dir: { x: Math.cos(a) * 0.72, y: 0.82, z: Math.sin(a) * 0.72 },
        scale: isPurplePeony ? 1.22 : 1.14 - (i % 2) * 0.06,
        layers: 5,
        petalsBase: 4,
        petalRoundness: 1,
        hueSeed: isPurplePeony ? (i === 1 ? 0.12 : 0.58) : (0.04 + i * 0.19) % 1,
        openExtra: 0.12,
        style: 'peony' as const,
        isPurple: isPurplePeony,
      };
    }),
    // Lower billowing perimeter ring (peonies + iris, orchid & plum purple peonies)
    ...Array.from({ length: 6 }, (_, i) => {
      const a = (i / 6) * Math.PI * 2 + 0.65;
      const r = 0.95 + (i % 2) * 0.08;
      const y = 0.2 + (i % 2) * 0.09;
      const isPurplePeony = i === 0 || i === 2 || i === 4;
      return {
        center: { x: Math.cos(a) * r, y, z: Math.sin(a) * r },
        dir: { x: Math.cos(a) * 0.98, y: 0.48, z: Math.sin(a) * 0.98 },
        scale: isPurplePeony ? 1.1 : 1.05,
        layers: 4,
        petalsBase: 4,
        petalRoundness: 1,
        hueSeed: isPurplePeony
          ? purpleShades[(i / 2 + 1) % purpleShades.length]
          : (0.14 + i * 0.16) % 1,
        openExtra: 0.09,
        style: 'peony' as const,
        isPurple: isPurplePeony,
      };
    }),
    // Upper-side accent purple peony bud (front-left) & coral peony bud (back-right)
    {
      center: { x: -0.4, y: 0.95, z: 0.38 },
      dir: { x: -0.48, y: 0.9, z: 0.44 },
      scale: 0.92,
      layers: 5,
      petalsBase: 3,
      petalRoundness: 1,
      hueSeed: 0.38,
      openExtra: -0.02,
      style: 'peony',
      isPurple: true,
    },
    {
      center: { x: 0.46, y: 0.93, z: -0.3 },
      dir: { x: 0.52, y: 0.9, z: -0.34 },
      scale: 0.82,
      layers: 4,
      petalsBase: 3,
      petalRoundness: 1,
      hueSeed: 0.56,
      openExtra: -0.02,
      style: 'peony',
    },
  ];
}

export function generateBouquetBuffer(preset: BouquetPreset): BouquetBuffer {
  const seed =
    preset === 'peony' ? 4219 : preset === 'lotus' ? 7731 : preset === 'roses' ? 5897 : 9013;
  const rand = mulberry32(seed);
  const builder = createBuilder();

  // 1. Sculpted Vase
  addVase(builder);

  // 2. Flowers & Stems
  const flowers = getPresetSpecs(preset);
  flowers.forEach((f, idx) => addFlower(builder, f, idx));

  // 3. Foliage Leaves radiating around the vase collar and tucked between blooms for crisp visual separation
  const collarLeafCount = 12;
  for (let i = 0; i < collarLeafCount; i++) {
    const az = (i / collarLeafCount) * Math.PI * 2 + 0.18 + (rand() - 0.5) * 0.15;
    const collarR = 0.24 + (i % 2) * 0.08;
    const base: Vec3 = {
      x: Math.cos(az) * collarR,
      y: -0.18 + (i % 3) * 0.1,
      z: Math.sin(az) * collarR,
    };
    addLeaf(
      builder,
      base,
      az,
      0.56 + (i % 3) * 0.12,
      0.13 + (i % 2) * 0.03,
      0.24 + (i % 3) * 0.18,
      i
    );
  }

  // Mid-crown foliage leaves tucked between upper and lower rings to frame individual flowers
  const midLeafCount = 8;
  for (let i = 0; i < midLeafCount; i++) {
    const az = (i / midLeafCount) * Math.PI * 2 + 0.42;
    const midR = 0.44 + (i % 2) * 0.1;
    const base: Vec3 = {
      x: Math.cos(az) * midR,
      y: 0.28 + (i % 3) * 0.12,
      z: Math.sin(az) * midR,
    };
    addLeaf(
      builder,
      base,
      az,
      0.38 + (i % 2) * 0.08,
      0.095 + (i % 2) * 0.02,
      0.46 + (i % 2) * 0.18,
      collarLeafCount + i
    );
  }

  return {
    count: builder.kind.length,
    closedPos: new Float32Array(builder.closedPos),
    midPos: new Float32Array(builder.midPos),
    openPos: new Float32Array(builder.openPos),
    closedNorm: new Float32Array(builder.closedNorm),
    openNorm: new Float32Array(builder.openNorm),
    kind: new Uint8Array(builder.kind),
    hueSeed: new Float32Array(builder.hueSeed),
    swayPhase: new Float32Array(builder.swayPhase),
    swayAmp: new Float32Array(builder.swayAmp),
    cupDepth: new Float32Array(builder.cupDepth),
    petalEdge: new Float32Array(builder.petalEdge),
    petalIndices: new Uint32Array(builder.petalIndices),
  };
}
