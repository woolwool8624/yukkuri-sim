import * as THREE from 'three';
import type { BoxCollider } from '../physics/SoftBody';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import { createAccessoryOutlineMaterial } from '../render/outlineMaterial';
import { withOutline } from '../character/shapes';
import { floorTexture, type FloorId } from './floorTextures';
import type { Area } from './Stage';

/**
 * 飼育ケース（ガラスの水槽）：中の広さは 横 W × 奥行き D m（体 10 × 6 つ分）、壁の高さ H m。原点が床の真ん中、奥が -z。
 *   壁 … 透明なガラス（光の筋の映り込み）と、角と縁の枠。カメラの側の壁（カメラが壁の外にある面）はさらに薄くして中を見やすく
 *   床 … 床材（新聞紙・おがくず・タオル）を切り替える
 *   置く物 … 餌皿・水皿（当たる。体は乗れない）。奥の壁ぎわ。寝床は置かない（おうちせんげんした所に巣材で作る。指示）
 * 当たり：壁は外へ厚い箱（体を中へ押し返す。薄いとすり抜ける）
 */
export const CAGE_W = 10;
export const CAGE_D = 6;
const H = 2;
/** 壁の当たりの厚み（m。外へ） */
const WALL_T = 1;
/** 枠の太さ（m） */
const FRAME = 0.06;
/** ガラスの濃さ：ふつう／カメラの側の壁 */
const GLASS_OPACITY = 0.45;
const GLASS_NEAR_OPACITY = 0.15;

/** 置く物の場所と大きさ（m） */
// 水皿は、ゆっくりが普通の 1/4 という体に合わせて最初の倍の大きさ（指示）。大きくした分、壁から離して並べ直した。
// 餌皿は元の大きさ（指示。大きくしても、体が乗れないので餌を置ける所は縁寄りだけで、使わない所が多かった）
const FOOD_DISH = { x: 2.55, z: -2.1, r: 0.34, h: 0.1 };
const WATER_DISH = { x: 3.85, z: -1.95, r: 0.6, h: 0.12 };
/**
 * といれ：砂を入れた浅いトレイ（指示）。手前の左。横 w × 奥行き d、縁の高さ h・厚み t（m）。
 * 体ごと乗れる（当たらない）。砂は床とほぼ同じ高さ（うんうんの塊は地面に寝そべるので、砂が高いと埋もれる）
 */
const TOILET = { x: -3.5, z: 1.75, w: 1.9, d: 1.5, h: 0.07, t: 0.05 };
const TOILET_COLORS = { lit: '#bfe3c8', shade: '#9fcfad', deep: '#79b08a', rim: '#f0fff4' };

const FRAME_COLORS = { lit: '#8d969c', shade: '#6d757b', deep: '#545b60', rim: '#d6dde2' };
const FOOD_DISH_COLORS = { lit: '#fbf3e4', shade: '#eadcc4', deep: '#cdb99a', rim: '#ffffff' };
const WATER_DISH_COLORS = { lit: '#d7eaf5', shade: '#b9d4e6', deep: '#93b4cc', rim: '#ffffff' };
/** 皿の縁の色の線（上から見ても縁と分かるように） */
const FOOD_DISH_LINE = { lit: '#e9a35f', shade: '#d48a45', deep: '#b06d30', rim: '#ffe9cf' };
const WATER_DISH_LINE = { lit: '#5f9fd0', shade: '#4a86b8', deep: '#356b98', rim: '#d9eefa' };
interface Glass {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** 外向きの法線と、壁の上の 1 点 */
  out: THREE.Vector3;
  at: THREE.Vector3;
}

