const palette = {
  bg: "#f6f5f2",
  parasite: "#00ff66",
  grid: "rgba(17,17,17,0.05)",
  spores: "rgba(0,255,102,0.22)"
};

const settings = {
  text: "PARASITE",
  fontFamily: "IBM Plex Sans",
  colorway: "acid",
  customColor: "#00ff66",
  infection: 68,
  growth: 54,
  mutation: 36,
  generation: 4,
  resistance: 48,
  species: "hybrid"
};

const state = {
  maskCanvas: null,
  maskCtx: null,
  maskData: null,
  hybridBuffer: null,
  hybridBlurBuffer: null,
  bbox: null,
  interiorNodes: [],
  edgeNodes: [],
  attractors: [],
  bridgePairs: [],
  sampleStep: 10,
  manualSeeds: [],
  excisions: [],
  parasites: [],
  ready: false,
  pressing: false,
  pressAt: 0,
  pressPoint: null,
  dragAdded: false,
  hostOffset: { x: 0, y: 0 },
  isComposing: false,
  rebuildTimer: null,
  rebuildToken: 0,
  growthStartMs: 0,
  playLoop: true,
  loopDurationMs: 15000,
  lastLoopTick: 0
};

const dom = {};

function setStatus(text) {
  if (dom.status) dom.status.innerHTML = text;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mapRange(value, inMin, inMax, outMin, outMax) {
  if (inMin === inMax) return outMin;
  const t = (value - inMin) / (inMax - inMin);
  return outMin + (outMax - outMin) * t;
}

function randomJitter(scale) {
  return (Math.random() - 0.5) * scale;
}

function distSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function normalize(x, y) {
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}

function angleToVec(angle) {
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function vecToAngle(vec) {
  return Math.atan2(vec.y, vec.x);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpPoint(a, b, t) {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

function normalizeHostText(value) {
  return value
    .replace(/\r/g, "")
    .split("\n")
    .slice(0, 3)
    .map((line) => line.toUpperCase().slice(0, 14))
    .join("\n")
    .slice(0, 42);
}

function activePalette() {
  const palettes = {
    acid: { stroke: [0, 184, 84], pulse: [0, 255, 170], spores: [0, 184, 84], residue: [0, 92, 54], ui: "#00b854" },
    cobalt: { stroke: [25, 82, 220], pulse: [110, 205, 255], spores: [25, 82, 220], residue: [26, 52, 132], ui: "#1952dc" },
    ember: { stroke: [214, 64, 36], pulse: [255, 174, 92], spores: [214, 64, 36], residue: [120, 44, 30], ui: "#d64024" },
    mono: { stroke: [32, 32, 32], pulse: [110, 110, 110], spores: [32, 32, 32], residue: [96, 96, 96], ui: "#202020" }
  };
  if (settings.colorway === "custom") {
    const rgb = hexToRgb(settings.customColor);
    return {
      stroke: [rgb.r, rgb.g, rgb.b],
      pulse: [
        clamp(rgb.r + 48, 0, 255),
        clamp(rgb.g + 48, 0, 255),
        clamp(rgb.b + 48, 0, 255)
      ],
      spores: [rgb.r, rgb.g, rgb.b],
      residue: [
        Math.round(rgb.r * 0.42),
        Math.round(rgb.g * 0.42),
        Math.round(rgb.b * 0.42)
      ],
      ui: settings.customColor
    };
  }
  return palettes[settings.colorway] || palettes.acid;
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const value = clean.length === 3
    ? clean.split("").map((ch) => ch + ch).join("")
    : clean;
  const num = parseInt(value, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255
  };
}

function snapAngle(angle, step) {
  return Math.round(angle / step) * step;
}

function ensureMaskCanvas() {
  if (!state.maskCanvas) {
    state.maskCanvas = document.createElement("canvas");
    state.maskCtx = state.maskCanvas.getContext("2d", { willReadFrequently: true });
  }
}

function alphaAt(x, y) {
  if (!state.maskData) return 0;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= state.maskCanvas.width || iy >= state.maskCanvas.height) return 0;
  return state.maskData[(iy * state.maskCanvas.width + ix) * 4 + 3];
}

function insideMask(x, y) {
  return alphaAt(x, y) > 20;
}

function edgeStrength(x, y) {
  const center = insideMask(x, y) ? 1 : 0;
  let sum = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (!ox && !oy) continue;
      sum += insideMask(x + ox * 3, y + oy * 3) ? 1 : 0;
    }
  }
  return center ? 8 - sum : 0;
}

function nearestNode(point, list, maxDist) {
  let best = null;
  let bestScore = maxDist * maxDist;
  for (const node of list) {
    const d = distSq(point, node);
    if (d < bestScore) {
      bestScore = d;
      best = node;
    }
  }
  return best;
}

function clusterSampledNodes(nodes, threshold) {
  const clusters = [];
  const visited = new Set();
  const thresholdSq = threshold * threshold;
  for (let i = 0; i < nodes.length; i++) {
    if (visited.has(i)) continue;
    const stack = [i];
    const cluster = [];
    visited.add(i);
    while (stack.length) {
      const idx = stack.pop();
      const node = nodes[idx];
      cluster.push(node);
      for (let j = 0; j < nodes.length; j++) {
        if (visited.has(j)) continue;
        if (distSq(node, nodes[j]) <= thresholdSq) {
          visited.add(j);
          stack.push(j);
        }
      }
    }
    if (cluster.length) clusters.push(cluster);
  }
  return clusters;
}

function deriveBridgePairs(edgeNodes, sampleStep) {
  const clusters = clusterSampledNodes(edgeNodes, sampleStep * 1.9).filter((cluster) => cluster.length > 4);
  const bridges = [];
  const maxBridgeDist = sampleStep * 14;
  const minBridgeDist = sampleStep * 3;
  for (let i = 0; i < clusters.length; i++) {
    let best = null;
    for (let j = i + 1; j < clusters.length; j++) {
      for (const a of clusters[i]) {
        for (const b of clusters[j]) {
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < minBridgeDist || d > maxBridgeDist) continue;
          if (!best || d < best.dist) {
            best = { start: a, end: b, dist: d };
          }
        }
      }
    }
    if (best) bridges.push(best);
  }
  return bridges.slice(0, 8);
}

function buildMask() {
  ensureMaskCanvas();
  const holder = document.getElementById("canvas-holder");
  const w = holder.clientWidth;
  const h = holder.clientHeight;
  state.maskCanvas.width = w;
  state.maskCanvas.height = h;

  const ctx = state.maskCtx;
  ctx.clearRect(0, 0, w, h);

  const lines = settings.text.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 3);
  const textLines = lines.length ? lines : ["HOST"];
  let fontSize = Math.min(w * 0.2, h * 0.32);
  const lineHeightFactor = 0.84;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let i = 0; i < 10; i++) {
    ctx.font = `700 ${fontSize}px "${settings.fontFamily}"`;
    let maxLineWidth = 1;
    let maxLineHeight = 1;
    for (const line of textLines) {
      const metrics = ctx.measureText(line);
      maxLineWidth = Math.max(maxLineWidth, metrics.width);
      maxLineHeight = Math.max(maxLineHeight, metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent);
    }
    const widthScale = (w * 0.76) / maxLineWidth;
    const totalHeight = maxLineHeight * (1 + (textLines.length - 1) * lineHeightFactor);
    const heightScale = (h * 0.5) / Math.max(totalHeight, 1);
    const scale = Math.min(widthScale, heightScale);
    fontSize *= scale;
    if (Math.abs(1 - scale) < 0.03) break;
  }

  ctx.fillStyle = "#000";
  ctx.font = `700 ${fontSize}px "${settings.fontFamily}"`;
  const blockHeight = fontSize * (1 + (textLines.length - 1) * lineHeightFactor);
  const startY = h * 0.53 - blockHeight * 0.5 + fontSize * 0.5;
  textLines.forEach((line, index) => {
    ctx.fillText(line, w * 0.5, startY + index * fontSize * lineHeightFactor);
  });

  const image = ctx.getImageData(0, 0, w, h);
  state.maskData = image.data;

  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  const interior = [];
  const edge = [];
  const attractors = [];
  const sampleTarget = clamp(Math.floor((textLines.join("").length || 1) / 10) + textLines.length, 1, 5);
  const step = 4 + sampleTarget * 2;
  const attractorStep = step * 2;

  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (!insideMask(x, y)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      const edgeValue = edgeStrength(x, y);
      const node = { x, y };
      interior.push(node);
      if (edgeValue > 0) edge.push(node);
      if (x % attractorStep === 0 && y % attractorStep === 0) {
        attractors.push(node);
      }
    }
  }

  state.bbox = {
    x1: minX,
    y1: minY,
    x2: maxX,
    y2: maxY
  };
  state.sampleStep = step;
  state.interiorNodes = interior;
  state.edgeNodes = edge;
  state.attractors = attractors;
  state.bridgePairs = deriveBridgePairs(edge, step);
  state.manualSeeds = [];
  state.excisions = [];
  state.ready = interior.length > 0;
}

function fontReady(fontFamily) {
  if (!document.fonts || !document.fonts.load) return Promise.resolve();
  return document.fonts.load(`700 160px "${fontFamily}"`);
}

function makeSeed(point, inherited = false, force = 1) {
  const edge = nearestNode(point, state.edgeNodes, 120);
  const baseDir = edge ? normalize(point.x - edge.x, point.y - edge.y) : angleToVec(Math.random() * Math.PI * 2);
  const angle = settings.species === "hybrid"
    ? vecToAngle({ x: -baseDir.y, y: baseDir.x }) + randomJitter(0.35)
    : vecToAngle(baseDir) + randomJitter(1.2);
  return {
    x: point.x,
    y: point.y,
    angle,
    force,
    inherited
  };
}

function overflowAllowance() {
  return mapRange(settings.resistance, 0, 100, 24, 8);
}

function canOccupy(x, y, outsideBudget) {
  if (insideMask(x, y)) return { ok: true, outside: false };
  if (outsideBudget <= 0 || !state.edgeNodes.length) return { ok: false, outside: true };
  const edge = nearestNode({ x, y }, state.edgeNodes, outsideBudget);
  return { ok: Boolean(edge), outside: true };
}

function sampleBaseSeeds() {
  const count = settings.species === "hybrid"
    ? Math.round(mapRange(settings.infection, 0, 100, 10, 42))
    : Math.round(mapRange(settings.infection, 0, 100, 24, 200));
  const seeds = [];
  if (!state.interiorNodes.length) return seeds;
  for (let i = 0; i < count; i++) {
    const useEdge = settings.species === "hybrid" ? true : Math.random() < mapRange(settings.resistance, 0, 100, 0.2, 0.7);
    const source = useEdge && state.edgeNodes.length ? state.edgeNodes : state.interiorNodes;
    const node = source[Math.floor(Math.random() * source.length)];
    seeds.push(makeSeed(node, false, settings.species === "hybrid" ? 0.92 : 1));
  }
  return seeds;
}

function branchBlocked(branch) {
  if (!state.excisions.length) return false;
  for (const cut of state.excisions) {
    const r2 = cut.radius * cut.radius;
    for (const pt of branch.points) {
      const dx = pt.x - cut.x;
      const dy = pt.y - cut.y;
      if (dx * dx + dy * dy <= r2) return true;
    }
  }
  return false;
}

function averageAttractorDirection(point, radius) {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  const r2 = radius * radius;
  for (const attractor of state.attractors) {
    const dx = attractor.x - point.x;
    const dy = attractor.y - point.y;
    const d2 = dx * dx + dy * dy;
    if (d2 === 0 || d2 > r2) continue;
    const influence = 1 - d2 / r2;
    const dir = normalize(dx, dy);
    sumX += dir.x * influence;
    sumY += dir.y * influence;
    count += 1;
  }
  if (!count) return null;
  return normalize(sumX, sumY);
}

function steerInside(point, angle, resistance) {
  const tries = [
    angle,
    angle + 0.18,
    angle - 0.18,
    angle + 0.42,
    angle - 0.42,
    angle + Math.PI * 0.5,
    angle - Math.PI * 0.5
  ];

  const edge = nearestNode(point, state.edgeNodes, 70);
  const edgeAngle = edge ? vecToAngle(normalize(edge.x - point.x, edge.y - point.y)) + Math.PI * 0.5 : angle;
  for (let i = 0; i < tries.length; i++) {
    tries[i] = lerp(tries[i], edgeAngle, resistance * 0.18);
  }
  return tries;
}

