import * as THREE from 'three';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import { createAccessoryOutlineMaterial } from '../render/outlineMaterial';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { tubeAlong, withOutline } from '../character/shapes';
import { createBlobShadow } from '../render/blobShadow';
import type { ToonColors } from '../render/toonMaterial';
import type { MapId } from '../world/Stage';
import { bodyFacing } from './fx';
import type { Yukkuri } from './Yukkuri';

/**
 * 巣材：おうち（おうちせんげんした所）に寝床を作るために集める物（指示）。種類は 食糧・たからもの・べっど の 3 つ。
 *   食糧 … 餌集めの餌（forage.ts）をそのまま使う
 *   たからもの … アイスの当たり棒・ビー玉・きれいな小石・ボタン（飼育ケース）／鳥の羽根・松ぼっくり・カタツムリの殻（森）
 *   べっど … ちぎった新聞紙・ティッシュ・布の切れ端・牧草（飼育ケース）／落ち葉のひと束・大きな葉っぱ・苔のかたまり（森）
 * マップごとに出る組が違う（NestSet。平地は飼育ケースの組を 1/4 の大きさで）。森の組は指示で選んだ（2026-10-30）。
 * ここは、たからものとべっどの物（形と、地面に置く・片付ける・運ぶ間の形）。出し方（指示）は、飼育ケース・森を開いたときに少し散らばっていて、
 * ボタンで 1 個ずつゆっくりの前に出すこともできる。森の苔だけは散らばらせず、倒木・岩などの脇に生えていて、はがすと跡に土が見える
 * （指示：はがれた苔が地面にまばらに散らばっているのはおかしい）。運んで寝床を整えるのは巣作り（nestBuild.ts）。
 * 運ぶ間（指示：三つ編みは垂らしたまま、床を引きずって運ぶ）：べっどは端を毛先でつまみ、つまんだ所だけ浮いて、残りは後ろへ床を
 * 引きずる（DRAG）。たからものは硬いので、形を変えずに毛先に付ける
 * 大きさは実物どおり：飼育ケースの組は飼育ケースの縮尺（ゆっくりは普通の 1/4 という体。実物 1 cm ＝ CM m。新聞紙の床と同じ）で作り、
 * 平地（普通の大きさのゆっくり）ではその 1/4 で置く。森の組は普通の大きさのゆっくりの縮尺（実物 1 cm ＝ F m）で作り、そのまま置く
 * （森のべっどは実物で 20〜30 cm あるので、置いた大きさは飼育ケースのべっどと同じくらいになる）。
 * 森の大木のうろの中に置いた物は、ゆっくりと同じく暗がりに沈める（update。暗いうろの中で明るく浮かないよう）
 */
export type NestCategory = 'treasure' | 'bedding';
export type NestKindId =
  | 'stick' | 'marble' | 'pebble' | 'button' | 'paper' | 'tissue' | 'cloth' | 'hay'
  | 'feather' | 'pinecone' | 'snail' | 'leaves' | 'bigleaf' | 'moss';
/** 出る組：飼育ケース（平地も）・森 */
export type NestSet = 'cage' | 'forest';

export interface NestKind {
  id: NestKindId;
  name: string;
  category: NestCategory;
  set: NestSet;
  /** 地面で占める広さ（上から見た半径。m、置く大きさの倍率 1 のとき） */
  r: number;
  /** 細長い物（当たり棒・羽根）の長さ（m、倍率 1 のとき）。巣では寝床のふちに沿って寝かせ、長さに沿って場所を取る */
  len?: number;
}

/** 実物 1 cm がこの世界で何 m か（飼育ケース。普通のゆっくりの胴の直径 1 m を実物 31 cm とみて、その 1/4） */
const CM = 4 / 31;
/** 実物 1 cm がこの世界で何 m か（森。普通のゆっくりの縮尺） */
const F = 1 / 31;

export const NEST_KINDS: NestKind[] = [
  { id: 'stick', name: 'アイスの当たり棒', category: 'treasure', set: 'cage', r: 4.8 * CM, len: 9.5 * CM },
  { id: 'marble', name: 'ビー玉', category: 'treasure', set: 'cage', r: 0.85 * CM },
  { id: 'pebble', name: 'きれいな小石', category: 'treasure', set: 'cage', r: 1.2 * CM },
  { id: 'button', name: 'ボタン', category: 'treasure', set: 'cage', r: 0.9 * CM },
  { id: 'paper', name: 'ちぎった新聞紙', category: 'bedding', set: 'cage', r: 3.4 * CM },
  { id: 'tissue', name: 'ティッシュ', category: 'bedding', set: 'cage', r: 2.2 * CM },
  { id: 'cloth', name: '布の切れ端', category: 'bedding', set: 'cage', r: 3.4 * CM },
  { id: 'hay', name: '牧草', category: 'bedding', set: 'cage', r: 5 * CM },
  { id: 'feather', name: '鳥の羽根', category: 'treasure', set: 'forest', r: 6.2 * F, len: 12 * F },
  { id: 'pinecone', name: '松ぼっくり', category: 'treasure', set: 'forest', r: 3.2 * F },
  { id: 'snail', name: 'カタツムリの殻', category: 'treasure', set: 'forest', r: 1.7 * F },
  { id: 'leaves', name: '落ち葉のひと束', category: 'bedding', set: 'forest', r: 12 * F },
  { id: 'bigleaf', name: '大きな葉っぱ', category: 'bedding', set: 'forest', r: 15 * F },
  { id: 'moss', name: '苔のかたまり', category: 'bedding', set: 'forest', r: 10 * F },
];

export const CATEGORY_NAMES: Record<NestCategory, string> = { treasure: 'たからもの', bedding: 'べっど' };

/** 「出す」で選ぶもの：種類、またはその仲間からランダム */
export type NestPick = NestKindId | 'treasure' | 'bedding';

/** 飼育ケース・森を開いたときに散らばっている数（指示はなかった。少しだけ。森は広いので少し多め） */
const SCATTER: Record<NestSet, Record<NestCategory, number>> = { cage: { treasure: 2, bedding: 3 }, forest: { treasure: 3, bedding: 3 } };
/**
 * 森の苔は散らばらせず、苔の生える所（Stage.mossSites：倒木の脇・切り株・岩・木の根元）に生やしておく（指示：はがれた苔が地面に
 * まばらに散らばっているのはおかしい。生えている所からはがして運ぶ）。生やす所の数と、1 か所に並べる枚数
 */
const MOSS_SITES = 2;
const MOSS_PER_SITE = 2;
/** 1 か所の苔を並べる間隔（m。ふちに沿って）と、隣の生えている苔に重ねてよい所（半径の和に対する比。少し重ねてひと続きに見せる） */
const MOSS_STEP = 0.42;
const MOSS_GAP = 0.6;
/** 生えている苔の高さ（はがした形に対する比） */
const ROOTED_FLAT = 0.45;

/** 飼育ケース以外のマップでの大きさ（普通の大きさのゆっくりに対して実物どおり） */
const OPEN_SCALE = 0.25;
/** 地面に出す数の上限 */
const MAX_ITEMS = 40;
/** 出す所：ゆっくりの前へ胴の半径の何倍か・横へのばらつき */
const SPAWN_AHEAD = [2.2, 3.4];
const SPAWN_SIDE = 1.4;
/** 足元の影の濃さと、形の広がりに対する大きさ */
const SHADOW_OPACITY = 0.4;
const SHADOW_SPREAD = 1.25;
/** 置く所を探す回数 */
const TRIES = 40;
/**
 * 引きずる形（m、飼育ケースの縮尺。物の座標）：つまむ所（pin。物の -z の縁）、つまんだ近くの横のすぼまり（sq。1 で元の幅）、
 * つまんだ所から床へ下りきるまでの長さ（ramp）。つまむ所より +z の側が、引きずる向きの後ろへ流れる。
 * stiff（当たり棒）は曲げずに、つまんだ端を持ち上げ、反対の端を床に付けて斜めに引きずる（真ん中を持つと長い棒が体に刺さった）
 */
const DRAG: Partial<Record<NestKindId, { pin: [number, number, number]; sq: number; ramp: number; stiff?: boolean }>> = {
  stick: { pin: [0, 0.1 * CM, -4.2 * CM], sq: 1, ramp: 0, stiff: true },
  paper: { pin: [0, 0.04, -0.3], sq: 0.5, ramp: 0.3 },
  cloth: { pin: [0, 0.03, -0.36], sq: 0.35, ramp: 0.35 },
  tissue: { pin: [0, 0.05, -0.42], sq: 0.35, ramp: 0.35 },
  hay: { pin: [0, 0.05, -0.45], sq: 0.5, ramp: 0.35 },
  feather: { pin: [0, 0.1 * F, -5.6 * F], sq: 1, ramp: 0, stiff: true },
  leaves: { pin: [0, 0.03, -0.3], sq: 0.45, ramp: 0.32 },
  bigleaf: { pin: [0, 0.03, -14 * F], sq: 0.6, ramp: 0.35 },
  moss: { pin: [0, 0.05, -0.26], sq: 0.7, ramp: 0.4 },
};
/**
 * 寝床で重ねる（settle）：下の物の高さを、この大きさ（m、飼育ケースの縮尺）の升目ごとに一番高い所で覚え、
 * 上に置く物の頂点を、そこの高さ＋SETTLE_GAP だけ持ち上げる（下の物にかぶさって乗る）。
 * 升目の高さは、まわり 1 升の一番高い所を取ってから 3×3 でならし、升目の真ん中どうしの間はなめらかにつなぐ
 * （升目の高さそのままだと段々の崖になった。この順なら、どこでも下の物の一番高い所より下にならない）。
 * 寝床に置いた物は上から押されたように高さを BED_FLATTEN 倍につぶす（そのまま重ねると、くしゃっとした紙や
 * 盛り上がったティッシュの高さが積み重なって塔になった）
 */
