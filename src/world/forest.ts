import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BoxCollider } from '../physics/SoftBody';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import { createAccessoryOutlineMaterial } from '../render/outlineMaterial';
import type { ToonColors } from '../render/toonMaterial';
import { lathe, tubeAlong, withOutline } from '../character/shapes';
import type { Area } from './Stage';

/**
 * 森：木に囲まれた広場（指示）。ゆっくりは普通の大きさ（胴 1 m ＝ 実物 31 cm。指示）。原点が広場の真ん中、奥が -z。
 *   行ける範囲 … 横 W × 奥行き D m。周りを木が囲み、その内側だけ歩ける（外へは見えない壁で押し返す）
 *   置く物（指示）… 木と切り株・倒木と岩（当たる）、草むら・茂み（当たらない。中に入れる）、キノコと落ち葉（飾り）
 *   洞穴（指示）… 奥の右。中に入ると、岩ごしにシルエットだけが見える（Stage.inCave → Yukkuri のシルエット）
 *   といれ（指示）… 奥の左の大きな木の根元のくぼみ
 * 洞穴の岩・床は描くときステンシルに 1 を、ほかの物は 0 を書く（シルエットは 1 の所にだけ、奥行きを無視して描く。
 * 洞穴の手前の木などが 0 で上書きするので、手前の物にはシルエットがかぶらない）
 */
export const FOREST_W = 16;
export const FOREST_D = 12;
/** 見えない壁の当たり（外へ厚い箱）の厚み・高さ（m） */
const WALL_T = 1;
const WALL_H = 3;
/** 地面（落ち葉の床）の半径と、絵 1 枚が覆う広さ（m） */
const FLOOR_R = 24;
const FLOOR_TILE = 4;

/** 洞穴：中心・入口の向き（入口は広場の真ん中を向く）・外の半径（横・高さ・奥行き）・岩の厚み・入口の幅と高さ（m） */
const CAVE = { x: 4.9, z: -4.0, rx: 2.6, ry: 2.6, rz: 2.6, wall: 0.3, door: 1.05, doorH: 1.9 };
/**
 * 洞穴は大木のうろ（指示：森の中に岩の洞穴だけ突然置いてあるのが不自然）。幹の高さ・てっぺんの半径の比・根元の広がり・
 * 樹皮の筋の数と深さ、葉の茂りの半径（m）
 */
const HOLLOW = { height: 7.5, topRatio: 0.72, flare: 0.14, ridges: 13, ridgeDepth: 0.035, crown: 3.2 };
/** うろの入口の縁の帯を、地面の下まで伸ばす角度（rad。アーチの両端から先へ） */
const ARCH_SINK = 0.2;
/** 体の真ん中が、洞穴の内側の楕円のこの比より内なら「洞穴の中」（屋根の下に体が入りきった所） */
const CAVE_INSIDE = 0.62;
/** うろの床の上とみなす所（巣材を暗がりに沈める）：内側の円のこの比より内 */
const HOLLOW_FLOOR = 0.92;
/** といれの木の根：向き（rad。木から見て +z が 0）と長さ（m）。くぼみの左右と横へ */
const TOILET_ROOTS: [number, number][] = [[-1, 1.3], [1, 1.2], [-1.7, 1.0], [1.75, 1.05]].map(([side, len]) => [Math.atan2(Math.sin(side * 0.9), Math.abs(Math.cos(side * 0.9))), len]);
/** 根を張る木の裾の広がり（幹の半径に対する比。根のない所。trunkProfile の 1.7 より控えめ） */
const BUTTRESS_SKIRT = 1.3;
/** 根元のふくらみ（buttress）：大きさ（半径に対する比）・向きのまわりの幅（rad）・消える高さ（m） */
const TOILET_BUTTRESS = { amp: 0.5, w: 0.26, h: 0.4 };
const HOLLOW_BUTTRESS = { amp: 0.14, w: 0.12, h: 0.6 };
/** うろの根の向き（洞穴のローカル。入口 +z の側 ±0.35π は空ける） */
const HOLLOW_ROOTS = Array.from({ length: 7 }, (_, i) => Math.PI * 0.35 + (i / 7) * Math.PI * 1.3 + Math.sin(i * 2.3) * 0.12);
/** 苔の生える所を、物の体が乗れない所（props の円）からこれだけ外に置く（m。根元に寄り添うよう、苔の半径より少し内） */
const MOSS_OFF = 0.22;
/** 草むら・茂み・キノコを置かない所：洞穴の外の楕円のこの倍より内 */
const CAVE_CLEAR = 1.2;

/** といれ：大きな木の根元のくぼみ（指示）。木の場所と太さ、くぼみの中心と横・奥行き（m） */
const TOILET_TREE = { x: -5.2, z: -4.5, r: 0.62 };
const TOILET = { x: -5.2, z: -2.55, w: 2.0, d: 1.5 };

const BARK: ToonColors = { lit: '#a57c54', shade: '#8a643f', deep: '#6b4b2f', rim: '#ead6b8' };
const LEAVES: ToonColors = { lit: '#93c76c', shade: '#77ab57', deep: '#5b8b45', rim: '#e7f6d2' };
const LEAVES_DARK: ToonColors = { lit: '#7fb35f', shade: '#64974b', deep: '#4b7838', rim: '#dcefc7' };
const BUSH: ToonColors = { lit: '#86bd63', shade: '#6aa04f', deep: '#51803d', rim: '#e2f3cd' };
const GRASS: ToonColors = { lit: '#a3d173', shade: '#86b85c', deep: '#6a9847', rim: '#eef9dc' };
const MOSS: ToonColors = { lit: '#78a84a', shade: '#5f8c3a', deep: '#466b2a', rim: '#e3f2cc' };
const ROCK: ToonColors = { lit: '#bdb8ae', shade: '#9f9a90', deep: '#7f7a71', rim: '#f3f0ea' };
/** うろの入口の縁（幹の切り口の明るい木の色） */
const HOLLOW_RIM: ToonColors = { lit: '#c49a6c', shade: '#a87f55', deep: '#86613f', rim: '#f3dfc4' };
const STUMP_TOP = '#e3c48f';
const SOIL: ToonColors = { lit: '#9a7652', shade: '#80603f', deep: '#644a30', rim: '#e6d2b6' };
const MUSHROOM_CAP: ToonColors = { lit: '#e2604f', shade: '#c84b3c', deep: '#a3372c', rim: '#ffd9d0' };
const MUSHROOM_CAP_BROWN: ToonColors = { lit: '#c9965e', shade: '#ae7c47', deep: '#8c6034', rim: '#f7e2c6' };
const MUSHROOM_STEM: ToonColors = { lit: '#f6efe0', shade: '#e6dac3', deep: '#cbbb9d', rim: '#ffffff' };
const DOT: ToonColors = { lit: '#ffffff', shade: '#f2ede4', deep: '#ded6c8', rim: '#ffffff' };
/** 洞穴の内側（暗い）と床 */
const CAVE_INNER = '#2e2119';
const CAVE_FLOOR = '#3e2d20';
/** うろの床の絵 1 枚が覆う広さ（m） */
const HOLLOW_FLOOR_TILE = 1.6;

/** 木（カメラとゆっくりの間に入ったら隠す）：場所・幹の太さ・高さ・葉の茂りの半径 */
interface Tree { group: THREE.Group; x: number; z: number; trunk: number; height: number; crown: number }
/** 見ている所よりこれ（m）以上カメラ寄りの木は、画面に映っていれば隠す */
const HIDE_NEARER = 1.5;