export class Cage {
  readonly object = new THREE.Group();
  readonly colliders: BoxCollider[] = [];
  readonly area: Area = { minX: -CAGE_W / 2, maxX: CAGE_W / 2, minZ: -CAGE_D / 2, maxZ: CAGE_D / 2 };
  /**
   * 餌皿：中心・半径（m）と、餌を置く輪（中心からの距離 m）と、中心から dist m の所の内側の底の高さ。
   * 輪は平らな底の内側：餌（差し渡し 16〜19 cm）の端が皿の内側の壁に入らない所まで
   * （縁寄りの 0.55〜0.7 倍に置くと、皿を元の大きさに戻したとき餌が皿の壁を突き抜けた）
   */
  readonly foodDish = {
    x: FOOD_DISH.x, z: FOOD_DISH.z, r: FOOD_DISH.r, ring: [FOOD_DISH.r * 0.1, FOOD_DISH.r * 0.4] as const,
    floorAt: (dist: number) => bowlFloor(FOOD_DISH.r, FOOD_DISH.h, dist),
  };
  /** 水皿：中心・半径と、水面の高さ・半径（m） */
  readonly waterDish = { x: WATER_DISH.x, z: WATER_DISH.z, r: WATER_DISH.r, surfaceY: WATER_DISH.h * 0.72, surfaceR: WATER_DISH.r * 0.86 };
  /** といれ（砂のトレイ）：中心と、横・奥行き（m。向きは軸にそろえる） */
  readonly toilet = { x: TOILET.x, z: TOILET.z, w: TOILET.w, d: TOILET.d };
  /** 置いてある物（体が乗れない所）：餌皿・水皿の中心と半径 */
  readonly props = [FOOD_DISH, WATER_DISH].map((d) => ({ x: d.x, z: d.z, r: d.r }));
  private readonly floor: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly glass: Glass[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private floorId: FloorId | null = null;

  constructor(body: THREE.ShaderMaterial, outlineBody: THREE.ShaderMaterial, floor: FloorId) {
    const outline = createAccessoryOutlineMaterial(outlineBody);
    // 地面に押し付けない（皿の底などが持ち上がらないように）
    const mat = (c: typeof FRAME_COLORS, doubleSide = false) => createAccessoryMaterial(body, c, { rim: 0.2, ground: -10, doubleSide });
    const frameMat = mat(FRAME_COLORS);
    this.disposables.push(outline, frameMat);

    // 床（床材の絵。地面より手前に描く）
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(CAGE_W, CAGE_D).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial());
    this.floor.position.y = 0.0005;
    this.object.add(this.floor);
    this.setFloor(floor);

    // ガラス：前後・左右の 4 面
    const streaks = glassStreaks();
    this.disposables.push(streaks);
    const walls: [number, number, number, number][] = [
      // 中心 x, z、幅、向き（外向きの法線の角度）
      [0, -CAGE_D / 2, CAGE_W, Math.PI],
      [0, CAGE_D / 2, CAGE_W, 0],
      [-CAGE_W / 2, 0, CAGE_D, -Math.PI / 2],
      [CAGE_W / 2, 0, CAGE_D, Math.PI / 2],
    ];
    for (const [x, z, w, a] of walls) {
      const m = new THREE.MeshBasicMaterial({
        color: '#d9eef5', map: streaks, transparent: true, opacity: GLASS_OPACITY, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, H), m);
      // 板は枠の厚みの真ん中に置く（縁は枠の中に隠れる）。壁の面ちょうどに置くと枠の内側の面と重なり、縁がちらついた
      mesh.position.set(x + Math.sin(a) * FRAME / 2, H / 2, z + Math.cos(a) * FRAME / 2);
      mesh.rotation.y = a;
      mesh.renderOrder = 10;
      this.object.add(mesh);
      this.glass.push({ mesh, out: new THREE.Vector3(Math.sin(a), 0, Math.cos(a)), at: new THREE.Vector3(x, 0, z) });
      // 当たり：外へ厚い箱
      const nx = Math.sin(a), nz = Math.cos(a);
      const along = Math.abs(nx) > 0.5;
      this.colliders.push({
        x: x + nx * WALL_T / 2, z: z + nz * WALL_T / 2, yaw: 0,
        hx: along ? WALL_T / 2 : w / 2 + WALL_T, hz: along ? w / 2 + WALL_T : WALL_T / 2, h: H, contacts: 0,
      });
    }

    // 枠：下の縁は太め、上の縁と角の柱は細め。柱は上の縁の高さまで伸ばす。
    // 縁の棒は柱の中まで差し込み（継ぎ目に輪郭線がのぞかないように）、柱より少し細くして面をずらす
    // （棒どうし・棒と柱が角で同じ所に面を持つと、ちらついた）
    const addFrame = (g: THREE.BufferGeometry) => {
      this.disposables.push(g);
      this.object.add(withOutline(g, frameMat, outline));
    };
    const W2 = CAGE_W / 2, D2 = CAGE_D / 2;
    const BOTTOM = FRAME * 1.2, TOP = H + FRAME / 2;
    const BAR = FRAME * 0.96;
    for (const [y0, y1] of [[0, BOTTOM], [H - BAR / 2, H + BAR / 2]] as const) {
      const t = y1 - y0, cy = (y0 + y1) / 2;
      for (const s of [-1, 1]) {
        addFrame(new THREE.BoxGeometry(CAGE_W + FRAME, t, BAR).translate(0, cy, s * (D2 + FRAME / 2)));
        addFrame(new THREE.BoxGeometry(BAR, t, CAGE_D + FRAME).translate(s * (W2 + FRAME / 2), cy, 0));
      }
    }
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) addFrame(new THREE.BoxGeometry(FRAME, TOP, FRAME).translate(sx * (W2 + FRAME / 2), TOP / 2, sz * (D2 + FRAME / 2)));
    }

    // 餌皿・水皿（当たる）
    const dish = (d: typeof FOOD_DISH, colors: typeof FRAME_COLORS, line: typeof FRAME_COLORS, water: boolean) => {
      const m = mat(colors, true);
      const g = new THREE.LatheGeometry(bowlProfile(d.r, d.h), 48);
      const lm = mat(line);
      const lg = new THREE.TorusGeometry(d.r * 0.965, d.r * 0.03, 8, 64).rotateX(Math.PI / 2).translate(0, d.h * 0.985, 0);
      // 輪郭線は外側の形（上をふさいだ形）だけで描く（器の形のままだと、線が内側の奥の壁に透けて見えた）
      const og = new THREE.LatheGeometry(bowlOutline(d.r, d.h), 48);
      this.disposables.push(m, g, lm, lg, og);
      const obj = withOutline(og, outline, null);
      obj.add(new THREE.Mesh(g, m), new THREE.Mesh(lg, lm));
      obj.position.set(d.x, 0, d.z);
      this.object.add(obj);
      if (water) {
        const wm = new THREE.MeshBasicMaterial({ color: '#8fc7e8', transparent: true, opacity: 0.75 });
        const wg = new THREE.CircleGeometry(d.r * 0.86, 40).rotateX(-Math.PI / 2);
        this.disposables.push(wm, wg);
        const surface = new THREE.Mesh(wg, wm);
        surface.position.set(d.x, d.h * 0.72, d.z);
        this.object.add(surface);
      }
      const half = d.r * 0.92;
      this.colliders.push({ x: d.x, z: d.z, yaw: 0, hx: half, hz: half, h: d.h, contacts: 0 });
    };
    dish(FOOD_DISH, FOOD_DISH_COLORS, FOOD_DISH_LINE, false);
    dish(WATER_DISH, WATER_DISH_COLORS, WATER_DISH_LINE, true);

    // といれ：角の丸い枠（縁）と、中の砂（床とほぼ同じ高さ。当たらない）
    const trayMat = mat(TOILET_COLORS);
    const trayGeo = trayRim(TOILET.w, TOILET.d, TOILET.h, TOILET.t);
    const sandMat = new THREE.MeshBasicMaterial({ map: sandTexture() });
    const sandGeo = new THREE.ShapeGeometry(roundRect(TOILET.w - TOILET.t * 2, TOILET.d - TOILET.t * 2, Math.min(TOILET.w, TOILET.d) * 0.14) as THREE.Shape, 10);
    sandGeo.rotateX(-Math.PI / 2);
    // 砂の絵は横 w・奥行き d に合わせる（ShapeGeometry の uv は形の座標そのままなので、0〜1 へ寄せる）
    const uv = sandGeo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / TOILET.w + 0.5, uv.getY(i) / TOILET.d + 0.5);
    this.disposables.push(trayMat, trayGeo, sandMat, sandMat.map!, sandGeo);
    const tray = withOutline(trayGeo, trayMat, outline);
    const sand = new THREE.Mesh(sandGeo, sandMat);
    sand.position.y = 0.0015;
    tray.add(sand);
    tray.position.set(TOILET.x, 0, TOILET.z);
    this.object.add(tray);
  }

  setFloor(id: FloorId): void {
    if (id === this.floorId) return;
    this.floorId = id;
    const m = this.floor.material;
    m.map?.dispose();
    m.map = floorTexture(id, CAGE_W, CAGE_D);
    m.needsUpdate = true;
  }

  /** 毎フレーム：カメラの側の壁（カメラがその壁の外にある）を薄くする */
  update(camera: THREE.Vector3): void {
    for (const g of this.glass) {
      const outside = (camera.x - g.at.x) * g.out.x + (camera.z - g.at.z) * g.out.z > 0;
      g.mesh.material.opacity = outside ? GLASS_NEAR_OPACITY : GLASS_OPACITY;
    }
  }

  dispose(): void {
    this.floor.material.map?.dispose();
    this.floor.material.dispose();
    this.floor.geometry.dispose();
    for (const g of this.glass) {
      g.mesh.material.dispose();
      g.mesh.geometry.dispose();
    }
    for (const d of this.disposables) d.dispose();
  }
}