const SETTLE_CELL = 0.04;
const SETTLE_GAP = 0.006;
const BED_FLATTEN = 0.35;
/** 当たり棒を傾ける深さ（反対の端がちょうど床に着く傾きに対する比。棒の厚みの分だけ床に潜らないよう浅めに） */
const STIFF_TILT = 0.8;
/** 引きずる形で床から浮かせる高さ（m） */
const FLOOR_LIFT = 0.006;
/** 引きずった所のしわ：横の波の細かさと高さ（m） */
const DRAG_WRINKLE = [25, 0.02];
/** うろの中の物を沈める量（DARKEN_GLSL の uDarken。ゆっくりは 1）と、沈む・戻る速さ（1 秒あたり） */
export const HOLLOW_DARKEN = 0.75;
const DARKEN_RATE = 4;
/** 暗がりの色（DARKEN_GLSL と同じ。トゥーンでない材質は色にこれを掛ける） */
const SHADE = new THREE.Color(0.24, 0.23, 0.3);

const WOOD = { lit: '#f0dcb0', shade: '#dcc290', deep: '#b89a66', rim: '#fff6e0' };
const PEBBLES: ToonColors[] = [
  { lit: '#eeeae2', shade: '#cfcac0', deep: '#a8a297', rim: '#ffffff' },
  { lit: '#b9c6d2', shade: '#95a5b5', deep: '#6c7e91', rim: '#eef4fa' },
  { lit: '#ecc9be', shade: '#d4a99b', deep: '#ad8072', rim: '#fff1ec' },
  { lit: '#d9cdb0', shade: '#bdae8c', deep: '#948463', rim: '#fbf5e6' },
];
const BUTTONS: ToonColors[] = [
  { lit: '#e8584e', shade: '#c63d36', deep: '#952a25', rim: '#ffd6d0' },
  { lit: '#5a8fd8', shade: '#3f70b8', deep: '#2b508a', rim: '#d6e6ff' },
  { lit: '#f3ead6', shade: '#dccfb2', deep: '#b6a684', rim: '#ffffff' },
  { lit: '#79c27a', shade: '#55a05a', deep: '#3a7840', rim: '#dcf5dc' },
  { lit: '#f2a6c4', shade: '#d983a6', deep: '#b0607f', rim: '#ffe6f0' },
];
/** ビー玉の中の色の羽 */
const MARBLE_VANES = ['#e8483e', '#3f7fe0', '#3fb35a', '#f0b93a'];
const HAY = [
  { lit: '#e6cf86', shade: '#c9ad60', deep: '#99803e', rim: '#fff5d6' },
  { lit: '#c3d07a', shade: '#9fb055', deep: '#718234', rim: '#f2f8d4' },
  { lit: '#d6b878', shade: '#b39552', deep: '#836935', rim: '#fbf0d8' },
];
/** 布の切れ端のギンガムチェックの色 */
const CLOTHS = ['#4f86c6', '#d9506a', '#e0a020', '#4d9a5a'];
/** 羽根の軸、松ぼっくりの鱗片（2 色）と芯、カタツムリの殻・しま・口の中・口の縁 */
const QUILL = { lit: '#f1e6cf', shade: '#d9c9a8', deep: '#b29f7c', rim: '#ffffff' };
const CONE_SCALES = [
  { lit: '#a8743f', shade: '#8a5a2e', deep: '#66401f', rim: '#efd2b0' },
  { lit: '#946433', shade: '#784c25', deep: '#573618', rim: '#e6c8a4' },
];
const CONE_CORE = { lit: '#6e4a2a', shade: '#583a20', deep: '#3f2916', rim: '#d7bea0' };
const SHELL = { lit: '#d9b27a', shade: '#bf955c', deep: '#977240', rim: '#fbecd2' };
const SHELL_BAND = { lit: '#6e4526', shade: '#5a381e', deep: '#432915', rim: '#d2b394' };
const SHELL_MOUTH = { lit: '#5a3c26', shade: '#4a311f', deep: '#352215', rim: '#bfa58a' };
const SHELL_LIP = { lit: '#f3e7d2', shade: '#ddcdb2', deep: '#b9a888', rim: '#ffffff' };
/** 落ち葉の色（赤・橙・黄・茶・くすんだ黄緑。色・葉脈・ふち） */
const FALL_LEAVES: [string, string, string][] = [
  ['#c8432e', '#9e2f20', '#7d2418'],
  ['#e07a2a', '#b85d1c', '#8f4614'],
  ['#e3b23a', '#bd8f25', '#8f6a18'],
  ['#9c6a3e', '#7c522e', '#5c3c21'],
  ['#a9a24a', '#868034', '#646026'],
];
/** 大きな葉っぱの色（落ちて黄褐色になったもの・まだ緑のもの） */
const BIG_LEAVES: [string, string, string][] = [
  ['#c49a52', '#a37a3a', '#7d5c2a'],
  ['#86a457', '#69863f', '#4f682e'],
];

export interface NestItem {
  readonly kind: NestKind;
  readonly object: THREE.Group;
  /** その物だけが持つ形・絵・材質（片付けるときに捨てる） */
  readonly own: { dispose(): void }[];
  /** 足元の影（運ぶ間は消す） */
  readonly shadow: THREE.Object3D;
  /** 形の高さ（m、飼育ケースの縮尺。たからものは毛先にこの真ん中を付ける） */
  readonly height: number;
  /** 巣に置いた（おうちの寝床・横の固まりに並べた） */
  nest: boolean;
  /** 寝床で下の物に乗せる割合（0〜1。乗せる高さは頂点ごとに形の userData.settle） */
  settled: number;
  /** 運んでいる途中 */
  held: boolean;
  /** うろの中で沈める材質（森の組はその物だけの材質を持つ）と、今の沈み具合（0〜1） */
  readonly tints: THREE.Material[];
  dark: number;
  /** 生えている苔（まだはがしていない。はがすと跡に土が見える） */
  rooted: boolean;
}

export class NestStuff {
  /** 巣材（体と一緒に震えないよう、シーンに直接置く） */
  readonly object = new THREE.Group();
  /** 次に出すもの */
  kindId: NestPick = 'treasure';
  private readonly items: NestItem[] = [];
  /** 苔をはがした跡（片付けるときに捨てる） */
  private readonly scars: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = [];
  /** 大きさの倍率（飼育ケース・森 1、平地 OPEN_SCALE） */
  private scale = OPEN_SCALE;
  /** 今のマップで出る組 */
  private setId: NestSet = 'cage';
  private readonly mats = new Map<string, THREE.Material>();
  private readonly outline: THREE.Material;

  constructor(private readonly y: Yukkuri) {
    this.outline = createAccessoryOutlineMaterial(y.outlineMaterial);
  }

  /** 地面にある数（仲間ごと） */
  count(c: NestCategory): number {
    return this.items.filter((i) => i.kind.category === c).length;
  }

  /** 大きさの倍率（飼育ケース・森 1、平地 1/4） */
  get size(): number {
    return this.scale;
  }

  /** 今のマップで出る種類 */
  get kinds(): NestKind[] {
    return NEST_KINDS.filter((k) => k.set === this.setId);
  }

  /** 地面にある巣材（inNest：巣に置いたもの／まだのもの。運んでいる物は除く） */
  list(inNest: boolean): NestItem[] {
    return this.items.filter((i) => !i.held && i.nest === inNest);
  }

  /** 片付けられた（もう運べない） */
  gone(it: NestItem): boolean {
    return !this.items.includes(it);
  }

  /** 地面で占める広さ（上から見た半径。m） */
  radius(it: NestItem): number {
    return it.kind.r * this.scale;
  }

  /** 三つ編みでつまむ所（ワールド。地面の高さ）：べっどは縁、たからものは真ん中 */
  grabPoint(it: NestItem): THREE.Vector3 {
    const d = DRAG[it.kind.id];
    const p = d ? new THREE.Vector3(...d.pin).setY(0) : new THREE.Vector3();
    return it.object.localToWorld(p).setY(0);
  }

  /** 引きずって運ぶ物か（べっどと当たり棒）。ほかのたからものは形を変えずに持つ */
  drags(it: NestItem): boolean {
    return !!DRAG[it.kind.id];
  }

  /** 持ち上げる（これから運ぶ。影を消す） */
  hold(it: NestItem): void {
    if (it.rooted) this.peel(it);
    it.held = true;
    it.nest = false;
    it.shadow.visible = false;
    this.unsettle(it);
  }

  /** 生えている苔をはがす：跡に土の色の地肌を残す（形は苔のふちに合わせた、少し小さいでこぼこの丸） */
  private peel(it: NestItem): void {
    it.rooted = false;
    this.rootedLook(it.object, false);
    const r = this.radius(it) * 0.95; // ふちはぼかすので、苔と同じくらいの広さ
    const geo = new THREE.CircleGeometry(r, 28);
    const p = geo.getAttribute('position') as THREE.BufferAttribute;
    const ph = Math.random() * 6;
    for (let i = 1; i < p.count; i++) {
      const a = Math.atan2(p.getY(i), p.getX(i));
      const k = 1 + 0.12 * Math.sin(3 * a + ph) + 0.06 * Math.sin(7 * a - ph);
      p.setXY(i, p.getX(i) * k, p.getY(i) * k);
    }
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.MeshBasicMaterial({ map: scarTexture(), transparent: true, depthWrite: false });
    const scar = new THREE.Mesh(geo, m);
    scar.position.set(it.object.position.x, 0.0025, it.object.position.z);
    this.object.add(scar);
    this.scars.push(scar);
  }

  /**
   * 生えている苔の見た目にする／戻す：生えている間は土のふちのない絵にし、高さを ROOTED_FLAT 倍に低くして地面になじませる
   * （はがすと土のふちと厚みが出る）
   */
  private rootedLook(o: THREE.Object3D, on: boolean): void {
    o.scale.y = this.scale * (on ? ROOTED_FLAT : 1);
    o.traverse((m) => {
      if (!(m instanceof THREE.Mesh) || !m.userData.rootedMap) return;
      const mat = m.material as THREE.MeshBasicMaterial;
      if (on && !m.userData.peeledMap) m.userData.peeledMap = mat.map;
      mat.map = on ? m.userData.rootedMap : m.userData.peeledMap;
      mat.needsUpdate = true;
    });
  }

