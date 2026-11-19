import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AmbientLight,
  BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Raycaster,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DEM_RESOLUTIONS, fetchDem, metresPerDegLon, sampleDem, type DemGrid, type DemResolution } from "../lib/dem";
import { describeError, isAbort } from "../lib/http";
import { sunPosition, type TerrainFeature } from "../lib/terrain";
import { fmtHour } from "../lib/format";
import type { Tune } from "../lib/tune";
import { cn } from "../utils/cn";
import TerrainTuner from "./TerrainTuner";

interface Props {
  lat: number;
  lon: number;
  features: TerrainFeature[];
  stations: { id: string; name: string; lat: number; lon: number; distanceKm: number }[];
  /** Instant de référence, pour la position du soleil. */
  nowMs: number;
  tz: string;
  onPick: (lat: number, lon: number) => void;
  tune: Tune;
  onTune: (next: Tune) => void;
  deltaRh: number;
  deltaSigma: number;
  rhNow: number;
}

const WORLD = 10; // taille du relief en unités three.js
const M_PER_DEG_LAT = 111_320;

const RAMP = { low: "#487d8d", mid: "#8dbfa0", high: "#edf0d5" };

const VERT = /* glsl */ `
attribute float aHeight;
varying vec3 vN;
varying float vH;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  vH = aHeight;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uSun;
uniform vec3 uFill;
uniform vec3 uLow;
uniform vec3 uMid;
uniform vec3 uHigh;
uniform float uHMin;
uniform float uHRange;
uniform float uContour;
uniform float uShowContour;
uniform float uDaylight;
varying vec3 vN;
varying float vH;
void main() {
  float t = clamp((vH - uHMin) / max(uHRange, 1.0), 0.0, 1.0);
  vec3 base = mix(uLow, uMid, smoothstep(0.0, 0.55, t));
  base = mix(base, uHigh, smoothstep(0.55, 1.0, t));
  vec3 n = normalize(vN);
  vec3 sun = normalize(uSun);
  // Demi-Lambert : un versant à l'ombre reste lisible, au lieu de devenir noir.
  float wrap = clamp(dot(n, sun) * 0.62 + 0.38, 0.0, 1.0);
  float fill = clamp(dot(n, normalize(uFill)) * 0.5 + 0.5, 0.0, 1.0);
  float sky = clamp(n.y * 0.55 + 0.45, 0.15, 1.0);
  vec3 warm = vec3(1.0, 0.93, 0.82);
  vec3 cool = vec3(0.62, 0.74, 0.92);
  vec3 light = mix(cool, warm, uDaylight);
  // Bien plus lumineux à midi : lumière diffuse franche, ombres encore perceptibles.
  vec3 col = base * light * (0.78 + 0.88 * wrap * mix(0.75, 1.0, uDaylight) + 0.2 * fill + 0.24 * sky);
  if (uShowContour > 0.5 && uContour > 0.5) {
    float f = fract(vH / uContour);
    float band = smoothstep(0.0, 0.04, f) * (1.0 - smoothstep(0.96, 1.0, f));
    col = mix(col, col * 0.55, (1.0 - band) * 0.35);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

/** Intervalle de courbes de niveau lisible pour un relief donné. */
function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Distance à laquelle le relief remplit le cadre, quelle que soit l'emprise. */
const IDEAL_DIST = 12;

/** Repositionne la caméra à une distance donnée, en conservant son orientation. */
function placeCamera(controls: OrbitControls, camera: PerspectiveCamera, dist: number): void {
  const dir = camera.position.clone().sub(controls.target).normalize();
  camera.position.copy(controls.target).add(dir.multiplyScalar(dist));
  controls.update();
}

function contourInterval(relief: number): number {
  const target = relief / 9;
  const steps = [5, 10, 20, 25, 50, 100, 200, 500, 1000];
  for (const s of steps) if (s >= target) return s;
  return 1000;
}

/** Rééchantillonne une polyligne pour qu'elle épouse le relief. */
function resample(points: [number, number][], closed: boolean, stepM: number, maxPts: number): [number, number][] {
  const src = closed && points.length > 2 ? [...points, points[0]] : points;
  const out: [number, number][] = [src[0]];
  for (let i = 0; i + 1 < src.length; i++) {
    const [la0, lo0] = src[i];
    const [la1, lo1] = src[i + 1];
    const dx = (lo1 - lo0) * metresPerDegLon(la0);
    const dy = (la1 - la0) * M_PER_DEG_LAT;
    const len = Math.hypot(dx, dy);
    const k = Math.min(maxPts, Math.max(1, Math.round(len / stepM)));
    for (let j = 1; j <= k; j++) out.push([la0 + ((la1 - la0) * j) / k, lo0 + ((lo1 - lo0) * j) / k]);
  }
  return out;
}

export default function Terrain3D({ lat, lon, features, stations, nowMs, tz, onPick, tune, onTune, deltaRh, deltaSigma, rhNow }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [res, setResState] = useState<DemResolution>(DEM_RESOLUTIONS[1]);
  const resIndexRef = useRef(1);
  const applyLevel = useCallback(
    (i: number) => {
      const c = Math.max(0, Math.min(DEM_RESOLUTIONS.length - 1, i));
      if (c === resIndexRef.current) return false;
      resIndexRef.current = c;
      setResState(DEM_RESOLUTIONS[c]);
      return true;
    },
    []
  );
  const applyLevelRef = useRef(applyLevel);
  applyLevelRef.current = applyLevel;
  const [exagg, setExagg] = useState(2);
  const [contours, setContours] = useState(true);
  const [showWater, setShowWater] = useState(true);
  const [sunOffsetH, setSunOffsetH] = useState(0);
  const [grid, setGrid] = useState<DemGrid | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [webgl, setWebgl] = useState(true);
  const needleRef = useRef<SVGGElement>(null);
  const scaleBarRef = useRef<HTMLSpanElement>(null);
  const scaleLabelRef = useRef<HTMLSpanElement>(null);
  const tuneRef = useRef(tune);
  tuneRef.current = tune;
  const [progress, setProgress] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ lat: number; lon: number; elev: number } | null>(null);
  const [spin, setSpin] = useState(false);
  /** Faux tant que la section n'approche pas de la fenêtre : sa grille attend. */
  const [near, setNear] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  // Accès direct aux contrôles de la scène, sans la reconstruire.
  const liveRef = useRef<{ controls: OrbitControls; camera: PerspectiveCamera } | null>(null);
  const spinRef = useRef(false);

  const toggleSpin = () => {
    const next = !spinRef.current;
    spinRef.current = next;
    setSpin(next);
    if (liveRef.current) {
      liveRef.current.controls.autoRotate = next;
      liveRef.current.controls.autoRotateSpeed = 0.9;
    }
  };

  /** Oriente la caméra vers un point cardinal (azimut 0 = caméra au sud, regard vers le nord). */
  const flyToView = (azimuthDeg: number, polarDeg: number) => {
    const live = liveRef.current;
    if (!live) return;
    const dist = live.camera.position.distanceTo(live.controls.target);
    const az = (azimuthDeg * Math.PI) / 180;
    const pol = (polarDeg * Math.PI) / 180;
    live.camera.position.set(
      live.controls.target.x + dist * Math.sin(pol) * Math.sin(az),
      live.controls.target.y + dist * Math.cos(pol),
      live.controls.target.z + dist * Math.sin(pol) * Math.cos(az)
    );
    live.controls.update();
  };

  // Le relief 3D est loin sous la ligne de flottaison. Sa grille (n × n altitudes,
  // jusqu'à 16 requêtes) attend donc que la section entre dans la fenêtre : sinon, elle
  // disputerait la bande passante aux données visibles et allongerait le LCP.
  useEffect(() => {
    if (near) return;
    const el = sectionRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: "0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near]);

  // MNT : rechargé si le lieu bouge de plus de ~150 m ou si la résolution change.
  const gridLat = useMemo(() => Math.round(lat * 64) / 64, [lat]);
  const gridLon = useMemo(() => Math.round(lon * 64) / 64, [lon]);
  useEffect(() => {
    if (!near) return;
    const ctrl = new AbortController();
    setLoading(true);
    setNote(null);
    setProgress(null);
    fetchDem(gridLat, gridLon, res, { signal: ctrl.signal }, (done, total) => {
      if (!ctrl.signal.aborted) setProgress(`${done}/${total}`);
    })
      .then((g) => {
        if (ctrl.signal.aborted) return;
        setGrid(g);
        setLoading(false);
        setProgress(null);
        if (g.fetched < g.n * g.n * 0.85) {
          setNote("Quelques altitudes manquent : le relief a été complété par interpolation.");
        }
      })
      .catch((e) => {
        if (isAbort(e)) return;
        setNote(`${describeError(e, "Le modèle de terrain")} Le bouton reste utilisable : réessayez.`);
        setLoading(false);
        setProgress(null);
      });
    return () => ctrl.abort();
  }, [gridLat, gridLon, res, attempt, near]);

  const sun = useMemo(() => sunPosition(nowMs + sunOffsetH * 3.6e6, lat, lon), [nowMs, sunOffsetH, lat, lon]);
  const sunLabel = useMemo(
    () => fmtHour(nowMs + sunOffsetH * 3.6e6, tz),
    [nowMs, sunOffsetH, tz]
  );

  // ------------------------------------------------------------ scène
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !grid || !webgl) return;

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    } catch {
      setWebgl(false);
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    // Dimensions lues une fois, puis tenues à jour par le ResizeObserver : les relire
    // dans la boucle de rendu forçait une mise en page à chaque image (l'échelle est
    // écrite en style juste avant la lecture de la hauteur).
    let viewW = mount.clientWidth;
    let viewH = mount.clientHeight;
    renderer.setPixelRatio(dpr);
    renderer.setSize(viewW, viewH, false);
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);
    // three.js expose un canvas intrinsèque de (largeur × DPR) : sans dimensionnement
    // CSS explicite, il débordait du conteneur et recouvrait les boutons sur rétina.
    Object.assign(renderer.domElement.style, {
      display: "block",
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      maxWidth: "100%",
      maxHeight: "100%",
      zIndex: "0",
      touchAction: "none",
    });
    renderer.domElement.setAttribute("aria-hidden", "true");

    const scene = new Scene();
    const camera = new PerspectiveCamera(42, viewW / Math.max(1, viewH), 0.05, 400);
    // Le relief occupe toujours la même place à l'écran, quelle que soit l'emprise :
    // c'est l'emprise qui change, pas le cadrage. La distance idéale est donc fixe.
    camera.position.set(0, 7.2, 9.6);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.zoomSpeed = 1.25;
    controls.minDistance = 1.6;
    controls.maxDistance = 46;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.target.set(0, 0, 0);
    controls.autoRotate = spinRef.current;
    controls.autoRotateSpeed = 0.9;
    controls.update();
    liveRef.current = { controls, camera };

    const ambient = new AmbientLight(0xbcd4e6, 0.55);
    const key = new DirectionalLight(0xfff2d8, 1.15);
    scene.add(ambient, key);

    const world = new Group();
    scene.add(world);

    // ------------------------------------------------------------ repères
    const n = grid.n;
    const mid = grid.min + (grid.max - grid.min) / 2;
    const toX = (l: number) => ((l - grid.centerLon) * metresPerDegLon(grid.centerLat)) / grid.widthM * WORLD;
    const toZ = (l: number) => -(((l - grid.centerLat) * M_PER_DEG_LAT) / grid.heightM) * WORLD;
    const toY = (h: number) => ((h - mid) / Math.max(1, grid.widthM)) * WORLD * exagg;
    const fromX = (x: number) => grid.centerLon + (x / WORLD) * grid.widthM / metresPerDegLon(grid.centerLat);
    const fromZ = (z: number) => grid.centerLat + (z / WORLD) * grid.heightM / M_PER_DEG_LAT;

    const heights = grid.elev;
    const heightAtWorld = (x: number, z: number): number => {
      const la = fromZ(z);
      const lo = fromX(x);
      return sampleDem(grid, la, lo) ?? mid;
    };

    // ------------------------------------------------------------ maillage du relief
    const pos = new Float32Array(n * n * 3);
    const hgt = new Float32Array(n * n);
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const i = row * n + col;
        const h = heights[i];
        pos[i * 3] = ((col - (n - 1) / 2) / (n - 1)) * WORLD;
        pos[i * 3 + 1] = toY(h);
        pos[i * 3 + 2] = ((row - (n - 1) / 2) / (n - 1)) * WORLD;
        hgt[i] = h;
      }
    }
    const idx: number[] = [];
    for (let row = 0; row < n - 1; row++)
      for (let col = 0; col < n - 1; col++) {
        const a = row * n + col;
        // Sens anti-horaire vu du dessus : les normales pointent vers le ciel, pas vers le sol.
        idx.push(a, a + 1, a + n, a + 1, a + n + 1, a + n);
      }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
    geo.setAttribute("aHeight", new Float32BufferAttribute(hgt, 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const normals = geo.getAttribute("normal");
    let ny = 0;
    for (let i = 0; i < normals.count; i++) ny += normals.getY(i);
    if (ny < 0) {
      for (let i = 0; i < normals.count; i++) {
        normals.setXYZ(i, -normals.getX(i), -normals.getY(i), -normals.getZ(i));
      }
      normals.needsUpdate = true;
    }

    const daylight = clamp01(0.42 + Math.max(0, sun.altitude) / 70);
    const azRad = (sun.azimuth * Math.PI) / 180;
    const altRad = (Math.max(8, sun.altitude) * Math.PI) / 180;
    const sunDir = new Vector3(Math.cos(altRad) * Math.sin(azRad), Math.sin(altRad), -Math.cos(altRad) * Math.cos(azRad)).normalize();
    const fillDir = new Vector3(-sunDir.x * 0.6, 0.85, -sunDir.z * 0.6).normalize();

    const mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: DoubleSide,
      uniforms: {
        uSun: { value: sunDir },
        uFill: { value: fillDir },
        uLow: { value: new Color(RAMP.low) },
        uMid: { value: new Color(RAMP.mid) },
        uHigh: { value: new Color(RAMP.high) },
        uHMin: { value: grid.min },
        uHRange: { value: Math.max(1, grid.max - grid.min) },
        uContour: { value: contourInterval(grid.max - grid.min) },
        uShowContour: { value: contours ? 1 : 0 },
        uDaylight: { value: daylight },
      },
    });
    const terrain = new Mesh(geo, mat);
    world.add(terrain);

    key.position.copy(sunDir).multiplyScalar(30);
    key.intensity = 0.35 + 0.95 * daylight;
    key.color.set(daylight > 0.15 ? 0xfff0d4 : 0x9fb8d8);
    ambient.intensity = 0.35 + 0.3 * daylight;

    // Socle : évite l'effet « feuille qui flotte ».
    const base = new Mesh(
      new BufferGeometry().setFromPoints([]),
      new MeshBasicMaterial({ color: 0x0a111c })
    );
    base.geometry.dispose();
    const baseGeo = new BufferGeometry();
    const yMin = toY(grid.min) - 0.02;
    const yBase = yMin - 0.85;
    const hw = WORLD / 2;
    const verts: number[] = [];
    const quads: [number[], number[], number[], number[]][] = [
      [[-hw, yMin, -hw], [hw, yMin, -hw], [hw, yBase, -hw], [-hw, yBase, -hw]],
      [[hw, yMin, -hw], [hw, yMin, hw], [hw, yBase, hw], [hw, yBase, -hw]],
      [[hw, yMin, hw], [-hw, yMin, hw], [-hw, yBase, hw], [hw, yBase, hw]],
      [[-hw, yMin, hw], [-hw, yMin, -hw], [-hw, yBase, -hw], [-hw, yBase, hw]],
      [[-hw, yBase, -hw], [hw, yBase, -hw], [hw, yBase, hw], [-hw, yBase, hw]],
    ];
    for (const q of quads) {
      const tri = [q[0], q[1], q[2], q[0], q[2], q[3]];
      for (const v of tri) verts.push(v[0], v[1], v[2]);
    }
    baseGeo.setAttribute("position", new Float32BufferAttribute(verts, 3));
    baseGeo.computeVertexNormals();
    base.geometry = baseGeo;
    world.add(base);

    // ------------------------------------------------------------ graticule
    const gratPts: number[] = [];
    const lines = 4;
    for (let i = 0; i <= lines; i++) {
      const f = i / lines;
      for (const axis of [0, 1]) {
        let prev: Vector3 | null = null;
        for (let s = 0; s <= 40; s++) {
          const g = s / 40;
          const x = axis === 0 ? (f - 0.5) * WORLD : (g - 0.5) * WORLD;
          const z = axis === 0 ? (g - 0.5) * WORLD : (f - 0.5) * WORLD;
          const y = toY(heightAtWorld(x, z)) + 0.02;
          const cur = new Vector3(x, y, z);
          if (prev) gratPts.push(prev.x, prev.y, prev.z, cur.x, cur.y, cur.z);
          prev = cur;
        }
      }
    }
    const gratGeo = new BufferGeometry();
    gratGeo.setAttribute("position", new Float32BufferAttribute(gratPts, 3));
    const graticule = new LineSegments(gratGeo, new LineBasicMaterial({ color: 0xdfe9f2, transparent: true, opacity: 0.09 }));
    world.add(graticule);

    // ------------------------------------------------------------ eau et végétation
    const ribbon = (
      pts: [number, number][],
      closed: boolean,
      widthM: number,
      liftWorld: number,
      color: number,
      opacity: number
    ) => {
      const step = Math.max(20, grid.spacingM * 0.6);
      const line = resample(pts, closed, step, 260);
      const wWorld = Math.max(0.028, (widthM / grid.widthM) * WORLD);
      const vertsR: number[] = [];
      let prevLeft: Vector3 | null = null;
      let prevRight: Vector3 | null = null;
      let prevCentre: Vector3 | null = null;
      for (const [la, lo] of line) {
        const h = sampleDem(grid, la, lo);
        if (h === null) {
          prevLeft = null;
          prevRight = null;
          prevCentre = null;
          continue;
        }
        const centre = new Vector3(toX(lo), toY(h) + liftWorld, toZ(la));
        // Ruban perpendiculaire au tracé, dans le plan horizontal.
        const dir = prevCentre ? centre.clone().sub(prevCentre) : new Vector3(1, 0, 0);
        dir.y = 0;
        if (dir.lengthSq() < 1e-9) dir.set(1, 0, 0);
        dir.normalize();
        const perp = new Vector3(-dir.z, 0, dir.x).multiplyScalar(wWorld / 2);
        const left = centre.clone().add(perp);
        const right = centre.clone().sub(perp);
        if (prevLeft && prevRight) {
          vertsR.push(prevLeft.x, prevLeft.y, prevLeft.z, prevRight.x, prevRight.y, prevRight.z, left.x, left.y, left.z);
          vertsR.push(prevRight.x, prevRight.y, prevRight.z, right.x, right.y, right.z, left.x, left.y, left.z);
        }
        prevLeft = left;
        prevRight = right;
        prevCentre = centre;
      }
      if (vertsR.length === 0) return null;
      const g = new BufferGeometry();
      g.setAttribute("position", new Float32BufferAttribute(vertsR, 3));
      g.computeVertexNormals();
      return new Mesh(g, new MeshBasicMaterial({ color, transparent: true, opacity, side: DoubleSide, depthWrite: false }));
    };

    if (showWater) {
      for (const f of features) {
        const isForest = f.kind === "forest";
        const widthM = isForest ? 14 : f.kind === "sea" ? 60 : f.kind === "river" ? 26 : f.kind === "lake" ? 18 : 9;
        const mesh = ribbon(
          f.points,
          f.closed,
          widthM * (0.6 + 0.8 * f.size),
          0.035,
          isForest ? 0x63a06a : 0x54c8ec,
          isForest ? 0.4 : 0.82
        );
        if (mesh) world.add(mesh);
      }
    }

    // ------------------------------------------------------------ marqueurs
    const pinGroup = new Group();
    const px = toX(lon);
    const pz = toZ(lat);
    const ph = sampleDem(grid, lat, lon) ?? mid;
    const py = toY(ph);
    const pinMat = new MeshBasicMaterial({ color: 0x7dd3fc });
    const cone = new Mesh(new ConeGeometry(0.19, 0.5, 20), pinMat);
    cone.position.set(px, py + 0.86, pz);
    cone.rotation.x = Math.PI;
    const head = new Mesh(new SphereGeometry(0.15, 20, 16), new MeshBasicMaterial({ color: 0xffffff }));
    head.position.set(px, py + 1.06, pz);
    const stem = new Line(
      new BufferGeometry().setFromPoints([new Vector3(px, py, pz), new Vector3(px, py + 0.66, pz)]),
      new LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.75 })
    );
    const ring = new Mesh(
      new RingGeometry(0.26, 0.34, 40),
      new MeshBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.85, side: DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(px, py + 0.02, pz);
    pinGroup.add(cone, head, stem, ring);
    world.add(pinGroup);

    const stationMeshes: { mesh: Mesh; id: string; name: string }[] = [];
    for (const s of stations) {
      const h = sampleDem(grid, s.lat, s.lon);
      if (h === null) continue;
      const sx = toX(s.lon);
      const sz = toZ(s.lat);
      const sy = toY(h);
      const m = new Mesh(new SphereGeometry(0.13, 16, 12), new MeshBasicMaterial({ color: 0x34d399 }));
      m.position.set(sx, sy + 0.34, sz);
      world.add(m);
      const drop = new Line(
        new BufferGeometry().setFromPoints([new Vector3(sx, sy, sz), new Vector3(sx, sy + 0.28, sz)]),
        new LineBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.6 })
      );
      world.add(drop);
      stationMeshes.push({ mesh: m, id: s.id, name: s.name });
    }

    // ------------------------------------------------------------ interaction
    const raycaster = new Raycaster();
    const ndc = new Vector2();
    let pinDragging = false;
    let downAt: { x: number; y: number; t: number } | null = null;
    let moved = false;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const pick = (ev: PointerEvent): { lat: number; lon: number; elev: number } | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObject(terrain, false)[0];
      if (!hit) return null;
      const la = fromZ(hit.point.z);
      const lo = fromX(hit.point.x);
      return { lat: la, lon: lo, elev: heightAtWorld(hit.point.x, hit.point.z) };
    };

    const nearPin = (ev: PointerEvent): boolean => {
      const v = new Vector3(px, py + 0.9, pz).project(camera);
      const rect = renderer.domElement.getBoundingClientRect();
      const sx = rect.left + ((v.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - v.y) / 2) * rect.height;
      return Math.hypot(ev.clientX - sx, ev.clientY - sy) < 26;
    };

    const onDown = (ev: PointerEvent) => {
      downAt = { x: ev.clientX, y: ev.clientY, t: performance.now() };
      moved = false;
      if (nearPin(ev)) {
        pinDragging = true;
        controls.enabled = false;
        renderer.domElement.setPointerCapture(ev.pointerId);
      }
    };
    const onMove = (ev: PointerEvent) => {
      if (downAt && Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 4) moved = true;
      if (pinDragging) {
        const p = pick(ev);
        if (p) {
          setDragging(p);
          pinGroup.position.set(toX(p.lon) - px, toY(p.elev) - py, toZ(p.lat) - pz);
        }
        return;
      }
      // Survol des stations
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObjects(stationMeshes.map((s) => s.mesh), false)[0];
      const found = hit ? stationMeshes.find((s) => s.mesh === hit.object)?.name ?? null : null;
      setHovered(found);
      renderer.domElement.style.cursor = found || nearPin(ev) ? "grab" : "crosshair";
    };
    const onUp = (ev: PointerEvent) => {
      if (pinDragging) {
        pinDragging = false;
        controls.enabled = true;
        try {
          renderer.domElement.releasePointerCapture(ev.pointerId);
        } catch {
          /* le pointeur a déjà été relâché */
        }
        setDragging((d) => {
          if (d) onPick(d.lat, d.lon);
          return null;
        });
        return;
      }
      const quick = downAt !== null && performance.now() - downAt.t < 400 && !moved;
      downAt = null;
      if (!quick) return;
      const p = pick(ev);
      if (p) onPick(p.lat, p.lon);
    };

    const el = renderer.domElement;
    // La molette zoome le relief (et donc l'échelle), elle ne fait pas défiler la page.
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointerleave", () => setHovered(null));
    // onWheel is registered above; keep it in the cleanup via the same element.

    // ------------------------------------------------------------ boucle
    let raf = 0;
    let visible = true;
    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((entries) => {
            visible = entries[0]?.isIntersecting ?? true;
          })
        : null;
    io?.observe(mount);

    // Disque d'eau placé à la main, et flèche de vent au sol : mis à jour chaque image
    // depuis les réglages, sans reconstruire le relief.
    const waterDisc = new Mesh(
      new CircleGeometry(0.38, 28),
      new MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.8, side: DoubleSide, depthWrite: false })
    );
    waterDisc.rotation.x = -Math.PI / 2;
    world.add(waterDisc);
    const windArrow = new Group();
    const shaft = new Mesh(new ConeGeometry(0.06, 0.55, 8), new MeshBasicMaterial({ color: 0xf8fafc }));
    shaft.rotation.x = Math.PI / 2;
    shaft.position.z = 0.28;
    windArrow.add(shaft);
    world.add(windArrow);

    const NICE = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
    let frame = 0;
    let lastSwitch = -Infinity;
    let armed = true;
    const now = () => performance.now();
    const clock = { t: 0 };
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!visible) return;
      clock.t += 0.016;
      if (!reduceMotion) {
        const s = 1 + 0.22 * Math.sin(clock.t * 2.2);
        ring.scale.set(s, s, s);
        (ring.material as MeshBasicMaterial).opacity = 0.45 + 0.4 * (0.5 + 0.5 * Math.sin(clock.t * 2.2));
      }
      controls.update();
      // Dézoomer élargit l'emprise : on recharge un terrain plus vaste plutôt que de
      // laisser la caméra s'éloigner d'un relief qui ne grandit pas. Les seuils sont
      // dissymétriques pour ne pas osciller entre deux niveaux.
      if ((frame++ & 7) === 0) {
        const d = camera.position.distanceTo(controls.target);
        // Un seul palier par geste : on ne réarme qu'une fois la vue revenue près
        // du cadrage nominal, sinon une salve de molette saute tous les niveaux.
        if (d < IDEAL_DIST * 1.2) armed = true;
        const i = resIndexRef.current;
        if (armed && now() - lastSwitch > 500) {
          if (d > IDEAL_DIST * 1.45 && i < DEM_RESOLUTIONS.length - 1) {
            if (applyLevelRef.current(i + 1)) {
              lastSwitch = now();
              armed = false;
              placeCamera(controls, camera, IDEAL_DIST);
            }
          } else if (d < IDEAL_DIST * 0.58 && i > 0) {
            if (applyLevelRef.current(i - 1)) {
              lastSwitch = now();
              armed = false;
              placeCamera(controls, camera, IDEAL_DIST * 0.8);
            }
          }
        }
      }
      if (needleRef.current) {
        needleRef.current.setAttribute("transform", `rotate(${(-controls.getAzimuthalAngle() * 180) / Math.PI} 22 22)`);
      }
      // Échelle : mètres réels par pixel, à la distance actuelle de la caméra.
      if (scaleBarRef.current && scaleLabelRef.current && viewH > 0) {
        const dist = Math.max(0.2, camera.position.distanceTo(controls.target));
        const visibleH = 2 * Math.tan((camera.fov * Math.PI) / 360) * dist;
        const mPerPx = ((visibleH * grid.widthM) / WORLD) / viewH;
        const raw = mPerPx * 110;
        let nice = NICE[NICE.length - 1];
        for (const s of NICE) if (s >= raw * 0.55) { nice = s; break; }
        const px = Math.max(36, Math.min(160, nice / mPerPx));
        scaleBarRef.current.style.width = `${px.toFixed(0)}px`;
        scaleLabelRef.current.textContent = nice >= 1000 ? `${nice / 1000} km`.replace(".", ",") : `${nice} m`;
      }
      const tv = tuneRef.current;
      waterDisc.visible = tv.waterMode >= 2;
      if (waterDisc.visible) {
        const reach = Math.min(0.46, (tv.waterDist / Math.max(1, grid.widthM)) * WORLD);
        const ang = (tv.waterFrom * Math.PI) / 180;
        const wx = Math.sin(ang) * reach;
        const wz = -Math.cos(ang) * reach;
        waterDisc.position.set(wx, toY(heightAtWorld(wx, wz)) + 0.04, wz);
        waterDisc.scale.setScalar(0.55 + tv.waterSize);
      }
      windArrow.visible = tv.groundWind >= 0;
      if (windArrow.visible) {
        // Le vent « vient du » nord : la flèche pointe vers le sud.
        const blow = ((tv.windFrom + 180) * Math.PI) / 180;
        windArrow.position.set(0.35, toY(heightAtWorld(0.35, 0)) + 0.35, 0);
        windArrow.rotation.y = blow;
        windArrow.scale.setScalar(0.7 + Math.min(2.2, tv.groundWind / 16));
      }
      renderer.render(scene, camera);
    };
    loop();

    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w === 0 || h === 0) return;
      viewW = w;
      viewH = h;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    });
    ro.observe(mount);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io?.disconnect();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      controls.dispose();
      scene.traverse((o) => {
        const m = o as Mesh;
        if (m.geometry) m.geometry.dispose();
        const material = m.material as { dispose?: () => void } | undefined;
        material?.dispose?.();
      });
      liveRef.current = null;
      renderer.dispose();
      if (el.parentNode === mount) mount.removeChild(el);
    };
  }, [grid, exagg, contours, showWater, sun, features, stations, lat, lon, webgl, onPick]);

  const profile = useMemo(() => {
    if (!grid) return null;
    const n = grid.n;
    const midI = (n - 1) / 2;
    const ew: number[] = [];
    const ns: number[] = [];
    for (let i = 0; i < n; i++) {
      ew.push(grid.elev[Math.round(midI) * n + i]);
      ns.push(grid.elev[i * n + Math.round(midI)]);
    }
    return { ew, ns, min: grid.min, max: grid.max };
  }, [grid]);

  const relief = grid ? Math.round(grid.max - grid.min) : 0;
  const contour = grid ? contourInterval(grid.max - grid.min) : 0;
  const pointElev = grid ? sampleDem(grid, lat, lon) : null;

  return (
    <section
      ref={sectionRef}
      id="relief"
      aria-labelledby="terrain3d-title"
      className="min-w-0 scroll-mt-4 overflow-hidden rounded-3xl border border-white/10 bg-white/[0.04] shadow-2xl shadow-black/30 backdrop-blur-xl"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 px-4 py-4 sm:px-5">
        <div>
          <h3 id="terrain3d-title" className="text-base font-semibold text-white">
            Le lieu en relief
          </h3>
          <p className="text-xs text-slate-400">
            {grid
              ? `${grid.n} × ${grid.n} altitudes · ${(grid.widthM / 1000).toFixed(1).replace(".", ",")} km de large · dénivelé ${relief} m`
              : "Modèle de terrain Copernicus (90 m) et occupation du sol OpenStreetMap"}
          </p>
          <p className="text-[11px] text-slate-500">Dézoomez pour élargir le terrain affiché.</p>
          {pointElev !== null && (
            <p className="mt-0.5 text-xs text-sky-200">
              Point à <strong className="font-semibold tabular-nums">{Math.round(pointElev)} m</strong>
              {stations.length > 0 && (
                <>
                  {" "}· {stations.length} station{stations.length > 1 ? "s" : ""} de mesure dans la vue
                </>
              )}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Rose des vents : suit l'azimut de la caméra */}
          <div className="relative h-11 w-11 shrink-0" title="Orientation de la vue">
            <svg viewBox="0 0 44 44" className="h-full w-full" aria-hidden="true">
              <circle cx="22" cy="22" r="20" fill="rgba(2,6,23,.6)" stroke="rgba(255,255,255,.14)" />
              <g ref={needleRef} transform="rotate(0 22 22)">
                <path d="M22 5 L26 22 L22 19 L18 22 Z" fill="#f87171" />
                <path d="M22 39 L18 22 L22 25 L26 22 Z" fill="rgba(226,232,240,.5)" />
              </g>
              <text x="22" y="13" textAnchor="middle" fontSize="8" fontWeight="700" fill="#fecaca">N</text>
            </svg>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wider text-slate-400">Échelle</div>
            <div className="mt-1 flex items-center justify-end gap-1.5">
              <span ref={scaleBarRef} className="inline-block h-1 w-16 rounded-sm bg-white" />
              <span ref={scaleLabelRef} className="text-xs font-semibold tabular-nums text-slate-100">
                —
              </span>
            </div>
            <p className="text-[10px] text-slate-500">suit le zoom</p>
          </div>
        </div>
      </header>

      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Scène */}
        <div className="relative min-w-0 overflow-hidden">
          <div
            ref={mountRef}
            className="relative isolate h-[340px] w-full overflow-hidden sm:h-[420px] lg:h-[480px]"
            style={{ background: "radial-gradient(120% 90% at 50% 0%, #0d1a2b 0%, #060b14 70%)" }}
          />
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-950/55 text-sm text-slate-200 backdrop-blur-sm">
              <span className="flex items-center gap-3">
                <span aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-2 border-slate-600 border-t-sky-300" />
                {progress ? `Relief ${res.label.toLowerCase()} · ${progress}` : "Chargement du modèle de terrain…"}
              </span>
            </div>
          )}
          {note && !loading && (
            <div className="absolute inset-x-3 bottom-14 z-10 flex items-start justify-between gap-2 rounded-xl border border-amber-400/30 bg-amber-500/15 px-3 py-2 text-xs text-amber-100 backdrop-blur">
              <span>{note}</span>
              <button
                type="button"
                onClick={() => setAttempt((n) => n + 1)}
                className="shrink-0 rounded-lg bg-amber-400/20 px-2 py-1 text-[11px] font-semibold hover:bg-amber-400/30"
              >
                Réessayer
              </button>
            </div>
          )}
          {!webgl && (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-slate-300">
              Ce navigateur ne permet pas l'affichage 3D. La coupe de terrain ci-dessous reste disponible.
            </div>
          )}
          {dragging && (
            <div className="pointer-events-none absolute left-3 top-3 rounded-xl border border-sky-400/40 bg-slate-950/85 px-3 py-2 text-xs text-sky-100 backdrop-blur">
              <div className="font-semibold">
                {dragging.lat.toFixed(5)}, {dragging.lon.toFixed(5)}
              </div>
              <div className="text-slate-300">Altitude {Math.round(dragging.elev)} m · relâchez pour appliquer</div>
            </div>
          )}
          {hovered && (
            <div className="pointer-events-none absolute right-3 top-3 rounded-xl border border-emerald-400/40 bg-slate-950/85 px-3 py-1.5 text-xs text-emerald-100 backdrop-blur">
              Station {hovered}
            </div>
          )}

          {/* Légende d'altitude */}
          {grid && (
            <div className="pointer-events-none absolute bottom-3 left-3 rounded-xl border border-white/10 bg-slate-950/75 px-3 py-2 backdrop-blur">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">Altitude</div>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-[11px] tabular-nums text-slate-300">{Math.round(grid.min)}</span>
                <span
                  aria-hidden="true"
                  className="h-2 w-24 rounded-full"
                  style={{ background: `linear-gradient(90deg, ${RAMP.low}, ${RAMP.mid} 55%, ${RAMP.high})` }}
                />
                <span className="text-[11px] tabular-nums text-slate-300">{Math.round(grid.max)} m</span>
              </div>
              {contours && (
                <div className="mt-0.5 text-[10px] text-slate-400">courbes tous les {contour} m</div>
              )}
            </div>
          )}

          {/* Soleil */}
          <div className="pointer-events-none absolute bottom-3 right-3 rounded-xl border border-white/10 bg-slate-950/75 px-3 py-2 text-right backdrop-blur">
            <div className="text-[10px] uppercase tracking-wider text-slate-400">Éclairage</div>
            <div className="text-[11px] tabular-nums text-slate-200">
              {sunLabel} · {sun.altitude > 0 ? `soleil à ${Math.round(sun.altitude)}°` : "nuit"}
            </div>
          </div>
        </div>

        {/* Réglages */}
        <div className="relative z-20 flex min-w-0 flex-col gap-4 border-t border-white/10 bg-slate-950 px-4 py-4 sm:px-5 lg:border-l lg:border-t-0">
          <fieldset className="min-w-0">
            <legend className="text-xs font-semibold uppercase tracking-wider text-slate-400">Vue</legend>
            <div className="mt-2 space-y-3">
              <Field label="Emprise du terrain">
                <div className="grid grid-cols-3 gap-1 rounded-xl bg-white/5 p-1">
                  {DEM_RESOLUTIONS.map((r, i) => (
                    <button
                      key={r.id}
                      type="button"
                      aria-pressed={res.id === r.id}
                      aria-busy={loading && res.id === r.id}
                      onClick={() => {
                        setNote(null);
                        applyLevel(i);
                      }}
                      title={r.hint}
                      className={cn(
                        "rounded-lg px-1 py-1.5 text-[11px] font-semibold transition",
                        res.id === r.id
                          ? "bg-sky-500 text-white shadow ring-1 ring-sky-300/50"
                          : "text-slate-200 hover:bg-white/10"
                      )}
                    >
                      {loading && res.id === r.id ? "…" : r.label}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[10px] text-slate-500">
                  {res.hint}
                  {progress ? ` · chargement ${progress}` : ""}
                </p>
              </Field>
              <Slider
                label="Exagération verticale"
                value={exagg}
                min={1}
                max={6}
                step={0.5}
                display={`${exagg.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ×`}
                onChange={setExagg}
              />
              <Slider
                label="Heure d'éclairage"
                value={sunOffsetH}
                min={-12}
                max={36}
                step={1}
                display={sunLabel}
                onChange={setSunOffsetH}
                help="Déplace le soleil pour voir quel versant reçoit l'énergie — le contraste adret / ubac en dépend."
              />
              <Field label="Regarder vers">
                <div className="flex gap-1 rounded-xl bg-white/5 p-1" role="group" aria-label="Orientation de la caméra">
                  {(
                    [
                      ["N", 0, "Regarder vers le nord"],
                      ["E", -90, "Regarder vers l'est"],
                      ["S", 180, "Regarder vers le sud"],
                      ["O", 90, "Regarder vers l'ouest"],
                      ["⬒", 0, "Vue du dessus"],
                    ] as const
                  ).map(([label, az, title]) => (
                    <button
                      key={label}
                      type="button"
                      title={title}
                      aria-label={title}
                      onClick={() => flyToView(az, label === "⬒" ? 12 : 55)}
                      className="flex-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-slate-300 transition hover:bg-white/10 hover:text-white active:bg-white/15"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </Field>
              <div className="flex flex-wrap gap-1.5">
                <Chip pressed={contours} onClick={() => setContours((v) => !v)}>
                  Courbes de niveau
                </Chip>
                <Chip pressed={showWater} onClick={() => setShowWater((v) => !v)}>
                  Eau et forêts
                </Chip>
                <Chip pressed={spin} onClick={toggleSpin}>
                  ⟳ Rotation auto
                </Chip>
                <Chip
                  pressed={false}
                  onClick={() => {
                    setExagg(2);
                    setContours(true);
                    setShowWater(true);
                    setSunOffsetH(0);
                    applyLevel(1);
                    if (liveRef.current) placeCamera(liveRef.current.controls, liveRef.current.camera, IDEAL_DIST);
                    if (spinRef.current) toggleSpin();
                    flyToView(0, 55);
                  }}
                >
                  Réinitialiser la vue
                </Chip>
              </div>
            </div>
          </fieldset>

          {/* Coupe de terrain : lisible même sans WebGL */}
          {profile && (
            <fieldset className="min-w-0">
              <legend className="text-xs font-semibold uppercase tracking-wider text-slate-400">Coupes à travers le point</legend>
              <Profile profile={profile} label="ouest → est" values={profile.ew} />
              <Profile profile={profile} label="nord → sud" values={profile.ns} />
            </fieldset>
          )}

          <TerrainTuner
            tune={tune}
            onChange={onTune}
            deltaRh={deltaRh}
            deltaSigma={deltaSigma}
            rhNow={rhNow}
            onExagg={setExagg}
          />
        </div>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] text-slate-400">{label}</div>
      {children}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
  help,
  accent = "#38bdf8",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
  help?: string;
  accent?: string;
}) {
  const pct = ((value - min) / Math.max(1e-9, max - min)) * 100;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label className="text-[11px] text-slate-400">{label}</label>
        <span className="text-[11px] font-semibold tabular-nums text-slate-100">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none"
        style={{
          background: `linear-gradient(90deg, ${accent} ${pct}%, rgba(255,255,255,.12) ${pct}%)`,
        }}
      />
      {help && <p className="mt-1 text-[10px] leading-snug text-slate-500">{help}</p>}
    </div>
  );
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "rounded-lg px-2.5 py-1 text-[11px] font-medium transition",
        pressed ? "bg-sky-500/25 text-sky-100 ring-1 ring-sky-400/40" : "bg-white/5 text-slate-300 hover:bg-white/10"
      )}
    >
      {children}
    </button>
  );
}

function Profile({ profile, label, values }: { profile: { min: number; max: number }; label: string; values: number[] }) {
  const W = 300;
  const Hh = 46;
  const span = Math.max(1, profile.max - profile.min);
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * W).toFixed(1)},${(Hh - ((v - profile.min) / span) * (Hh - 6) - 3).toFixed(1)}`)
    .join(" ");
  return (
    <div className="mt-1.5">
      <div className="flex items-baseline justify-between text-[10px] text-slate-400">
        <span>{label}</span>
        <span className="tabular-nums">
          {Math.round(profile.min)} – {Math.round(profile.max)} m
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${Hh}`} className="h-12 w-full" role="img" aria-label={`Coupe de terrain ${label}`}>
        <polyline points={`0,${Hh} ${pts} ${W},${Hh}`} fill="rgba(56,189,248,.14)" stroke="none" />
        <polyline points={pts} fill="none" stroke="#7dd3fc" strokeWidth="1.4" strokeLinejoin="round" />
        <line x1={W / 2} y1="0" x2={W / 2} y2={Hh} stroke="rgba(255,255,255,.35)" strokeDasharray="2 2" />
      </svg>
    </div>
  );
}