/** 浅い器の断面（中心の底 → 内側の壁 → 縁 → 外側 → 高台）。半径 r・高さ h */
function bowlProfile(r: number, h: number): THREE.Vector2[] {
  return [
    [0, h * 0.25], [r * 0.55, h * 0.26], [r * 0.75, h * 0.38], [r * 0.88, h * 0.7], [r * 0.93, h * 0.97],
    [r * 0.97, h], [r, h * 0.94], [r * 0.95, h * 0.55], [r * 0.82, h * 0.18], [r * 0.7, h * 0.08], [r * 0.7, 0], [0, 0],
  ].map(([x, y]) => new THREE.Vector2(x, y));
}

/** 器の内側の底の高さ（中心から dist m の所。断面の内側の点をつないだ線の上） */
function bowlFloor(r: number, h: number, dist: number): number {
  const p = bowlProfile(r, h).slice(0, 5);
  for (let i = 1; i < p.length; i++) {
    if (dist <= p[i].x) {
      const k = (dist - p[i - 1].x) / (p[i].x - p[i - 1].x);
      return p[i - 1].y + (p[i].y - p[i - 1].y) * k;
    }
  }
  return p[p.length - 1].y;
}

/** 器の外側の形（縁の上でふさぐ）：輪郭線用 */
function bowlOutline(r: number, h: number): THREE.Vector2[] {
  return [
    [0, h], [r * 0.97, h], [r, h * 0.94], [r * 0.95, h * 0.55], [r * 0.82, h * 0.18], [r * 0.7, h * 0.08], [r * 0.7, 0], [0, 0],
  ].reverse().map(([x, y]) => new THREE.Vector2(x, y)); // 下から上へ並べる（逆だと面の表裏が反対になり、ふたの裏が上から見えた）
}