export class Forest {
  readonly object = new THREE.Group();
  readonly colliders: BoxCollider[] = [];
  readonly area: Area = { minX: -FOREST_W / 2, maxX: FOREST_W / 2, minZ: -FOREST_D / 2, maxZ: FOREST_D / 2 };
  /** 森には餌皿・水皿はない */
  readonly foodDish = null;
  readonly waterDish = null;
  readonly toilet = { x: TOILET.x, z: TOILET.z, w: TOILET.w, d: TOILET.d };
  /** 置いてある物（体が乗れない所）：木・切り株・岩・倒木の中心と半径。行き先もこの外へ寄せる */
  readonly props: { x: number; z: number; r: number }[] = [];
  /** 地面を這う根の通り道（上から見た線分と半幅。草・キノコ・茂み・巣材を根に重ねない） */
  private readonly rootSegs: { ax: number; az: number; bx: number; bz: number; w: number }[];
  /** 草むら・茂み（当たらないが、中に置いた物が隠れる）：中心と半径（m） */
  readonly covers: { x: number; z: number; r: number }[] = [];
  /**
   * 苔の生える所（倒木の脇・切り株・岩・広場の木の根元の地面。巣材の苔はここに生えていて、ゆっくりがはがして運ぶ）：
   * 物のすぐ脇の点と、物のふちに沿う向き（単位ベクトル）
   */
  readonly mossSites: { x: number; z: number; tx: number; tz: number }[] = [];
  /** 空と遠くの色（霧） */
  readonly sky = '#e3ead9';
  private readonly trees: Tree[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private readonly caveYaw: number;
  private seed = 7;

  constructor(body: THREE.ShaderMaterial, outlineBody: THREE.ShaderMaterial) {
    // 洞穴の向き（入口は広場の真ん中を向く）。置く物を洞穴に重ねないのに先に使う
    this.caveYaw = Math.atan2(-CAVE.x, -CAVE.z);
    this.rootSegs = rootSegments(this.caveYaw);
    const outline = createAccessoryOutlineMaterial(outlineBody);
    const caveOutline = createAccessoryOutlineMaterial(outlineBody);
    this.disposables.push(outline, caveOutline);
    // 地面に押し付けない（岩の下や根が持ち上がらないように）
    const mats = new Map<ToonColors, THREE.ShaderMaterial>();
    const mat = (c: ToonColors, doubleSide = false) => {
      if (!doubleSide && mats.has(c)) return mats.get(c)!;
      const m = createAccessoryMaterial(body, c, { rim: 0.2, ground: -10, doubleSide });
      this.disposables.push(m);
      if (!doubleSide) mats.set(c, m);
      return m;
    };
    const add = (g: THREE.BufferGeometry, m: THREE.Material, line: THREE.Material | null = outline) => {
      this.disposables.push(g);
      return withOutline(g, m, line);
    };

    // 地面：落ち葉の床（繰り返しの絵）
    const floorTex = leafLitterTexture();
    floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set((FLOOR_R * 2) / FLOOR_TILE, (FLOOR_R * 2) / FLOOR_TILE);
    const floorMat = new THREE.MeshBasicMaterial({ map: floorTex });
    const floorGeo = new THREE.CircleGeometry(FLOOR_R, 64).rotateX(-Math.PI / 2);
    this.disposables.push(floorTex, floorMat, floorGeo);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.y = 0.0005;
    this.object.add(floor);

    // 見えない壁（外へ厚い箱）
    const W2 = FOREST_W / 2, D2 = FOREST_D / 2;
    for (const [x, z, hx, hz] of [
      [0, -D2 - WALL_T / 2, W2 + WALL_T, WALL_T / 2], [0, D2 + WALL_T / 2, W2 + WALL_T, WALL_T / 2],
      [-W2 - WALL_T / 2, 0, WALL_T / 2, D2 + WALL_T], [W2 + WALL_T / 2, 0, WALL_T / 2, D2 + WALL_T],
    ]) this.colliders.push({ x, z, yaw: 0, hx, hz, h: WALL_H, contacts: 0 });

    // 木：周りをぐるりと囲む（範囲の縁の外。奥ほど密に）と、もっと外の列（霧に溶ける）
    const tree = (x: number, z: number, trunk: number, height: number, solid: boolean, roots?: readonly number[]) => {
      const g = new THREE.Group();
      // 根を張る木は、根の向きだけ幹の根元をふくらませる（幹から根が生えて見えるように）
      g.add(add(roots ? buttressTrunk(trunk, height, roots) : lathe(trunkProfile(trunk, height), 20), mat(BARK)));
      // 葉の茂り：幹の上に丸い塊を 4〜6 つ（色ごとに 1 つの形にまとめる。木が多いので、描く回数を減らす）
      const crown = trunk * 3.4 + 0.6;
      const n = 4 + Math.floor(this.rand() * 3);
      const light: THREE.BufferGeometry[] = [], dark: THREE.BufferGeometry[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + this.rand();
        const s = crown * (0.55 + this.rand() * 0.3);
        const geo = lumpy(new THREE.IcosahedronGeometry(s, 2), s * 0.08, this.rand() * 10);
        geo.translate(Math.cos(a) * crown * 0.45, height + this.rand() * crown * 0.5, Math.sin(a) * crown * 0.45);
        (i % 2 ? dark : light).push(geo);
      }
      const top = lumpy(new THREE.IcosahedronGeometry(crown * 0.7, 2), crown * 0.05, this.rand() * 10);
      top.translate(0, height + crown * 0.75, 0);
      light.push(top);
      for (const [geos, colors] of [[light, LEAVES], [dark, LEAVES_DARK]] as const) {
        g.add(add(mergeGeometries(geos), mat(colors)));
        for (const geo of geos) geo.dispose();
      }
      g.position.set(x, 0, z);
      g.rotation.y = this.rand() * Math.PI * 2;
      this.object.add(g);
      this.trees.push({ group: g, x, z, trunk, height, crown });
      if (solid) {
        this.colliders.push({ x, z, yaw: 0, hx: trunk, hz: trunk, h: height, contacts: 0 });
        this.props.push({ x, z, r: trunk * 1.25 });
      }
    };
    // 縁の外の 1 列目（範囲の縁から 0.6〜1.6 m 外）
    const ring = (inset: number, spread: number, step: number, solid: boolean) => {
      const hw = W2 + inset, hd = D2 + inset;
      const perim = 4 * (hw + hd);
      for (let s = this.rand() * step; s < perim; s += step * (0.75 + this.rand() * 0.5)) {
        let x: number, z: number;
        let d = s;
        if (d < 2 * hw) [x, z] = [-hw + d, -hd];
        else if ((d -= 2 * hw) < 2 * hd) [x, z] = [hw, -hd + d];
        else if ((d -= 2 * hd) < 2 * hw) [x, z] = [hw - d, hd];
        else [x, z] = [-hw, hd - (d - 2 * hw)];
        x += (this.rand() - 0.5) * spread;
        z += (this.rand() - 0.5) * spread;
        // といれの木・洞穴の後ろには置かない（重なる）
        if (Math.hypot(x - TOILET_TREE.x, z - TOILET_TREE.z) < 2.2 || Math.hypot(x - CAVE.x, z - CAVE.z) < CAVE.rx + 0.9) continue;
        tree(x, z, 0.28 + this.rand() * 0.2, 3.6 + this.rand() * 1.4, solid);
      }
    };
    ring(1.1, 0.8, 2.6, false);
    ring(3.4, 1.6, 3.0, false);
    ring(6.5, 2.4, 3.6, false);
    // 広場の中の木（1 本）と、といれの木
    tree(-3.4, 1.9, 0.34, 4.2, true);
    tree(TOILET_TREE.x, TOILET_TREE.z, TOILET_TREE.r, 4.8, true, TOILET_ROOTS.map((r) => r[0]));

    // といれ：木の根元のくぼみ（土の色の浅い穴。縁が少し盛り上がる）と、くぼみの両脇へ伸びる根
    const soilTex = soilTexture();
    const soilMat = new THREE.MeshBasicMaterial({ map: soilTex });
    const soilGeo = new THREE.ShapeGeometry(blob(TOILET.w / 2, TOILET.d / 2, 0.06, 3), 1);
    soilGeo.rotateX(-Math.PI / 2);
    const suv = soilGeo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < suv.count; i++) suv.setXY(i, suv.getX(i) / TOILET.w + 0.5, suv.getY(i) / TOILET.d + 0.5);
    this.disposables.push(soilTex, soilMat, soilGeo);
    const hollow = new THREE.Mesh(soilGeo, soilMat);
    hollow.position.set(TOILET.x, 0.0015, TOILET.z);
    this.object.add(hollow);
    const rim = add(moundRing(TOILET.w / 2, TOILET.d / 2, 0.14, 0.035), mat(SOIL));
    rim.position.set(TOILET.x, 0, TOILET.z);
    this.object.add(rim);
    // 根：幹の根元のふくらみ（buttressTrunk）の足元から、くぼみの左右と横へ平たく地面を這い、細くなって潜る（flatRoot）
    for (const [a, len] of TOILET_ROOTS) {
      const geo = flatRoot(a, TOILET_TREE.r * 0.75, toiletRootEnd(len), 0.17, 0.11, a * 7);
      const root = add(geo, mat(BARK));
      root.position.set(TOILET_TREE.x, 0, TOILET_TREE.z);
      this.object.add(root);
    }

    // 切り株
    for (const [x, z, r, h] of [[3.6, 1.7, 0.48, 0.5], [-1.4, -3.6, 0.36, 0.36]]) {
      const g = add(lathe(stumpProfile(r, h), 24), mat(BARK));
      const capTex = ringsTexture();
      const capMat = new THREE.MeshBasicMaterial({ map: capTex, color: STUMP_TOP });
      const capGeo = new THREE.CircleGeometry(r * 0.94, 24).rotateX(-Math.PI / 2);
      this.disposables.push(capTex, capMat, capGeo);
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.position.y = h + 0.002;
      g.add(cap);
      g.position.set(x, 0, z);
      this.object.add(g);
      this.colliders.push({ x, z, yaw: 0, hx: r * 0.95, hz: r * 0.95, h, contacts: 0 });
      this.props.push({ x, z, r: r * 1.15 });
    }

    // 倒木：横に寝た丸太（両端は年輪）
    {
      const L = { x: -5.6, z: 2.7, len: 3.4, r: 0.32, yaw: 0.45 };
      const g = new THREE.Group();
      const bark = add(new THREE.CylinderGeometry(L.r, L.r * 1.08, L.len, 20, 1, true).rotateZ(Math.PI / 2), mat(BARK, true));
      g.add(bark);
      for (const s of [-1, 1]) {
        const capTex = ringsTexture();
        const capMat = new THREE.MeshBasicMaterial({ map: capTex, color: STUMP_TOP, side: THREE.DoubleSide });
        const capGeo = new THREE.CircleGeometry(L.r * (s < 0 ? 1.06 : 1), 20).rotateY(Math.PI / 2);
        this.disposables.push(capTex, capMat, capGeo);
        const cap = new THREE.Mesh(capGeo, capMat);
        cap.position.x = (s * L.len) / 2;
        g.add(cap);
      }
      g.position.set(L.x, L.r * 0.9, L.z);
      g.rotation.y = L.yaw;
      this.object.add(g);
      this.colliders.push({ x: L.x, z: L.z, yaw: L.yaw, hx: L.len / 2, hz: L.r, h: L.r * 1.8, contacts: 0 });
      for (const t of [-0.35, 0, 0.35]) {
        this.props.push({ x: L.x + Math.cos(L.yaw) * L.len * t, z: L.z - Math.sin(L.yaw) * L.len * t, r: L.r * 1.4 });
      }
    }

    // 岩
    for (const [x, z, s, h] of [[6.4, 2.3, 0.75, 0.55], [0.9, -4.7, 0.55, 0.45], [-7.0, -0.7, 0.5, 0.4], [7.0, 3.4, 0.35, 0.28]]) {
      const geo = lumpy(new THREE.IcosahedronGeometry(1, 2), 0.12, x * 3 + z);
      geo.scale(s, h, s * 0.85);
      const g = add(geo, mat(ROCK));
      g.position.set(x, h * 0.45, z);
      g.rotation.y = this.rand() * Math.PI;
      this.object.add(g);
      this.colliders.push({ x, z, yaw: 0, hx: s * 0.85, hz: s * 0.85, h: h * 1.4, contacts: 0 });
      this.props.push({ x, z, r: s });
    }

    // 苔の生える所：切り株・岩・広場の木の根元（広場の真ん中の側から少しずらした所）と、倒木の広場側の脇。
    // 物の脇（体が乗れない所 props の円のすぐ外）に置く。苔は根元に少しかかって寄り添う（巣材の grow）
    // 生える所の物には、はがせない苔を根元・側面に少し這わせる（苔がそこに生えていると分かるように）
    {
      const off = MOSS_OFF;
      const mossMat = mat(MOSS);
      const creep = (x: number, y: number, z: number, yaw: number, w: number, h: number, d: number) => {
        const geo = lumpy(new THREE.IcosahedronGeometry(1, 2), 0.18, x * 5 + z * 3).scale(w, h, d).rotateY(yaw);
        const m = add(geo, mossMat);
        m.position.set(x, y, z);
        this.object.add(m);
      };
      const round = (cx: number, cz: number, r: number, rv: number) => {
        const a = Math.atan2(-cx, -cz) + 0.5;
        this.mossSites.push({ x: cx + Math.sin(a) * (r + off), z: cz + Math.cos(a) * (r + off), tx: Math.cos(a), tz: -Math.sin(a) });
        // 根元を這う苔（物の表面に半分埋めた平たいかたまり 2 つ）
        for (const da of [-0.35, 0.3]) {
          const b = a + da;
          creep(cx + Math.sin(b) * rv * 0.95, 0.04, cz + Math.cos(b) * rv * 0.95, b, rv * 0.55, 0.13, 0.13);
        }
      };
      // 切り株・岩・木の、体が乗れない所の半径（props と同じ）と、見た目の半径
      for (const [x, z, r, rv] of [
        [3.6, 1.7, 0.48 * 1.15, 0.5], [-1.4, -3.6, 0.36 * 1.15, 0.38], [6.4, 2.3, 0.75, 0.66], [0.9, -4.7, 0.55, 0.48],
        [-7.0, -0.7, 0.5, 0.44], [-3.4, 1.9, 0.34 * 1.25, 0.4],
      ]) {
        round(x, z, r, rv);
      }
      const L = { x: -5.6, z: 2.7, len: 3.4, r: 0.32 * 1.4, yaw: 0.45 };
      const dx = Math.cos(L.yaw), dz = -Math.sin(L.yaw), nx = Math.sin(L.yaw), nz = Math.cos(L.yaw);
      const side = nx * -L.x + nz * -L.z > 0 ? 1 : -1;
      for (const t of [-0.2, 0.2]) {
        this.mossSites.push({ x: L.x + dx * L.len * t + nx * side * (L.r + off), z: L.z + dz * L.len * t + nz * side * (L.r + off), tx: dx, tz: dz });
        // 倒木の脇腹を這う苔
        const yaw = Math.atan2(nx * side, nz * side);
        creep(L.x + dx * L.len * t + nx * side * 0.26, 0.2, L.z + dz * L.len * t + nz * side * 0.26, yaw, 0.42, 0.16, 0.12);
      }
    }

    // 茂み（当たらない。中に入れる）
    for (const [x0, z0, s] of [[-7.2, 4.6, 0.55], [7.3, -1.2, 0.6], [1.8, 5.4, 0.5], [-2.2, -5.4, 0.55], [7.2, 5.3, 0.45], [-7.4, -3.2, 0.5]]) {
      if (this.nearCave(x0, z0)) continue;
      const [x, z] = this.offRoots(x0, z0, s * 1.3);
      const g = new THREE.Group();
      const n = 4 + Math.floor(this.rand() * 2);
      for (let i = 0; i < n; i++) {
        const r = s * (0.6 + this.rand() * 0.45);
        const a = (i / n) * Math.PI * 2 + this.rand();
        const geo = lumpy(new THREE.IcosahedronGeometry(r, 1), r * 0.1, this.rand() * 10);
        geo.translate(Math.cos(a) * s * 0.6, r * 0.75, Math.sin(a) * s * 0.6);
        g.add(add(geo, mat(BUSH)));
      }
      g.position.set(x, 0, z);
      this.object.add(g);
      this.covers.push({ x, z, r: s * 1.6 });
    }

    // 草むら（当たらない）：細い葉の束
    const grassMat = mat(GRASS, true);
    for (const [x0, z0, s] of [
      [-1.8, 3.6, 1], [2.6, 3.9, 0.8], [5.4, -0.4, 0.9], [-6.6, 1.0, 1.1], [-0.4, -2.6, 0.7], [1.9, -1.2, 0.8],
      [-4.0, 4.9, 1], [6.0, 4.6, 0.9], [-7.3, -5.0, 1.1], [0.3, 5.3, 0.9], [-3.6, -1.0, 0.6], [-5.6, -1.0, 1],
    ]) {
      if (this.nearCave(x0, z0)) continue;
      const [x, z] = this.offRoots(x0, z0, 0.4 * s);
      const geo = grassClump(0.32 * s, 0.45 * s, 26, this.seed++);
      this.disposables.push(geo);
      const m = new THREE.Mesh(geo, grassMat);
      m.position.set(x, 0, z);
      this.object.add(m);
      this.covers.push({ x, z, r: 0.45 * s });
    }

    // キノコ：といれの木の根元・倒木・切り株の脇
    for (const [x0, z0, s, red] of [
      [-6.3, -4.0, 1, 1], [-6.6, -3.7, 0.7, 1], [-4.2, -4.1, 0.8, 0], [-4.5, 3.3, 0.9, 0], [-4.2, 3.5, 0.6, 0],
      [4.2, 2.1, 0.75, 1], [-0.9, -3.8, 0.65, 0], [6.9, 1.5, 0.7, 1],
    ]) {
      if (this.nearCave(x0, z0)) continue;
      const [x, z] = this.offRoots(x0, z0, 0.13 * s);
      const g = new THREE.Group();
      const h = 0.16 * s, cr = 0.11 * s;
      g.add(add(lathe([[0, 0], [0.035 * s, 0], [0.03 * s, h * 0.6], [0.026 * s, h], [0, h]], 12, true), mat(MUSHROOM_STEM)));
      const capGeo = new THREE.SphereGeometry(cr, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      capGeo.scale(1, 0.75, 1).translate(0, h * 0.92, 0);
      g.add(add(capGeo, mat(red ? MUSHROOM_CAP : MUSHROOM_CAP_BROWN, true)));
      if (red) {
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + 0.4, el = i === 0 ? 1.4 : 0.75;
          const dot = new THREE.SphereGeometry(cr * 0.16, 8, 6).scale(1, 0.4, 1);
          const dir = new THREE.Vector3(Math.cos(a) * Math.cos(el), Math.sin(el) * 0.75, Math.sin(a) * Math.cos(el));
          dot.lookAt(dir).translate(dir.x * cr, h * 0.92 + dir.y * cr, dir.z * cr);
          g.add(add(dot, mat(DOT), null));
        }
      }
      g.position.set(x, 0, z);
      g.rotation.y = this.rand() * Math.PI * 2;
      this.object.add(g);
    }

    // 洞穴（入口は広場の真ん中を向く）
    const cave = this.buildCave(body, caveOutline, outline);
    // ステンシル：洞穴は 1、ほかは 0。森の物は先に描く（ゆっくりのシルエットより前に、ステンシルを書き終える）
    this.object.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.renderOrder = -1;
    });
    const stencil = (root: THREE.Object3D, ref: number) => root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        m.stencilWrite = true;
        m.stencilRef = ref;
        m.stencilFunc = THREE.AlwaysStencilFunc;
        m.stencilZPass = THREE.ReplaceStencilOp;
      }
    });
    for (const c of this.object.children) if (c !== cave) stencil(c, 0);
    stencil(cave, 1);
  }

  /** 点（x, z）が洞穴の中か（屋根の下に体が入りきった所） */
  inCave(x: number, z: number): boolean {
    const [lx, lz] = this.toCave(x, z);
    const rx = CAVE.rx - CAVE.wall, rz = CAVE.rz - CAVE.wall;
    return (lx / rx) ** 2 + (lz / rz) ** 2 < CAVE_INSIDE ** 2;
  }

  /**
   * 毎フレーム：カメラ寄りの木を隠す（周りを木が囲むので、外や上から見ると幹や葉が前をふさぐ）。
   * 幹の中ほど・葉の茂りのどちらかが、見ている所より HIDE_NEARER m 以上カメラに近く、画面に映っている木と、
   * カメラのすぐそば（水平に葉の茂りの半径 + 1 m）の木。
   * 加えて、カメラと見ている所を結ぶ線のすぐそばの幹も隠す
   */
  update(camera: THREE.Camera, target?: THREE.Vector3): void {
    if (!target) return;
    const cp = camera.position;
    const far = Math.hypot(target.x - cp.x, target.z - cp.z) - HIDE_NEARER;
    const far3 = cp.distanceTo(target) - HIDE_NEARER;
    const ax = cp.x, az = cp.z, bx = target.x - ax, bz = target.z - az;
    const len2 = bx * bx + bz * bz;
    const v = this.tmp;
    // 点が見ている所よりカメラ寄りで、画面に映っているか
    const blocks = (x: number, y: number, z: number) => {
      v.set(x, y, z);
      if (v.distanceTo(cp) >= far3) return false;
      v.project(camera);
      return v.z < 1 && Math.abs(v.x) < 1.15 && Math.abs(v.y) < 1.15;
    };
    for (const t of this.trees) {
      let hide = false;
      const d = Math.hypot(t.x - cp.x, t.z - cp.z);
      // カメラのすぐそばの木は、幹が画面の外でも葉が画面をふさぐ
      hide = (d < far && d < t.crown + 1) || blocks(t.x, t.height * 0.5, t.z) || blocks(t.x, t.height + t.crown * 0.6, t.z);
      if (!hide && len2 > 1e-6) {
        const k = Math.min(1, Math.max(0, ((t.x - ax) * bx + (t.z - az) * bz) / len2));
        hide = k < 0.97 && Math.hypot(ax + bx * k - t.x, az + bz * k - t.z) < t.trunk + 0.6;
      }
      t.group.visible = !hide;
    }
  }
  private readonly tmp = new THREE.Vector3();

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private rand(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  /**
   * 点（x, z）が洞穴の岩の殻（外の楕円の CAVE_CLEAR 倍）にかかるか。草むら・茂み・キノコはそこに置かない
   * （洞穴の中に草むらがあると、暗い洞穴の中で草だけ明るく浮いて見えた）。巣材も散らばらせない
   */
  nearCave(x: number, z: number): boolean {
    const [lx, lz] = this.toCave(x, z);
    return (lx / CAVE.rx) ** 2 + (lz / CAVE.rz) ** 2 < CAVE_CLEAR ** 2;
  }

  /** 点（x, z）がうろの床の上か（内側の円の HOLLOW_FLOOR 倍より内） */
  inHollow(x: number, z: number): boolean {
    const [lx, lz] = this.toCave(x, z);
    return Math.hypot(lx, lz) < (CAVE.rx - CAVE.wall) * HOLLOW_FLOOR;
  }

  /**
   * 歩く道（Locomotion.route）：（fx, fz）から（tx, tz）へまっすぐ行くと幹（壁の当たり）を通るなら、その手前で向かう点。
   * うろの中と外を行き来するときは入口の前と入口の内を通り、外どうしで幹が間にあれば幹のまわりを回る。毎回、今いる所から決める
   * （道を探す仕組みはなく、まっすぐ幹へ向かうと当たって止まり、運ぶ・拾うのをあきらめていた）
   */
  via(fx: number, fz: number, tx: number, tz: number, R: number): { x: number; z: number } | null {
    const ri = CAVE.rx - CAVE.wall, ro = CAVE.rx + CAVE.wall;
    const [cx, cz] = this.toCave(fx, fz);
    const [gx, gz] = this.toCave(tx, tz);
    const door = CAVE.door - R * 0.8;
    // 体が幹にかかる所（入口の通り道は除く）
    const hits = (x: number, z: number) => {
      const d = Math.hypot(x, z);
      return d > ri - R * 0.7 && d < ro + R * 0.6 && !(z > 0 && Math.abs(x) < door);
    };
    // 行き先の手前 R は見ない（幹のすぐそばの行き先は、幹に当たって止まる所が着く所。見ると着かずに回り続けた）
    const blocked = (ax: number, az: number, bx: number, bz: number) => {
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.ceil(len / 0.15);
      for (let i = 1; i <= n; i++) {
        if (len * (1 - i / n) < R) break;
        if (hits(ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n)) return true;
      }
      return false;
    };
    if (!blocked(cx, cz, gx, gz)) return null;
    const inside = (x: number, z: number) => Math.hypot(x, z) < ri - 0.1;
    const outer: [number, number] = [0, ro + R + 0.6], inner: [number, number] = [0, ri - R - 0.4];
    // 幹のまわりを、目当ての向き（ローカルの角度）の側へ回る
    const orbit = (goal: number): [number, number] => {
      const a = Math.atan2(cx, cz);
      const diff = Math.atan2(Math.sin(goal - a), Math.cos(goal - a));
      const b = a + Math.sign(diff) * Math.min(Math.abs(diff), 0.8);
      const r = Math.max(Math.hypot(cx, cz), ro + R + 0.5);
      return [Math.sin(b) * r, Math.cos(b) * r];
    };
    let p: [number, number];
    if (inside(cx, cz)) {
      // 出る：入口の通り道に入っていれば外の入口の前へ、まだなら内の入口へ
      p = Math.abs(cx) < door - 0.15 && cz > 0.3 ? outer : inner;
    } else if (inside(gx, gz)) {
      // 入る：入口の前なら内の入口へ、入口の前へまっすぐ行けるならそこへ、だめなら入口の側へ回る
      p = !blocked(cx, cz, ...inner) ? inner : !blocked(cx, cz, ...outer) ? outer : orbit(0);
    } else {
      p = orbit(Math.atan2(gx, gz));
    }
    const c = Math.cos(this.caveYaw), s = Math.sin(this.caveYaw);
    return { x: CAVE.x + p[0] * c + p[1] * s, z: CAVE.z - p[0] * s + p[1] * c };
  }

  /**
   * 点 p が大木のうろの幹（壁）にかかる所なら、近い側（うろの中・外）へ keep m 離して寄せる（入口の通り道は除く）。寄せたら true。
   * 幹の裏の行き先が幹の中になり、着かずに周りを回り続けた
   */
  pushOutOfHollow(p: { x: number; z: number }, keep: number): boolean {
    const ri = CAVE.rx - CAVE.wall, ro = CAVE.rx + CAVE.wall;
    const [lx, lz] = this.toCave(p.x, p.z);
    const d = Math.hypot(lx, lz);
    if (d <= ri - keep || d >= ro + keep || (lz > 0 && Math.abs(lx) < CAVE.door - keep * 0.8) || d < 1e-6) return false;
    const k = (d < (ri + ro) / 2 ? ri - keep : ro + keep) / d;
    const c = Math.cos(this.caveYaw), s = Math.sin(this.caveYaw);
    p.x = CAVE.x + lx * k * c + lz * k * s;
    p.z = CAVE.z - lx * k * s + lz * k * c;
    return true;
  }

  /** 中心（x, z）・半径 r の円が、地面を這う根にかかるか */
  onRoot(x: number, z: number, r: number): boolean {
    return this.rootSegs.some((g) => {
      const vx = g.bx - g.ax, vz = g.bz - g.az;
      const k = Math.min(1, Math.max(0, ((x - g.ax) * vx + (z - g.az) * vz) / (vx * vx + vz * vz)));
      return Math.hypot(x - (g.ax + vx * k), z - (g.az + vz * k)) < g.w + r;
    });
  }

  /** 飾り（草・キノコ・茂み）の置き場が根にかかるなら、近くの根にかからない所へずらす（根を突き抜けて見えた） */
  private offRoots(x: number, z: number, r: number): [number, number] {
    if (!this.onRoot(x, z, r)) return [x, z];
    for (let d = 0.1; d <= 1.5; d += 0.1) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const px = x + Math.sin(a) * d, pz = z + Math.cos(a) * d;
        if (!this.onRoot(px, pz, r)) return [px, pz];
      }
    }
    return [x, z];
  }

  /** ワールドの点を洞穴のローカル（入口が +z）へ */
  private toCave(x: number, z: number): [number, number] {
    const dx = x - CAVE.x, dz = z - CAVE.z;
    const c = Math.cos(this.caveYaw), s = Math.sin(this.caveYaw);
    return [dx * c - dz * s, dx * s + dz * c];
  }

  /**
   * 洞穴：でこぼこした半球の岩の殻（外と内の 2 枚。内は暗い色）に、入口のアーチをくり抜く。床は暗い楕円。
   * 当たりは内側の楕円に沿って並べた箱（入口だけ空ける）
   */
  private buildCave(body: THREE.ShaderMaterial, outline: THREE.ShaderMaterial, crownOutline: THREE.ShaderMaterial): THREE.Group {
    const g = new THREE.Group();
    const barkMat = createAccessoryMaterial(body, BARK, { rim: 0.2, ground: -10 });
    const rimMat = createAccessoryMaterial(body, HOLLOW_RIM, { rim: 0.2, ground: -10 });
    const innerMat = new THREE.MeshBasicMaterial({ color: CAVE_INNER, side: THREE.BackSide });
    // 床：土に木くず・細い繊維・砂粒が混じったごわごわした絵（指示）。床の形の座標（m）を uv にしているので、HOLLOW_FLOOR_TILE m ごとに繰り返す
    const floorTex = hollowFloorTexture();
    floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set(1 / HOLLOW_FLOOR_TILE, 1 / HOLLOW_FLOOR_TILE);
    const floorMat = new THREE.MeshBasicMaterial({ map: floorTex });
    this.disposables.push(barkMat, rimMat, innerMat, floorMat, floorTex);
    const W = CAVE.wall;
    // 幹（入口のアーチをくり抜く）と、中の暗い天井（半球）と床
    const trunk = hollowTrunk();
    const inner = caveShell(CAVE.rx - W, CAVE.ry - W, CAVE.rz - W);
    const floorGeo = hollowFloor(W);
    this.disposables.push(trunk, inner, floorGeo);
    g.add(withOutline(trunk, barkMat, outline));
    g.add(new THREE.Mesh(inner, innerMat));
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.y = 0.0012;
    g.add(floor);
    // 入口の縁：アーチに沿った明るい木の帯。幹の表面に置いて、くり抜いた縁のぎざぎざを外から覆う
    // （幹と中の天井の間に置くと、帯が幹の中に隠れて、ぎざぎざが見えた）。奥行きに長くして、幹と中の天井のすき間もふさぐ
    // 帯の両端は地面の下まで伸ばす（地面ちょうどで止めると、管の切り口が見えた）
    const archAngle = (t: number) => -ARCH_SINK + (Math.PI + ARCH_SINK * 2) * t;
    const arch = tubeAlong((t) => {
      const a = archAngle(t);
      const x = Math.cos(a) * CAVE.door, y = Math.sin(a) * CAVE.doorH;
      const zo = Math.sqrt(Math.max(0, hollowRadius(Math.max(0, y), 0) ** 2 - x * x));
      return new THREE.Vector3(x, y, zo - 0.06);
    }, (t) => 0.2 + 0.03 * Math.sin(t * 17), 48, 12);
    // 入口の壁の厚み：外の幹の縁から中の天井の縁までを、アーチに沿った帯の面でつなぐ（幹と中の天井のすき間をふさぐ）。
    // 前は太い管でふさいでいて、管がアーチの両脇で幹の表面より外へはみ出していた
    const reveal = archReveal(archAngle, W);
    const revealMat = createAccessoryMaterial(body, HOLLOW_RIM, { rim: 0.2, ground: -10, doubleSide: true });
    this.disposables.push(reveal, revealMat);
    g.add(new THREE.Mesh(reveal, revealMat));
    this.disposables.push(arch);
    g.add(withOutline(arch, rimMat, outline));
    // 根：入口を避けて、幹の根元のふくらみ（hollowRadius の HOLLOW_ROOTS）の足元から、放射状に平たく地面を這う
    HOLLOW_ROOTS.forEach((a, i) => {
      const geo = flatRoot(a, hollowRootStart(a), hollowRootEnd(a, i), 0.36, 0.2, i * 3.1);
      this.disposables.push(geo);
      g.add(withOutline(geo, barkMat, outline));
    });
    g.position.set(CAVE.x, 0, CAVE.z);
    g.rotation.y = this.caveYaw;
    this.object.add(g);

    // 葉の茂り（ステンシルは 0。洞穴の中のシルエットにかぶらないよう、洞穴の組の外に置き、輪郭線もほかの森の物と同じものを使う）。
    // カメラの前をふさげば隠す
    const crown = new THREE.Group();
    const leaves = (geos: THREE.BufferGeometry[], colors: ToonColors) => {
      const geo = mergeGeometries(geos);
      for (const x of geos) x.dispose();
      this.disposables.push(geo);
      const m = createAccessoryMaterial(body, colors, { rim: 0.2, ground: -10 });
      this.disposables.push(m);
      crown.add(withOutline(geo, m, crownOutline));
    };
    const light: THREE.BufferGeometry[] = [], dark: THREE.BufferGeometry[] = [];
    const H = HOLLOW.height, R = HOLLOW.crown;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.3;
      const s = R * (0.6 + 0.25 * Math.abs(Math.sin(i * 1.9)));
      const geo = lumpy(new THREE.IcosahedronGeometry(s, 2), s * 0.08, i * 1.7);
      geo.translate(Math.cos(a) * R * 0.75, H - 0.4 + Math.abs(Math.sin(i * 2.7)) * R * 0.5, Math.sin(a) * R * 0.75);
      (i % 2 ? dark : light).push(geo);
    }
    const top = lumpy(new THREE.IcosahedronGeometry(R * 0.85, 2), R * 0.05, 4.2);
    top.translate(0, H + R * 0.7, 0);
    light.push(top);
    leaves(light, LEAVES);
    leaves(dark, LEAVES_DARK);
    crown.position.set(CAVE.x, 0, CAVE.z);
    this.object.add(crown);
    this.trees.push({ group: crown, x: CAVE.x, z: CAVE.z, trunk: CAVE.rx, height: H, crown: R * 1.4 });

    // 当たり：内側の楕円に沿って、外へ厚い箱を並べる（入口の幅だけ空ける）
    const rx = CAVE.rx - W, rz = CAVE.rz - W, T = 0.6, N = 22;
    const c = Math.cos(this.caveYaw), s = Math.sin(this.caveYaw);
    const at = (a: number) => new THREE.Vector2(rx * Math.sin(a), rz * Math.cos(a));
    for (let i = 0; i < N; i++) {
      const p0 = at((i / N) * Math.PI * 2), p1 = at(((i + 1) / N) * Math.PI * 2);
      const mid = p0.clone().add(p1).multiplyScalar(0.5);
      if (mid.y > 0 && Math.abs(mid.x) < CAVE.door + 0.15) continue;
      const n = new THREE.Vector2(mid.x / (rx * rx), mid.y / (rz * rz)).normalize();
      const lc = mid.clone().addScaledVector(n, T / 2);
      const yaw = Math.atan2(-(p1.y - p0.y), p1.x - p0.x) + this.caveYaw;
      this.colliders.push({
        x: CAVE.x + lc.x * c + lc.y * s, z: CAVE.z - lc.x * s + lc.y * c, yaw,
        hx: p0.distanceTo(p1) / 2 + 0.12, hz: T / 2, h: 2, contacts: 0,
      });
    }
    return g;
  }
}

