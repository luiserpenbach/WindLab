import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type {
  AnalysisResult,
  Curve,
  LinerSpec,
  MachineSpec,
  PathResult,
  SimulationResult,
  ThicknessMapResult,
} from '../api/types';
import { frameIndexAt } from '../state/playback';
import { layerColors } from './colors';
import { NODATA_RGB, type Rgb } from './colormaps';

/*
 * World frame: x = vessel axis (part frame z, 0 = cylinder mid-plane),
 * y up (payout eye side), z towards the default camera.
 *
 * Axisymmetric geometry (liner, layers, bosses, shaft) lives in `staticGroup`;
 * everything that must visibly rotate with the mandrel (fibre, chuck marker,
 * index lines) lives in `mandrelGroup`, rotated about +x.
 *
 * Section view: lathes are generated over phi in [pi/2, 3pi/2] which maps to
 * world z <= 0 (the half away from the camera), and filled cap polygons are
 * added in the z = 0 plane so the wall build-up is visible.
 */

const SEG = 72;
const PHI_SECTION_START = Math.PI / 2;
const DEG = Math.PI / 180;

export interface ViewerTheme {
  background: string;
  grid: string;
  gridCenter: string;
  text: string;
}

export interface VesselData {
  analysis: AnalysisResult | null;
  liner: LinerSpec;
  layers: { id: string; type: 'hoop' | 'helical' }[];
}

interface SimVisual {
  sim: SimulationResult;
  /** For each simulation frame, the index of the nearest path point (cached per path). */
  pathIndex: { path: PathResult; idx: Int32Array } | null;
  laid: THREE.Line;
  laidPos: Float32Array;
  free: THREE.Line;
  eye: THREE.Group;
  roller: THREE.Mesh;
  carriage: THREE.Group;
  arm: THREE.Mesh;
  railY: number;
}

const FIBRE_COLOR = '#e34948';

/**
 * Colour painted on the outer vessel surface.
 * - `z`: a quantity along the axis (shell FE), as lathe vertex colours.
 * - `map`: a band-level thickness map as a texture on one layer's surface
 *   (u = phi, v = liner meridian arclength); layers after it are hidden.
 */
export type SurfaceOverlay =
  | { type: 'z'; z: number[]; values: (number | null)[]; color: (v: number) => Rgb }
  | { type: 'map'; map: ThicknessMapResult; color: (v: number) => Rgb };

/** Nodal displacements (shell FE) drawn magnified by `scale`. */
export interface Deformation {
  z: number[];
  ur: number[];
  uz: number[];
  scale: number;
}

/** Linear interpolation on ascending x, clamped at the ends. */
function interpAsc(x: ArrayLike<number>, y: ArrayLike<number>, v: number): number {
  const n = x.length;
  if (!n) return 0;
  if (v <= x[0]) return y[0];
  if (v >= x[n - 1]) return y[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (x[m] <= v) lo = m;
    else hi = m;
  }
  const dx = x[hi] - x[lo];
  return dx ? y[lo] + ((y[hi] - y[lo]) * (v - x[lo])) / dx : y[lo];
}

/** Cumulative chord length of a (z, r) curve. */
function arcLength(c: Curve): Float64Array {
  const s = new Float64Array(c.x.length);
  for (let i = 1; i < c.x.length; i++) s[i] = s[i - 1] + Math.hypot(c.x[i] - c.x[i - 1], c.y[i] - c.y[i - 1]);
  return s;
}

/** Every k-th point of a curve (keeping the last), at most `maxPts`. */
function strideIndices(n: number, maxPts: number): number[] {
  const k = Math.max(1, Math.ceil(n / maxPts));
  const out: number[] = [];
  for (let i = 0; i < n; i += k) out.push(i);
  if (out[out.length - 1] !== n - 1) out.push(n - 1);
  return out;
}

const _col = new THREE.Color();
function toLinear(rgb: Rgb): [number, number, number] {
  _col.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
  return [_col.r, _col.g, _col.b];
}

/**
 * Map every contact point of a simulation to the nearest point of the fibre
 * path. Both run along the same fibre in the same order, so the search is a
 * window around the arclength-proportional guess instead of all-pairs.
 */
function mapContactsToPath(contact: number[][], points: number[][]): Int32Array {
  const cum = (pts: number[][]) => {
    const s = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      s[i] = s[i - 1] + Math.hypot((b[0] ?? 0) - (a[0] ?? 0), (b[1] ?? 0) - (a[1] ?? 0), (b[2] ?? 0) - (a[2] ?? 0));
    }
    return s;
  };
  const sc = cum(contact);
  const sp = cum(points);
  const tc = sc[sc.length - 1] || 1;
  const tp = sp[sp.length - 1] || 1;
  const n = points.length;
  const w = Math.max(24, Math.ceil(n / 60));
  const out = new Int32Array(contact.length);
  let g = 0;
  for (let i = 0; i < contact.length; i++) {
    const target = (sc[i] / tc) * tp;
    while (g < n - 1 && sp[g + 1] <= target) g++;
    const c = contact[i];
    let best = g;
    let bd = Infinity;
    for (let k = Math.max(0, g - w); k <= Math.min(n - 1, g + w); k++) {
      const q = points[k];
      const d = ((q[0] ?? 0) - (c[0] ?? 0)) ** 2 + ((q[1] ?? 0) - (c[1] ?? 0)) ** 2 + ((q[2] ?? 0) - (c[2] ?? 0)) ** 2;
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    out[i] = best;
  }
  return out;
}

