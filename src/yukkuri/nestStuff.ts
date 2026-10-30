import * as THREE from 'three';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import { createAccessoryOutlineMaterial } from '../render/outlineMaterial';
import { withOutline } from '../character/shapes';
import { createBlobShadow } from '../render/blobShadow';
import type { ToonColors } from '../render/toonMaterial';
import type { MapId } from '../world/Stage';
import { bodyFacing } from './fx';
import type { Yukkuri } from './Yukkuri';

/**
 * 巣材：おうち（おうちせんげんした所）に寝床を作るために集める物（指示）。種類は 食糧・たからもの・べっど の 3 つ。
 *   食糧 … 餌集めの餌（forage.ts）をそのまま使う
 *   たからもの … アイスの当たり棒・ビー玉・きれいな小石・ボタン
 *   べっど … ちぎった新聞紙・ティッシュ・布の切れ端・牧草
 * ここは、たからものとべっどの物（形と、地面に置く・片付ける・運ぶ間の形）。出し方（指示）は、飼育ケースを開いたときに少し散らばっていて、
 * ボタンで 1 個ずつゆっくりの前に出すこともできる。運んで寝床を整えるのは巣作り（nestBuild.ts）。
 * 運ぶ間（指示：三つ編みは垂らしたまま、床を引きずって運ぶ）：べっどは端を毛先でつまみ、つまんだ所だけ浮いて、残りは後ろへ床を
 * 引きずる（DRAG）。たからものは硬いので、形を変えずに毛先に付ける
 * 大きさは実物どおり：飼育ケースの縮尺（ゆっくりは普通の 1/4 という体。実物 1 cm ＝ CM m。新聞紙の床と同じ）。
 * ほかのマップ（普通の大きさのゆっくり）ではその 1/4
 */
export type NestCategory = 'treasure' | 'bedding';
export type NestKindId = 'stick' | 'marble' | 'pebble' | 'button' | 'paper' | 'tissue' | 'cloth' | 'hay';

export interface NestKind {
  id: NestKindId;
  name: string;
  category: NestCategory;
  /** 地面で占める広さ（上から見た半径。m、飼育ケースの縮尺） */
  r: number;
}

/** 実物 1 cm がこの世界で何 m か（飼育ケース。普通のゆっくりの胴の直径 1 m を実物 31 cm とみて、その 1/4） */
const CM = 4 / 31;

export const NEST_KINDS: NestKind[] = [
  { id: 'stick', name: 'アイスの当たり棒', category: 'treasure', r: 4.8 * CM },
  { id: 'marble', name: 'ビー玉', category: 'treasure', r: 0.85 * CM },
  { id: 'pebble', name: 'きれいな小石', category: 'treasure', r: 1.2 * CM },
  { id: 'button', name: 'ボタン', category: 'treasure', r: 0.9 * CM },
  { id: 'paper', name: 'ちぎった新聞紙', category: 'bedding', r: 3.4 * CM },
  { id: 'tissue', name: 'ティッシュ', category: 'bedding', r: 2.2 * CM },
  { id: 'cloth', name: '布の切れ端', category: 'bedding', r: 3.4 * CM },
  { id: 'hay', name: '牧草', category: 'bedding', r: 5 * CM },
];

export const CATEGORY_NAMES: Record<NestCategory, string> = { treasure: 'たからもの', bedding: 'べっど' };

/** 「出す」で選ぶもの：種類、またはその仲間からランダム */
export type NestPick = NestKindId | 'treasure' | 'bedding';

/** 飼育ケースを開いたときに散らばっている数（指示はなかった。少しだけ） */
const SCATTER: Record<NestCategory, number> = { treasure: 2, bedding: 3 };
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
}

export class NestStuff {
  /** 巣材（体と一緒に震えないよう、シーンに直接置く） */
  readonly object = new THREE.Group();
  /** 次に出すもの */
  kindId: NestPick = 'treasure';
  private readonly items: NestItem[] = [];
  /** 大きさの倍率（飼育ケース 1、ほかのマップ OPEN_SCALE） */
  private scale = OPEN_SCALE;
  private readonly mats = new Map<string, THREE.Material>();
  private readonly outline: THREE.Material;

  constructor(private readonly y: Yukkuri) {
    this.outline = createAccessoryOutlineMaterial(y.outlineMaterial);
  }

  /** 地面にある数（仲間ごと） */
  count(c: NestCategory): number {
    return this.items.filter((i) => i.kind.category === c).length;
  }