  /** 寝床で下の物に乗せていた分を外す */
  private unsettle(it: NestItem): void {
    it.settled = 0;
    it.object.traverse((m) => {
      if (m instanceof THREE.Mesh) delete m.geometry.userData.settle;
    });
  }

  /**
   * 寝床で重ねる準備：（x, z）・向き yaw に元の形で置いたとき、下の物（under）にかぶさって乗るよう、頂点ごとに持ち上げる高さを決めておく
   * （適用する割合は settled。reshape・put がそのつど足す）。物の置き場と形は呼ぶ前のまま戻す
   */
  prepareSettle(it: NestItem, under: NestItem[], x: number, z: number, yaw: number): void {
    const cell = SETTLE_CELL * this.scale;
    const key = (cx: number, cz: number) => cx * 100003 + cz;
    const top = new Map<number, number>();
    const v = new THREE.Vector3();
    for (const o of under) {
      o.object.updateMatrixWorld(true);
      o.object.traverse((m) => {
        if (!(m instanceof THREE.Mesh) || m === o.shadow) return;
        const p = m.geometry.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < p.count; i++) {
          v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
          const k = key(Math.floor(v.x / cell), Math.floor(v.z / cell));
          top.set(k, Math.max(top.get(k) ?? 0, v.y));
        }
      });
    }
    const at = (cx: number, cz: number) => top.get(key(cx, cz)) ?? 0;
    const memo = (f: (cx: number, cz: number) => number) => {
      const c = new Map<number, number>();
      return (cx: number, cz: number) => {
        const k = key(cx, cz);
        let h = c.get(k);
        if (h === undefined) c.set(k, (h = f(cx, cz)));
        return h;
      };
    };
    const around = (f: (cx: number, cz: number) => number, cx: number, cz: number, pick: (a: number, b: number) => number, init: number) => {
      let h = init;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) h = pick(h, f(cx + dx, cz + dz));
      return h;
    };
    const dilated = memo((cx, cz) => around(at, cx, cz, Math.max, 0));
    const smooth = memo((cx, cz) => around(dilated, cx, cz, (a, b) => a + b, 0) / 9);
    /** 点（x, z）での下の物の高さ（升目の真ん中どうしの間をなめらかにつなぐ） */
    const heightAt = (x: number, z: number) => {
      const fx = x / cell - 0.5, fz = z / cell - 0.5;
      const cx = Math.floor(fx), cz = Math.floor(fz), tx = fx - cx, tz = fz - cz;
      const a = smooth(cx, cz) * (1 - tx) + smooth(cx + 1, cz) * tx;
      const b = smooth(cx, cz + 1) * (1 - tx) + smooth(cx + 1, cz + 1) * tx;
      return a * (1 - tz) + b * tz;
    };
    const o = it.object;
    const pos = o.position.clone(), rot = o.rotation.clone(), settled = it.settled;
    o.position.set(x, 0, z);
    o.rotation.set(0, yaw, 0);
    it.settled = 0;
    this.reshape(it, 0);
    o.updateMatrixWorld(true);
    o.traverse((m) => {
      if (!(m instanceof THREE.Mesh) || m === it.shadow) return;
      const p = m.geometry.getAttribute('position') as THREE.BufferAttribute;
      const lift = new Float32Array(p.count);
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
        const h = heightAt(v.x, v.z);
        // 物の座標の高さに直す（物は上向きまわりにしか回さないので、大きさで割るだけ）。寝床の外（下に何もない所）は床のまま
        lift[i] = h > 1e-4 ? (h + SETTLE_GAP * this.scale) / this.scale : 0;
      }
      m.geometry.userData.settle = lift;
    });
    o.position.copy(pos);
    o.rotation.copy(rot);
    it.settled = settled;
  }

  /**
   * 運ぶ間の形と置き場：つまむ所を grip（ワールド）に合わせ、物の +z を向き yaw（rad）へ向ける。
   * b は引きずる形の割合（0 で元の形・1 で引きずりきった形）。たからものは形を変えず、地面より下へは下げない
   */
  pose(it: NestItem, grip: THREE.Vector3, yaw: number, b: number): void {
    const o = it.object;
    const d = DRAG[it.kind.id];
    // 当たり棒：つまんだ端の高さから、反対の端が床に着くまで傾ける（b の割合だけ）
    const pitch = d?.stiff ? Math.asin(THREE.MathUtils.clamp((grip.y * STIFF_TILT) / (Math.abs(d.pin[2]) * 2 * this.scale), 0, 1)) * b : 0;
    o.rotation.set(pitch, yaw, 0, 'YXZ');
    const pin = d ? new THREE.Vector3(...d.pin) : new THREE.Vector3(0, it.height * 0.5, 0);
    o.position.copy(grip).sub(pin.multiplyScalar(this.scale).applyEuler(o.rotation));
    if (!d) {
      o.position.y = Math.max(0, o.position.y);
      return;
    }
    if (!d.stiff) this.drag(it, b);
  }

  /** （x, z）の地面に元の形で置く（向き yaw）。nest なら巣に置いた物として */
  put(it: NestItem, x: number, z: number, yaw: number, nest: boolean): void {
    const o = it.object;
    o.position.set(x, 0, z);
    o.rotation.set(0, yaw, 0);
    // 巣の外に置くなら、寝床で下の物に乗せる分は外す（巣に置くときは、呼ぶ側が決めた乗せる割合のまま）
    if (!nest) this.unsettle(it);
    this.reshape(it, 0);
    it.held = false;
    it.nest = nest;
    it.shadow.visible = true;
  }

  /** 引きずる形を b の割合にする（置くときに、置く所へ寄せながら元の形へ戻す。たからものは何もしない） */
  reshape(it: NestItem, b: number): void {
    const d = DRAG[it.kind.id];
    if (!d) return;
    if (d.stiff) {
      // 傾きを b の割合へ（置くときに寝かせる）
      const o = it.object;
      o.rotation.x = (it.object.userData.pitch ??= o.rotation.x) * b;
      if (b <= 0) delete o.userData.pitch;
      return;
    }
    this.drag(it, b);
  }

  /**
   * 毎ステップ：森の大木のうろの中にある物を暗がりに沈める（ゆっくりと同じ色に寄せる。入ると少しずつ）。足元の影も薄くする
   * （うろの暗い床に影が明るく浮く）。運んでいる物は運んでいるゆっくりに合わせる（入口で物だけ先に沈まないよう）
   */
  update(dt: number): void {
    const st = this.y.stage;
    const k = Math.min(1, dt * DARKEN_RATE);
    const carrier = this.y.center;
    for (const it of this.items) {
      if (!it.tints.length) continue;
      const p = it.held ? carrier : it.object.position;
      const goal = (it.held ? st?.inCave(p.x, p.z) : st?.inHollow(p.x, p.z)) ? 1 : 0;
      if (it.dark === goal) continue;
      it.dark += (goal - it.dark) * k;
      if (Math.abs(goal - it.dark) < 1e-3) it.dark = goal;
      const v = it.dark * HOLLOW_DARKEN;
      for (const m of it.tints) {
        const u = (m as THREE.ShaderMaterial).uniforms?.uDarken;
        if (u) u.value = v;
        else if (m instanceof THREE.MeshBasicMaterial) m.color.setRGB(1, 1, 1).lerp(SHADE, v);
      }
      (it.shadow as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>).material.uniforms.uOpacity.value = SHADOW_OPACITY * (1 - it.dark);
    }
  }

  /** 巣に置いた印を全部外す（おうちを移したとき：次の巣作りで新しいおうちへ運び直す） */
  forgetNest(): void {
    for (const it of this.items) it.nest = false;
  }

  /**
   * 引きずる形にする（b の割合だけ）：つまんだ所だけ浮き、そこから +z へ離れるほど床へ下りて流れる。
   * つまんだ近くは横がすぼまり、床に着いた所は横に細かくしわが寄る。床より下へは行かない
   */
  private drag(it: NestItem, b: number): void {
    const d = DRAG[it.kind.id]!;
    const [px, py, pz] = d.pin;
    const o = it.object;
    const floor = (FLOOR_LIFT - o.position.y) / this.scale;
    o.traverse((m) => {
      if (!(m instanceof THREE.Mesh) || m === it.shadow) return;
      const geo = m.geometry as THREE.BufferGeometry;
      const p = geo.getAttribute('position') as THREE.BufferAttribute;
      const orig = (geo.userData.orig ??= (p.array as Float32Array).slice()) as Float32Array;
      const lift = geo.userData.settle as Float32Array | undefined;
      const sk = lift ? it.settled : 0;
      for (let i = 0; i < p.count; i++) {
        const x = orig[i * 3], yy = orig[i * 3 + 1], z = orig[i * 3 + 2];
        const lat = x - px, along = Math.max(0, z - pz);
        const k = Math.max(0, 1 - along / d.ramp);
        const spread = d.sq + (1 - d.sq) * Math.min(1, along / d.ramp);
        const nx = px + lat * spread;
        const ny = floor + (py - floor) * k * k + yy * 0.6;
        const nz = pz + along * 0.92 + Math.sin(lat * DRAG_WRINKLE[0] * this.scale) * (DRAG_WRINKLE[1] / this.scale) * (1 - k);
        // 寝床に置いた物：上から押されたようにつぶし、下の物の上へ持ち上げる（sk の割合だけ）
        const h = Math.max(floor, yy + (ny - yy) * b);
        p.setXYZ(i, x + (nx - x) * b, sk ? h * (1 - (1 - BED_FLATTEN) * sk) + lift![i] * sk : h, z + (nz - z) * b);
      }
      p.needsUpdate = true;
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
    });
  }

  /** マップを変えたとき：片付けて、出る組と大きさを合わせ、飼育ケース・森なら少し散らばらせる */
  mapChanged(map: MapId): void {
    this.clear();
    this.setId = map === 'forest' ? 'forest' : 'cage';
    this.scale = map === 'open' ? OPEN_SCALE : 1;
    // 出すものが別の組の種類なら、その仲間からランダムに
    const k = NEST_KINDS.find((i) => i.id === this.kindId);
    if (k && k.set !== this.setId) this.kindId = k.category;
    if (map === 'open') return;
    for (const c of ['treasure', 'bedding'] as const) {
      for (let n = 0; n < SCATTER[this.setId][c]; n++) this.scatterOne(this.pick(c, true));
    }
    if (this.setId !== 'forest') return;
    // 苔は生える所に生やす（ランダムに選んだ所に、ふちに沿って並べる）
    const sites = [...(this.y.stage?.mossSites ?? [])].sort(() => Math.random() - 0.5).slice(0, MOSS_SITES);
    for (const site of sites) for (let n = 0; n < MOSS_PER_SITE; n++) this.grow(site, (n - (MOSS_PER_SITE - 1) / 2) * MOSS_STEP);
  }

  /**
   * 今の組の、その仲間からランダムに 1 種類。散らばらせるとき（scatter）は苔を除く（苔は生える所に生やす）
   */
  private pick(c: NestCategory, scatter = false): NestKind {
    const ks = this.kinds.filter((k) => k.category === c && !(scatter && k.id === 'moss'));
    return ks[Math.floor(Math.random() * ks.length)];
  }

  /**
   * 苔の生える所（物のすぐ脇の点と、ふちに沿う向き）に、生えている苔を 1 枚生やす：ふちに沿って左右へずらし、物から少しずつ離して、
   * 置ける所を探す。生やせたら true
   */
  private grow(site: { x: number; z: number; tx: number; tz: number }, prefer = 0): boolean {
    const kind = NEST_KINDS.find((k) => k.id === 'moss')!;
    const r = kind.r * this.scale;
    for (const q of [0, 0.12, 0.24, 0.36]) {
      for (const dt of [0, 0.2, -0.2, 0.45, -0.45, 0.8, -0.8]) {
        for (const sgn of [1, -1]) {
          const t = prefer + dt;
          const x = site.x + site.tx * t - site.tz * q * sgn, z = site.z + site.tz * t + site.tx * q * sgn;
          if (!this.fits(x, z, r, 0, false, MOSS_GAP, true)) continue;
          this.place(kind, x, z, true);
          return true;
        }
      }
    }
    return false;
  }

  /** 1 個出す（ゆっくりの前の地面に。種類は kindId）。置ける所がなければ false */
  spawn(): boolean {
    if (this.items.length >= MAX_ITEMS) return false;
    const y = this.y;
    const R = y.shape.radius;
    const named = this.kinds.find((k) => k.id === this.kindId);
    const kind = named ?? this.pick(this.kindId === 'bedding' ? 'bedding' : 'treasure');
    // 森の苔は、ゆっくりに近い苔の生える所に生やす（地面に転がしては出さない）
    if (kind.id === 'moss' && this.y.stage?.mossSites.length) {
      const c = this.y.center;
      const sites = [...this.y.stage.mossSites].sort((a, b) => Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z));
      return sites.some((site) => this.grow(site));
    }
    const f = bodyFacing(y);
    const side = new THREE.Vector3(f.z, 0, -f.x);
    const r = kind.r * this.scale;
    const p = new THREE.Vector3();
    for (let k = 0; k < TRIES * 2; k++) {
      const ahead = (SPAWN_AHEAD[0] + Math.random() * (SPAWN_AHEAD[1] - SPAWN_AHEAD[0])) * R + r;
      if (k < TRIES / 2) {
        // 初めは前
        p.copy(y.center).addScaledVector(f, ahead).addScaledVector(side, R * SPAWN_SIDE * (Math.random() * 2 - 1));
      } else {
        // 前が埋まっていれば、まわりのどこかへ少しずつ遠くまで
        const a = Math.random() * Math.PI * 2;
        const d = ahead * (1 + (k - TRIES / 2) / 15);
        p.set(y.center.x + Math.sin(a) * d, 0, y.center.z + Math.cos(a) * d);
      }
      if (!this.fits(p.x, p.z, r, R * 1.2)) continue;
      this.place(kind, p.x, p.z);
      return true;
    }
    return false;
  }

  /** 全部片付ける */
  clear(): void {
    for (const it of this.items) {
      this.object.remove(it.object);
      for (const d of it.own) d.dispose();
    }
    this.items.length = 0;
    for (const m of this.scars) {
      this.object.remove(m);
      m.geometry.dispose();
      m.material.map?.dispose();
      m.material.dispose();
    }
    this.scars.length = 0;
  }

  /** 飼育ケース・森のどこか（ゆっくりから離れた所）に 1 個置く */
  private scatterOne(kind: NestKind): void {
    const a = this.y.stage?.area;
    if (!a) return;
    const r = kind.r * this.scale;
    for (let k = 0; k < TRIES; k++) {
      const x = a.minX + Math.random() * (a.maxX - a.minX);
      const z = a.minZ + Math.random() * (a.maxZ - a.minZ);
      if (!this.fits(x, z, r, this.y.shape.radius * 1.8, true)) continue;
      this.place(kind, x, z);
      return;
    }
  }

  /**
   * 中心（x, z）・半径 r の物を置けるか：行ける範囲の内側、皿・木・岩・といれ・ほかの巣材に重ならない、体から away m より離れている。
   * 草むら・茂み（中に置くと隠れる）にも置かない。散らばらせるとき（scatter）は、うろの幹のまわり（中も）にも置かない
   */
  private fits(x: number, z: number, r: number, away: number, scatter = false, rootedGap = 1.05, hug = false): boolean {
    const st = this.y.stage;
    if (st) {
      if (!st.inside(x, z, r + 0.08)) return false;
      // 生える苔（hug）は物の根元に寄り添う：体が乗れない所（props の円）には少しかかってよく、当たる箱の上には半分まで
      if (!hug && st.overlapProp(x, z, r + 0.08)) return false;
      if (st.inToilet(x, z, -(r + 0.05))) return false;
      if (st.blocked(x, z, hug ? r * 0.5 : r + 0.08) || st.inCover(x, z, r) || (scatter && st.nearCave(x, z))) return false;
    }
    const c = this.y.center;
    if (Math.hypot(x - c.x, z - c.z) < away + r) return false;
    for (const it of this.items) {
      const o = it.object.position;
      if (Math.hypot(x - o.x, z - o.z) < (r + it.kind.r * this.scale) * (it.rooted ? rootedGap : 1.05)) return false;
    }
    return true;
  }

  private place(kind: NestKind, x: number, z: number, rooted = false): void {
    const own: { dispose(): void }[] = [];
    const tints: THREE.Material[] = [];
    const object = this.build(kind.id, own, tints);
    // 足元の影（地面から浮いて見えず、物として見分けやすいように）。形の広がりに合わせた楕円
    const box = new THREE.Box3().setFromObject(object);
    const shadow = createBlobShadow();
    shadow.material.uniforms.uOpacity.value = SHADOW_OPACITY;
    shadow.scale.set((box.max.x - box.min.x) * SHADOW_SPREAD, 1, (box.max.z - box.min.z) * SHADOW_SPREAD);
    shadow.position.set((box.max.x + box.min.x) / 2, 0.002, (box.max.z + box.min.z) / 2);
    own.push(shadow.geometry, shadow.material);
    object.add(shadow);
    object.scale.setScalar(this.scale);
    if (rooted) this.rootedLook(object, true);
    object.position.set(x, 0, z);
    object.rotation.y = Math.random() * Math.PI * 2;
    this.object.add(object);
    this.items.push({ kind, object, own, shadow, height: box.max.y, nest: false, held: false, settled: 0, tints, dark: 0, rooted });
  }

  /** トゥーンの材質（色ごとに 1 つを使い回す。地面へ押し付ける処理は切る：薄い物が潰れないよう、底を地面に置いて作る） */
  private mat(c: ToonColors, doubleSide = false): THREE.Material {
    const key = c.lit + (doubleSide ? 'd' : '');
    let m = this.mats.get(key);
    if (!m) {
      m = createAccessoryMaterial(this.y.bodyMaterial, c, { rim: 0.2, doubleSide, ground: -100 });
      this.mats.set(key, m);
    }
    return m;
  }

  /**
   * 形を作る（m、倍率 1 の大きさ。底が y = 0、上から見た中心が原点）。森の組は、うろの中で沈めるため材質をその物だけで持つ
   * （tints に入れる）
   */
  private build(id: NestKindId, own: { dispose(): void }[], tints: THREE.Material[]): THREE.Group {
    const g = new THREE.Group();
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, outline = true) => {
      own.push(geo);
      const o = withOutline(geo, m, outline ? this.outline : null);
      g.add(o);
      return o;
    };
    // その物だけのトゥーンの材質・絵を貼った薄い板の材質（森の組）
    const toon = (c: ToonColors, doubleSide = false) => {
      const m = createAccessoryMaterial(this.y.bodyMaterial, c, { rim: 0.2, doubleSide, ground: -100 });
      own.push(m);
      tints.push(m);
      return m;
    };
    const sheet = (tex: THREE.Texture) => {
      const m = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true });
      own.push(tex, m);
      tints.push(m);
      return m;
    };
    switch (id) {
      case 'stick': {
        // アイスの当たり棒：両端の丸い平たい木の棒（実物 9.5 × 1 cm、厚み 2 mm）。字の頭の側の端に赤い「あたり」
        const L = 9.5 * CM, W = 1.0 * CM, T = 0.2 * CM, bevel = T * 0.3;
        const s = new THREE.Shape();
        s.absarc(0, L / 2 - W / 2, W / 2, 0, Math.PI, false);
        s.absarc(0, -L / 2 + W / 2, W / 2, Math.PI, Math.PI * 2, false);
        const geo = new THREE.ExtrudeGeometry(s, { depth: T - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 12 });
        geo.rotateX(-Math.PI / 2);
        geo.translate(0, bevel, 0);
        add(geo, this.mat(WOOD));
        const tex = stampTexture();
        const tm = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
        const tg = new THREE.PlaneGeometry(W * 0.62, W * 2.1).rotateX(-Math.PI / 2);
        own.push(tex, tm, tg);
        const text = new THREE.Mesh(tg, tm);
        // 字の頭（「あ」の側。板の -z）の端に寄せる
        text.position.set(0, T + 0.003, -(L / 2 - W * 1.9));
        g.add(text);
        break;
      }
      case 'marble': {
        // ビー玉：透き通った玉（実物 直径 1.7 cm）の中に、ねじれた色の羽。上にてかり
        const r = 0.85 * CM;
        const glass = glassMaterial();
        const geo = new THREE.SphereGeometry(r, 24, 16).translate(0, r, 0);
        own.push(glass);
        const vane = new THREE.MeshBasicMaterial({ color: MARBLE_VANES[Math.floor(Math.random() * MARBLE_VANES.length)], side: THREE.DoubleSide });
        own.push(vane);
        for (const a of [0, Math.PI * 2 / 3, Math.PI * 4 / 3]) {
          const v = twistedVane(r * 0.8, r * 0.5);
          v.rotateY(a);
          v.translate(0, r, 0);
          own.push(v);
          g.add(new THREE.Mesh(v, vane));
        }
        // 中の羽を先に描いて、外の玉を重ねる。輪郭線は付けない（透けた玉の奥に、線の裏側が黒く見える）。縁は玉の材質で濃くする
        const ball = add(geo, glass, false);
        ball.renderOrder = 1;
        const hl = new THREE.MeshBasicMaterial({ color: '#ffffff' });
        const hg = new THREE.SphereGeometry(r * 0.18, 10, 8).scale(1, 0.6, 1).translate(-r * 0.38, r * 1.72, r * 0.3);
        own.push(hl, hg);
        g.add(new THREE.Mesh(hg, hl));
        break;
      }
      case 'pebble': {
        // きれいな小石：つるっと丸い平たい石（実物 2.4 cm）。色はいくつか
        const geo = new THREE.SphereGeometry(1, 24, 16);
        const p = geo.getAttribute('position') as THREE.BufferAttribute;
        const ph = Math.random() * 6;
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i), yy = p.getY(i), z = p.getZ(i);
          const k = 1 + 0.07 * Math.sin(x * 2.1 + ph) * Math.cos(z * 1.7 - ph) + 0.04 * Math.sin(yy * 3 + x * 2);
          p.setXYZ(i, x * k * 1.2 * CM, (yy < 0 ? yy * 0.7 : yy) * k * 0.55 * CM, z * k * 0.9 * CM);
        }
        geo.computeVertexNormals();
        geo.computeBoundingBox();
        geo.translate(0, -geo.boundingBox!.min.y, 0);
        add(geo, this.mat(PEBBLES[Math.floor(Math.random() * PEBBLES.length)]));
        break;
      }
      case 'button': {
        // ボタン：縁が少し盛り上がった平たい丸（実物 直径 1.8 cm）と 4 つの穴
        const R = 0.9 * CM, H = 0.28 * CM;
        const prof = [
          [0.001, 0], [R * 0.86, 0], [R, H * 0.3], [R * 0.98, H * 0.85], [R * 0.86, H], [R * 0.72, H * 0.8], [R * 0.6, H * 0.7], [0.001, H * 0.7],
        ].map(([a, b]) => new THREE.Vector2(a, b));
        const geo = new THREE.LatheGeometry(prof, 40);
        const colors = BUTTONS[Math.floor(Math.random() * BUTTONS.length)];
        add(geo, this.mat(colors));
        const hole = new THREE.MeshBasicMaterial({ color: colors.deep });
        own.push(hole);
        for (const [hx, hz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const hg = new THREE.CircleGeometry(R * 0.11, 12).rotateX(-Math.PI / 2).translate(hx * R * 0.2, H * 0.7 + 0.002, hz * R * 0.2);
          own.push(hg);
          g.add(new THREE.Mesh(hg, hole));
        }
        break;
      }
      case 'paper':
      case 'cloth':
      case 'tissue': {
        // ちぎった新聞紙・布の切れ端（6 × 5 cm）と、落ちたティッシュ（7 cm 四方）：薄い紙・布に絵を貼り、縁は絵の透けで形づくる。
        // 平らだと床に貼った模様にしか見えなかった（指示）ので、どれも立体にする：
        //   新聞紙 … くしゃっと折れじわ（面を角張らせる）、縁が少し反る
        //   布 … ひだのある柔らかい波（ギンガムチェックと縫い目で布と分かるように）
        //   ティッシュ … 真ん中をつまみ上げたようにふわっと盛り上がり、まわりは花びらのように波打って床へ垂れる
        const [w, d] = id === 'tissue' ? [7 * CM, 7 * CM] : [6.2 * CM, 5.0 * CM];
        const tex = scrapTexture(id);
        const geo = crumpledSheet(w, d, id);
        const m = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true });
        own.push(tex, m, geo);
        g.add(new THREE.Mesh(geo, m));
        break;
      }
      case 'hay': {
        // 牧草：細く少し曲がった干し草を 30 本（実物 4.5〜8 cm）、向きをばらばらに絡ませて、真ん中が盛り上がった山にする
        // （太く真っすぐな 11 本の束は、箸の束のように見えた。指示）
        const n = 30, r = 0.07 * CM, HEAP = 2.6 * CM, TOP = 0.75 * CM;
        const base = Math.random() * Math.PI;
        for (let i = 0; i < n; i++) {
          const L = (4.5 + Math.random() * 3.5) * CM;
          const a = base + (Math.random() - 0.5) * 2.2;
          const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
          const side = new THREE.Vector3(dir.z, 0, -dir.x);
          const c = new THREE.Vector3((Math.random() - 0.5) * 2.4 * CM, 0, (Math.random() - 0.5) * 2.4 * CM);
          const bend = (Math.random() - 0.5) * 0.9 * CM;
          const lift = 0.4 + Math.random() * 0.6;
          const pts: THREE.Vector3[] = [];
          for (let k = 0; k <= 4; k++) {
            const t = k / 4 - 0.5;
            const q = c.clone().addScaledVector(dir, t * L).addScaledVector(side, bend * (1 - 4 * t * t) + (Math.random() - 0.5) * 0.2 * CM);
            // 山の真ん中を通る所ほど高く（上に乗った草）
            q.y = r + TOP * lift * Math.max(0, 1 - Math.hypot(q.x, q.z) / HEAP);
            pts.push(q);
          }
          const s = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, r, 4, false);
          add(s, this.mat(HAY[i % 5 === 0 ? 1 : i % 3 === 0 ? 2 : 0]));
        }
        break;
      }
      case 'feather': {
        // 鳥の羽根（実物 12 cm）：茶色に濃いしまの羽（絵を貼った薄い板。外は透かす）と、白っぽい軸。-z が根元（軸だけの所）。
        // 床に寝て、根元と先が少し浮き、羽のふちは少し反る
        const L = 12 * F, W = 3.4 * F;
        const lift = (x: number, z: number) => 0.45 * F * ((2 * z) / L) ** 2 + 0.25 * F * ((2 * x) / W) ** 2;
        const geo = new THREE.PlaneGeometry(W, L, 6, 24).rotateX(-Math.PI / 2);
        const p = geo.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < p.count; i++) p.setY(i, lift(p.getX(i), p.getZ(i)) + 0.003);
        shadeSheet(geo, [0.62, 0.6, 0.58]);
        own.push(geo);
        g.add(new THREE.Mesh(geo, sheet(featherTexture())));
        const shaft = tubeAlong((t) => {
          const z = -L / 2 + t * L * 0.97;
          return new THREE.Vector3(0, lift(0, z) + 0.12 * F * (1 - t) + 0.004, z);
        }, (t) => (0.13 - 0.1 * t) * F, 24, 6);
        add(shaft, toon(QUILL), false);
        break;
      }
      case 'pinecone': {
        // 松ぼっくり（実物 長さ 6 cm・太さ 4 cm）：芯のまわりに、開いた鱗片をらせん（黄金角）に並べる。横に寝かせる（+z が先）
        const L = 6 * F, R = 2 * F, N = 64;
        const scales: THREE.BufferGeometry[][] = [[], []];
        const m4 = new THREE.Matrix4();
        const up = new THREE.Vector3(0, 1, 0);
        for (let i = 0; i < N; i++) {
          const t = (i + 0.5) / N;
          const a = i * 2.39996;
          // 太さ：根元の少し先がいちばん太く、先へ細る
          const rr = R * Math.sin(Math.PI * (0.12 + 0.8 * t ** 0.85));
          const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
          // 鱗片は外へ開き、少し先の側へ向く
          const dir = out.clone().multiplyScalar(Math.cos(0.5)).addScaledVector(up, Math.sin(0.5)).normalize();
          const tan = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
          const nrm = new THREE.Vector3().crossVectors(dir, tan).normalize();
          const len = rr * 0.62 + R * 0.12, wid = R * (0.26 + 0.18 * Math.sin(Math.PI * t)), th = R * 0.11;
          const sc = new THREE.SphereGeometry(1, 8, 6).scale(wid, th, len).translate(0, 0, len * 0.85);
          m4.makeBasis(tan, nrm, dir).setPosition(out.x * rr * 0.4, (t - 0.5) * L * 0.92, out.z * rr * 0.4);
          scales[i % 3 === 0 ? 1 : 0].push(sc.applyMatrix4(m4));
        }
        const core = new THREE.SphereGeometry(1, 16, 12).scale(R * 0.5, L * 0.5, R * 0.5);
        const lay = (geo: THREE.BufferGeometry) => geo.rotateX(Math.PI / 2).rotateZ(0.12);
        const parts = [lay(core), ...scales.map((list) => {
          const geo = lay(mergeGeometries(list));
          for (const x of list) x.dispose();
          return geo;
        })];
        const box = new THREE.Box3();
        for (const geo of parts) {
          geo.computeBoundingBox();
          box.union(geo.boundingBox!);
        }
        for (const geo of parts) geo.translate(0, -box.min.y, 0);
        add(parts[0], toon(CONE_CORE));
        add(parts[1], toon(CONE_SCALES[0]));
        add(parts[2], toon(CONE_SCALES[1]));
        break;
      }
      case 'snail': {
        // カタツムリの空の殻（実物 直径 3 cm）：太りながら巻く管（3 巻き半）に、濃い色のしまを 1 本。口は内が暗く、縁が白っぽい。横に寝かせる
        const turns = 3.4, k = Math.log(13) / (turns * Math.PI * 2);
        const D = 3 * F, rEnd = D * 0.27;
        const r0 = rEnd / Math.exp(k * turns * Math.PI * 2);
        // 巻きの中心から管の真ん中までの距離・管の太さ・巻く軸の向きの高さ
        const at = (t: number) => {
          const th = t * turns * Math.PI * 2, g2 = r0 * Math.exp(k * th);
          return { th, c: g2 * 1.25, tube: g2, h: -g2 * 0.9 };
        };
        const path = (t: number, out = 0, lift = 0) => {
          const q = at(t);
          return new THREE.Vector3(Math.cos(q.th) * (q.c + out * q.tube), q.h + lift * q.tube, Math.sin(q.th) * (q.c + out * q.tube));
        };
        const shell = tubeAlong((t) => path(t), (t) => at(t).tube, 140, 14);
        const band = tubeAlong((t) => path(t, 0.93, 0.25), (t) => at(t).tube * 0.16, 140, 6);
        const end = path(1), tangent = path(1).sub(path(0.995)).normalize();
        const mouth = new THREE.CircleGeometry(rEnd * 0.9, 20);
        const lip = new THREE.TorusGeometry(rEnd * 0.95, rEnd * 0.1, 6, 24);
        const face = new THREE.Matrix4().lookAt(new THREE.Vector3(), tangent, new THREE.Vector3(0, 1, 0)).setPosition(end);
        mouth.applyMatrix4(face);
        lip.applyMatrix4(face);
        const parts = [shell, band, mouth, lip];
        for (const geo of parts) geo.rotateX(Math.PI / 2).rotateY(0.6);
        const box = new THREE.Box3();
        for (const geo of parts) {
          geo.computeBoundingBox();
          box.union(geo.boundingBox!);
        }
        const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
        for (const geo of parts) geo.translate(-cx, -box.min.y, -cz);
        add(shell, toon(SHELL));
        add(band, toon(SHELL_BAND), false);
        add(mouth, toon(SHELL_MOUTH, true), false);
        add(lip, toon(SHELL_LIP), false);
        break;
      }
      case 'leaves': {
        // 落ち葉のひと束（実物 25 cm ほど）：色づいた葉（もみじの形・丸い葉）7 枚を、少しずつずらして重ねる。葉は少し丸まる
        const n = 7;
        for (let i = 0; i < n; i++) {
          const maple = Math.random() < 0.45;
          const L = (9 + Math.random() * 4) * F, W = maple ? L : L * 0.55;
          const geo = new THREE.PlaneGeometry(W, L, 10, 12).rotateX(-Math.PI / 2);
          const p = geo.getAttribute('position') as THREE.BufferAttribute;
          const curl = (0.4 + Math.random() * 0.8) * F, ph = Math.random() * 6;
          for (let j = 0; j < p.count; j++) {
            const u = (2 * p.getX(j)) / W, v = (2 * p.getZ(j)) / L;
            p.setY(j, curl * (u * u + 0.5 * v * v) + 0.15 * F * Math.sin(u * 3 + v * 2 + ph));
          }
          // 重ねる：後の葉ほど上。束の真ん中のまわりに散らす
          const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * 5 * F;
          geo.rotateY(Math.random() * Math.PI * 2).translate(Math.sin(a) * d, 0.004 + i * 0.35 * F, Math.cos(a) * d);
          shadeSheet(geo, [0.62, 0.6, 0.6]);
          own.push(geo);
          g.add(new THREE.Mesh(geo, sheet(leafTexture(maple ? 'maple' : 'oval', FALL_LEAVES[Math.floor(Math.random() * FALL_LEAVES.length)]))));
        }
        break;
      }
      case 'bigleaf': {
        // 大きな葉っぱ（ホオノキの葉のような 1 枚。実物 30 × 13 cm）：先寄りが幅広い卵形、短い葉柄（-z）。
        // 真ん中の葉脈で V に折れ、長さの向きにもゆるく反る
        const L = 30 * F, W = 13 * F;
        const geo = new THREE.PlaneGeometry(W, L, 12, 32).rotateX(-Math.PI / 2);
        const p = geo.getAttribute('position') as THREE.BufferAttribute;
        const ph = Math.random() * 6;
        for (let i = 0; i < p.count; i++) {
          const u = (2 * p.getX(i)) / W, v = (2 * p.getZ(i)) / L;
          p.setY(i, 1.1 * F * Math.abs(u) ** 1.3 + 0.9 * F * v * v + 0.2 * F * Math.sin(v * 7 + ph) * Math.abs(u));
        }
        geo.translate(0, 0.004, 0);
        shadeSheet(geo, [0.6, 0.6, 0.58]);
        own.push(geo);
        g.add(new THREE.Mesh(geo, sheet(leafTexture('big', BIG_LEAVES[Math.random() < 0.7 ? 0 : 1]))));
        break;
      }
      case 'moss': {
        // 苔のかたまり（はがした苔のマット。実物 20 × 16 cm・厚み 2 cm ほど）：ふちがでこぼこの丸い座布団の形。上はもこもこ、
        // ふちは土の色で地面へ下りる（絵で外を透かし、ふちの土を描く）
        const W = 20 * F, D = 16 * F, T = 2.2 * F;
        const ph = Math.random() * 6;
        const edge = (th: number) => 0.9 * (1 + 0.1 * Math.sin(3 * th + ph) + 0.06 * Math.sin(5 * th - ph * 1.7));
        const geo = new THREE.PlaneGeometry(W, D, 48, 40).rotateX(-Math.PI / 2);
        const p = geo.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i), z = p.getZ(i);
          const u = (2 * x) / W, v = (2 * z) / D;
          const q = Math.hypot(u, v) / edge(Math.atan2(v, u));
          // ふちはなだらかに土へ下りる（急だと切り立った土の塊に見えた）。もこもこは大きめのうねりと、細かい粒を少し
          const body = THREE.MathUtils.smoothstep(1 - q, 0, 0.45);
          const bumps = 0.35 * T * (0.5 + 0.5 * Math.sin(x * 70 + ph) * Math.sin(z * 64 - ph)) + 0.05 * T * Math.sin(x * 160 + z * 140);
          p.setY(i, (T + bumps) * body + 0.003);
        }
        shadeSheet(geo, [0.55, 0.58, 0.52]);
        own.push(geo);
        // 生えている間の絵（土のふちなし）も作っておく（place・peel が差し替える）
        const rootedMap = mossTexture(edge, false);
        own.push(rootedMap);
        const mesh = new THREE.Mesh(geo, sheet(mossTexture(edge)));
        mesh.userData.rootedMap = rootedMap;
        g.add(mesh);
        break;
      }
    }
    return g;
  }

  dispose(): void {
    this.clear();
    for (const m of this.mats.values()) m.dispose();
    this.outline.dispose();
  }
}