function computeBranchMetrics(points, branch) {
  const lengths = [0];
  let totalLength = 0;
  for (let i = 1; i < points.length; i++) {
    totalLength += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    lengths.push(totalLength);
  }
  branch.lengths = lengths;
  branch.totalLength = totalLength;
  branch.pulseSpeed = mapRange(settings.growth, 0, 100, 16, 42) + Math.random() * 8;
  branch.pulseSpan = mapRange(settings.infection, 0, 100, 16, 42);
  branch.revealDelay = branch.generation * mapRange(settings.resistance, 0, 100, 180, 360) + Math.random() * 220;
  branch.revealDuration = mapRange(settings.growth, 0, 100, 900, 280) + branch.totalLength * mapRange(settings.infection, 0, 100, 4, 10);
  branch.pressure = clamp(mapRange(branch.revealDuration, 1100, 260, 1.22, 0.78), 0.72, 1.28);
  branch.decayDelay = branch.revealDelay + branch.revealDuration + mapRange(settings.resistance, 0, 100, 1200, 2600);
  branch.decayDuration = mapRange(settings.mutation, 0, 100, 3800, 1600);
  branch.deposits = branch.deposits || [];
  return branch;
}

function cumulativeLengths(points) {
  const lengths = [0];
  let totalLength = 0;
  for (let i = 1; i < points.length; i++) {
    totalLength += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    lengths.push(totalLength);
  }
  return { lengths, totalLength };
}

function pointNormal(points, index) {
  const prev = points[Math.max(0, index - 1)];
  const next = points[Math.min(points.length - 1, index + 1)];
  const tangent = normalize(next.x - prev.x, next.y - prev.y);
  return { x: -tangent.y, y: tangent.x };
}

function branchWidthAt(branch, index, count) {
  const t = count <= 1 ? 0 : index / (count - 1);
  const belly = Math.sin(t * Math.PI);
  const base = mapRange(settings.growth, 0, 100, 6, 22);
  const width = settings.species === "hybrid"
    ? base * (0.42 + belly * 0.9) * branch.pressure
    : base * 0.16;
  return width;
}

function buildRibbonOutline(points, branch, jitterScale = 1) {
  if (!points || points.length < 2) return [];
  const left = [];
  const right = [];
  const seedPhase = branch.motion?.phase || 0;
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const normal = pointNormal(points, i);
    const width = branchWidthAt(branch, i, points.length);
    const rag = settings.species === "hybrid"
      ? Math.sin(i * 0.85 + seedPhase * 1.7) * width * 0.14 * jitterScale + randomJitter(width * 0.04) * jitterScale
      : 0;
    left.push({
      x: pt.x + normal.x * (width + rag),
      y: pt.y + normal.y * (width + rag)
    });
    right.push({
      x: pt.x - normal.x * (width - rag * 0.45),
      y: pt.y - normal.y * (width - rag * 0.45)
    });
  }
  return [...left, ...right.reverse()];
}

function branchVisibleLength(branch, elapsedMs) {
  const local = elapsedMs - branch.revealDelay;
  if (local <= 0) return 0;
  const t = clamp(local / Math.max(branch.revealDuration, 1), 0, 1);
  return branch.totalLength * (1 - Math.pow(1 - t, 2.2));
}

function branchDecayProgress(branch, elapsedMs) {
  const local = elapsedMs - branch.decayDelay;
  if (local <= 0) return 0;
  return clamp(local / Math.max(branch.decayDuration, 1), 0, 1);
}

function branchRevealProgress(branch, elapsedMs) {
  const local = elapsedMs - branch.revealDelay;
  if (local <= 0) return 0;
  return clamp(local / Math.max(branch.revealDuration, 1), 0, 1);
}

function revealedPoints(branch, visibleLength) {
  if (!branch.points.length || visibleLength <= 0) return [];
  const pts = [branch.points[0]];
  for (let i = 1; i < branch.points.length; i++) {
    const prevLen = branch.lengths[i - 1];
    const len = branch.lengths[i];
    if (visibleLength >= len) {
      pts.push(branch.points[i]);
      continue;
    }
    if (visibleLength > prevLen) {
      const span = len - prevLen || 1;
      const t = (visibleLength - prevLen) / span;
      pts.push(lerpPoint(branch.points[i - 1], branch.points[i], t));
    }
    break;
  }
  return pts;
}

function buildDeposits(points, branch) {
  const deposits = [];
  if (points.length < 3) return deposits;
  const density = settings.species === "hybrid"
    ? mapRange(settings.infection, 0, 100, 0.04, 0.12)
    : mapRange(settings.infection, 0, 100, 0.14, 0.34);
  const spread = settings.species === "hybrid"
    ? mapRange(settings.mutation, 0, 100, 1.4, 4.2)
    : mapRange(settings.mutation, 0, 100, 2.5, 9);
  for (let i = 1; i < points.length - 1; i++) {
    if (Math.random() > density) continue;
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];
    const tangent = normalize(next.x - prev.x, next.y - prev.y);
    const normal = { x: -tangent.y, y: tangent.x };
    const side = Math.random() < 0.5 ? -1 : 1;
    const len = (settings.species === "hybrid"
      ? mapRange(settings.growth, 0, 100, 2, 5.5)
      : mapRange(settings.growth, 0, 100, 3, 11)) * (0.6 + Math.random() * 0.8);
    const offset = (1 + Math.random() * spread) * side;
    const anchor = {
      x: curr.x + normal.x * offset + randomJitter(1.2),
      y: curr.y + normal.y * offset + randomJitter(1.2)
    };
    const tip = {
      x: anchor.x + normal.x * side * len * 0.45 + tangent.x * randomJitter(2.5),
      y: anchor.y + normal.y * side * len * 0.45 + tangent.y * randomJitter(2.5)
    };
    deposits.push({
      anchor,
      tip,
      size: settings.species === "hybrid"
        ? mapRange(settings.growth, 0, 100, 0.35, 0.9)
        : mapRange(settings.growth, 0, 100, 0.6, 1.8),
      jitter: Math.random() * Math.PI * 2,
      revealAt: branch.revealDelay + (branch.totalLength ? branch.lengths[i] / branch.totalLength : 0) * branch.revealDuration
    });
  }
  return deposits;
}

function cumulativePathMetrics(points, closed = false) {
  const pts = closed && points.length ? [...points, points[0]] : points.slice();
  const lengths = [0];
  let totalLength = 0;
  for (let i = 1; i < pts.length; i++) {
    totalLength += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    lengths.push(totalLength);
  }
  return { points: pts, lengths, totalLength };
}

function softInside(x, y, softness = 18) {
  if (insideMask(x, y)) return true;
  const edge = nearestNode({ x, y }, state.edgeNodes, softness);
  return Boolean(edge);
}

function bboxScale() {
  if (!state.bbox) return 1;
  const w = Math.max(1, state.bbox.x2 - state.bbox.x1);
  const h = Math.max(1, state.bbox.y2 - state.bbox.y1);
  return Math.min(w, h) / 220;
}

function wrapAngleDelta(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

function makeCellProfile(tangentAngle, radialNorm = 0, familySeed = Math.random()) {
  const families = [
    {
      name: "frond",
      mode: "frond",
      elongation: [1.08, 1.42],
      cross: [0.74, 0.98],
      directional: [0.16, 0.28],
      pinch: [0.06, 0.16],
      taper: [0.08, 0.18],
      ripple: [0.04, 0.09],
      wobble: [0.14, 0.22],
      asymmetry: [0.05, 0.12],
      sway: [0.1, 0.24]
    },
    {
      name: "blade",
      mode: "blade",
      elongation: [1.16, 1.58],
      cross: [0.62, 0.88],
      directional: [0.22, 0.34],
      pinch: [0.12, 0.22],
      taper: [0.14, 0.24],
      ripple: [0.02, 0.06],
      wobble: [0.08, 0.15],
      asymmetry: [0.08, 0.18],
      sway: [0.16, 0.3]
    },
    {
      name: "kelp",
      mode: "kelp",
      elongation: [0.98, 1.28],
      cross: [0.82, 1.08],
      directional: [0.12, 0.22],
      pinch: [0.08, 0.18],
      taper: [0.04, 0.12],
      ripple: [0.06, 0.12],
      wobble: [0.18, 0.28],
      asymmetry: [0.08, 0.16],
      sway: [0.18, 0.34]
    }
  ];
  const family = families[Math.floor(familySeed * families.length) % families.length];
  const pick = (range) => lerp(range[0], range[1], Math.random());
  const flowBias = tangentAngle + randomJitter(0.38) + (radialNorm - 0.5) * 0.28;
  return {
    family: family.name,
    mode: family.mode,
    majorScale: pick(family.elongation),
    minorScale: pick(family.cross),
    directionalBias: pick(family.directional),
    pinchDepth: pick(family.pinch),
    taperDepth: pick(family.taper),
    rippleAmp: pick(family.ripple),
    lobeAmp: pick(family.wobble),
    asymmetry: pick(family.asymmetry),
    sway: pick(family.sway),
    flowAngle: flowBias,
    tipAngle: flowBias,
    tailAngle: flowBias + Math.PI + randomJitter(0.34),
    pinchAngle: flowBias + (Math.random() < 0.5 ? -1 : 1) * (0.9 + Math.random() * 0.8),
    biasAngle: flowBias + randomJitter(1.4),
    primaryLobes: 2 + Math.floor(Math.random() * 3),
    secondaryLobes: 4 + Math.floor(Math.random() * 4),
    notchWidth: 0.22 + Math.random() * 0.24,
    pinchWidth: 0.26 + Math.random() * 0.28,
    shoulderWidth: 0.34 + Math.random() * 0.3
  };
}

function generateElasticCellPoints(center, tangentAngle, lengthRadius, thicknessRadius, phase, count, profile = null) {
  const points = [];
  const radialTargets = [];
  const shape = profile || makeCellProfile(tangentAngle, 0);
  const baseRadius = (lengthRadius + thicknessRadius) * 0.5;
  const axisRadiusA = lerp(baseRadius, lengthRadius * shape.majorScale, 0.42);
  const axisRadiusB = lerp(baseRadius, thicknessRadius * shape.minorScale, 0.34);
  const lobePhaseA = phase;
  const lobePhaseB = phase * 0.63 + 1.4;
  const lobePhaseC = phase * 1.21 - 0.7;
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const theta = t * Math.PI * 2;
    const tipDelta = wrapAngleDelta(theta, shape.tipAngle);
    const tailDelta = wrapAngleDelta(theta, shape.tailAngle);
    const pinchDelta = wrapAngleDelta(theta, shape.pinchAngle);
    const biasDelta = wrapAngleDelta(theta, shape.biasAngle);
    const front = Math.max(0, Math.cos(tipDelta));
    const back = Math.max(0, Math.cos(tailDelta));
    const side = Math.sin(theta - shape.flowAngle);
    const taper = Math.exp(-(tailDelta * tailDelta) / shape.shoulderWidth) * shape.taperDepth;
    const pinch = Math.exp(-(pinchDelta * pinchDelta) / shape.pinchWidth) * shape.pinchDepth;
    const asym = Math.sin(biasDelta) * shape.asymmetry;
    const lobeA = Math.sin(theta * shape.primaryLobes + lobePhaseA) * shape.lobeAmp;
    const lobeB = Math.sin(theta * shape.secondaryLobes + lobePhaseB) * (shape.lobeAmp * 0.42);
    const lobeC = Math.cos(theta * 2 + lobePhaseC) * (shape.rippleAmp * 0.9);
    const ripple = Math.sin(theta * 7 + phase * 0.8) * shape.rippleAmp;
    let widthBias = 0;
    let lengthBias = 0;
    let verticalSway = 0;

    if (shape.mode === "blade") {
      lengthBias = front * (shape.directionalBias * 1.45) - back * (shape.taperDepth * 0.9);
      widthBias = -front * 0.18 + Math.sin(theta * 2 + phase) * shape.rippleAmp * 0.4;
      verticalSway = side * shape.sway * axisRadiusB * 0.16;
    } else if (shape.mode === "frond") {
      const leaflet = Math.abs(Math.sin(theta * (shape.primaryLobes + 1) + phase * 0.5));
      lengthBias = front * (shape.directionalBias * 1.1) + leaflet * 0.08 - back * (shape.taperDepth * 0.55);
      widthBias = side * shape.sway * 0.08 + Math.sin(theta * 4 + phase) * shape.rippleAmp * 0.75;
      verticalSway = Math.sin(theta * 2 - shape.flowAngle) * axisRadiusB * shape.sway * 0.12;
    } else {
      const paddle = Math.sin(theta * 3 + phase) * shape.lobeAmp * 0.5;
      lengthBias = front * (shape.directionalBias * 0.86) - pinch * 0.2 + paddle;
      widthBias = Math.sin(theta * 2 + phase) * shape.rippleAmp + side * shape.sway * 0.05;
      verticalSway = Math.sin(theta - shape.tipAngle) * axisRadiusB * shape.sway * 0.18;
    }

    const wobble = lobeA + lobeB + lobeC + ripple + asym + lengthBias + widthBias - pinch - taper + randomJitter(0.01);
    const rx = axisRadiusA * (1 + wobble);
    const ry = axisRadiusB * (1 + wobble * 0.64 + widthBias * 0.85);
    const local = {
      x: Math.cos(theta) * rx,
      y: Math.sin(theta) * ry + verticalSway
    };
    const c = Math.cos(tangentAngle);
    const s = Math.sin(tangentAngle);
    points.push({
      x: center.x + local.x * c - local.y * s,
      y: center.y + local.x * s + local.y * c
    });
    radialTargets.push(Math.hypot(local.x, local.y));
  }
  return { points, radialTargets };
}