/** 大木の幹の半径（高さ y・向き a。a は +z が 0）：根元が広がり、上へ細くなり、縦に樹皮の筋が入る */
function hollowRadius(y: number, a: number): number {
  const base = CAVE.rx + 0.15;
  const taper = base * (1 - (1 - HOLLOW.topRatio) * Math.min(1, y / HOLLOW.height));
  const flare = 1 + HOLLOW.flare * Math.exp(-y / 0.45);
  const ridge = 1 + HOLLOW.ridgeDepth * Math.sin(a * HOLLOW.ridges + y * 0.35);
  return taper * flare * ridge * (1 + buttress(a, y, HOLLOW_ROOTS, HOLLOW_BUTTRESS));
}

/**
 * うろの床：中の天井（半球）の足元の円に、入口の敷居（入口の壁の厚みの帯にはさまれた所。外は幹の表面まで）を足した形。
 * 床の縁を壁の足元に合わせる（前は少し大きい円で、入口で床の縁が壁と合わず、入口の外の地面へもはみ出していた）
 */
function hollowFloor(wall: number): THREE.BufferGeometry {
  const r = CAVE.rx - wall;
  const d = CAVE.door + 0.03; // 入口の壁の厚みの帯（archReveal）と同じ幅
  const zIn = Math.sqrt(Math.max(0, r * r - d * d));
  const start = Math.atan2(d, zIn); // 円と入口の帯の交わる所（+z が 0、+x へ回る）
  // 形の座標は (x, -z)（rotateX(-π/2) で y が -z になる）
  const s = new THREE.Shape();
  const N = 72;
  for (let i = 0; i <= N; i++) {
    const a = start + ((Math.PI * 2 - start * 2) * i) / N;
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (i === 0) s.moveTo(x, -z);
    else s.lineTo(x, -z);
  }
  // 敷居：左の帯に沿って幹の表面まで出て、幹の表面に沿って右へ、右の帯に沿って戻る
  const M = 12;
  for (let i = 0; i <= M; i++) {
    const x = -d + (2 * d * i) / M;
    const zo = Math.sqrt(Math.max(0, hollowRadius(0, 0) ** 2 - x * x)) - 0.02;
    s.lineTo(x, -zo);
  }
  s.closePath();
  return new THREE.ShapeGeometry(s, 1).rotateX(-Math.PI / 2);
}