/** ビー玉の中の羽：中心を通る薄い板を、上下でねじる（半径 r・幅 w） */
function twistedVane(r: number, w: number): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(w, r * 2, 1, 12);
  const p = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), yy = p.getY(i);
    const a = (yy / r) * 1.4;
    // 球の中に収まるよう、端ほど幅を細める
    const k = Math.sqrt(Math.max(0, 1 - (yy / r) ** 2));
    p.setXYZ(i, x * k * Math.cos(a), yy, x * k * Math.sin(a));
  }
  geo.computeVertexNormals();
  return geo;
}

/** ビー玉のガラス：真ん中は透けて、縁ほど濃い（輪郭線の代わり） */
function glassMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
        vec3 col = mix(vec3(0.82, 0.94, 0.95), vec3(0.2, 0.36, 0.42), smoothstep(0.35, 1.0, rim));
        gl_FragColor = vec4(col, mix(0.22, 0.95, rim));
        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * くしゃっとした薄い紙・布（横 w × 奥行き d）。光の当たり方を頂点の色にして、絵を貼った板でも凹凸が見えるように
 *   paper … 向きの違う 3 本の折れじわ（|sin| で角が立つ）と、縁の反り。面は角張らせる
 *   cloth … 一方向に流れるひだと、ゆるい波
 *   tissue … 真ん中がふわっと盛り上がり、まわりは花びらのように波打って床へ垂れる
 */