function relaxElasticPoints(points, center, radialTargets) {
  let current = points;
  for (let iter = 0; iter < 28; iter++) {
    current = current.map((pt, i) => {
      const prev = current[(i - 1 + current.length) % current.length];
      const curr = current[i];
      const nextPt = current[(i + 1) % current.length];
      const avg = { x: (prev.x + nextPt.x) * 0.5, y: (prev.y + nextPt.y) * 0.5 };
      const radial = normalize(curr.x - center.x, curr.y - center.y);
      const target = {
        x: center.x + radial.x * radialTargets[i],
        y: center.y + radial.y * radialTargets[i]
      };
      let candidate = {
        x: lerp(curr.x, avg.x, 0.24),
        y: lerp(curr.y, avg.y, 0.24)
      };
      candidate = {
        x: lerp(candidate.x, target.x, 0.2),
        y: lerp(candidate.y, target.y, 0.2)
      };
      const tangent = normalize(nextPt.x - prev.x, nextPt.y - prev.y);
      candidate.x += tangent.x * Math.sin(i * 0.55 + iter * 0.12) * 0.08;
      candidate.y += tangent.y * Math.sin(i * 0.55 + iter * 0.12) * 0.08;
      if (!softInside(candidate.x, candidate.y, Math.max(state.sampleStep * 3, 24))) {
        candidate = {
          x: lerp(candidate.x, center.x, 0.34),
          y: lerp(candidate.y, center.y, 0.34)
        };
      }
      return candidate;
    });
  }
  return current;
}

function cellsOverlap(a, b, gap = 8) {
  return Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y) < a.footprint + b.footprint + gap;
}

function contoursTooClose(a, b, gap = 8) {
  if (!a.points || !b.points) return false;
  const gapSq = gap * gap;
  for (let i = 0; i < a.points.length; i += 3) {
    const pa = a.points[i];
    for (let j = 0; j < b.points.length; j += 3) {
      const pb = b.points[j];
      const dx = pa.x - pb.x;
      const dy = pa.y - pb.y;
      if (dx * dx + dy * dy < gapSq) return true;
    }
  }
  return false;
}

function createElasticCell(center, tangentAngle, lengthRadius, thicknessRadius, generation, phase, revealDelay, profile = null) {
  const baseCount = Math.round(mapRange(settings.growth, 0, 100, 16, 28));
  const count = Math.max(14, baseCount + Math.round(randomJitter(6)));
  const resolvedProfile = profile || makeCellProfile(tangentAngle, 0);
  const generated = generateElasticCellPoints(center, tangentAngle, lengthRadius, thicknessRadius, phase, count, resolvedProfile);
  const points = relaxElasticPoints(generated.points, center, generated.radialTargets);

  const metrics = cumulativePathMetrics(points, true);
  const branch = {
    type: "cell",
    center,
    tangentAngle,
    anchor: center,
    lengthRadius,
    thicknessRadius,
    footprint: Math.max(lengthRadius, thicknessRadius) * 0.92,
    profile: resolvedProfile,
    points: metrics.points,
    generation,
    stroke: 0.22,
    spores: [],
    motion: {
      phase,
      amp: 0.18,
      driftX: randomJitter(0.02),
      driftY: randomJitter(0.02)
    }
  };
  branch.lengths = metrics.lengths;
  branch.totalLength = metrics.totalLength;
  branch.pulseSpeed = 0;
  branch.pulseSpan = 0;
  branch.revealDelay = revealDelay;
  branch.revealDuration = mapRange(settings.growth, 0, 100, 1100, 320);
  branch.pressure = 1;
  branch.decayDelay = branch.revealDelay + branch.revealDuration + mapRange(settings.resistance, 0, 100, 1700, 3400);
  branch.decayDuration = mapRange(settings.mutation, 0, 100, 4800, 2200);
  branch.deposits = [];
  return branch;
}

function reshapeForContacts(cells, gap = 8) {
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i];
      const b = cells[j];
      const dx = b.center.x - a.center.x;
      const dy = b.center.y - a.center.y;
      const dist = Math.hypot(dx, dy) || 0.001;
      const limit = a.footprint + b.footprint + gap;
      if (dist >= limit) continue;
      const nx = dx / dist;
      const ny = dy / dist;
      for (let k = 0; k < a.points.length; k++) {
        const pt = a.points[k];
        const side = (pt.x - a.center.x) * nx + (pt.y - a.center.y) * ny;
        if (side > 0) {
          a.points[k] = {
            x: pt.x - nx * side * 0.16,
            y: pt.y - ny * side * 0.16
          };
        }
      }
      for (let k = 0; k < b.points.length; k++) {
        const pt = b.points[k];
        const side = (pt.x - b.center.x) * -nx + (pt.y - b.center.y) * -ny;
        if (side > 0) {
          b.points[k] = {
            x: pt.x + nx * side * 0.16,
            y: pt.y + ny * side * 0.16
          };
        }
      }
      const aMetrics = cumulativePathMetrics(a.points.slice(0, -1), true);
      a.points = aMetrics.points;
      a.lengths = aMetrics.lengths;
      a.totalLength = aMetrics.totalLength;
      const bMetrics = cumulativePathMetrics(b.points.slice(0, -1), true);
      b.points = bMetrics.points;
      b.lengths = bMetrics.lengths;
      b.totalLength = bMetrics.totalLength;
    }
  }
}

function dedupeNodes(nodes, minDist) {
  const result = [];
  const minDistSq = minDist * minDist;
  for (const node of nodes) {
    if (!result.some((existing) => distSq(existing, node) < minDistSq)) {
      result.push(node);
    }
  }
  return result;
}

function smoothPolyline(points, passes = 2) {
  let current = points.slice();
  for (let pass = 0; pass < passes; pass++) {
    if (current.length < 3) return current;
    const next = [current[0]];
    for (let i = 0; i < current.length - 1; i++) {
      const a = current[i];
      const b = current[i + 1];
      next.push(lerpPoint(a, b, 0.25));
      next.push(lerpPoint(a, b, 0.75));
    }
    next.push(current[current.length - 1]);
    current = next;
  }
  return current;
}

function pickClusterExtremes(cluster) {
  if (!cluster.length) return [];
  let top = cluster[0];
  let bottom = cluster[0];
  let left = cluster[0];
  let right = cluster[0];
  for (const node of cluster) {
    if (node.y < top.y) top = node;
    if (node.y > bottom.y) bottom = node;
    if (node.x < left.x) left = node;
    if (node.x > right.x) right = node;
  }
  const center = cluster.reduce((acc, node) => ({ x: acc.x + node.x / cluster.length, y: acc.y + node.y / cluster.length }), { x: 0, y: 0 });
  const centroidNode = nearestNode(center, cluster, Math.max(width, height)) || cluster[0];
  return dedupeNodes([top, left, bottom, right, centroidNode], Math.max(state.sampleStep * 1.2, 10));
}

function selectHybridRootSeeds() {
  const clusters = clusterSampledNodes(state.edgeNodes, state.sampleStep * 2.2).filter((cluster) => cluster.length > 5);
  const seeds = [];
  for (const cluster of clusters) {
    const extremes = pickClusterExtremes(cluster);
    const quota = clamp(Math.round(cluster.length / 26), 1, 3);
    for (let i = 0; i < extremes.length && i < quota; i++) {
      seeds.push(makeSeed(extremes[i], false, 1.08 + Math.random() * 0.18));
    }
  }
  return dedupeNodes(
    [...seeds.map((seed) => ({ x: seed.x, y: seed.y, angle: seed.angle, force: seed.force, inherited: seed.inherited })), ...state.manualSeeds],
    Math.max(state.sampleStep * 1.8, 12)
  );
}

function buildRootBarbs(branch) {
  const twigs = [];
  if (!branch.points || branch.points.length < 6) return twigs;
  const density = mapRange(settings.infection, 0, 100, 0.06, 0.11);
  const depthMax = clamp(Math.round(mapRange(settings.generation, 1, 8, 2, 3)), 2, 3);
  const baseSide = branch.rootSide || 1;
  let lastRevealAt = -Infinity;

  function makeTwig(start, angle, length, revealAt, depth, side) {
    const bend = 0.08 + Math.random() * 0.08;
    const p1 = {
      x: start.x + Math.cos(angle) * length * 0.3,
      y: start.y + Math.sin(angle) * length * 0.3
    };
    const p2 = {
      x: p1.x + Math.cos(angle + side * bend) * length * 0.34,
      y: p1.y + Math.sin(angle + side * bend) * length * 0.34
    };
    const p3 = {
      x: p2.x + Math.cos(angle + side * bend * 0.65) * length * 0.36,
      y: p2.y + Math.sin(angle + side * bend * 0.65) * length * 0.36
    };
    const twig = { points: [start, p1, p2, p3], revealAt, children: [] };
    if (depth < depthMax) {
      const childCount = depth === 0 ? 2 : 1;
      for (let i = 0; i < childCount; i++) {
        const anchor = i === 0 ? p2 : p3;
        const childSide = i === 0 ? side : side * 0.7;
        const childAngle = angle + childSide * (0.26 + Math.random() * 0.18);
        const childLen = length * (depth === 0 ? 0.56 : 0.46);
        twig.children.push(makeTwig(anchor, childAngle, childLen, revealAt + length * (0.12 + i * 0.08), depth + 1, side));
      }
    }
    return twig;
  }

  for (let i = 3; i < branch.points.length - 3; i++) {
    if (Math.random() > density) continue;
    const revealAt = branch.lengths[i] || 0;
    if (revealAt - lastRevealAt < Math.max(branch.twinGap * 16, 58)) continue;
    const prev = branch.points[i - 1];
    const curr = branch.points[i];
    const next = branch.points[i + 1];
    const tangent = normalize(next.x - prev.x, next.y - prev.y);
    const normal = { x: -tangent.y, y: tangent.x };
    const side = baseSide;
    const start = {
      x: curr.x + normal.x * branch.stroke * 0.9 * side,
      y: curr.y + normal.y * branch.stroke * 0.9 * side
    };
    const len = mapRange(settings.growth, 0, 100, 42, 120) * (0.95 + Math.random() * 0.85) * Math.max(0.8, 1 - branch.generation * 0.08);
    const angle = Math.atan2(normal.y * side, normal.x * side) + randomJitter(0.08);
    twigs.push(makeTwig(start, angle, len, revealAt, 0, side));
    lastRevealAt = revealAt;
  }
  return twigs;
}