function disposeTree(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = (m as { material?: THREE.Material | THREE.Material[] }).material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) mat.dispose();
    const sp = c as THREE.Sprite;
    if (sp.isSprite) (sp.material.map as THREE.Texture | null)?.dispose();
  });
}

function clearGroup(g: THREE.Group) {
  for (const c of [...g.children]) {
    g.remove(c);
    disposeTree(c);
  }
}

/** Linear interpolation of r(z) on a curve with monotonic x. */
function interpCurve(c: Curve, z: number): number {
  const x = c.x;
  const n = x.length;
  if (!n) return 0;
  const asc = x[n - 1] >= x[0];
  if (asc ? z <= x[0] : z >= x[0]) return c.y[0];
  if (asc ? z >= x[n - 1] : z <= x[n - 1]) return c.y[n - 1];
  for (let i = 1; i < n; i++) {
    const a = x[i - 1];
    const b = x[i];
    if ((z >= a && z <= b) || (z <= a && z >= b)) {
      const t = b === a ? 0 : (z - a) / (b - a);
      return c.y[i - 1] + t * (c.y[i] - c.y[i - 1]);
    }
  }
  return c.y[n - 1];
}

/**
 * Profile (z, r) curve -> lathe points Vector2(r, z), simplified so that lathes
 * stay light: points closer than `tol` mm to the chord of their neighbours
 * are dropped (Douglas-Peucker-like greedy pass), capped at `maxPts`.
 */