/**
 * うろの入口の壁の厚み：アーチ（幅 door・高さ doorH。少し広げて、くり抜いた縁のぎざぎざの内側を覆う）に沿って、
 * 外の幹の表面から中の天井（厚み wall だけ内側の半球）までをつなぐ帯の面。angle(t) はアーチの角度（両端は地面の下まで）
 */
function archReveal(angle: (t: number) => number, wall: number): THREE.BufferGeometry {
  const N = 64;
  const rx = CAVE.rx - wall, ry = CAVE.ry - wall, rz = CAVE.rz - wall;
  const pos: number[] = [];
  for (let i = 0; i <= N; i++) {
    const a = angle(i / N);
    const x = Math.cos(a) * (CAVE.door + 0.03), y = Math.sin(a) * CAVE.doorH;
    const yi = Math.max(0, y);
    const zo = Math.sqrt(Math.max(0, hollowRadius(yi, 0) ** 2 - x * x)) - 0.01;
    const zi = rz * Math.sqrt(Math.max(0, 1 - (x / rx) ** 2 - (yi / ry) ** 2));
    pos.push(x, y, zo, x, y, Math.min(zi, zo - 0.02));
  }
  const index: number[] = [];
  for (let i = 0; i < N; i++) {
    const a = i * 2, b = a + 2;
    index.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** 大木の幹：根元から高さ HOLLOW.height までの筒（上はふさぐ）。入口（+z の側）のアーチをくり抜く */
function hollowTrunk(): THREE.BufferGeometry {
  // 入口のアーチの縁は三角形ごとに切り抜くので、細かく（粗いと縁が階段状にぎざぎざになり、縁の帯で隠しきれなかった）
  const NA = 192, NY = 80;
  const H = HOLLOW.height;
  const pos: number[] = [];
  for (let j = 0; j <= NY; j++) {
    // 根元の近くを細かく（入口のアーチの縁がなめらかになるように）
    const y = H * (j / NY) ** 1.6;
    for (let i = 0; i <= NA; i++) {
      const a = (i / NA) * Math.PI * 2;
      const r = hollowRadius(y, a);
      pos.push(Math.sin(a) * r, y, Math.cos(a) * r);
    }
  }
  const topCenter = pos.length / 3;
  pos.push(0, H + 0.3, 0);
  const index: number[] = [];
  const P = (k: number) => new THREE.Vector3(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]);
  const inDoor = (a: number, b: number, c: number) => {
    const m = P(a).add(P(b)).add(P(c)).multiplyScalar(1 / 3);
    return m.z > 0 && (m.x / CAVE.door) ** 2 + (m.y / CAVE.doorH) ** 2 < 1;
  };
  const tri = (a: number, b: number, c: number) => {
    if (!inDoor(a, b, c)) index.push(a, b, c);
  };
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NA; i++) {
      const a = j * (NA + 1) + i, b = a + NA + 1;
      // 外向きの面（逆に巻くと内向きになり、幹が暗く見えた）
      tri(a, a + 1, b);
      tri(b, a + 1, b + 1);
    }
  }
  const last = NY * (NA + 1);
  for (let i = 0; i < NA; i++) index.push(last + i + 1, topCenter, last + i);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** 洞穴の殻：横 rx・高さ ry・奥行き rz の半球を少しでこぼこにして、入口（+z の側）のアーチをくり抜いた面 */