function makeHybridRootBranch(seed, generation = 0, bridge = false) {
  const points = [{ x: seed.x, y: seed.y }];
  let pos = { x: seed.x, y: seed.y };
  let angle = seed.angle;
  const lateralBoost = seed.lateral ? 1.25 : 1;
  const stepBase = mapRange(settings.growth, 0, 100, 4.5, 10.5) * (seed.force || 1) * lateralBoost;
  const steps = Math.round((mapRange(settings.infection, 0, 100, 46, 120) - generation * 4) * (seed.lateral ? 1.2 : 1));
  const mutation = mapRange(settings.mutation, 0, 100, 0.008, 0.08);
  const resistance = settings.resistance / 100;
  const attractorRadius = mapRange(settings.growth, 0, 100, 22, 54);

  for (let i = 0; i < steps; i++) {
    const flow = averageAttractorDirection(pos, attractorRadius);
    if (flow) {
      angle = lerp(angle, vecToAngle(flow), 0.14);
    }

    const edge = nearestNode(pos, state.edgeNodes, 64);
    if (edge) {
      const normal = normalize(pos.x - edge.x, pos.y - edge.y);
      let tangentAngle = vecToAngle({ x: -normal.y, y: normal.x });
      if (Math.cos(tangentAngle - angle) < 0) tangentAngle += Math.PI;
      angle = lerp(angle, tangentAngle, 0.18 + resistance * 0.12);
    }

    angle += Math.sin(i * 0.18 + generation * 0.8) * 0.035 + randomJitter(mutation);
    const tries = [angle, angle + 0.16, angle - 0.16, angle + 0.34, angle - 0.34];
    let next = null;
    let accepted = angle;
    for (const candidateAngle of tries) {
      const dir = angleToVec(candidateAngle);
      const step = stepBase * (0.78 + Math.random() * 0.42);
      const target = { x: pos.x + dir.x * step, y: pos.y + dir.y * step };
      if (softInside(target.x, target.y, Math.max(state.sampleStep * 1.4, 10))) {
        next = target;
        accepted = candidateAngle;
        break;
      }
    }
    if (!next) break;
    pos = next;
    angle = accepted;
    points.push(next);
  }

  if (points.length < 4) return null;
  const smoothPoints = smoothPolyline(points, seed.lateral ? 1 : 2);
  const branch = computeBranchMetrics(smoothPoints, {
    type: bridge ? "root-bridge" : "root",
    points: smoothPoints,
    generation,
    stroke: Math.max(0.9, 2.2 - generation * 0.35),
    spores: [],
    motion: {
      phase: Math.random() * Math.PI * 2,
      amp: 0.08,
      driftX: randomJitter(0.015),
      driftY: randomJitter(0.015)
    }
  });
  branch.twinGap = mapRange(settings.growth, 0, 100, 2.4, 4.4) * (0.88 + Math.random() * 0.36);
  branch.rootSide = seed.side || (Math.sin(branch.motion.phase) >= 0 ? 1 : -1);
  branch.barbs = buildRootBarbs(branch);
  branch.revealDelay = generation * 120 + Math.random() * 180;
  branch.revealDuration = branch.totalLength * mapRange(settings.growth, 0, 100, 11, 20) + 320;
  branch.decayDelay = 24000;
  branch.decayDuration = 4000;
  branch.deposits = [];
  return branch;
}

function branchDistance(a, b) {
  let best = Infinity;
  for (let i = 0; i < a.points.length; i += 3) {
    for (let j = 0; j < b.points.length; j += 3) {
      const d = Math.hypot(a.points[i].x - b.points[j].x, a.points[i].y - b.points[j].y);
      if (d < best) best = d;
    }
  }
  return best;
}

function branchTooClose(branches, candidate, minDist) {
  return branches.some((existing) => branchDistance(existing, candidate) < minDist);
}

function deriveChildSeeds(branch, generation) {
  const seeds = [];
  if (!branch.points || branch.points.length < 8) return seeds;
  const branchCount = clamp(Math.round(mapRange(settings.infection, 0, 100, 2, 5) + generation * 0.8), 1, 6);
  let cursor = branch.points.length * 0.2;
  const minStep = Math.max(3, Math.floor(branch.points.length / (branchCount + 2)));
  for (let i = 0; i < branchCount; i++) {
    cursor += minStep + Math.random() * minStep * 0.8;
    const idx = clamp(Math.floor(cursor), 2, branch.points.length - 3);
    const prev = branch.points[idx - 1];
    const curr = branch.points[idx];
    const next = branch.points[idx + 1];
    const tangent = Math.atan2(next.y - prev.y, next.x - prev.x);
    const side = i % 2 === 0 ? 1 : -1;
    seeds.push({
      x: curr.x,
      y: curr.y,
      angle: tangent + side * (Math.PI / 2 + randomJitter(0.28)),
      force: clamp(0.72 - generation * 0.08 + Math.random() * 0.1, 0.38, 0.82),
      inherited: true,
      parentLength: branch.lengths[idx] || 0,
      side
    });
  }
  return seeds;
}

function deriveLateralBranchSeeds(branch, generation) {
  const seeds = [];
  if (!branch.points || branch.points.length < 10) return seeds;
  const count = clamp(Math.round(mapRange(settings.infection, 0, 100, 2, 6) - generation * 0.6), 1, 5);
  let cursor = branch.points.length * 0.16;
  const minStep = Math.max(4, Math.floor(branch.points.length / (count + 1.5)));
  for (let i = 0; i < count; i++) {
    cursor += minStep + Math.random() * minStep * 0.9;
    const idx = clamp(Math.floor(cursor), 3, branch.points.length - 4);
    const prev = branch.points[idx - 1];
    const curr = branch.points[idx];
    const next = branch.points[idx + 1];
    const tangent = Math.atan2(next.y - prev.y, next.x - prev.x);
    const side = i % 2 === 0 ? 1 : -1;
    seeds.push({
      x: curr.x,
      y: curr.y,
      angle: tangent + side * (Math.PI / 2 + randomJitter(0.22)),
      force: clamp(0.96 - generation * 0.08 + Math.random() * 0.14, 0.7, 1.12),
      inherited: true,
      parentLength: branch.lengths[idx] || 0,
      lateral: true,
      side
    });
  }
  return seeds;
}

function generateHybridRoots() {
  const branches = [];
  const seeds = selectHybridRootSeeds();
  const maxSeeds = Math.round(mapRange(settings.infection, 0, 100, 2, 6));
  const baseSeeds = seeds.slice(0, maxSeeds);
  const queue = baseSeeds.map((seed, index) => ({ seed, generation: 0, delay: index * 90 }));

  while (queue.length) {
    const item = queue.shift();
    const branch = makeHybridRootBranch(item.seed, item.generation, false);
    if (!branch || branchBlocked(branch)) continue;
    if (branchTooClose(branches, branch, Math.max(state.sampleStep * (item.generation === 0 ? 2.4 : 1.7), 12))) continue;
    branch.revealDelay += item.delay;
    branch.twinGap *= Math.max(0.62, 1 - item.generation * 0.12);
    branch.barbs = buildRootBarbs(branch);
    branches.push(branch);

    if (item.generation < settings.generation - 1) {
      const childSeeds = deriveChildSeeds(branch, item.generation);
      const lateralSeeds = deriveLateralBranchSeeds(branch, item.generation);
      const nextSeeds = [...lateralSeeds, ...childSeeds];
      for (let i = 0; i < nextSeeds.length; i++) {
        queue.push({
          seed: nextSeeds[i],
          generation: item.generation + 1,
          delay: branch.revealDelay + 220 + i * 95 + item.generation * 120
        });
      }
    }
  }

  state.bridgePairs.forEach((pair, index) => {
    const seed = {
      x: pair.start.x,
      y: pair.start.y,
      angle: Math.atan2(pair.end.y - pair.start.y, pair.end.x - pair.start.x),
      force: 0.92,
      inherited: true
    };
    const bridge = makeHybridRootBranch(seed, 1, true);
    if (!bridge || branchBlocked(bridge)) return;
    if (branchTooClose(branches, bridge, Math.max(state.sampleStep * 1.4, 10))) return;
    bridge.revealDelay += 1300 + index * 220;
    bridge.twinGap *= 0.82;
    bridge.barbs = buildRootBarbs(bridge);
    branches.push(bridge);
  });

  return branches;
}

function ensureHybridBuffers() {
  if (!state.hybridBuffer || state.hybridBuffer.width !== width || state.hybridBuffer.height !== height) {
    state.hybridBuffer = createGraphics(width, height);
    state.hybridBlurBuffer = createGraphics(width, height);
  }
}

function hybridFieldAngle(x, y, baseAngle) {
  const n = noise(x * 0.0042, y * 0.0042, settings.mutation * 0.015 + settings.growth * 0.008 + 17);
  const flow = baseAngle + mapRange(n, 0, 1, -Math.PI * 0.35, Math.PI * 0.35);
  return lerp(baseAngle, flow, 0.1 + settings.mutation / 320);
}

function growHybridTopologySegment(seed, depth = 0) {
  const points = [{ x: seed.x, y: seed.y }];
  let pos = { x: seed.x, y: seed.y };
  let angle = seed.angle;
  const stepLen = mapRange(settings.growth, 0, 100, 3.4, 6.8) * (seed.force || 1) * Math.max(0.74, 1 - depth * 0.08);
  const steps = Math.round(mapRange(settings.infection, 0, 100, 90, 190) * Math.max(0.58, 1 - depth * 0.12));

  for (let i = 0; i < steps; i++) {
    const flowAngle = hybridFieldAngle(pos.x, pos.y, angle);
    angle = lerp(angle, flowAngle, 0.16);
    const localAttractor = averageAttractorDirection(pos, mapRange(settings.growth, 0, 100, 20, 60));
    if (localAttractor) {
      angle = lerp(angle, vecToAngle(localAttractor), 0.1);
    }
    const edge = nearestNode(pos, state.edgeNodes, Math.max(state.sampleStep * 4.5, 26));
    if (edge) {
      const normal = normalize(pos.x - edge.x, pos.y - edge.y);
      let tangentAngle = vecToAngle({ x: -normal.y, y: normal.x });
      if (Math.cos(tangentAngle - angle) < 0) tangentAngle += Math.PI;
      angle = lerp(angle, tangentAngle, 0.3);
    }
    angle += Math.sin(i * 0.12 + depth * 0.7 + (seed.phase || 0)) * 0.018 + randomJitter(mapRange(settings.mutation, 0, 100, 0.004, 0.028));
    const next = {
      x: pos.x + Math.cos(angle) * stepLen * (0.86 + Math.random() * 0.28),
      y: pos.y + Math.sin(angle) * stepLen * (0.86 + Math.random() * 0.28)
    };
    if (!softInside(next.x, next.y, Math.max(state.sampleStep * 2.2, 16))) break;
    points.push(next);
    pos = next;
  }

  if (points.length < 6) return null;
  const smooth = smoothPolyline(points, depth === 0 ? 2 : 1);
  const branch = computeBranchMetrics(smooth, {
    type: "hybrid-segment",
    points: smooth,
    generation: depth,
    depth,
    side: seed.side || 1,
    stroke: Math.max(0.75, 2.2 - depth * 0.28),
    spores: [],
    motion: {
      phase: seed.phase || Math.random() * Math.PI * 2,
      amp: Math.max(0.02, 0.08 - depth * 0.012),
      driftX: randomJitter(0.01),
      driftY: randomJitter(0.01)
    }
  });
  branch.revealDelay = seed.delay || 0;
  branch.revealDuration = branch.totalLength * mapRange(settings.growth, 0, 100, 9, 16) + 220;
  branch.decayDelay = 36000;
  branch.decayDuration = 4000;
  branch.pressure = 1;
  return branch;
}

function deriveHybridTopologyChildren(branch, depth = 0) {
  const children = [];
  if (!branch.points || branch.points.length < 10) return children;
  const depthMax = clamp(Math.round(mapRange(settings.generation, 1, 8, 2, 3)), 2, 3);
  if (depth >= depthMax) return children;
  const count = clamp(Math.round((depth === 0 ? 2 : 1) + settings.infection / 70 - depth * 0.4), 1, depth === 0 ? 3 : 2);
  let cursor = branch.points.length * 0.16;
  const minStep = Math.max(5, Math.floor(branch.points.length / (count + 1.4)));
  for (let i = 0; i < count; i++) {
    cursor += minStep + Math.random() * minStep * 0.7;
    const idx = clamp(Math.floor(cursor), 3, branch.points.length - 4);
    const prev = branch.points[idx - 1];
    const curr = branch.points[idx];
    const next = branch.points[idx + 1];
    const tangent = Math.atan2(next.y - prev.y, next.x - prev.x);
    const side = branch.side || 1;
    children.push({
      x: curr.x,
      y: curr.y,
      angle: tangent + side * (Math.PI / 2 + randomJitter(0.16)),
      force: clamp(0.92 - depth * 0.12 + Math.random() * 0.12, 0.48, 0.96),
      side,
      phase: (branch.motion?.phase || 0) + i * 0.8,
      delay: branch.revealDelay + branch.revealDuration * 0.42 + i * 110
    });
  }
  return children;
}

