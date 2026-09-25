import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { AnalysisResult, Curve, LinerSpec, MachineSpec, PathResult, SimulationResult } from '../api/types';
import { frameIndexAt } from '../state/playback';
import { layerColors } from './colors';

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

const SEG = 96;
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
  laid: THREE.Line;
  laidPos: Float32Array;
  free: THREE.Line;
  eye: THREE.Group;
  roller: THREE.Mesh;
  carriage: THREE.Group;
  arm: THREE.Mesh;
  railY: number;
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

function curveToPoints(c: Curve): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  const n = Math.min(c.x.length, c.y.length);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(c.x[i]) && Number.isFinite(c.y[i])) out.push(new THREE.Vector2(Math.max(0, c.y[i]), c.x[i]));
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
  private layerMeshes = new Map<string, THREE.Object3D[]>();
  private maxR = 100;
  private span: [number, number] = [-250, 250];
  private sectionPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  private simVis: SimVisual | null = null;
  private currentTime = 0;
  private hasFitted = false;
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

  setSelectedLayer(id: string | null) {
    this.selectedLayer = id;
    this.applyLayerHighlight();
    this.invalidate();
  }

  setPath(p: PathResult | null, color = '#e34948') {
    clearGroup(this.pathGroup);
    if (p && p.points.length > 1) {
      const pos = new Float32Array(p.points.length * 3);
      p.points.forEach((q, i) => this.lift(q, pos, i * 3, 0.25));
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const hasSim = !!this.simVis;
      const m = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: hasSim ? 0.28 : 0.95,
        depthWrite: false,
      });
      const line = new THREE.Line(g, m);
      line.name = 'path';
      this.pathGroup.add(line);
    }
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
    if (pathLine) (pathLine.material as THREE.LineBasicMaterial).opacity = this.simVis ? 0.28 : 0.95;
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
    disposeTree(this.scene);
    disposeTree(this.gizmoScene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------------------------------------------------------------- internals
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
    const zs = outer.x;
    const zMin = Math.min(...zs);
    const zMax = Math.max(...zs);
    this.maxR = Math.max(...outer.y, liner.radius);

    // ---- liner (closed wall profile: outer A->B, inner B->A)
    const linerMat = this.material('#a9aeb6', { metalness: 0.55, roughness: 0.38 });
    const outerPts = curveToPoints(outer);
    const innerPts = inner ? curveToPoints(inner) : [];
    const wall = [...outerPts, ...[...innerPts].reverse()];
    if (wall.length > 2) wall.push(wall[0].clone());
    const linerMesh = new THREE.Mesh(latheX(wall.length > 2 ? wall : outerPts, this.section), linerMat);
    this.staticGroup.add(linerMesh);
    if (this.section && inner) {
      const capMat = this.material('#8d939c', { metalness: 0.4, roughness: 0.5 });
      const poly: [number, number][] = [
        ...outer.x.map((z, i) => [z, outer!.y[i]] as [number, number]),
        ...[...inner.x.map((z, i) => [z, inner!.y[i]] as [number, number])].reverse(),
      ];
      this.addCap(this.staticGroup, poly, capMat);
    }

    // ---- bosses and shaft
    const rA = outer.y[zs[0] <= zs[zs.length - 1] ? 0 : zs.length - 1];
    const rB = outer.y[zs[0] <= zs[zs.length - 1] ? zs.length - 1 : 0];
    const bossMat = this.material('#7d848f', { metalness: 0.6, roughness: 0.35 });
    const shaftMat = this.material('#5b6069', { metalness: 0.7, roughness: 0.3 });
    const bl = Math.max(liner.boss_length, 4);
    const bossA = Math.max(liner.boss_radius_a, rA * 0.6);
    const bossB = Math.max(liner.boss_radius_b, rB * 0.6);
    const cyl = (r: number, z0: number, z1: number, mat: THREE.Material) => {
      const pts = [new THREE.Vector2(0, z0), new THREE.Vector2(r, z0), new THREE.Vector2(r, z1), new THREE.Vector2(0, z1)];
      this.staticGroup.add(new THREE.Mesh(latheX(pts, this.section), mat));
      if (this.section) this.addCap(this.staticGroup, [[z0, 0], [z0, r], [z1, r], [z1, 0]], mat);
    };
    cyl(bossA, zMin - bl, zMin + Math.min(8, (zMax - zMin) * 0.05), bossMat);
    cyl(bossB, zMax - Math.min(8, (zMax - zMin) * 0.05), zMax + bl, bossMat);
    const shaftExt = Math.max(60, this.maxR * 0.8);
    const s0 = zMin - bl - shaftExt;
    const s1 = zMax + bl + shaftExt;
    cyl(liner.shaft_radius, s0, s1, shaftMat);
    this.span = [s0, s1];

    // ---- layers
    if (a && this.showLayers) {
      const colors = layerColors(d.layers.length ? d.layers : a.layers);
      let prev: Curve = outer;
      const n = a.layers.length;
      a.layers.forEach((lr, idx) => {
        const color = colors.get(lr.id) ?? '#2a78d6';
        const meshes: THREE.Object3D[] = [];
        if (lr.surface.x.length > 1) {
          const isLast = idx === n - 1;
          const mat = this.material(color, {
            transparent: true,
            opacity: this.section ? 0.95 : isLast ? 0.55 : 0.3,
            depthWrite: this.section,
            roughness: 0.7,
            polygonOffset: true,
            polygonOffsetFactor: -1 - idx,
            polygonOffsetUnits: -1,
          });
          // only the extent of the layer, bottom follows the previous surface
          const top: [number, number][] = [];
          const bot: [number, number][] = [];
          for (let i = 0; i < lr.surface.x.length; i++) {
            const z = lr.surface.x[i];
            const rp = interpCurve(prev, z);
            top.push([z, Math.max(lr.surface.y[i], rp)]);
            bot.push([z, rp]);
          }
          const m = new THREE.Mesh(latheX(curveToPoints(lr.surface), this.section), mat);
          m.renderOrder = 1 + idx;
          m.userData.baseOpacity = mat.opacity;
          this.staticGroup.add(m);
          meshes.push(m);
          if (this.section) {
            const capMat = this.material(color, { roughness: 0.8 });
            this.addCap(this.staticGroup, [...top, ...bot.reverse()], capMat, meshes);
          }
          prev = lr.surface;
        }
        this.layerMeshes.set(lr.id, meshes);
      });
      this.maxR = Math.max(this.maxR, ...a.layers.flatMap((l) => l.surface.y));
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
    const chuck = new THREE.Mesh(new THREE.CylinderGeometry(chuckR, chuckR, 18, 40), this.material('#454a52', { metalness: 0.6 }));
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
        else mat.opacity = id === sel ? Math.max(0.75, base) : Math.min(base, this.section ? 0.35 : 0.12);
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
    const laid = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: '#e34948' }));
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
    const roller = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 30, 20), this.material('#2b2f36', { metalness: 0.6 }));
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

    this.simVis = { sim, laid, laidPos, free, eye, roller, carriage, arm, railY };
  }
}