function crumpledSheet(w: number, d: number, style: 'paper' | 'cloth' | 'tissue'): THREE.BufferGeometry {
  let geo: THREE.BufferGeometry = new THREE.PlaneGeometry(w, d, 40, 32).rotateX(-Math.PI / 2);
  const p = geo.getAttribute('position') as THREE.BufferAttribute;
  const folds = [0, 1, 2].map(() => ({ a: Math.random() * Math.PI, k: 1.6 + Math.random() * 1.8, ph: Math.random() * 6 }));
  const ph = Math.random() * 6;
  let min = Infinity;
  for (let i = 0; i < p.count; i++) {
    // -1〜1 に寄せた位置
    const u = (p.getX(i) / w) * 2, v = (p.getZ(i) / d) * 2;
    let h = 0;
    if (style === 'paper') {
      for (const f of folds) h += 0.3 * CM * Math.abs(Math.sin((u * Math.cos(f.a) + v * Math.sin(f.a)) * f.k + f.ph));
      h += 0.55 * CM * Math.max(Math.abs(u), Math.abs(v)) ** 2;
    } else if (style === 'cloth') {
      const f = folds[0];
      const along = u * Math.cos(f.a) + v * Math.sin(f.a), across = -u * Math.sin(f.a) + v * Math.cos(f.a);
      h = 0.5 * CM * (0.5 + 0.5 * Math.sin(along * 4.2 + across * 0.8 + ph)) * (0.6 + 0.4 * Math.cos(across * 1.5))
        + 0.2 * CM * Math.sin(u * 2.3 + ph) * Math.sin(v * 2.1 - ph);
    } else {
      const rr = Math.min(1, Math.hypot(u, v) / 1.25);
      const th = Math.atan2(v, u);
      h = 1.6 * CM * (1 - rr) ** 1.7
        + 0.5 * CM * rr * (1 - rr) * 4 * (0.5 + 0.5 * Math.sin(th * 5 + ph))
        + 0.1 * CM * Math.abs(Math.sin(u * 7 + v * 3 + ph));
    }
    p.setY(i, h);
    min = Math.min(min, h);
  }
  geo.translate(0, -min + 0.004, 0);
  if (style === 'paper') geo = geo.toNonIndexed();
  const lo = style === 'tissue' ? 0.72 : 0.6;
  // 暗い所の色：ティッシュは白なので青みの灰色に寄せる（灰色のままだと汚れて見える）
  shadeSheet(geo, style === 'tissue' ? [0.74, 0.77, 0.88] : [lo, lo, lo]);
  return geo;
}