function caveShell(rx: number, ry: number, rz: number): THREE.BufferGeometry {
  const src = new THREE.SphereGeometry(1, 72, 36, 0, Math.PI * 2, 0, Math.PI / 2).toNonIndexed();
  const p = src.getAttribute('position') as THREE.BufferAttribute;
  const out: number[] = [];
  const v = new THREE.Vector3();
  const tri: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (let i = 0; i < p.count; i += 3) {
    for (let k = 0; k < 3; k++) {
      v.fromBufferAttribute(p, i + k);
      // でこぼこ（向きで決める。外と内の殻で同じ形になる）。地面の縁は動かさない
      const bump = 1 + 0.05 * Math.sin(v.x * 7.1 + 1.3) * Math.sin(v.z * 6.3 + 0.7) + 0.035 * Math.sin(v.y * 9.7 + v.x * 3.1);
      const f = v.y < 0.02 ? 1 : bump;
      tri[k].set(v.x * rx * f, v.y * ry * f, v.z * rz * f);
    }
    // 入口：アーチ（幅 door・高さ doorH の半楕円）の中にかかる三角形は捨てる
    const cx = (tri[0].x + tri[1].x + tri[2].x) / 3, cy = (tri[0].y + tri[1].y + tri[2].y) / 3, cz = (tri[0].z + tri[1].z + tri[2].z) / 3;
    if (cz > 0 && (cx / CAVE.door) ** 2 + (cy / CAVE.doorH) ** 2 < 1) continue;
    for (const t of tri) out.push(t.x, t.y, t.z);
  }
  src.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  // 頂点を共有させて、なめらかな法線にする
  const merged = mergeVertices(g);
  g.dispose();
  merged.computeVertexNormals();
  return merged;
}