function curveToPoints(c: Curve, tol = 0.05, maxPts = 220): THREE.Vector2[] {
  const raw: THREE.Vector2[] = [];
  const n = Math.min(c.x.length, c.y.length);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(c.x[i]) && Number.isFinite(c.y[i])) raw.push(new THREE.Vector2(Math.max(0, c.y[i]), c.x[i]));
  }
  if (raw.length <= 3) return raw;
  const keep = new Uint8Array(raw.length);
  keep[0] = keep[raw.length - 1] = 1;
  const stack: [number, number][] = [[0, raw.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pa = raw[a];
    const pb = raw[b];
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    let best = -1;
    let bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((raw[i].x - pa.x) * dy - (raw[i].y - pa.y) * dx) / len;
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  let out = raw.filter((_, i) => keep[i]);
  if (out.length > maxPts) {
    const step = out.length / maxPts;
    out = Array.from({ length: maxPts }, (_, k) => out[Math.floor(k * step)]).concat(out[out.length - 1]);
  }
  return out;
}

/** Lathe around world x from (r, z) profile points (Vector2(r, z)). */
function latheX(pts: THREE.Vector2[], section: boolean): THREE.BufferGeometry {
  const g = section
    ? new THREE.LatheGeometry(pts, SEG / 2, PHI_SECTION_START, Math.PI)
    : new THREE.LatheGeometry(pts, SEG);
  g.rotateZ(-Math.PI / 2);
  return g;
}

/**
 * Lathe with texture coordinates u = map azimuth / 2pi and v = `vs[j]` per
 * profile point. The map azimuth phi_m of a path point is y = r cos phi_m,
 * z = -r sin phi_m (see PathResult); the lathe puts y = -r sin phi_L,
 * z = r cos phi_L after rotating about z, so phi_m = -phi_L - pi/2.
 */
function latheXMapped(pts: THREE.Vector2[], vs: number[], section: boolean): THREE.BufferGeometry {
  const segs = section ? SEG / 2 : SEG;
  const start = section ? PHI_SECTION_START : 0;
  const len = section ? Math.PI : Math.PI * 2;
  const g = latheX(pts, section);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const n = pts.length;
  for (let i = 0; i <= segs; i++) {
    const phiL = start + (i / segs) * len;
    const u = (-phiL - Math.PI / 2) / (2 * Math.PI);
    for (let j = 0; j < n; j++) uv.setXY(i * n + j, u, vs[j]);
  }
  uv.needsUpdate = true;
  return g;
}

/** Per-vertex colours for a lathe from one colour per profile point. */
function setLatheColors(g: THREE.BufferGeometry, rgb: [number, number, number][]) {
  const n = rgb.length;
  const count = (g.getAttribute('position') as THREE.BufferAttribute).count;
  const col = new Float32Array(count * 3);
  for (let k = 0; k < count; k++) {
    const c = rgb[k % n];
    col[k * 3] = c[0];
    col[k * 3 + 1] = c[1];
    col[k * 3 + 2] = c[2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

function makeTextSprite(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.font = 'bold 40px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, 32, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(0.5, 0.5, 0.5);
  return s;
}

export class VesselViewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private staticGroup = new THREE.Group();
  private mandrelGroup = new THREE.Group();
  private machineGroup = new THREE.Group();
  private pathGroup = new THREE.Group();
  private grid: THREE.GridHelper | null = null;
  private gizmoScene = new THREE.Scene();
  private gizmoCamera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
  private gizmoLabels: THREE.Sprite[] = [];
  private ro: ResizeObserver;
  private frame = 0;
  private disposed = false;
  private host: HTMLElement;

  private data: VesselData | null = null;
  private section = false;
  private showLayers = true;
  private showGrid = true;
  private selectedLayer: string | null = null;
  private layerCutoff: string | null = null;
  private layerMeshes = new Map<string, THREE.Object3D[]>();
  private maxR = 100;
  private span: [number, number] = [-250, 250];
  private sectionPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  private simVis: SimVisual | null = null;
  private pathData: PathResult | null = null;
  /** Linear-RGB vertex colours of the path (null = plain colour). */
  private pathColors: Float32Array | null = null;
  private currentTime = 0;
  private hasFitted = false;
  private overlay: SurfaceOverlay | null = null;
  private deformation: Deformation | null = null;
  private mapTexture: { map: ThicknessMapResult; color: (v: number) => Rgb; tex: THREE.DataTexture } | null = null;
  private theme: ViewerTheme = { background: '#f4f4f2', grid: '#d8d7d0', gridCenter: '#b8b7ae', text: '#333' };

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.autoClear = false;
    this.renderer.domElement.className = 'viewer-canvas';
    this.renderer.domElement.setAttribute('aria-label', '3D vessel view (drag to orbit, scroll to zoom)');
    this.renderer.domElement.tabIndex = 0;
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 50000);
    this.camera.position.set(250, 380, 900);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener('change', () => this.invalidate());
    this.controls.listenToKeyEvents?.(this.renderer.domElement);

    // lights
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x60646c, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(300, 800, 600);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.7);
    rim.position.set(-600, -200, -500);
    this.scene.add(rim);

    this.scene.add(this.staticGroup, this.mandrelGroup, this.machineGroup);
    this.mandrelGroup.add(this.pathGroup);

    this.buildGizmo();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
  }

  // ---------------------------------------------------------------- public API
  setTheme(t: ViewerTheme) {
    this.theme = t;
    this.scene.background = new THREE.Color(t.background);
    this.rebuildGrid();
    this.gizmoLabels.forEach((s) => s.material.color.set(t.text));
    this.invalidate();
  }

  setView(opts: { section: boolean; showLayers: boolean; showGrid: boolean }) {
    const rebuild = opts.section !== this.section || opts.showLayers !== this.showLayers;
    this.section = opts.section;
    this.showLayers = opts.showLayers;
    this.showGrid = opts.showGrid;
    if (this.grid) this.grid.visible = this.showGrid;
    if (rebuild) this.rebuildVessel();
    this.applyClipping();
    this.invalidate();
  }

  setVessel(d: VesselData) {
    this.data = d;
    this.rebuildVessel();
    if (!this.hasFitted && d.analysis) {
      this.fit();
      this.hasFitted = true;
    }
  }

  /** Show only layers wound before `id` (null = all layers). */
  setLayerCutoff(id: string | null) {
    if (id === this.layerCutoff) return;
    this.layerCutoff = id;
    this.rebuildVessel();
  }

  /** Paint the outer surface (FE along z) or one layer surface (thickness map). */
  setOverlay(o: SurfaceOverlay | null) {
    if (o === this.overlay) return;
    this.overlay = o;
    this.rebuildVessel();
  }

  /** Show the vessel deformed by the FE displacements (null = undeformed). */
  setDeformation(d: Deformation | null) {
    if (d === this.deformation) return;
    this.deformation = d;
    this.rebuildVessel();
  }

  setSelectedLayer(id: string | null) {
    this.selectedLayer = id;
    this.applyLayerHighlight();
    this.invalidate();
  }

  /**
   * Show a fibre path. `colors` (sRGB 0..1, 3 per point) switches to per-vertex
   * colouring; the laid fibre of a running simulation then uses the same colours.
   */
  setPath(p: PathResult | null, color = FIBRE_COLOR, colors: Float32Array | null = null) {
    clearGroup(this.pathGroup);
    this.pathData = p;
    this.pathColors = null;
    if (p && p.points.length > 1) {
      const pos = new Float32Array(p.points.length * 3);
      p.points.forEach((q, i) => this.lift(q, pos, i * 3, 0.25));
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      if (colors && colors.length === pos.length) {
        const lin = new Float32Array(colors.length);
        const c = new THREE.Color();
        for (let i = 0; i < colors.length; i += 3) {
          c.setRGB(colors[i], colors[i + 1], colors[i + 2], THREE.SRGBColorSpace);
          lin[i] = c.r;
          lin[i + 1] = c.g;
          lin[i + 2] = c.b;
        }
        g.setAttribute('color', new THREE.BufferAttribute(lin, 3));
        this.pathColors = lin;
      }
      const m = new THREE.LineBasicMaterial({
        color: this.pathColors ? '#ffffff' : color,
        vertexColors: !!this.pathColors,
        transparent: true,
        opacity: this.pathOpacity(),
        depthWrite: false,
      });
      const line = new THREE.Line(g, m);
      line.name = 'path';
      this.pathGroup.add(line);
    }
    this.colorLaidFibre();
    this.applyClipping();
    this.invalidate();
  }

  setSimulation(sim: SimulationResult | null, machine: MachineSpec | null) {
    clearGroup(this.machineGroup);
    if (this.simVis) {
      this.mandrelGroup.remove(this.simVis.laid);
      disposeTree(this.simVis.laid);
    }
    this.simVis = null;
    this.mandrelGroup.rotation.x = 0;
    if (sim && sim.frames.t.length && machine) this.buildMachine(sim);
    // dim the static path once a simulation is present
    const pathLine = this.pathGroup.getObjectByName('path') as THREE.Line | undefined;
    if (pathLine) (pathLine.material as THREE.LineBasicMaterial).opacity = this.pathOpacity();
    this.colorLaidFibre();
    this.applyClipping();
    this.setTime(this.currentTime);
  }

  setTime(t: number) {
    this.currentTime = t;
    const v = this.simVis;
    if (!v) {
      this.invalidate();
      return;
    }
    const f = v.sim.frames;
    const i = frameIndexAt(f.t, t);
    const ang = (f.mandrel[i] ?? 0) * DEG;
    this.mandrelGroup.rotation.x = ang;
    const cx = f.carriage[i] ?? 0;
    const cy = f.crossfeed[i] ?? this.maxR + 20;
    v.eye.position.set(cx, cy, 0);
    v.eye.rotation.y = (f.eye[i] ?? 0) * DEG;
    v.carriage.position.x = cx;
    const armLen = Math.max(1, v.railY - cy);
    v.arm.scale.y = armLen;
    v.arm.position.set(cx, cy + armLen / 2, 0);
    v.laid.geometry.setDrawRange(0, i + 1);
    // free fibre: eye -> rotated contact point
    const c = f.contact[i];
    if (c) {
      const p = new THREE.Vector3(c[0], c[1], c[2]).applyAxisAngle(new THREE.Vector3(1, 0, 0), ang);
      const pos = v.free.geometry.getAttribute('position') as THREE.BufferAttribute;
      pos.setXYZ(0, cx, cy - 6, 0);
      pos.setXYZ(1, p.x, p.y, p.z);
      pos.needsUpdate = true;
      v.free.geometry.computeBoundingSphere();
    }
    this.invalidate();
  }

  fit() {
    const box = new THREE.Box3();
    box.expandByObject(this.staticGroup);
    if (this.simVis) box.expandByObject(this.machineGroup);
    if (box.isEmpty()) box.set(new THREE.Vector3(-250, -100, -100), new THREE.Vector3(250, 100, 100));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const fov = this.camera.fov * DEG;
    const aspect = Math.max(0.3, this.camera.aspect);
    const dist = (sphere.radius / Math.sin(Math.min(fov, fov * aspect) / 2)) * 1.05;
    const dir = new THREE.Vector3(0.35, 0.45, 1).normalize();
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    this.camera.near = Math.max(0.5, dist / 200);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.invalidate();
  }

  /** Snapshot as PNG data URL. */
  snapshot(): string {
    this.render();
    return this.renderer.domElement.toDataURL('image/png');
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.ro.disconnect();
    this.controls.dispose();
    this.mapTexture?.tex.dispose();
    disposeTree(this.scene);
    disposeTree(this.gizmoScene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------------------------------------------------------------- internals
  private pathOpacity(): number {
    if (!this.simVis) return 0.95;
    // coloured paths stay readable behind the laid fibre
    return this.pathColors ? 0.45 : 0.28;
  }

  /** Colour the laid (simulated) fibre like the path, or plain red. */
  private colorLaidFibre() {
    const v = this.simVis;
    if (!v) return;
    const g = v.laid.geometry;
    const mat = v.laid.material as THREE.LineBasicMaterial;
    const p = this.pathData;
    const colors = this.pathColors;
    const contact = v.sim.frames.contact;
    if (p && colors && p.layer_id === v.sim.layer_id && p.points.length > 1 && contact.length) {
      if (!v.pathIndex || v.pathIndex.path !== p) v.pathIndex = { path: p, idx: mapContactsToPath(contact, p.points) };
      const idx = v.pathIndex.idx;
      const n = v.laidPos.length / 3;
      const lc = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const j = (idx[i] ?? 0) * 3;
        lc[i * 3] = colors[j];
        lc[i * 3 + 1] = colors[j + 1];
        lc[i * 3 + 2] = colors[j + 2];
      }
      g.setAttribute('color', new THREE.BufferAttribute(lc, 3));
      mat.vertexColors = true;
      mat.color.set('#ffffff');
    } else {
      if (g.getAttribute('color')) g.deleteAttribute('color');
      mat.vertexColors = false;
      mat.color.set(FIBRE_COLOR);
    }
    mat.needsUpdate = true;
  }

  private lift(q: number[], out: Float32Array, o: number, dr: number) {
    const x = q[0] ?? 0;
    const y = q[1] ?? 0;
    const z = q[2] ?? 0;
    const r = Math.hypot(y, z);
    const k = r > 1e-6 ? (r + dr) / r : 1;
    out[o] = x;
    out[o + 1] = y * k;
    out[o + 2] = z * k;
  }

  private invalidate() {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const moving = this.controls.update();
      this.render();
      if (moving) this.invalidate();
    });
  }

  private resize() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  private render() {
    const r = this.renderer;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    r.setViewport(0, 0, w, h);
    r.setScissorTest(false);
    r.clear();
    r.render(this.scene, this.camera);
    // axis gizmo, bottom-left corner
    const s = 84;
    this.gizmoCamera.position.copy(this.camera.position).sub(this.controls.target).setLength(4);
    this.gizmoCamera.quaternion.copy(this.camera.quaternion);
    r.clearDepth();
    r.setScissorTest(true);
    r.setScissor(8, 8, s, s);
    r.setViewport(8, 8, s, s);
    r.render(this.gizmoScene, this.gizmoCamera);
    r.setScissorTest(false);
  }

  private buildGizmo() {
    const axes: [THREE.Vector3, number, string][] = [
      [new THREE.Vector3(1, 0, 0), 0xe34948, 'x'],
      [new THREE.Vector3(0, 1, 0), 0x1baf7a, 'y'],
      [new THREE.Vector3(0, 0, 1), 0x2a78d6, 'z'],
    ];
    for (const [dir, color, label] of axes) {
      const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(), 1, color, 0.28, 0.16);
      this.gizmoScene.add(arrow);
      const sp = makeTextSprite(label, '#ffffff');
      sp.position.copy(dir.clone().multiplyScalar(1.35));
      sp.material.color.set(this.theme.text);
      this.gizmoLabels.push(sp);
      this.gizmoScene.add(sp);
    }
  }

  private rebuildGrid() {
    if (this.grid) {
      this.scene.remove(this.grid);
      disposeTree(this.grid);
    }
    const len = Math.max(200, this.span[1] - this.span[0]);
    const size = Math.ceil((len * 1.8) / 100) * 100;
    const grid = new THREE.GridHelper(size, size / 20, this.theme.gridCenter, this.theme.grid);
    grid.position.set((this.span[0] + this.span[1]) / 2, -this.maxR * 1.25 - 20, 0);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.8;
    grid.visible = this.showGrid;
    this.grid = grid;
    this.scene.add(grid);
  }

  private material(color: string, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
    return new THREE.MeshStandardMaterial({
      color,
      side: THREE.DoubleSide,
      metalness: 0.1,
      roughness: 0.55,
      ...opts,
    });
  }

  /** Add a filled cap polygon (z, r) in the z = 0 plane, mirrored to both sides. */
  private addCap(group: THREE.Group, outline: [number, number][], mat: THREE.Material, into?: THREE.Object3D[]) {
    if (outline.length < 3) return;
    const shape = new THREE.Shape(outline.map(([z, r]) => new THREE.Vector2(z, r)));
    const geo = new THREE.ShapeGeometry(shape);
    for (const sgn of [1, -1]) {
      const m = new THREE.Mesh(geo.clone(), mat);
      m.scale.y = sgn;
      m.renderOrder = 2;
      group.add(m);
      into?.push(m);
    }
    geo.dispose();
  }

  /** Texture of a thickness map (rows = map rows along s, columns = phi), cached per map. */
  private thicknessTexture(map: ThicknessMapResult, color: (v: number) => Rgb): THREE.DataTexture | null {
    const c = this.mapTexture;
    if (c && c.map === map && c.color === color) return c.tex;
    c?.tex.dispose();
    this.mapTexture = null;
    const rows = map.t.length;
    const cols = rows ? map.t[0].length : 0;
    if (!rows || !cols) return null;
    const data = new Uint8Array(rows * cols * 4);
    for (let i = 0; i < rows; i++) {
      const row = map.t[i];
      for (let j = 0; j < cols; j++) {
        const v = row[j];
        const rgb = v == null || !Number.isFinite(v) ? NODATA_RGB : color(v);
        const o = (i * cols + j) * 4;
        data[o] = Math.round(rgb[0] * 255);
        data[o + 1] = Math.round(rgb[1] * 255);
        data[o + 2] = Math.round(rgb[2] * 255);
        data[o + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, cols, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    tex.needsUpdate = true;
    this.mapTexture = { map, color, tex };
    return tex;
  }

  /** Displace a (z, r) curve by the magnified FE displacements. */
  private deformCurve(c: Curve): Curve {
    const d = this.deformation;
    if (!d || !d.scale || !d.z.length) return c;
    // remove the rigid-body axial shift: z = 0 stays put
    const uz0 = interpAsc(d.z, d.uz, 0);
    const x = new Array<number>(c.x.length);
    const y = new Array<number>(c.y.length);
    for (let i = 0; i < c.x.length; i++) {
      const z = c.x[i];
      x[i] = z + d.scale * (interpAsc(d.z, d.uz, z) - uz0);
      y[i] = Math.max(0, c.y[i] + d.scale * interpAsc(d.z, d.ur, z));
    }
    return { x, y };
  }

  /** Axial shift of a vessel end (bosses move with the dome they close). */
  private deformShift(z: number): number {
    const d = this.deformation;
    if (!d || !d.scale || !d.z.length) return 0;
    return d.scale * (interpAsc(d.z, d.uz, z) - interpAsc(d.z, d.uz, 0));
  }

  /**
   * Lathe of the painted surface: vertex colours (FE along z) or the thickness
   * texture. `surface` is the undeformed curve; `drawn` the curve to draw.
   */
  private overlayMesh(surface: Curve, drawn: Curve, linerOuter: Curve | null): THREE.Mesh | null {
    const o = this.overlay;
    if (!o) return null;
    const idx = strideIndices(drawn.x.length, 420);
    const pts = idx.map((i) => new THREE.Vector2(Math.max(0, drawn.y[i]), drawn.x[i]));
    if (pts.length < 2) return null;
    // pulled towards the camera: the painted surface can coincide with the one below (zero thickness)
    const matOpts: THREE.MeshStandardMaterialParameters = {
      color: '#ffffff',
      side: THREE.DoubleSide,
      metalness: 0.05,
      roughness: 0.75,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    };
    if (o.type === 'z') {
      const g = latheX(pts, this.section);
      const neutral = toLinear(NODATA_RGB);
      const zs = o.z;
      const vals = o.values;
      const rgb = idx.map((i) => {
        const z = surface.x[i];
        // nearest element value (the FE arrays are dense)
        let lo = 0;
        let hi = zs.length - 1;
        if (hi < 0) return neutral;
        while (hi - lo > 1) {
          const m = (lo + hi) >> 1;
          if (zs[m] <= z) lo = m;
          else hi = m;
        }
        const k = Math.abs(zs[hi] - z) < Math.abs(zs[lo] - z) ? hi : lo;
        const v = vals[k];
        return v == null || !Number.isFinite(v) ? neutral : toLinear(o.color(v));
      });
      setLatheColors(g, rgb);
      return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ ...matOpts, vertexColors: true }));
    }
    // thickness map: v from the liner arclength of the shared profile index
    const map = o.map;
    const tex = this.thicknessTexture(map, o.color);
    if (!tex || !linerOuter || map.s.length < 2) return null;
    const sL = arcLength(linerOuter);
    const shared = linerOuter.x.length === surface.x.length;
    const rows = map.s.length;
    const rowIdx = map.s.map((_, i) => i);
    const vs = idx.map((i) => {
      const s = shared ? sL[i] : interpAsc(linerOuter.x, sL, surface.x[i]);
      return (interpAsc(map.s, rowIdx, s) + 0.5) / rows;
    });
    const g = latheXMapped(pts, vs, this.section);
    return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ ...matOpts, map: tex }));
  }

  private rebuildVessel() {
    clearGroup(this.staticGroup);
    this.layerMeshes.clear();
    const d = this.data;
    if (!d) return;
    const a = d.analysis;
    const liner = d.liner;
    let outer: Curve | null = a?.liner_outer ?? null;
    let inner: Curve | null = a?.liner_inner ?? null;
    if (!outer || outer.x.length < 2) {
      // Fallback preview before the first analysis: cylinder + hemispherical ends.
      const fb = this.fallbackProfile(liner);
      outer = fb.outer;
      inner = fb.inner;
    }
    const outer0 = outer;
    const zs = outer.x;
    const zMin = Math.min(...zs);
    const zMax = Math.max(...zs);
    this.maxR = Math.max(...outer.y, liner.radius);
    const overlay = a ? this.overlay : null;
    const deformed = !!(this.deformation && this.deformation.scale);
    outer = this.deformCurve(outer);
    if (inner) inner = this.deformCurve(inner);

    // Painted surface: the thickness-map layer, else the outermost shown layer, else the liner.
    const mapLayer = overlay?.type === 'map' ? overlay.map.layer_id : null;
    const layersAll = a?.layers ?? [];
    const cutIdx = this.layerCutoff ? layersAll.findIndex((l) => l.id === this.layerCutoff) : -1;
    const mapIdx = mapLayer ? layersAll.findIndex((l) => l.id === mapLayer) : -1;
    const shown = mapIdx >= 0 ? layersAll.slice(0, mapIdx + 1) : cutIdx >= 0 ? layersAll.slice(0, cutIdx) : layersAll;
    const drawLayers = !!a && (this.showLayers || mapIdx >= 0);
    const paintLiner = !!overlay && overlay.type === 'z' && (!drawLayers || !shown.length);

    // ---- liner (closed wall profile: outer A->B, inner B->A)
    const linerMat = this.material('#a9aeb6', { metalness: 0.55, roughness: 0.38 });
    const outerPts = curveToPoints(outer);
    const innerPts = inner ? curveToPoints(inner) : [];
    const wall = [...outerPts, ...[...innerPts].reverse()];
    if (wall.length > 2) wall.push(wall[0].clone());
    const linerPainted = paintLiner ? this.overlayMesh(outer0, outer, a?.liner_outer ?? null) : null;
    if (linerPainted) {
      this.staticGroup.add(linerPainted);
      if (inner) this.staticGroup.add(new THREE.Mesh(latheX(curveToPoints(inner), this.section), linerMat));
    } else {
      const linerMesh = new THREE.Mesh(latheX(wall.length > 2 ? wall : outerPts, this.section), linerMat);
      this.staticGroup.add(linerMesh);
    }
    if (this.section && inner) {
      const capMat = this.material('#8d939c', { metalness: 0.4, roughness: 0.5 });
      const poly: [number, number][] = [
        ...outer.x.map((z, i) => [z, outer!.y[i]] as [number, number]),
        ...[...inner.x.map((z, i) => [z, inner!.y[i]] as [number, number])].reverse(),
      ];
      this.addCap(this.staticGroup, poly, capMat);
    }

    // ---- bosses and shaft
    const rA = outer0.y[zs[0] <= zs[zs.length - 1] ? 0 : zs.length - 1];
    const rB = outer0.y[zs[0] <= zs[zs.length - 1] ? zs.length - 1 : 0];
    const bossMat = this.material('#7d848f', { metalness: 0.6, roughness: 0.35 });
    const shaftMat = this.material('#5b6069', { metalness: 0.7, roughness: 0.3 });
    const bl = Math.max(liner.boss_length, 4);
    const bossA = Math.max(liner.boss_radius_a, rA * 0.6);
    const bossB = Math.max(liner.boss_radius_b, rB * 0.6);
    const cyl = (r: number, z0: number, z1: number, mat: THREE.Material) => {
      const pts = [
        new THREE.Vector2(0, z0),
        new THREE.Vector2(r, z0),
        new THREE.Vector2(r, z1),
        new THREE.Vector2(0, z1),
      ];
      this.staticGroup.add(new THREE.Mesh(latheX(pts, this.section), mat));
      if (this.section)
        this.addCap(
          this.staticGroup,
          [
            [z0, 0],
            [z0, r],
            [z1, r],
            [z1, 0],
          ],
          mat,
        );
    };
    const dA = this.deformShift(zMin);
    const dB = this.deformShift(zMax);
    cyl(bossA, zMin - bl + dA, zMin + Math.min(8, (zMax - zMin) * 0.05) + dA, bossMat);
    cyl(bossB, zMax - Math.min(8, (zMax - zMin) * 0.05) + dB, zMax + bl + dB, bossMat);
    const shaftExt = Math.max(60, this.maxR * 0.8);
    const s0 = zMin - bl - shaftExt;
    const s1 = zMax + bl + shaftExt;
    cyl(liner.shaft_radius, s0, s1, shaftMat);
    this.span = [s0, s1];

    // ---- layers
    // `layerCutoff`: show only the layers wound before this one (simulation);
    // a thickness-map overlay shows the layers up to and including its layer.
    let outerMost: Curve = outer0;
    if (a && drawLayers) {
      const colors = layerColors(d.layers.length ? d.layers : a.layers);
      let prev: Curve = outer;
      const n = shown.length;
      shown.forEach((lr, idx) => {
        const color = colors.get(lr.id) ?? '#2a78d6';
        const meshes: THREE.Object3D[] = [];
        if (lr.surface.x.length > 1) {
          const isOuter = idx === n - 1;
          const surf = deformed ? this.deformCurve(lr.surface) : lr.surface;
          const painted = isOuter && overlay ? this.overlayMesh(lr.surface, surf, a.liner_outer) : null;
          if (painted) {
            painted.renderOrder = 1 + idx;
            this.staticGroup.add(painted);
            meshes.push(painted);
          } else if (!this.section || isOuter) {
            // Section: only the outermost surface is drawn (inner ones are hidden
            // behind it anyway) and every layer shows as a filled cap.
            // Full view: inner layers faint, outermost semi-transparent (hidden
            // behind an opaque painted surface).
            const mat = this.material(color, {
              transparent: !this.section,
              opacity: this.section ? 1 : isOuter ? 0.5 : overlay ? 0 : 0.1,
              depthWrite: this.section,
              roughness: 0.7,
            });
            const m = new THREE.Mesh(latheX(curveToPoints(surf), this.section), mat);
            m.renderOrder = 1 + idx;
            m.userData.baseOpacity = mat.opacity;
            m.visible = mat.opacity > 0;
            this.staticGroup.add(m);
            meshes.push(m);
          }
          if (this.section) {
            const top: [number, number][] = [];
            const bot: [number, number][] = [];
            for (let i = 0; i < surf.x.length; i++) {
              const z = surf.x[i];
              const rp = interpCurve(prev, z);
              top.push([z, Math.max(surf.y[i], rp)]);
              bot.push([z, rp]);
            }
            const capMat = this.material(color, {
              roughness: 0.8,
              polygonOffset: true,
              polygonOffsetFactor: -1,
              polygonOffsetUnits: -1,
            });
            this.addCap(this.staticGroup, [...top, ...bot.reverse()], capMat, meshes);
          }
          prev = surf;
          outerMost = lr.surface;
        }
        this.layerMeshes.set(lr.id, meshes);
      });
      this.maxR = Math.max(this.maxR, ...a.layers.flatMap((l) => l.surface.y));
    }

    // ---- undeformed outline when the deformed shape is shown
    if (deformed) {
      const pos: number[] = [];
      const idx = strideIndices(outerMost.x.length, 400);
      for (const sgn of [1, -1]) {
        for (let k = 0; k < idx.length - 1; k++) {
          const i = idx[k];
          const j = idx[k + 1];
          pos.push(outerMost.x[i], sgn * outerMost.y[i], 0.5, outerMost.x[j], sgn * outerMost.y[j], 0.5);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const ghost = new THREE.LineSegments(
        g,
        new THREE.LineDashedMaterial({
          color: this.theme.text,
          dashSize: 4,
          gapSize: 3,
          transparent: true,
          opacity: 0.85,
          depthTest: false,
        }),
      );
      ghost.computeLineDistances();
      ghost.renderOrder = 50;
      this.staticGroup.add(ghost);
    }

    // ---- rotating index marks (make mandrel rotation visible)
    this.buildMandrelMarks(zMin - bl, zMax + bl, liner.shaft_radius);
    this.rebuildGrid();
    this.applyLayerHighlight();
    this.applyClipping();
    this.invalidate();
  }

  private buildMandrelMarks(z0: number, z1: number, shaftR: number) {
    for (const c of [...this.mandrelGroup.children]) {
      if (c === this.pathGroup || c === this.simVis?.laid) continue;
      this.mandrelGroup.remove(c);
      disposeTree(c);
    }
    const mat = new THREE.MeshStandardMaterial({ color: '#e8c547', roughness: 0.5 });
    const chuckR = Math.max(shaftR * 2.6, 30);
    const chuck = new THREE.Mesh(
      new THREE.CylinderGeometry(chuckR, chuckR, 18, 40),
      this.material('#454a52', { metalness: 0.6 }),
    );
    chuck.rotation.z = -Math.PI / 2;
    const zc = z0 - Math.max(60, this.maxR * 0.8) + 9;
    chuck.position.x = zc;
    this.mandrelGroup.add(chuck);
    // index marks on the chuck face and on the shaft stubs
    for (let k = 0; k < 3; k++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(4, chuckR * 0.9, 6), mat);
      const phi = (k * 2 * Math.PI) / 3;
      bar.position.set(zc + 10, Math.cos(phi) * chuckR * 0.5, Math.sin(phi) * chuckR * 0.5);
      bar.rotation.x = -phi;
      this.mandrelGroup.add(bar);
    }
    for (const zz of [z0 - 20, z1 + 20]) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(30, 2, 2), mat);
      stripe.position.set(zz, shaftR + 0.5, 0);
      this.mandrelGroup.add(stripe);
    }
  }

  private fallbackProfile(l: LinerSpec): { outer: Curve; inner: Curve } {
    const R = l.radius;
    const h = l.dome_type === 'elliptical' ? l.dome_aspect * R : l.dome_type === 'hemispherical' ? R : 0.6 * R;
    const L = l.cyl_length / 2;
    const ox: number[] = [];
    const oy: number[] = [];
    const ix: number[] = [];
    const iy: number[] = [];
    const push = (z: number, r: number) => {
      ox.push(z);
      oy.push(r);
      ix.push(z);
      iy.push(Math.max(0, r - l.wall_thickness));
    };
    const N = 24;
    const rb = (end: number) => (end < 0 ? l.boss_radius_a : l.boss_radius_b);
    for (let i = 0; i <= N; i++) {
      const t = Math.PI / 2 - (i / N) * (Math.PI / 2);
      const r = Math.max(rb(-1), R * Math.cos(t));
      push(-L - h * Math.sin(t), r);
    }
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * (Math.PI / 2);
      const r = Math.max(rb(1), R * Math.cos(t));
      push(L + h * Math.sin(t), r);
    }
    return { outer: { x: ox, y: oy }, inner: { x: ix, y: iy } };
  }

  private applyLayerHighlight() {
    const sel = this.selectedLayer;
    for (const [id, meshes] of this.layerMeshes) {
      for (const o of meshes) {
        const m = o as THREE.Mesh;
        const mat = m.material as THREE.MeshStandardMaterial;
        if (!mat.transparent) continue;
        const base = (m.userData.baseOpacity as number | undefined) ?? mat.opacity;
        if (!sel) mat.opacity = base;
        else mat.opacity = id === sel ? Math.max(0.6, base) : Math.min(base, 0.06);
        mat.emissive = new THREE.Color(id === sel ? '#222222' : '#000000');
      }
    }
  }

  private applyClipping() {
    const planes = this.section ? [this.sectionPlane] : [];
    const apply = (o: THREE.Object3D) =>
      o.traverse((c) => {
        const m = (c as THREE.Mesh).material as THREE.Material | undefined;
        if (m && !Array.isArray(m)) {
          m.clippingPlanes = planes;
          m.needsUpdate = true;
        }
      });
    // Only the rotating content needs plane clipping; static lathes are built as halves.
    apply(this.pathGroup);
    if (this.simVis) apply(this.simVis.laid);
  }

  private buildMachine(sim: SimulationResult) {
    const f = sim.frames;
    const n = f.t.length;
    // laid fibre (contact points, mandrel frame)
    const laidPos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) this.lift(f.contact[i] ?? [0, 0, 0], laidPos, i * 3, 0.35);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(laidPos, 3));
    lg.setDrawRange(0, 1);
    const laid = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: FIBRE_COLOR }));
    laid.frustumCulled = false;
    this.mandrelGroup.add(laid);

    const maxCross = Math.max(...f.crossfeed, this.maxR + 30);
    const railY = maxCross + 70;
    const zMin = Math.min(...f.carriage, this.span[0]);
    const zMax = Math.max(...f.carriage, this.span[1]);
    const railMat = this.material('#8a9099', { metalness: 0.5, roughness: 0.35 });
    const railLen = zMax - zMin + 120;
    for (const zz of [-26, 26]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(railLen, 10, 10), railMat);
      rail.position.set((zMin + zMax) / 2, railY + 22, zz);
      this.machineGroup.add(rail);
    }
    // carriage block with crossfeed guide
    const carriage = new THREE.Group();
    const block = new THREE.Mesh(new THREE.BoxGeometry(70, 26, 72), this.material('#3d6fb6', { metalness: 0.3 }));
    block.position.set(0, railY + 22, 0);
    carriage.add(block);
    this.machineGroup.add(carriage);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(14, 1, 14), this.material('#9aa3ae', { metalness: 0.5 }));
    this.machineGroup.add(arm);
    // payout eye: box + roller (roller axis along x at eye = 0 deg)
    const eye = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(34, 14, 20), this.material('#eda100'));
    eye.add(body);
    const roller = new THREE.Mesh(
      new THREE.CylinderGeometry(4, 4, 30, 20),
      this.material('#2b2f36', { metalness: 0.6 }),
    );
    roller.rotation.z = Math.PI / 2;
    roller.position.y = -10;
    eye.add(roller);
    const notch = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 24), this.material('#e34948'));
    notch.position.set(12, 8, 0);
    eye.add(notch);
    this.machineGroup.add(eye);
    // free fibre
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const free = new THREE.Line(fg, new THREE.LineBasicMaterial({ color: '#1baf7a' }));
    free.frustumCulled = false;
    this.machineGroup.add(free);

    this.simVis = { sim, pathIndex: null, laid, laidPos, free, eye, roller, carriage, arm, railY };
  }
}