/** 角の丸い長方形（横 w × 奥行き d、角の半径 r。中心が原点） */
function roundRect(w: number, d: number, r: number, s: THREE.Shape | THREE.Path = new THREE.Shape()): THREE.Shape | THREE.Path {
  s.moveTo(-w / 2 + r, -d / 2);
  s.lineTo(w / 2 - r, -d / 2);
  s.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r);
  s.lineTo(w / 2, d / 2 - r);
  s.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2);
  s.lineTo(-w / 2 + r, d / 2);
  s.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r);
  s.lineTo(-w / 2, -d / 2 + r);
  s.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2);
  return s;
}

/** といれの縁：角の丸い長方形の枠（外が横 w × 奥行き d、厚み t、高さ h。底が y = 0） */
function trayRim(w: number, d: number, h: number, t: number): THREE.BufferGeometry {
  const r = Math.min(w, d) * 0.18;
  const s = roundRect(w, d, r) as THREE.Shape;
  s.holes.push(roundRect(w - t * 2, d - t * 2, r - t, new THREE.Path()) as THREE.Path);
  const bevel = t * 0.3;
  const g = new THREE.ExtrudeGeometry(s, { depth: h - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.5, bevelSegments: 2, curveSegments: 10 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, bevel, 0);
  return g;
}

/** といれの砂：明るい灰色がかったベージュに、細かい粒（512 四方） */
function sandTexture(): THREE.CanvasTexture {
  const N = 512;
  const c = document.createElement('canvas');
  c.width = N;
  c.height = N;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e4dccb';
  g.fillRect(0, 0, N, N);
  let seed = 31;
  const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const colors = ['#d2c8b2', '#f1ebdd', '#c6bba3', '#ebe3d2', '#b9ad94'];
  for (let k = 0; k < 14000; k++) {
    g.fillStyle = colors[Math.floor(r() * colors.length)];
    g.beginPath();
    g.arc(r() * N, r() * N, 0.8 + r() * 1.6, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** ガラスの映り込み：斜めの白い筋を数本（筋の所だけ濃い。地は薄く、ガラスの濃さを掛ける） */
function glassStreaks(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.fillRect(0, 0, 512, 256);
  g.fillStyle = '#ffffff';
  for (const [x, w] of [[90, 26], [130, 8], [330, 40], [385, 10]]) {
    g.beginPath();
    g.moveTo(x, 256);
    g.lineTo(x + w, 256);
    g.lineTo(x + w + 110, 0);
    g.lineTo(x + 110, 0);
    g.closePath();
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