function generateHybridField() {
  const segments = [];
  const centerPoint = {
    x: (state.bbox.x1 + state.bbox.x2) * 0.5,
    y: (state.bbox.y1 + state.bbox.y2) * 0.5
  };
  const edgeSeeds = selectHybridRootSeeds();
  const interiorSeeds = dedupeNodes(
    state.interiorNodes
      .filter((_, index) => index % Math.max(2, Math.round(mapRange(settings.infection, 0, 100, 6, 3))) === 0)
      .sort((a, b) => distSq(a, centerPoint) - distSq(b, centerPoint))
      .slice(0, Math.round(mapRange(settings.infection, 0, 100, 6, 18))),
    Math.max(state.sampleStep * 2.2, 14)
  ).map((node) => ({
    x: node.x,
    y: node.y,
    angle: vecToAngle(normalize(node.x - centerPoint.x, node.y - centerPoint.y)) + Math.PI * 0.5 + randomJitter(0.28),
    force: 0.88 + Math.random() * 0.16
  }));
  const seeds = [...edgeSeeds.slice(0, Math.round(mapRange(settings.infection, 0, 100, 4, 10))), ...interiorSeeds];
  const queue = seeds.map((seed, index) => ({
    ...seed,
    phase: Math.random() * Math.PI * 2,
    side: index % 2 === 0 ? 1 : -1,
    delay: index * 38,
    depth: 0
  }));

  while (queue.length) {
    const item = queue.shift();
    const segment = growHybridTopologySegment(item, item.depth || 0);
    if (!segment || branchBlocked(segment)) continue;
    if (branchTooClose(segments, segment, Math.max(state.sampleStep * (item.depth === 0 ? 1.2 : 0.8), 5))) continue;
    segments.push(segment);
    const children = deriveHybridTopologyChildren(segment, item.depth || 0);
    for (const child of children) {
      queue.push({ ...child, depth: (item.depth || 0) + 1 });
    }
  }

  return {
    type: "hybrid-field",
    segments,
    grainSeed: Math.random() * 1000
  };
}