/** 絵を貼った薄い板の凹凸が見えるよう、光の当たり方を頂点の色にする（dark は光の当たらない所の色） */
function shadeSheet(geo: THREE.BufferGeometry, dark: number[]): void {
  geo.computeVertexNormals();
  const n = geo.getAttribute('normal') as THREE.BufferAttribute;
  const L = new THREE.Vector3(0.4, 1, 0.3).normalize();
  const col = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) {
    const t = THREE.MathUtils.smoothstep(n.getX(i) * L.x + n.getY(i) * L.y + n.getZ(i) * L.z, 0.25, 1);
    for (let k = 0; k < 3; k++) col[i * 3 + k] = dark[k] + (1 - dark[k]) * t;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function texture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** 当たり棒の「あたり」（縦書き。赤い焼き印） */
function stampTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 216);
  g.fillStyle = '#c4362c';
  g.font = 'bold 56px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  ['あ', 'た', 'り'].forEach((ch, i) => g.fillText(ch, 32, 38 + i * 70));
  return texture(c);
}

/** ちぎった紙・布・ティッシュの絵：縁の内側だけを塗る（外は透ける） */
function scrapTexture(kind: 'paper' | 'cloth' | 'tissue'): THREE.CanvasTexture {
  const S = 256;
  const [c, g] = canvas(S, S);
  // 縁：角の丸い四角。新聞紙と布は、ちぎった所をぎざぎざにして 1 辺だけ元の真っすぐな縁（布は縫ってある端）を残す。
  // ティッシュはちぎらないので、ゆるく波打つだけ
  const straight = Math.floor(Math.random() * 4);
  const pts: [number, number][] = [];
  const N = 72;
  const ph = Math.random() * 6;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    const cs = Math.cos(t), sn = Math.sin(t);
    // 角の丸い四角（超楕円）
    const e = 5;
    let r = 1 / Math.pow(Math.pow(Math.abs(cs), e) + Math.pow(Math.abs(sn), e), 1 / e);
    const side = Math.round(((t + Math.PI / 4) % (Math.PI * 2)) / (Math.PI / 2)) % 4;
    if (kind === 'tissue') r *= 0.95 + 0.03 * Math.sin(t * 5 + ph);
    else if (side !== straight) r *= 0.9 + 0.06 * Math.sin(t * 3 + ph) + 0.05 * Math.sin(t * 7 - ph) + (Math.random() - 0.5) * 0.05;
    pts.push([S / 2 + cs * r * S * 0.46, S / 2 + sn * r * S * 0.46]);
  }
  const path = () => {
    g.beginPath();
    pts.forEach(([x, z], i) => (i ? g.lineTo(x, z) : g.moveTo(x, z)));
    g.closePath();
  };
  // 真っすぐな縁の外向き（0:+x 1:+y 2:-x 3:-y。絵の座標）
  const out = [[1, 0], [0, 1], [-1, 0], [0, -1]][straight];
  if (kind === 'paper') {
    path();
    // 床の新聞紙と見分けられるよう、少し黄ばんだ色
    g.fillStyle = '#efe2bf';
    g.fill();
    g.save();
    path();
    g.clip();
    // 字は灰色の棒だけ（床の新聞紙と同じく、読める字は描かない）。縦書きの段
    g.fillStyle = '#9b978d';
    const rows = 5 + Math.floor(Math.random() * 3);
    for (let col = 0; col < 40; col++) {
      const x = S - 10 - col * 7;
      for (let row = 0; row < rows; row++) {
        const y0 = 8 + row * (S / rows);
        const len = S / rows - 14 - (Math.random() < 0.2 ? Math.random() * 30 : 0);
        g.fillRect(x, y0, 3, len);
      }
    }
    // 見出しの太い棒
    g.fillStyle = '#56534c';
    g.fillRect(S * 0.15, S * 0.12, 14, S * 0.3);
    g.restore();
    path();
    g.strokeStyle = '#a89a76';
    g.lineWidth = 3;
    g.stroke();
  } else if (kind === 'cloth') {
    const ink = CLOTHS[Math.floor(Math.random() * CLOTHS.length)];
    // ほつれた糸（ちぎった縁から外へ短い線。縫ってある端からは出さない）
    g.strokeStyle = ink;
    g.lineWidth = 2;
    for (let i = 0; i < N; i += 2) {
      const [x, z] = pts[i];
      const dx = x - S / 2, dz = z - S / 2, l = Math.hypot(dx, dz);
      if ((dx * out[0] + dz * out[1]) / l > 0.8) continue;
      const k = 4 + Math.random() * 9;
      g.beginPath();
      g.moveTo(x, z);
      g.lineTo(x + (dx / l) * k + (Math.random() - 0.5) * 4, z + (dz / l) * k + (Math.random() - 0.5) * 4);
      g.stroke();
    }
    path();
    g.fillStyle = '#fbf8f2';
    g.fill();
    g.save();
    path();
    g.clip();
    // ギンガムチェック：同じ色の縦と横の帯を半透明で重ねる（重なった所が濃くなる）
    const step = 36, band = 18;
    g.fillStyle = ink;
    g.globalAlpha = 0.5;
    for (let x = -step; x < S + step; x += step) g.fillRect(x, 0, band, S);
    for (let z = -step; z < S + step; z += step) g.fillRect(0, z, S, band);
    g.globalAlpha = 1;
    // 縫ってある端：真っすぐな縁から少し内側に、点線の縫い目
    g.strokeStyle = '#ffffff';
    g.lineWidth = 3;
    g.setLineDash([9, 6]);
    const inset = S * 0.46 * 0.86;
    g.beginPath();
    if (out[0] !== 0) {
      g.moveTo(S / 2 + out[0] * inset, 0);
      g.lineTo(S / 2 + out[0] * inset, S);
    } else {
      g.moveTo(0, S / 2 + out[1] * inset);
      g.lineTo(S, S / 2 + out[1] * inset);
    }
    g.stroke();
    g.setLineDash([]);
    g.restore();
    path();
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    g.lineWidth = 2;
    g.stroke();
  } else {
    path();
    g.fillStyle = '#fdfdfb';
    g.fill();
    g.save();
    path();
    g.clip();
    // うっすらした型押しの点
    g.fillStyle = 'rgba(150,160,185,0.18)';
    for (let x = 6; x < S; x += 12) for (let z = 6; z < S; z += 12) g.fillRect(x + ((z / 12) % 2) * 6, z, 3, 3);
    g.restore();
    path();
    g.strokeStyle = '#c3c8d6';
    g.lineWidth = 2.5;
    g.stroke();
  }
  return texture(c);
}