  /** 大きさの倍率（飼育ケース 1、ほかのマップ 1/4） */
  get size(): number {
    return this.scale;
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
    it.held = true;
    it.nest = false;
    it.shadow.visible = false;
    this.unsettle(it);
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
        const nz = pz + along * 0.92 + Math.sin(lat * DRAG_WRINKLE[0]) * DRAG_WRINKLE[1] * (1 - k);
        // 寝床に置いた物：上から押されたようにつぶし、下の物の上へ持ち上げる（sk の割合だけ）
        const h = Math.max(floor, yy + (ny - yy) * b);
        p.setXYZ(i, x + (nx - x) * b, sk ? h * (1 - (1 - BED_FLATTEN) * sk) + lift![i] * sk : h, z + (nz - z) * b);
      }
      p.needsUpdate = true;
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
    });
  }

  /** マップを変えたとき：片付けて、飼育ケースなら少し散らばらせる */
  mapChanged(map: MapId): void {
    this.clear();
    this.scale = map === 'cage' ? 1 : OPEN_SCALE;
    if (map !== 'cage') return;
    for (const c of ['treasure', 'bedding'] as const) {
      for (let n = 0; n < SCATTER[c]; n++) this.scatterOne(pickKind(c));
    }
  }

  /** 1 個出す（ゆっくりの前の地面に。種類は kindId）。置ける所がなければ false */
  spawn(): boolean {
    if (this.items.length >= MAX_ITEMS) return false;
    const y = this.y;
    const R = y.shape.radius;
    const kind = this.kindId === 'treasure' || this.kindId === 'bedding' ? pickKind(this.kindId) : NEST_KINDS.find((k) => k.id === this.kindId)!;
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
  }

  /** 飼育ケースのどこか（ゆっくりから離れた所）に 1 個置く */
  private scatterOne(kind: NestKind): void {
    const a = this.y.stage?.area;
    if (!a) return;
    const r = kind.r * this.scale;
    for (let k = 0; k < TRIES; k++) {
      const x = a.minX + Math.random() * (a.maxX - a.minX);
      const z = a.minZ + Math.random() * (a.maxZ - a.minZ);
      if (!this.fits(x, z, r, this.y.shape.radius * 1.8)) continue;
      this.place(kind, x, z);
      return;
    }
  }

  /** 中心（x, z）・半径 r の物を置けるか：行ける範囲の内側、皿・といれ・ほかの巣材に重ならない、体から away m より離れている */
  private fits(x: number, z: number, r: number, away: number): boolean {
    const st = this.y.stage;
    if (st) {
      if (!st.inside(x, z, r + 0.08)) return false;
      if (st.overlapProp(x, z, r + 0.08)) return false;
      if (st.inToilet(x, z, -(r + 0.05))) return false;
    }
    const c = this.y.center;
    if (Math.hypot(x - c.x, z - c.z) < away + r) return false;
    for (const it of this.items) {
      const o = it.object.position;
      if (Math.hypot(x - o.x, z - o.z) < (r + it.kind.r * this.scale) * 1.05) return false;
    }
    return true;
  }

  private place(kind: NestKind, x: number, z: number): void {
    const own: { dispose(): void }[] = [];
    const object = this.build(kind.id, own);
    // 足元の影（地面から浮いて見えず、物として見分けやすいように）。形の広がりに合わせた楕円
    const box = new THREE.Box3().setFromObject(object);
    const shadow = createBlobShadow();
    shadow.material.uniforms.uOpacity.value = SHADOW_OPACITY;
    shadow.scale.set((box.max.x - box.min.x) * SHADOW_SPREAD, 1, (box.max.z - box.min.z) * SHADOW_SPREAD);
    shadow.position.set((box.max.x + box.min.x) / 2, 0.002, (box.max.z + box.min.z) / 2);
    own.push(shadow.geometry, shadow.material);
    object.add(shadow);
    object.scale.setScalar(this.scale);
    object.position.set(x, 0, z);
    object.rotation.y = Math.random() * Math.PI * 2;
    this.object.add(object);
    this.items.push({ kind, object, own, shadow, height: box.max.y, nest: false, held: false, settled: 0 });
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

  /** 形を作る（m、飼育ケースの縮尺。底が y = 0、上から見た中心が原点） */
  private build(id: NestKindId, own: { dispose(): void }[]): THREE.Group {
    const g = new THREE.Group();
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, outline = true) => {
      own.push(geo);
      const o = withOutline(geo, m, outline ? this.outline : null);
      g.add(o);
      return o;
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
    }
    return g;
  }

  dispose(): void {
    this.clear();
    for (const m of this.mats.values()) m.dispose();
    this.outline.dispose();
  }
}

/** 仲間からランダムに 1 種類 */
function pickKind(c: NestCategory): NestKind {
  const ks = NEST_KINDS.filter((k) => k.category === c);
  return ks[Math.floor(Math.random() * ks.length)];
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
  geo.computeVertexNormals();
  const n = geo.getAttribute('normal') as THREE.BufferAttribute;
  const L = new THREE.Vector3(0.4, 1, 0.3).normalize();
  const lo = style === 'tissue' ? 0.72 : 0.6;
  // 暗い所の色：ティッシュは白なので青みの灰色に寄せる（灰色のままだと汚れて見える）
  const dark = style === 'tissue' ? [0.74, 0.77, 0.88] : [lo, lo, lo];
  const col = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) {
    const t = THREE.MathUtils.smoothstep(n.getX(i) * L.x + n.getY(i) * L.y + n.getZ(i) * L.z, 0.25, 1);
    for (let k = 0; k < 3; k++) col[i * 3 + k] = dark[k] + (1 - dark[k]) * t;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
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