function generateHybridCells() {
  const branches = [];
  const glyphScale = bboxScale();
  const count = Math.round(mapRange(settings.infection, 0, 100, 72, 186) * clamp(0.86 + glyphScale * 0.36, 0.78, 1.24));
  const gap = Math.max(state.sampleStep * 0.52, 4);
  const centerPoint = state.interiorNodes.reduce((acc, node) => ({
    x: acc.x + node.x / Math.max(state.interiorNodes.length, 1),
    y: acc.y + node.y / Math.max(state.interiorNodes.length, 1)
  }), { x: 0, y: 0 });
  const candidatePool = state.interiorNodes.slice();
  const clusterCount = 4 + Math.round(mapRange(settings.infection, 0, 100, 1, 5));
  const clusterSeeds = [];
  const clusterProfiles = [];
  const sorted = candidatePool.slice().sort((a, b) => distSq(a, centerPoint) - distSq(b, centerPoint));
  const bucketSize = Math.max(state.sampleStep * mapRange(settings.infection, 0, 100, 4.4, 3), 16);
  const buckets = new Map();
  for (const node of candidatePool) {
    const keyX = Math.floor((node.x - state.bbox.x1) / bucketSize);
    const keyY = Math.floor((node.y - state.bbox.y1) / bucketSize);
    const key = `${keyX}:${keyY}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { nodes: [], centerX: state.bbox.x1 + (keyX + 0.5) * bucketSize, centerY: state.bbox.y1 + (keyY + 0.5) * bucketSize };
      buckets.set(key, bucket);
    }
    bucket.nodes.push(node);
  }
  const coverageAnchors = Array.from(buckets.values())
    .map((bucket) => {
      let best = bucket.nodes[0];
      let bestScore = Infinity;
      for (const node of bucket.nodes) {
        const dx = node.x - bucket.centerX;
        const dy = node.y - bucket.centerY;
        const score = dx * dx + dy * dy;
        if (score < bestScore) {
          bestScore = score;
          best = node;
        }
      }
      return best;
    })
    .sort((a, b) => distSq(a, centerPoint) - distSq(b, centerPoint));
  for (let i = 0; i < clusterCount; i++) {
    const pick = sorted[Math.floor((sorted.length - 1) * (i / Math.max(clusterCount - 1, 1)) * 0.7 + Math.random() * sorted.length * 0.18)] || centerPoint;
    clusterSeeds.push(pick);
    const radialNorm = clamp(Math.hypot(pick.x - centerPoint.x, pick.y - centerPoint.y) / Math.max(1, Math.hypot(state.bbox.x2 - state.bbox.x1, state.bbox.y2 - state.bbox.y1) * 0.5), 0, 1);
    const flowAngle = vecToAngle(normalize(pick.x - centerPoint.x, pick.y - centerPoint.y)) + randomJitter(0.42);
    const baseProfile = makeCellProfile(flowAngle, radialNorm, Math.random());
    clusterProfiles.push({
      ...baseProfile,
      flowAngle,
      tipAngle: flowAngle + randomJitter(0.18),
      tailAngle: flowAngle + Math.PI + randomJitter(0.18),
      pinchAngle: flowAngle + (Math.random() < 0.5 ? -1 : 1) * (0.9 + Math.random() * 0.6)
    });
  }

  const makeCoverageCell = (source, radialBoost = 1, jitterScale = 1, familyProfile = null) => {
    const radial = normalize(source.x - centerPoint.x, source.y - centerPoint.y);
    const radialDist = Math.hypot(source.x - centerPoint.x, source.y - centerPoint.y);
    const maxRadial = Math.max(1, Math.hypot(state.bbox.x2 - state.bbox.x1, state.bbox.y2 - state.bbox.y1) * 0.5);
    const radialNorm = clamp(radialDist / maxRadial, 0, 1);
    const tangentAngle = vecToAngle(radial) + randomJitter(0.9 * jitterScale);
    const center = {
      x: source.x + randomJitter(Math.max(state.sampleStep * 0.16, 1.4) * jitterScale),
      y: source.y + randomJitter(Math.max(state.sampleStep * 0.16, 1.4) * jitterScale)
    };
    if (!softInside(center.x, center.y, Math.max(state.sampleStep * 1.2, 8))) return null;

    const profile = familyProfile
      ? {
          ...familyProfile,
          flowAngle: lerp(familyProfile.flowAngle, tangentAngle, 0.26),
          tipAngle: lerp(familyProfile.tipAngle, tangentAngle, 0.34) + randomJitter(0.12),
          tailAngle: lerp(familyProfile.tailAngle, tangentAngle + Math.PI, 0.34) + randomJitter(0.14),
          pinchAngle: familyProfile.pinchAngle + randomJitter(0.26),
          sway: clamp(familyProfile.sway * (0.82 + Math.random() * 0.44), 0.08, 0.36),
          lobeAmp: clamp(familyProfile.lobeAmp * (0.78 + Math.random() * 0.46), 0.08, 0.32),
          rippleAmp: clamp(familyProfile.rippleAmp * (0.7 + Math.random() * 0.52), 0.02, 0.16),
          asymmetry: clamp(familyProfile.asymmetry * (0.72 + Math.random() * 0.56), 0.03, 0.22)
        }
      : makeCellProfile(tangentAngle, radialNorm, Math.random());
    const baseRadius = mapRange(settings.growth, 0, 100, 6.2, 15.8) * clamp(glyphScale, 0.78, 1.04) * radialBoost * (0.58 + Math.random() * 0.84);
    const aspect = profile.family === "blade"
      ? 0.92 + Math.random() * 0.88
      : 0.78 + Math.random() * 0.68;
    const lengthRadius = baseRadius * aspect;
    const thicknessRadius = baseRadius * (profile.family === "blade" ? 0.54 + Math.random() * 0.26 : 0.66 + Math.random() * 0.46);
    const revealDelay = radialNorm * mapRange(settings.resistance, 0, 100, 120, 520) + Math.abs(randomJitter(28));
    const cell = createElasticCell(center, tangentAngle, lengthRadius, thicknessRadius, 0, Math.random() * Math.PI * 2, Math.max(0, revealDelay), profile);
    cell.anchor = source;
    return cell;
  };

  const targetCoverage = Math.min(coverageAnchors.length, Math.round(count * mapRange(settings.infection, 0, 100, 0.88, 0.64)));
  for (let i = 0; i < coverageAnchors.length && branches.length < targetCoverage; i++) {
    const source = coverageAnchors[i];
    const nearestClusterIndex = clusterSeeds.reduce((best, cluster, idx) => {
      const d = distSq(source, cluster);
      return d < best.dist ? { idx, dist: d } : best;
    }, { idx: 0, dist: Infinity }).idx;
    const cell = makeCoverageCell(source, i < targetCoverage * 0.28 ? 1.06 : 0.96, 0.72, clusterProfiles[nearestClusterIndex]);
    if (!cell) continue;
    if (!branches.some((existing) => cellsOverlap(existing, cell, gap * 0.92) || contoursTooClose(existing, cell, gap * 0.84))) {
      branches.push(cell);
    }
  }

  const maxAttempts = count * 24;
  for (let attempt = 0; attempt < maxAttempts && branches.length < count; attempt++) {
    const clusterIndex = Math.floor(Math.random() * clusterSeeds.length);
    const cluster = clusterSeeds[clusterIndex];
    const spread = mapRange(settings.growth, 0, 100, 12, 28) * clamp(glyphScale, 0.76, 1.06) * (0.82 + Math.random() * 0.5);
    const source = {
      x: cluster.x + randomJitter(spread),
      y: cluster.y + randomJitter(spread)
    };
    if (!softInside(source.x, source.y, Math.max(state.sampleStep * 1.45, 10))) continue;
    const cell = makeCoverageCell(source, 0.86 + Math.random() * 0.28, 1, clusterProfiles[clusterIndex]);
    if (!cell) continue;
    if (!branches.some((existing) => cellsOverlap(existing, cell, gap) || contoursTooClose(existing, cell, gap * 0.88))) {
      branches.push(cell);
    }
  }

  for (let iter = 0; iter < 20; iter++) {
    for (let i = 0; i < branches.length; i++) {
      let moveX = 0;
      let moveY = 0;
      for (let j = 0; j < branches.length; j++) {
        if (i === j) continue;
        const a = branches[i];
        const b = branches[j];
        const dx = a.center.x - b.center.x;
        const dy = a.center.y - b.center.y;
        const dist = Math.hypot(dx, dy) || 0.001;
        const minDist = a.footprint + b.footprint + gap;
        if (dist < minDist) {
          const push = (minDist - dist) * 0.12;
          moveX += (dx / dist) * push;
          moveY += (dy / dist) * push;
        }
      }
      const towardAnchor = normalize(branches[i].anchor.x - branches[i].center.x, branches[i].anchor.y - branches[i].center.y);
      moveX += towardAnchor.x * 0.2;
      moveY += towardAnchor.y * 0.2;
      const outward = normalize(branches[i].center.x - centerPoint.x, branches[i].center.y - centerPoint.y);
      moveX += outward.x * 0.015;
      moveY += outward.y * 0.015;
      const candidate = {
        x: branches[i].center.x + moveX,
        y: branches[i].center.y + moveY
      };
      if (softInside(candidate.x, candidate.y, Math.max(state.sampleStep * 1.2, 8))) {
        branches[i].center = candidate;
      }
    }
  }

  branches.forEach((cell, index) => {
    const radialDist = Math.hypot(cell.center.x - centerPoint.x, cell.center.y - centerPoint.y);
    const maxRadial = Math.max(1, Math.hypot(state.bbox.x2 - state.bbox.x1, state.bbox.y2 - state.bbox.y1) * 0.5);
    const radialNorm = clamp(radialDist / maxRadial, 0, 1);
    const regenerated = createElasticCell(
      cell.center,
      cell.tangentAngle,
      cell.lengthRadius,
      cell.thicknessRadius,
      0,
      cell.motion.phase,
      radialNorm * mapRange(settings.resistance, 0, 100, 110, 500) + index * 4,
      cell.profile
    );
    Object.assign(cell, regenerated, { anchor: cell.anchor });
  });

  state.bridgePairs.forEach((pair, index) => {
    const dx = pair.end.x - pair.start.x;
    const dy = pair.end.y - pair.start.y;
    const dist = Math.hypot(dx, dy);
    if (dist > state.sampleStep * 6.2) return;
    const tangentAngle = Math.atan2(dy, dx) + randomJitter(0.16);
    const center = {
      x: (pair.start.x + pair.end.x) * 0.5,
      y: (pair.start.y + pair.end.y) * 0.5
    };
    const bridgeBase = mapRange(settings.growth, 0, 100, 7, 13);
    const cell = createElasticCell(
      center,
      tangentAngle,
      bridgeBase * 1.08,
      bridgeBase * 0.74,
      1,
      Math.random() * Math.PI * 2,
      280 + index * 120,
      makeCellProfile(tangentAngle, 0.5 + Math.random() * 0.2, Math.random())
    );
    if (!branches.some((existing) => cellsOverlap(existing, cell, gap * 0.72) || contoursTooClose(existing, cell, gap * 0.66))) {
      branches.push(cell);
    }
  });

  reshapeForContacts(branches, gap * 0.9);

  return branches;
}

function makePolyline(seed, generation) {
  const points = [{ x: seed.x, y: seed.y }];
  let pos = { x: seed.x, y: seed.y };
  let angle = seed.angle;
  const mutation = mapRange(settings.mutation, 0, 100, 0.05, 0.9);
  const resistance = settings.resistance / 100;
  const growth = (settings.species === "hybrid"
    ? mapRange(settings.growth, 0, 100, 5, 14)
    : mapRange(settings.growth, 0, 100, 4, 12)) * seed.force;
  const baseSteps = settings.species === "memetic" ? 12 : 28;
  const steps = Math.round(baseSteps + generation * 2 + mapRange(settings.infection, 0, 100, 7, 24));
  const spores = [];
  let outsideSteps = 0;
  const outsideLimit = Math.round(mapRange(settings.infection, 0, 100, 1, 4) * mapRange(settings.resistance, 0, 100, 1.2, 0.55));
  const outsideBudget = overflowAllowance();
  const attractorRadius = settings.species === "hybrid"
    ? mapRange(settings.growth, 0, 100, 18, 40)
    : mapRange(settings.growth, 0, 100, 22, 68);
  const memory = settings.species === "memetic" ? 0.64 : 0.76;

  for (let i = 0; i < steps; i++) {
    const localFlow = averageAttractorDirection(pos, attractorRadius);
    if (localFlow) {
      angle = lerp(angle, vecToAngle(localFlow), 1 - memory);
    }

    if (settings.species === "memetic") {
      angle += randomJitter(mutation * 0.52);
    } else {
      angle += Math.sin((i + generation) * 0.26) * 0.04 + randomJitter(mutation * 0.06);
    }

    const candidates = steerInside(pos, angle, resistance);
    let next = null;
    let acceptedAngle = angle;
    for (const candidateAngle of candidates) {
      const dir = angleToVec(candidateAngle);
      const step = growth * (0.7 + Math.random() * 0.55);
      const target = { x: pos.x + dir.x * step, y: pos.y + dir.y * step };
      const occupancy = canOccupy(target.x, target.y, outsideBudget);
      if (occupancy.ok && (!occupancy.outside || outsideSteps < outsideLimit)) {
        next = target;
        acceptedAngle = candidateAngle;
        if (occupancy.outside) {
          outsideSteps += 1;
        } else {
          outsideSteps = Math.max(0, outsideSteps - 1);
        }
        break;
      }
    }

    if (!next) break;

    angle = acceptedAngle;
    pos = next;
    points.push(pos);

    if (Math.random() < (settings.species === "hybrid" ? 0.035 + settings.infection / 500 : 0.08 + settings.infection / 260)) {
      spores.push({
        x: pos.x + randomJitter(4),
        y: pos.y + randomJitter(4),
        r: mapRange(settings.mutation, 0, 100, 0.35, 1.05)
      });
    }
  }

  if (points.length < 3) return null;
  const branch = computeBranchMetrics(points, {
    type: "polyline",
    points,
    generation,
    stroke: settings.species === "memetic" ? 0.42 : 0.24,
    spores,
    motion: {
      phase: Math.random() * Math.PI * 2,
      amp: settings.species === "memetic" ? 0.64 : 0.42,
      driftX: randomJitter(0.05),
      driftY: randomJitter(0.06)
    }
  });
  if (settings.species === "hybrid") {
    branch.deposits = buildDeposits(points, branch);
  }
  return branch;
}

function makeMemeticCluster(seed, generation) {
  const points = [];
  const spores = [];
  const petals = Math.round(mapRange(settings.infection, 0, 100, 5, 11));
  const radius = mapRange(settings.growth, 0, 100, 10, 38);
  const center = { x: seed.x, y: seed.y };

  for (let i = 0; i < petals; i++) {
    const angle = seed.angle + (Math.PI * 2 * i) / petals + randomJitter(0.25);
    const tip = {
      x: center.x + Math.cos(angle) * radius * (0.6 + Math.random() * 0.5),
      y: center.y + Math.sin(angle) * radius * (0.6 + Math.random() * 0.5)
    };
    if (canOccupy(tip.x, tip.y, overflowAllowance()).ok) {
      points.push(center, lerpPoint(center, tip, 0.58), tip);
      spores.push({ x: tip.x, y: tip.y, r: 0.75 + Math.random() * 1.35 });
    }
  }

  if (points.length < 3) return null;
  return computeBranchMetrics(points, {
    type: "cluster",
    points,
    generation,
    stroke: 0.45,
    spores,
    motion: {
      phase: Math.random() * Math.PI * 2,
      amp: 0.8,
      driftX: randomJitter(0.18),
      driftY: randomJitter(0.18)
    }
  });
}

function makeBridgeBranch(pair, index) {
  const dx = pair.end.x - pair.start.x;
  const dy = pair.end.y - pair.start.y;
  const distance = Math.hypot(dx, dy) || 1;
  const dir = normalize(dx, dy);
  const normal = { x: -dir.y, y: dir.x };
  const bend = Math.sin(index * 1.7 + distance * 0.01) * mapRange(settings.mutation, 0, 100, 6, 24);
  const mid = {
    x: (pair.start.x + pair.end.x) * 0.5 + normal.x * bend,
    y: (pair.start.y + pair.end.y) * 0.5 + normal.y * bend
  };
  const steps = Math.max(8, Math.round(distance / Math.max(state.sampleStep * 0.8, 4)));
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = lerpPoint(pair.start, mid, t);
    const b = lerpPoint(mid, pair.end, t);
    points.push(lerpPoint(a, b, t));
  }
  return computeBranchMetrics(points, {
    type: "bridge",
    points,
    generation: settings.generation + 1,
    stroke: 0.18,
    spores: [],
    motion: {
      phase: Math.random() * Math.PI * 2,
      amp: 0.26,
      driftX: randomJitter(0.03),
      driftY: randomJitter(0.03)
    }
  });
}

function branchChildren(branch, generation) {
  const seeds = [];
  const infection = settings.infection / 100;
  const mutation = settings.mutation / 100;
  const chance = settings.species === "memetic" ? 0.16 : 0.1;

  for (let i = 2; i < branch.points.length - 2; i++) {
    if (Math.random() >= chance * (0.75 + infection + mutation * 0.3)) continue;
    const prev = branch.points[i - 1];
    const curr = branch.points[i];
    const next = branch.points[i + 1];
    const baseAngle = Math.atan2(next.y - prev.y, next.x - prev.x);
    const splitAngle = settings.species === "circuit"
      ? baseAngle + (Math.random() < 0.5 ? -1 : 1) * Math.PI / 2
      : baseAngle + randomJitter(1.15);
    seeds.push({
      x: curr.x,
      y: curr.y,
      angle: splitAngle,
      force: mapRange(settings.generation - generation, 1, 8, 0.75, 1.2),
      inherited: true
    });
  }

  const end = branch.points[branch.points.length - 1];
  const beforeEnd = branch.points[branch.points.length - 2];
  seeds.push({
    x: end.x,
    y: end.y,
    angle: Math.atan2(end.y - beforeEnd.y, end.x - beforeEnd.x),
    force: 1,
    inherited: true
  });

  return seeds;
}

function regenerateParasites() {
  if (!state.ready) return;
  if (settings.species === "hybrid") {
    state.parasites = [generateHybridField()];
    state.growthStartMs = millis();
    state.lastLoopTick = state.growthStartMs;
    setStatus(
      `<strong>${settings.fontFamily}</strong> host mask, <strong>Moss Network</strong> species, ` +
      `<strong>${state.parasites[0].segments.length}</strong> flow segments, generation <strong>${settings.generation}</strong>.`
    );
    redraw();
    return;
  }

  let currentSeeds = [...sampleBaseSeeds(), ...state.manualSeeds];
  const branches = [];

  for (let generation = 0; generation < settings.generation; generation++) {
    const nextSeeds = [];
    const limit = Math.round(mapRange(settings.infection, 0, 100, 30, 160) * (generation === 0 ? 1 : 0.75));

    for (let i = 0; i < currentSeeds.length && i < limit; i++) {
      const seed = currentSeeds[i];
      const branch = settings.species === "memetic" && Math.random() < 0.52
        ? makeMemeticCluster(seed, generation)
        : makePolyline(seed, generation);
      if (!branch || branchBlocked(branch)) continue;
      branches.push(branch);
      nextSeeds.push(...branchChildren(branch, generation));
    }

    currentSeeds = nextSeeds;
  }

  state.bridgePairs.forEach((pair, index) => {
    const bridge = makeBridgeBranch(pair, index);
    bridge.revealDelay += 1400 + index * 420;
    bridge.revealDuration *= 2.2;
    bridge.decayDelay += 2200;
    branches.push(bridge);
  });

  state.parasites = branches;
  state.growthStartMs = millis();
  state.lastLoopTick = state.growthStartMs;
  setStatus(
    `<strong>${settings.fontFamily}</strong> host mask, <strong>${settings.species}</strong> species, ` +
    `<strong>${state.parasites.length}</strong> fungal bodies, generation <strong>${settings.generation}</strong>.`
  );
  redraw();
}

async function rebuildHost() {
  const token = ++state.rebuildToken;
  setStatus("<strong>Preparing host mask.</strong> Rasterizing invisible letterform.");
  await fontReady(settings.fontFamily);
  if (token !== state.rebuildToken) return;
  buildMask();
  regenerateParasites();
}

function scheduleRebuild(delay = 90) {
  if (state.rebuildTimer) window.clearTimeout(state.rebuildTimer);
  state.rebuildTimer = window.setTimeout(() => {
    state.rebuildTimer = null;
    rebuildHost();
  }, delay);
}

function inoculateAt(point, bloom = 0) {
  if (!insideMask(point.x, point.y)) return;
  const count = bloom > 0 ? 6 : 2;
  for (let i = 0; i < count; i++) {
    const candidate = {
      x: point.x + randomJitter(18 + bloom * 18),
      y: point.y + randomJitter(18 + bloom * 18)
    };
    if (!insideMask(candidate.x, candidate.y)) continue;
    state.manualSeeds.push(makeSeed(candidate, false, 1 + bloom * 0.35));
  }
  regenerateParasites();
}

function exciseAt(point) {
  state.excisions.push({ x: point.x, y: point.y, radius: 30, createdAt: millis() });
  regenerateParasites();
}

function exportPNG() {
  saveCanvas("parasitic-type-system", "png");
}

function svgBranch(branch) {
  if (branch.type === "hybrid-field") {
    let content = "";
    for (const segment of branch.segments) {
      const d = segment.points.map((pt, index) => `${index === 0 ? "M" : "L"} ${pt.x.toFixed(2)} ${pt.y.toFixed(2)}`).join(" ");
      content += `<path d="${d}" fill="none" stroke="${palette.parasite}" stroke-width="${segment.stroke.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" />`;
    }
    return content;
  }

  if (branch.type === "root" || branch.type === "root-bridge") {
    const ribbon = buildRootRibbonPolygon(branch.points, branch.twinGap || 3);
    let content = `<path d="${svgPolygonPath(ribbon)}" fill="${palette.parasite}" stroke="none" />`;
    const emitTwig = (twig) => {
      const twigData = twig.points.map((pt, index) => `${index === 0 ? "M" : "Q"} ${pt.x.toFixed(2)} ${pt.y.toFixed(2)}`).join(" ");
      content += `<path d="M ${twig.points[0].x.toFixed(2)} ${twig.points[0].y.toFixed(2)} Q ${twig.points[1].x.toFixed(2)} ${twig.points[1].y.toFixed(2)} ${twig.points[2].x.toFixed(2)} ${twig.points[2].y.toFixed(2)} T ${twig.points[3].x.toFixed(2)} ${twig.points[3].y.toFixed(2)}" fill="none" stroke="${palette.parasite}" stroke-width="${Math.max(0.7, branch.stroke * 1.18)}" stroke-linecap="round" stroke-linejoin="round" />`;
      for (const child of twig.children || []) emitTwig(child);
    };
    for (const barb of branch.barbs || []) emitTwig(barb);
    return content;
  }

  if (branch.type === "cluster") {
    let content = "";
    for (let i = 0; i < branch.points.length; i += 3) {
      const a = branch.points[i];
      const b = branch.points[i + 1];
      const c = branch.points[i + 2];
      if (!a || !b || !c) continue;
      content += `<path d="M ${a.x.toFixed(2)} ${a.y.toFixed(2)} Q ${b.x.toFixed(2)} ${b.y.toFixed(2)} ${c.x.toFixed(2)} ${c.y.toFixed(2)}" fill="none" stroke="${palette.parasite}" stroke-width="${branch.stroke}" stroke-linecap="round" />`;
    }
    for (const spore of branch.spores) {
      content += `<circle cx="${spore.x.toFixed(2)}" cy="${spore.y.toFixed(2)}" r="${spore.r.toFixed(2)}" fill="${palette.spores}" />`;
    }
    return content;
  }

  const d = branch.points.map((pt, index) => `${index === 0 ? "M" : "L"} ${pt.x.toFixed(2)} ${pt.y.toFixed(2)}`).join(" ");
  let spores = "";
  for (const spore of branch.spores) {
    spores += `<circle cx="${spore.x.toFixed(2)}" cy="${spore.y.toFixed(2)}" r="${spore.r.toFixed(2)}" fill="${palette.spores}" />`;
  }
  return `<path d="${d}" fill="none" stroke="${palette.parasite}" stroke-width="${branch.stroke}" stroke-linecap="round" stroke-linejoin="round" />${spores}`;
}

function exportSVG() {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="${palette.bg}" />`,
    ...state.parasites.map(svgBranch),
    `</svg>`
  ].join("");
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "parasitic-type-system.svg";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function bindUI() {
  dom.status = document.getElementById("status");
  dom.textInput = document.getElementById("textInput");
  dom.fontSelect = document.getElementById("fontSelect");
  dom.colorSelect = document.getElementById("colorSelect");
  dom.customColor = document.getElementById("customColor");

  const ids = ["infection", "growth", "mutation", "generation", "resistance"];
  ids.forEach((id) => {
    dom[id] = document.getElementById(id);
    dom[`${id}Val`] = document.getElementById(`${id}Val`);
    dom[id].addEventListener("input", () => {
      settings[id] = Number(dom[id].value);
      dom[`${id}Val`].textContent = dom[id].value;
      regenerateParasites();
    });
  });

  dom.textInput.addEventListener("compositionstart", () => {
    state.isComposing = true;
  });

  dom.textInput.addEventListener("compositionend", () => {
    state.isComposing = false;
    const normalized = normalizeHostText(dom.textInput.value);
    if (normalized !== dom.textInput.value) dom.textInput.value = normalized;
    settings.text = normalized;
    scheduleRebuild(40);
  });

  dom.textInput.addEventListener("input", () => {
    if (state.isComposing) return;
    const normalized = normalizeHostText(dom.textInput.value);
    if (normalized !== dom.textInput.value) dom.textInput.value = normalized;
    settings.text = normalized;
    scheduleRebuild(90);
  });

  dom.fontSelect.addEventListener("change", async () => {
    settings.fontFamily = dom.fontSelect.value;
    await rebuildHost();
  });

  dom.colorSelect.addEventListener("change", () => {
    settings.colorway = dom.colorSelect.value;
    document.documentElement.style.setProperty("--parasite", activePalette().ui);
    redraw();
  });

  dom.customColor.addEventListener("input", () => {
    settings.customColor = dom.customColor.value;
    settings.colorway = "custom";
    dom.colorSelect.value = "custom";
    document.documentElement.style.setProperty("--parasite", activePalette().ui);
    redraw();
  });

  ["keydown", "keypress", "keyup"].forEach((eventName) => {
    dom.textInput.addEventListener(eventName, (event) => {
      event.stopPropagation();
    });
  });

  document.querySelectorAll("[data-species]").forEach((button) => {
    button.addEventListener("click", () => {
      settings.species = button.dataset.species;
      document.querySelectorAll("[data-species]").forEach((chip) => chip.classList.toggle("active", chip === button));
      regenerateParasites();
    });
  });

  document.getElementById("svgBtn").addEventListener("click", exportSVG);
  document.getElementById("pngBtn").addEventListener("click", exportPNG);
  document.getElementById("resetBtn").addEventListener("click", () => {
    state.manualSeeds = [];
    state.excisions = [];
    regenerateParasites();
  });
  document.getElementById("stepBtn").addEventListener("click", () => {
    settings.generation = clamp(settings.generation + 1, 1, 8);
    dom.generation.value = settings.generation;
    dom.generationVal.textContent = settings.generation;
    regenerateParasites();
  });

  dom.playBtn = document.getElementById("playBtn");
  dom.playBtn.addEventListener("click", () => {
    state.playLoop = !state.playLoop;
    dom.playBtn.textContent = state.playLoop ? "Pause Growth Loop" : "Resume Growth Loop";
    if (state.playLoop) state.lastLoopTick = millis();
  });
}

function setup() {
  const holder = document.getElementById("canvas-holder");
  const canvas = createCanvas(holder.clientWidth, holder.clientHeight);
  canvas.parent(holder);
  bindUI();
  dom.customColor.value = settings.customColor;
  document.documentElement.style.setProperty("--parasite", activePalette().ui);
  frameRate(24);
  rebuildHost();
}

function drawGuides() {
  stroke(palette.grid);
  strokeWeight(1);
  noFill();
  rect(24, 24, width - 48, height - 48, 12);
}

function animatedPoint(point, index, branch, time) {
  if (!point) return null;
  const motion = branch.motion || { phase: 0, amp: 0, driftX: 0, driftY: 0 };
  const tipBias = branch.points && branch.points.length > 1 ? index / Math.max(branch.points.length - 1, 1) : 0.5;
  const ampScale = 0.15 + tipBias * 0.95;
  const pulse = Math.sin(time * 1.2 + motion.phase + index * 0.22) * motion.amp * ampScale;
  const sway = Math.cos(time * 1.05 + motion.phase * 0.7 + index * 0.16) * motion.amp * 0.5 * ampScale;
  return {
    x: point.x + motion.driftX * time * 0.22 + pulse * 0.5,
    y: point.y + motion.driftY * time * 0.22 + sway * 0.5
  };
}

function drawPulseSegment(branch, time) {
  if (!branch.totalLength || !branch.lengths || branch.points.length < 2) return;
  const pulseHead = (time * branch.pulseSpeed + (branch.motion?.phase || 0) * 18) % (branch.totalLength + branch.pulseSpan);
  const pulseTail = pulseHead - branch.pulseSpan;
  let drawing = false;
  for (let i = 0; i < branch.points.length; i++) {
    const len = branch.lengths[i];
    if (len >= pulseTail && len <= pulseHead) {
      const pt = animatedPoint(branch.points[i], i, branch, time);
      if (!drawing) {
        beginShape();
        drawing = true;
      }
      vertex(pt.x, pt.y);
    } else if (drawing) {
      endShape();
      drawing = false;
    }
  }
  if (drawing) endShape();
}

function offsetBranchPoints(points, amount) {
  const shifted = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const tangent = normalize(next.x - prev.x, next.y - prev.y);
    const normal = { x: -tangent.y, y: tangent.x };
    shifted.push({
      x: points[i].x + normal.x * amount,
      y: points[i].y + normal.y * amount
    });
  }
  return shifted;
}