/**
 * 鳥の羽根の絵（縦長。上が根元 = 物の -z）：根元の 2 割は軸だけ（透かす）。羽は左右で幅が違い、先が丸い。
 * 茶色の地に濃いしま（羽枝の向きに斜め）、羽枝の細い線、ところどころ羽が割れたすき間
 */
function featherTexture(): THREE.CanvasTexture {
  const Wc = 64, Hc = 256;
  const [c, g] = canvas(Wc, Hc);
  const top = Hc * 0.2, mid = Wc / 2;
  // 羽のふち：左は広く右は狭い。根元から先へふくらみ、先は丸く閉じる
  const half = (t: number, side: number) => (side < 0 ? 0.46 : 0.34) * Wc * Math.sin(Math.PI * Math.min(1, t * 0.62 + 0.08)) ** 0.7 * (t > 0.85 ? Math.sqrt(Math.max(0, (1 - t) / 0.15)) : 1);
  const path = () => {
    g.beginPath();
    g.moveTo(mid, top);
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      g.lineTo(mid - half(t, -1), top + t * (Hc - top - 2));
    }
    for (let i = 40; i >= 0; i--) {
      const t = i / 40;
      g.lineTo(mid + half(t, 1), top + t * (Hc - top - 2));
    }
    g.closePath();
  };
  path();
  g.fillStyle = '#9a7650';
  g.fill();
  g.save();
  path();
  g.clip();
  // 濃いしま：羽枝の向き（軸から先の側へ斜め）に並ぶ帯
  g.fillStyle = '#4e3826';
  for (let y = top + 10; y < Hc + 20; y += 22) {
    g.beginPath();
    g.moveTo(0, y + 12);
    g.lineTo(mid, y);
    g.lineTo(Wc, y + 12);
    g.lineTo(Wc, y + 21);
    g.lineTo(mid, y + 9);
    g.lineTo(0, y + 21);
    g.closePath();
    g.fill();
  }
  // 羽枝の細い線
  g.strokeStyle = 'rgba(255,240,215,0.22)';
  g.lineWidth = 1;
  for (let y = top - 10; y < Hc + 20; y += 4) {
    g.beginPath();
    g.moveTo(0, y + 14);
    g.lineTo(mid, y);
    g.lineTo(Wc, y + 14);
    g.stroke();
  }
  // 根元に近い所は綿毛のように白っぽく
  const fluff = g.createLinearGradient(0, top, 0, top + Hc * 0.18);
  fluff.addColorStop(0, 'rgba(240,228,210,0.85)');
  fluff.addColorStop(1, 'rgba(240,228,210,0)');
  g.fillStyle = fluff;
  g.fillRect(0, top, Wc, Hc * 0.18);
  g.restore();
  // 羽が割れたすき間（ふちから軸の方へ斜めの切れ目）
  g.globalCompositeOperation = 'destination-out';
  g.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    const side = i % 2 ? 1 : -1;
    const y = top + Hc * (0.25 + Math.random() * 0.45);
    g.beginPath();
    g.moveTo(mid + side * Wc * 0.5, y + 14);
    g.lineTo(mid + side * Wc * 0.12, y + 2);
    g.stroke();
  }
  g.globalCompositeOperation = 'source-over';
  return texture(c);
}