/** 同じ場所の頂点を 1 つにまとめる（なめらかな法線のため） */
function mergeVertices(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const map = new Map<string, number>();
  const pos: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < p.count; i++) {
    const key = `${Math.round(p.getX(i) * 1e4)},${Math.round(p.getY(i) * 1e4)},${Math.round(p.getZ(i) * 1e4)}`;
    let j = map.get(key);
    if (j === undefined) {
      j = pos.length / 3;
      map.set(key, j);
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
    }
    index.push(j);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setIndex(index);
  return out;
}

/** 形を少しでこぼこにする（頂点を外向きに、向きで決まる量だけずらす） */
function lumpy(geo: THREE.BufferGeometry, amount: number, phase: number): THREE.BufferGeometry {
  const g = mergeVertices(geo);
  geo.dispose();
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = v.clone().normalize();
    const d = Math.sin(n.x * 5 + phase) * Math.sin(n.y * 4 + phase * 0.7) * Math.sin(n.z * 6 + phase * 1.3);
    v.addScaledVector(n, d * amount);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * 根の向き（roots。+z が 0 の角度）の所だけ幹の根元を外へふくらませる量（半径に対する比）：向きのまわり幅 w（rad）の山を、
 * 高さ h（m）で消える形で足す。幹から根へ一つながりにする（丸い管を幹に立てかけると、棒を貼り付けたように見えた）
 */
function buttress(a: number, y: number, roots: readonly number[], b: { amp: number; w: number; h: number }): number {
  let k = 0;
  for (const r of roots) {
    const d = Math.atan2(Math.sin(a - r), Math.cos(a - r));
    k += Math.exp(-((d / b.w) ** 2));
  }
  return b.amp * Math.min(1, k) * Math.exp(-y / b.h);
}

/** 根を張る木の幹（半径 r・高さ h）：trunkProfile より裾の広がりを控えめにし、根の向きだけ根元をふくらませる（buttress） */
function buttressTrunk(r: number, h: number, roots: readonly number[]): THREE.BufferGeometry {
  // 高さ → 半径（下から）。裾は全周ではなく、根のふくらみで広げる
  const prof: [number, number][] = [[r * BUTTRESS_SKIRT, 0], [r * 1.12, 0.14], [r * 1.03, 0.45], [r, 1], [r * 0.85, h * 0.7], [r * 0.7, h + 0.3]];
  const radius = (y: number) => {
    for (let i = 1; i < prof.length; i++) {
      const [r0, y0] = prof[i - 1], [r1, y1] = prof[i];
      if (y <= y1) return r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
    }
    return prof[prof.length - 1][0];
  };
  const NA = 96, NY = 48, top = h + 0.3;
  const pos: number[] = [];
  for (let j = 0; j <= NY; j++) {
    const y = top * (j / NY) ** 2;
    for (let i = 0; i <= NA; i++) {
      const a = (i / NA) * Math.PI * 2;
      const rr = radius(y) * (1 + buttress(a, y, roots, TOILET_BUTTRESS));
      pos.push(Math.sin(a) * rr, y, Math.cos(a) * rr);
    }
  }
  const tip = pos.length / 3;
  pos.push(0, top + 0.05, 0);
  const index: number[] = [];
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NA; i++) {
      const a = j * (NA + 1) + i, b = a + NA + 1;
      index.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const last = NY * (NA + 1);
  for (let i = 0; i < NA; i++) index.push(last + i + 1, tip, last + i);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/**
 * 根の付け根（中心からの距離）：幹の中に深く埋める（ふくらみの足元から始めると、少し上で幹が細くなる所で付け根の切り口が幹の外に出て、
 * 黒い穴＝すき間に見えた）。うろは壁の厚みの中（中の部屋へ突き抜けない）
 */
function hollowRootStart(a: number): number {
  return hollowRadius(0.6, a) - 0.3;
}
function hollowRootEnd(a: number, i: number): number {
  return hollowRadius(0, a) + (1.2 + 0.5 * Math.abs(Math.sin(i * 1.7))) * 0.8;
}
function toiletRootEnd(len: number): number {
  return TOILET_TREE.r * BUTTRESS_SKIRT * (1 + TOILET_BUTTRESS.amp) + len * 0.8;
}

/** 地面を這う根の通り道（ワールド。上から見た線分と半幅。横への曲がりの分を足す）。caveYaw はうろの向き */
function rootSegments(caveYaw: number): { ax: number; az: number; bx: number; bz: number; w: number }[] {
  const out: { ax: number; az: number; bx: number; bz: number; w: number }[] = [];
  for (const [a, len] of TOILET_ROOTS) {
    const s = Math.sin(a), c = Math.cos(a), d0 = TOILET_TREE.r, d1 = toiletRootEnd(len);
    out.push({ ax: TOILET_TREE.x + s * d0, az: TOILET_TREE.z + c * d0, bx: TOILET_TREE.x + s * d1, bz: TOILET_TREE.z + c * d1, w: 0.17 + 0.14 });
  }
  const cy = Math.cos(caveYaw), sy = Math.sin(caveYaw);
  const world = (lx: number, lz: number): [number, number] => [CAVE.x + lx * cy + lz * sy, CAVE.z - lx * sy + lz * cy];
  HOLLOW_ROOTS.forEach((a, i) => {
    const d0 = hollowRadius(0, a) * 0.9, d1 = hollowRootEnd(a, i);
    const [ax, az] = world(Math.sin(a) * d0, Math.cos(a) * d0), [bx, bz] = world(Math.sin(a) * d1, Math.cos(a) * d1);
    out.push({ ax, az, bx, bz, w: 0.36 + 0.14 });
  });
  return out;
}

/**
 * 地面を這う平たい根：向き a（+z が 0）へ、中心から d0（幹の根元のふくらみの中）から d1 まで。断面は横に広く上下に薄い楕円
 * （横の半幅 w・上下の半高さ h）を、少し地面に埋め、先へ細くとがらせて地面へ潜らせる。横へゆるく曲がる（seed で変える）。
 * 丸い管だと棒に見え、先の太い切り口も見えた
 */
function flatRoot(a: number, d0: number, d1: number, w: number, h: number, seed: number): THREE.BufferGeometry {
  const NS = 40, NR = 20;
  const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
  const side = new THREE.Vector3(dir.z, 0, -dir.x);
  const pos: number[] = [];
  for (let i = 0; i <= NS; i++) {
    const t = i / NS;
    const d = d0 + (d1 - d0) * t;
    const k = (1 - t) ** 0.75; // 先へ細る
    const ww = Math.max(0.004, w * (0.35 + 0.65 * k) * k ** 0.3);
    const hh = Math.max(0.003, h * k);
    // 横へのゆるい曲がりと、上下のうねり。先は地面へ潜る
    const sway = Math.sin(t * 3.1 + seed) * 0.12 * t;
    const cy = hh * 0.25 - (t > 0.7 ? ((t - 0.7) / 0.3) * h * 0.35 : 0) + 0.02 * Math.sin(t * 9 + seed) * k;
    const c = dir.clone().multiplyScalar(d).addScaledVector(side, sway);
    for (let j = 0; j <= NR; j++) {
      const th = (j / NR) * Math.PI * 2;
      pos.push(c.x + side.x * Math.cos(th) * ww, cy + Math.sin(th) * hh, c.z + side.z * Math.cos(th) * ww);
    }
  }
  const index: number[] = [];
  for (let i = 0; i < NS; i++) {
    for (let j = 0; j < NR; j++) {
      const p = i * (NR + 1) + j, q = p + NR + 1;
      // 外向きの面（逆に巻くと内向きになり、根が真っ黒に見えた）
      index.push(p, p + 1, q, p + 1, q + 1, q);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** 幹の断面：根元が広がり、上へ細くなる（半径 r・高さ h。上はふさぐ） */
function trunkProfile(r: number, h: number): [number, number][] {
  return [[0, 0], [r * 1.7, 0], [r * 1.25, 0.12], [r * 1.05, 0.4], [r, 1], [r * 0.85, h * 0.7], [r * 0.7, h + 0.3], [0, h + 0.3]];
}

/** 切り株の断面（半径 r・高さ h。上は年輪の絵の円盤を乗せるので、少し内へ折り返す） */
function stumpProfile(r: number, h: number): [number, number][] {
  return [[0, 0], [r * 1.35, 0], [r * 1.08, 0.08], [r, 0.25], [r, h], [r * 0.94, h], [0, h]];
}

/** 角の丸いでこぼこの楕円（半径 a・b、ゆらぎ wobble、ゆらぎの数 k） */
function blob(a: number, b: number, wobble: number, k: number): THREE.Shape {
  const s = new THREE.Shape();
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2;
    const f = 1 + wobble * Math.sin(t * k + 0.6);
    const x = Math.cos(t) * a * f, y = Math.sin(t) * b * f;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  return s;
}

/** くぼみの縁の盛り土：楕円（半径 a・b）に沿った、幅 w・高さ h の低い土手（太さ w の管を高さ h へつぶす） */
function moundRing(a: number, b: number, w: number, h: number): THREE.BufferGeometry {
  const g = tubeAlong((t) => {
    const u = t * Math.PI * 2;
    const f = 1 + 0.06 * Math.sin(u * 3 + 0.6);
    return new THREE.Vector3(Math.cos(u) * (a + w * 0.3) * f, 0, -Math.sin(u) * (b + w * 0.3) * f);
  }, (t) => w * (0.85 + 0.15 * Math.sin(t * 23)), 64, 10);
  g.scale(1, h / w, 1);
  g.computeVertexNormals();
  return g;
}

/** 草の束：根元の半径 r、高さ h、葉の数 n。葉は細い三角形で、外へ少し反る */
function grassClump(r: number, h: number, n: number, seed: number): THREE.BufferGeometry {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pos: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * r;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const hh = h * (0.55 + rand() * 0.55);
    const lean = 0.25 + rand() * 0.35;
    const w = 0.025 + rand() * 0.02;
    // 葉の面の向き：外向き（と直交）
    const ox = Math.cos(a), oz = Math.sin(a);
    const px = -oz * w, pz = ox * w;
    const tx = x + ox * hh * lean, tz = z + oz * hh * lean;
    const mx = x + ox * hh * lean * 0.35, mz = z + oz * hh * lean * 0.35;
    // 下半分（四角）と上半分（三角）
    pos.push(x - px, 0, z - pz, x + px, 0, z + pz, mx + px * 0.7, hh * 0.55, mz + pz * 0.7);
    pos.push(x - px, 0, z - pz, mx + px * 0.7, hh * 0.55, mz + pz * 0.7, mx - px * 0.7, hh * 0.55, mz - pz * 0.7);
    pos.push(mx - px * 0.7, hh * 0.55, mz - pz * 0.7, mx + px * 0.7, hh * 0.55, mz + pz * 0.7, tx, hh, tz);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function canvas(n: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = n;
  c.height = n;
  return [c, c.getContext('2d')!];
}

function texture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** 落ち葉の床（FLOOR_TILE m 四方。端でつながる）：黄土色の地に苔の斑、色とりどりの落ち葉と小枝 */
function leafLitterTexture(): THREE.CanvasTexture {
  const N = 1024;
  const [c, g] = canvas(N);
  g.fillStyle = '#c2ad80';
  g.fillRect(0, 0, N, N);
  let seed = 11;
  const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  // 端でつながるよう、はみ出した分を反対の端にも描く
  const wrap = (draw: (x: number, y: number) => void, x: number, y: number, m: number) => {
    for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) {
      if (x + dx < -m || x + dx > N + m || y + dy < -m || y + dy > N + m) continue;
      draw(x + dx, y + dy);
    }
  };
  // 苔と土の斑
  for (let k = 0; k < 60; k++) {
    const x = r() * N, y = r() * N, rad = 40 + r() * 90;
    g.fillStyle = r() < 0.6 ? 'rgba(150,170,100,0.35)' : 'rgba(150,120,80,0.3)';
    wrap((px, py) => { g.beginPath(); g.ellipse(px, py, rad, rad * (0.6 + r() * 0.4), r() * 3, 0, Math.PI * 2); g.fill(); }, x, y, rad);
  }
  // 落ち葉：先のとがった楕円に葉脈
  const colors = ['#d79a52', '#c7813f', '#e0b465', '#b8743c', '#a9b264', '#cf6f45', '#9c6a3c'];
  for (let k = 0; k < 700; k++) {
    const x = r() * N, y = r() * N, len = 10 + r() * 16, a = r() * Math.PI * 2;
    const col = colors[Math.floor(r() * colors.length)];
    wrap((px, py) => {
      g.save();
      g.translate(px, py);
      g.rotate(a);
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(-len, 0);
      g.quadraticCurveTo(0, -len * 0.55, len, 0);
      g.quadraticCurveTo(0, len * 0.55, -len, 0);
      g.fill();
      g.strokeStyle = 'rgba(90,60,30,0.35)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(-len * 0.9, 0);
      g.lineTo(len * 0.9, 0);
      g.stroke();
      g.restore();
    }, x, y, len);
  }
  // 小枝
  g.strokeStyle = '#7c5a38';
  g.lineCap = 'round';
  for (let k = 0; k < 40; k++) {
    const x = r() * N, y = r() * N, len = 20 + r() * 40, a = r() * Math.PI * 2;
    g.lineWidth = 2 + r() * 2;
    wrap((px, py) => { g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len); g.stroke(); }, x, y, len);
  }
  return texture(c);
}

/**
 * うろの床：暗い土の地に、濃淡のむら・細い繊維（枯れ草や木の皮のくず）・木くず・砂粒を重ねたごわごわした絵（端でつながる）。
 * 色は CAVE_FLOOR のまわりに抑える（明るくすると、暗いうろの中で床だけ浮く）
 */
function hollowFloorTexture(): THREE.CanvasTexture {
  const N = 512;
  const [c, g] = canvas(N);
  g.fillStyle = CAVE_FLOOR;
  g.fillRect(0, 0, N, N);
  let seed = 23;
  const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const wrap = (draw: (x: number, y: number) => void, x: number, y: number, m: number) => {
    for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) {
      if (x + dx < -m || x + dx > N + m || y + dy < -m || y + dy > N + m) continue;
      draw(x + dx, y + dy);
    }
  };
  // 濃淡のむら
  for (let k = 0; k < 70; k++) {
    const x = r() * N, y = r() * N, rad = 20 + r() * 60;
    g.fillStyle = r() < 0.5 ? 'rgba(25,16,10,0.28)' : 'rgba(90,66,44,0.18)';
    const rot = r() * 3, sq = 0.5 + r() * 0.5;
    wrap((px, py) => { g.beginPath(); g.ellipse(px, py, rad, rad * sq, rot, 0, Math.PI * 2); g.fill(); }, x, y, rad);
  }
  // 細い繊維：短い曲がった線をたくさん（ごわごわ）
  const fibers = ['#5c4431', '#2a1d14', '#6d5239', '#4a3626', '#7a5f42'];
  g.lineCap = 'round';
  for (let k = 0; k < 1400; k++) {
    const x = r() * N, y = r() * N, len = 5 + r() * 16, a = r() * Math.PI * 2, bend = (r() - 0.5) * 6;
    const col = fibers[Math.floor(r() * fibers.length)];
    const w = 0.8 + r() * 1.4;
    wrap((px, py) => {
      g.strokeStyle = col;
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(px, py);
      g.quadraticCurveTo(px + Math.cos(a) * len * 0.5 - Math.sin(a) * bend, py + Math.sin(a) * len * 0.5 + Math.cos(a) * bend,
        px + Math.cos(a) * len, py + Math.sin(a) * len);
      g.stroke();
    }, x, y, len);
  }
  // 木くず：角ばった小さなかけら
  const chips = ['#6e5338', '#5a4330', '#80623f'];
  for (let k = 0; k < 160; k++) {
    const x = r() * N, y = r() * N, s = 2 + r() * 5, a = r() * Math.PI;
    const col = chips[Math.floor(r() * chips.length)];
    const pts = [0, 1, 2, 3].map((i) => [Math.cos(a + i * 1.6 + r() * 0.6) * s * (0.6 + r() * 0.8), Math.sin(a + i * 1.6 + r() * 0.6) * s * (0.4 + r() * 0.5)]);
    wrap((px, py) => {
      g.fillStyle = col;
      g.beginPath();
      pts.forEach(([dx, dy], i) => (i === 0 ? g.moveTo(px + dx, py + dy) : g.lineTo(px + dx, py + dy)));
      g.closePath();
      g.fill();
    }, x, y, s * 2);
  }
  // 砂粒
  for (let k = 0; k < 5000; k++) {
    g.fillStyle = r() < 0.5 ? 'rgba(20,13,8,0.6)' : 'rgba(110,86,62,0.45)';
    g.fillRect(r() * N, r() * N, 1 + r() * 1.5, 1 + r() * 1.5);
  }
  return texture(c);
}

/** といれのくぼみの土：こげ茶の地に細かい粒と、少しの落ち葉 */
function soilTexture(): THREE.CanvasTexture {
  const N = 512;
  const [c, g] = canvas(N);
  const grad = g.createRadialGradient(N / 2, N / 2, N * 0.1, N / 2, N / 2, N * 0.55);
  grad.addColorStop(0, '#6e5238');
  grad.addColorStop(1, '#8c6c4a');
  g.fillStyle = grad;
  g.fillRect(0, 0, N, N);
  let seed = 5;
  const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const colors = ['#5e4530', '#7d6045', '#937352', '#4f3a28'];
  for (let k = 0; k < 9000; k++) {
    g.fillStyle = colors[Math.floor(r() * colors.length)];
    g.beginPath();
    g.arc(r() * N, r() * N, 0.8 + r() * 1.8, 0, Math.PI * 2);
    g.fill();
  }
  for (let k = 0; k < 14; k++) {
    g.fillStyle = ['#c7813f', '#b8743c', '#d79a52'][k % 3];
    g.save();
    g.translate(r() * N, r() * N);
    g.rotate(r() * 6);
    g.beginPath();
    g.ellipse(0, 0, 14, 6, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  return texture(c);
}

/** 年輪：中心から輪を何本も（色は材質の color を掛ける） */
function ringsTexture(): THREE.CanvasTexture {
  const N = 256;
  const [c, g] = canvas(N);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, N, N);
  g.strokeStyle = 'rgba(150,100,50,0.45)';
  for (let i = 1; i < 9; i++) {
    g.lineWidth = 2 + (i % 3);
    g.beginPath();
    g.arc(N / 2 + Math.sin(i) * 3, N / 2 + Math.cos(i) * 3, (i / 9) * N * 0.48, 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = 'rgba(120,80,40,0.5)';
  g.beginPath();
  g.arc(N / 2, N / 2, 6, 0, Math.PI * 2);
  g.fill();
  return texture(c);
}