function buildRootRibbonPolygon(points, gap) {
  if (!points || points.length < 2) return [];
  const left = offsetBranchPoints(points, gap * 0.5);
  const right = offsetBranchPoints(points, -gap * 0.5).reverse();
  return [...left, ...right];
}

function svgPolygonPath(points) {
  if (!points || !points.length) return "";
  return points.map((pt, index) => `${index === 0 ? "M" : "L"} ${pt.x.toFixed(2)} ${pt.y.toFixed(2)}`).join(" ") + " Z";
}

function drawRootBarbs(branch, visibleLength, timeOffset = 0) {
  if (!branch.barbs || !branch.barbs.length) return;
  const drawTwig = (twig, depth = 0) => {
    if (twig.revealAt > visibleLength || twig.points.length < 4) return;
    const start = animatedPoint(twig.points[0], 0, branch, timeOffset);
    const p1 = animatedPoint(twig.points[1], 1, branch, timeOffset);
    const p2 = animatedPoint(twig.points[2], 2, branch, timeOffset);
    const end = animatedPoint(twig.points[3], 3, branch, timeOffset);
    beginShape();
    vertex(start.x, start.y);
    quadraticVertex(p1.x, p1.y, p2.x, p2.y);
    quadraticVertex(p2.x, p2.y, end.x, end.y);
    endShape();
    strokeWeight(Math.max(branch.stroke * (1.18 - depth * 0.18), 0.7));
    for (const child of twig.children || []) drawTwig(child, depth + 1);
  };
  for (const barb of branch.barbs) drawTwig(barb, 0);
}

function drawBranchShape(points, branch, timeOffset = 0) {
  if (branch.type === "root" || branch.type === "root-bridge") {
    beginShape();
    for (let i = 0; i < points.length; i++) {
      const pt = animatedPoint(points[i], i, branch, timeOffset);
      curveVertex(pt.x, pt.y);
    }
    endShape();
    return;
  }

  if (branch.type === "cell") {
    const smooth = [];
    for (let i = 0; i < points.length; i++) {
      const pt = animatedPoint(points[i], i, branch, timeOffset);
      if (pt) smooth.push(pt);
    }
    if (smooth.length < 3) return;
    beginShape();
    const first = smooth[0];
    const second = smooth[1];
    const penultimate = smooth[smooth.length - 2];
    const last = smooth[smooth.length - 1];
    curveVertex(penultimate.x, penultimate.y);
    curveVertex(last.x, last.y);
    for (const pt of smooth) {
      curveVertex(pt.x, pt.y);
    }
    curveVertex(first.x, first.y);
    curveVertex(second.x, second.y);
    endShape(CLOSE);
    return;
  }

  if (branch.type === "cluster") {
    for (let i = 0; i < points.length; i += 3) {
      const a = animatedPoint(points[i], i, branch, timeOffset);
      const b = animatedPoint(points[i + 1], i + 1, branch, timeOffset);
      const c = animatedPoint(points[i + 2], i + 2, branch, timeOffset);
      if (!a || !b || !c) continue;
      beginShape();
      vertex(a.x, a.y);
      quadraticVertex(b.x, b.y, c.x, c.y);
      endShape();
    }
    return;
  }

  beginShape();
  for (let i = 0; i < points.length; i++) {
    const pt = animatedPoint(points[i], i, branch, timeOffset);
    vertex(pt.x, pt.y);
  }
  endShape();
}