/**
 * 葉の絵（上が葉柄 = 物の -z）。colors は 色・葉脈・ふち
 *   maple … もみじの形（5 つに裂けた手のひら形）
 *   oval … 先のとがった丸い葉（ふちに細かいぎざぎざ）
 *   big … 先寄りが幅広い大きな卵形（ホオノキの葉のような 1 枚）。ふちはなめらか
 * 落ちた葉らしく、茶色のしみをいくつか
 */
function leafTexture(shape: 'maple' | 'oval' | 'big', colors: [string, string, string]): THREE.CanvasTexture {
  const [Wc, Hc] = shape === 'big' ? [128, 288] : [128, 128];
  const [c, g] = canvas(Wc, Hc);
  const [fill, vein, rim] = colors;
  const pts: [number, number][] = [];
  // 葉柄の付け根（上）と、葉の先（下）
  const stemTop = 2, baseY = shape === 'maple' ? Hc * 0.4 : Hc * 0.12;
  // もみじ：付け根（上寄り）から下へ広がる 5 つのとがった裂片。角度 φ は真下が 0
  const lobes = [-0.62, -0.31, 0, 0.31, 0.62].map((k) => k * Math.PI);
  const mapleR = Hc * 0.55;
  if (shape === 'maple') {
    const cx = Wc / 2, cy = Hc * 0.4;
    for (let i = 0; i <= 140; i++) {
      const phi = Math.PI * (-0.8 + 1.6 * (i / 140));
      const lobe = Math.max(...lobes.map((l) => Math.exp(-(((phi - l) / 0.11) ** 2))));
      const r = mapleR * (0.38 + 0.62 * lobe) * (0.97 + 0.03 * Math.sin(i * 2.1));
      pts.push([cx + Math.sin(phi) * r, cy + Math.cos(phi) * r]);
    }
  } else {
    const len = Hc - baseY - 3, widest = shape === 'big' ? 0.62 : 0.45, half = Wc * 0.47;
    const profile = (t: number) => half * Math.sin(Math.PI * Math.min(1, t < widest ? (t / widest) * 0.5 : 0.5 + ((t - widest) / (1 - widest)) * 0.5)) ** (shape === 'big' ? 0.8 : 1);
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      const saw = shape === 'oval' ? (i % 2 ? 1.5 : 0) : 0;
      pts.push([Wc / 2 + profile(t) + saw, baseY + t * len]);
    }
    for (let i = 60; i >= 0; i--) {
      const t = i / 60;
      const saw = shape === 'oval' ? (i % 2 ? 1.5 : 0) : 0;
      pts.push([Wc / 2 - profile(t) - saw, baseY + t * len]);
    }
  }
  const path = () => {
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
  };
  path();
  g.fillStyle = fill;
  g.fill();
  g.save();
  path();
  g.clip();
  // 色むら（ところどころ明るく・暗く）と、茶色のしみ
  for (let i = 0; i < 14; i++) {
    g.fillStyle = i % 2 ? 'rgba(255,240,200,0.12)' : 'rgba(60,30,10,0.12)';
    g.beginPath();
    g.arc(Math.random() * Wc, Math.random() * Hc, 6 + Math.random() * 14, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = 'rgba(90,55,25,0.55)';
  for (let i = 0; i < 4; i++) {
    g.beginPath();
    g.arc(Math.random() * Wc, baseY + Math.random() * (Hc - baseY), 1.5 + Math.random() * 3, 0, Math.PI * 2);
    g.fill();
  }
  // 葉脈：真ん中の 1 本（もみじは付け根から裂片ごとに）と、横の細い脈
  g.strokeStyle = vein;
  g.lineCap = 'round';
  if (shape === 'maple') {
    const cx = Wc / 2, cy = Hc * 0.4;
    g.lineWidth = 2.2;
    for (const l of lobes) {
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.sin(l) * mapleR * 0.92, cy + Math.cos(l) * mapleR * 0.92);
      g.stroke();
    }
  } else {
    g.lineWidth = shape === 'big' ? 3 : 2;
    g.beginPath();
    g.moveTo(Wc / 2, baseY);
    g.lineTo(Wc / 2, Hc - 4);
    g.stroke();
    g.lineWidth = 1.2;
    const n = shape === 'big' ? 14 : 7;
    for (let i = 1; i < n; i++) {
      const y = baseY + ((Hc - baseY) * i) / n;
      for (const side of [-1, 1]) {
        g.beginPath();
        g.moveTo(Wc / 2, y);
        g.quadraticCurveTo(Wc / 2 + side * Wc * 0.2, y + 6, Wc / 2 + side * Wc * 0.42, y + (shape === 'big' ? 22 : 14));
        g.stroke();
      }
    }
  }
  g.restore();
  path();
  g.strokeStyle = rim;
  g.lineWidth = 2;
  g.stroke();
  // 葉柄
  g.strokeStyle = rim;
  g.lineWidth = shape === 'big' ? 4 : 3;
  g.beginPath();
  g.moveTo(Wc / 2, stemTop);
  g.lineTo(Wc / 2, baseY + 2);
  g.stroke();
  return texture(c);
}

/**
 * 苔のかたまりの絵（物の上から見た形と同じ並び）：ふちのでこぼこの形（edge：向き θ でのふちの距離。-1〜1 に寄せた座標）の内を、
 * ふちは土の茶色、内は緑。緑には明るい・暗い粒をたくさん（もこもこ）と、ところどころ細い胞子の柄（赤茶の点）。
 * soil が false なら生えている苔：土のふちはなく、ふちまで緑で、ふちの外へ粒が少しはみ出して地面になじむ
 */
function mossTexture(edge: (th: number) => number, soil = true): THREE.CanvasTexture {
  const S = 256;
  const [c, g] = canvas(S, S);
  const blob = (k: number) => {
    g.beginPath();
    for (let i = 0; i <= 96; i++) {
      const th = (i / 96) * Math.PI * 2;
      const r = edge(th) * k;
      const x = S / 2 + Math.cos(th) * r * (S / 2), y = S / 2 + Math.sin(th) * r * (S / 2);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.closePath();
  };
  const inner = soil ? 0.8 : 0.97;
  if (soil) {
    blob(1.0);
    g.fillStyle = '#5e4630';
    g.fill();
  }
  blob(inner);
  g.fillStyle = '#5f8a3a';
  g.fill();
  if (!soil) {
    // ふちの外へはみ出す粒（地面になじむ）
    for (let i = 0; i < 260; i++) {
      const th = Math.random() * Math.PI * 2, r = edge(th) * (0.9 + Math.random() * 0.14);
      g.fillStyle = Math.random() < 0.5 ? '#6f9a43' : '#4c7330';
      g.beginPath();
      g.arc(S / 2 + Math.cos(th) * r * (S / 2), S / 2 + Math.sin(th) * r * (S / 2), 2 + Math.random() * 3, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.save();
  blob(inner);
  g.clip();
  for (let i = 0; i < 1600; i++) {
    const r = Math.random();
    g.fillStyle = r < 0.45 ? '#7ea84b' : r < 0.8 ? '#4c7330' : r < 0.97 ? '#9cc35f' : '#8a4a2a';
    const x = Math.random() * S, y = Math.random() * S, d = r < 0.97 ? 2 + Math.random() * 3 : 1.5;
    g.beginPath();
    g.arc(x, y, d, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
  if (!soil) return texture(c);
  // ふちの土に、根の細い線
  g.strokeStyle = 'rgba(40,28,18,0.6)';
  g.lineWidth = 1;
  for (let i = 0; i < 40; i++) {
    const th = Math.random() * Math.PI * 2, r = edge(th) * (0.88 + Math.random() * 0.1);
    const x = S / 2 + Math.cos(th) * r * (S / 2), y = S / 2 + Math.sin(th) * r * (S / 2);
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(th) * 5, y + Math.sin(th) * 5);
    g.stroke();
  }
  return texture(c);
}

/**
 * 苔をはがした跡の絵：湿った土の地肌（明るい・暗い粒）と、ちぎれ残った苔の粒。ふちは地面へぼかす
 * （一色の濃い茶色だと、穴かしみのようにべったり見えた）
 */
function scarTexture(): THREE.CanvasTexture {
  const S = 128;
  const [c, g] = canvas(S, S);
  g.fillStyle = '#6a4f36';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 500; i++) {
    const r = Math.random();
    g.fillStyle = r < 0.5 ? '#543d29' : r < 0.85 ? '#7d6146' : r < 0.95 ? '#3f2d1f' : '#5f8a3a';
    g.beginPath();
    g.arc(Math.random() * S, Math.random() * S, 1 + Math.random() * 2.2, 0, Math.PI * 2);
    g.fill();
  }
  // ふちをぼかす（真ん中は濃く、外へ透ける）
  g.globalCompositeOperation = 'destination-in';
  const fade = g.createRadialGradient(S / 2, S / 2, S * 0.25, S / 2, S / 2, S * 0.5);
  fade.addColorStop(0, 'rgba(0,0,0,0.85)');
  fade.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = fade;
  g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'source-over';
  return texture(c);
}