function drawFilledRibbon(points, branch, gap, timeOffset = 0) {
  const polygon = buildRootRibbonPolygon(points, gap);
  if (polygon.length < 4) return;
  beginShape();
  for (let i = 0; i < polygon.length; i++) {
    const pt = animatedPoint(polygon[i], i, branch, timeOffset);
    vertex(pt.x, pt.y);
  }
  endShape(CLOSE);
}

function inflatedCellPoints(branch, progress, timeOffset = 0) {
  const eased = 1 - Math.pow(1 - clamp(progress, 0, 1), 2.6);
  const pts = [];
  for (let i = 0; i < branch.points.length; i++) {
    const pt = animatedPoint(branch.points[i], i, branch, timeOffset);
    if (!pt) continue;
    const dx = pt.x - branch.center.x;
    const dy = pt.y - branch.center.y;
    const bloom = 0.86 + eased * 0.14;
    pts.push({
      x: branch.center.x + dx * eased * bloom,
      y: branch.center.y + dy * eased * bloom
    });
  }
  return pts;
}

function drawDeposits(branch, elapsedMs, colors, time) {
  if (settings.species === "hybrid") return;
  if (!branch.deposits || !branch.deposits.length) return;
  noFill();
  for (const deposit of branch.deposits) {
    const local = elapsedMs - deposit.revealAt;
    if (local <= 0) continue;
    const growth = clamp(local / 1200, 0, 1);
    const decay = clamp((local - 2200) / 4200, 0, 1);
    const alpha = lerp(90, 16, decay) * growth;
    if (alpha <= 1) continue;
    const pulse = Math.sin(time * 0.8 + deposit.jitter) * 0.8;
    const anchor = {
      x: deposit.anchor.x + pulse * 0.25,
      y: deposit.anchor.y + Math.cos(time * 0.7 + deposit.jitter) * 0.25
    };
    const tip = lerpPoint(anchor, deposit.tip, growth);
    stroke(colors.residue[0], colors.residue[1], colors.residue[2], alpha);
    strokeWeight(deposit.size * lerp(1.7, 1.05, decay));
    line(anchor.x, anchor.y, tip.x, tip.y);
  }
}

function hybridOffsetPolyline(points, segment, layerIndex = 0) {
  const offset = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const tangent = normalize(next.x - prev.x, next.y - prev.y);
    const normal = { x: -tangent.y, y: tangent.x };
    const n = noise(points[i].x * 0.008, points[i].y * 0.008, layerIndex * 3.1 + segment.depth * 4.7);
    const drift = mapRange(n, 0, 1, -1, 1) * (1.2 + layerIndex * 0.9) * Math.max(0.7, 1 - segment.depth * 0.12);
    offset.push({
      x: points[i].x + normal.x * drift,
      y: points[i].y + normal.y * drift
    });
  }
  return offset;
}

function drawHybridPolylineToGraphics(g, points) {
  if (!points || points.length < 3) return;
  g.beginShape();
  const first = points[0];
  const second = points[1];
  const penultimate = points[points.length - 2];
  const last = points[points.length - 1];
  g.curveVertex(penultimate.x, penultimate.y);
  g.curveVertex(last.x, last.y);
  for (const pt of points) {
    g.curveVertex(pt.x, pt.y);
  }
  g.curveVertex(first.x, first.y);
  g.curveVertex(second.x, second.y);
  g.endShape();
}

function drawHybridField(branch, elapsedMs, colors, time) {
  ensureHybridBuffers();
  const blur = state.hybridBlurBuffer;
  const crisp = state.hybridBuffer;
  blur.clear();
  crisp.clear();
  blur.noFill();
  crisp.noFill();

  for (const segment of branch.segments) {
    const visibleLength = branchVisibleLength(segment, elapsedMs);
    const visiblePoints = revealedPoints(segment, visibleLength);
    if (visiblePoints.length < 4) continue;
    const depthAlpha = Math.max(38, 160 - segment.depth * 34);
    for (let layer = 0; layer < 3; layer++) {
      const strand = hybridOffsetPolyline(visiblePoints, segment, layer);
      blur.stroke(colors.stroke[0], colors.stroke[1], colors.stroke[2], 34 - layer * 6);
      blur.strokeWeight(segment.stroke * (3.6 - segment.depth * 0.34 - layer * 0.22));
      drawHybridPolylineToGraphics(blur, strand);
    }
    for (let layer = 0; layer < 3; layer++) {
      const strand = hybridOffsetPolyline(visiblePoints, segment, layer);
      crisp.stroke(colors.stroke[0], colors.stroke[1], colors.stroke[2], depthAlpha - layer * 18);
      crisp.strokeWeight(Math.max(0.55, segment.stroke * (1.2 - layer * 0.16)));
      drawHybridPolylineToGraphics(crisp, strand);
    }
  }

  blur.filter(BLUR, 2);
  image(blur, 0, 0);
  image(crisp, 0, 0);

  stroke(colors.residue[0], colors.residue[1], colors.residue[2], 22);
  strokeWeight(1);
  for (let i = 0; i < 140; i++) {
    const x = (noise(branch.grainSeed, i * 0.17, time * 0.02) * width);
    const y = (noise(branch.grainSeed + 31, i * 0.13, time * 0.02) * height);
    point(x, y);
  }
}

function drawParasites(time) {
  const colors = activePalette();
  const elapsedMs = millis() - state.growthStartMs;
  for (const branch of state.parasites) {
    if (settings.species === "hybrid" && branch.type === "hybrid-field") {
      drawHybridField(branch, elapsedMs, colors, time);
      continue;
    }
    const revealProgress = branchRevealProgress(branch, elapsedMs);
    if (settings.species === "hybrid" && branch.type === "cell") {
      if (revealProgress <= 0.01) continue;
    }
    const visibleLength = branchVisibleLength(branch, elapsedMs);
    const visiblePoints = revealedPoints(branch, visibleLength);
    const decay = branchDecayProgress(branch, elapsedMs);
    if (settings.species === "hybrid" && (branch.type === "root" || branch.type === "root-bridge")) {
      if (visiblePoints.length < 3) continue;
      const residuePoints = revealedPoints(branch, visibleLength * 0.82);
      const gap = branch.twinGap || 3;
      if (residuePoints.length >= 3) {
        noStroke();
        fill(colors.residue[0], colors.residue[1], colors.residue[2], 64);
        drawFilledRibbon(residuePoints, branch, gap, time * 0.82);
        stroke(colors.residue[0], colors.residue[1], colors.residue[2], 34);
        strokeWeight(branch.stroke * 1.1);
        drawRootBarbs(branch, visibleLength * 0.82, time * 0.82);
      }
      noStroke();
      fill(colors.stroke[0], colors.stroke[1], colors.stroke[2], 248);
      drawFilledRibbon(visiblePoints, branch, gap, time);
      stroke(colors.stroke[0], colors.stroke[1], colors.stroke[2], 216);
      strokeWeight(branch.stroke * 1.18);
      drawRootBarbs(branch, visibleLength, time);
      noFill();
    } else if (settings.species === "hybrid") {
      const inflated = inflatedCellPoints(branch, revealProgress, time);
      if (inflated.length < 3) continue;
      const residueProgress = clamp(revealProgress * 0.84, 0, 1);
      const residuePoints = inflatedCellPoints(branch, residueProgress, time * 0.82);
      noFill();
      if (residuePoints.length >= 3) {
        stroke(colors.residue[0], colors.residue[1], colors.residue[2], lerp(72, 18, decay));
        strokeWeight(branch.stroke * 1.25);
        drawBranchShape(residuePoints, branch, time * 0.82);
      }
      const liveAlpha = lerp(255, 120, decay);
      stroke(colors.stroke[0], colors.stroke[1], colors.stroke[2], liveAlpha);
      strokeWeight(branch.stroke * 1.6);
      drawBranchShape(inflated, branch, time);
    } else {
      if (visiblePoints.length < 2) continue;
      const residueLength = visibleLength * 0.82;
      const residuePoints = revealedPoints(branch, residueLength);
      noFill();
      if (residuePoints.length >= 2) {
        const residueAlpha = lerp(72, 18, decay);
        stroke(colors.residue[0], colors.residue[1], colors.residue[2], residueAlpha);
        strokeWeight(branch.stroke * (3.4 - decay * 0.9));
        drawBranchShape(residuePoints, branch, time * 0.82);
        stroke(colors.residue[0], colors.residue[1], colors.residue[2], residueAlpha * 0.6);
        strokeWeight(branch.stroke * (5.6 - decay * 1.2));
        drawBranchShape(residuePoints, branch, time * 0.68 + 1.7);
      }

      const liveAlpha = lerp(176, 58, decay);
      stroke(colors.stroke[0], colors.stroke[1], colors.stroke[2], liveAlpha);
      const liveWeight = branch.stroke * branch.pressure * (0.94 + Math.sin(time * 1.2 + (branch.motion?.phase || 0)) * 0.06);
      strokeWeight(liveWeight);
      drawBranchShape(visiblePoints, branch, time);

      if (branch.type !== "cluster" && branch.type !== "bridge") {
        stroke(colors.pulse[0], colors.pulse[1], colors.pulse[2], lerp(255, 90, decay));
        strokeWeight(branch.stroke * branch.pressure * 2.15);
        const visibleMetrics = cumulativeLengths(visiblePoints);
        drawPulseSegment({ ...branch, points: visiblePoints, lengths: visibleMetrics.lengths, totalLength: visibleMetrics.totalLength }, time);
      }

      noStroke();
      fill(colors.spores[0], colors.spores[1], colors.spores[2], lerp(110, 26, decay));
      for (let i = 0; i < branch.spores.length; i++) {
        const spore = branch.spores[i];
        if (visibleLength < (branch.lengths[Math.min(i + 1, branch.lengths.length - 1)] || 0)) continue;
        const pt = animatedPoint(spore, i, branch, time);
        circle(pt.x, pt.y, spore.r * 2);
      }
      noFill();
      if (branch.type === "polyline") {
        drawDeposits(branch, elapsedMs, colors, time);
      }
    }
  }
}

function drawExcisions() {
  if (!state.excisions.length) return;
  noFill();
  strokeWeight(1);
  const now = millis();
  for (const cut of state.excisions) {
    const age = now - (cut.createdAt || 0);
    const fade = clamp(1 - age / 2200, 0, 1);
    if (fade <= 0) continue;
    stroke(`rgba(17,17,17,${(0.22 * fade).toFixed(3)})`);
    circle(cut.x, cut.y, cut.radius * 2);
  }
}

function draw() {
  background(palette.bg);
  drawGuides();
  if (!state.ready) return;
  tickGrowthLoop();
  const time = millis() * 0.001;
  drawParasites(time);
  drawExcisions();

  if (state.pressing && state.pressPoint && millis() - state.pressAt > 350) {
    noFill();
    stroke(palette.parasite);
    strokeWeight(1);
    circle(state.pressPoint.x, state.pressPoint.y, 30 + Math.sin(millis() * 0.018) * 6);
  }
}

function mousePressed(event) {
  if (!state.ready || mouseX < 0 || mouseX > width || mouseY < 0 || mouseY > height) return;
  state.pressing = true;
  state.pressAt = millis();
  state.pressPoint = { x: mouseX, y: mouseY };
  state.dragAdded = false;

  if (event.shiftKey) {
    exciseAt(state.pressPoint);
    state.pressing = false;
  }
}

function mouseDragged(event) {
  if (!state.ready || !state.pressing || event.shiftKey) return;
  const point = { x: mouseX, y: mouseY };
  if (!insideMask(point.x, point.y)) return;
  state.dragAdded = true;
  inoculateAt(point, 0.2);
}

function mouseReleased(event) {
  if (!state.ready || event.shiftKey) {
    state.pressing = false;
    return;
  }
  const duration = millis() - state.pressAt;
  if (!state.dragAdded && state.pressPoint) inoculateAt(state.pressPoint, duration > 350 ? 1 : 0);
  state.pressing = false;
}

function tickGrowthLoop() {
  if (!state.playLoop || !state.ready) return;
  const now = millis();
  if (!state.lastLoopTick) {
    state.lastLoopTick = now;
    return;
  }
  if (now - state.lastLoopTick >= state.loopDurationMs) {
    state.lastLoopTick = now;
    regenerateParasites();
  }
}

function windowResized() {
  const holder = document.getElementById("canvas-holder");
  resizeCanvas(holder.clientWidth, holder.clientHeight);
  rebuildHost();
}
