import * as THREE from 'three';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import { createAccessoryOutlineMaterial } from '../render/outlineMaterial';
import { ellipsoid, withOutline } from '../character/shapes';
import type { ToonColors } from '../render/toonMaterial';
import { bodyExtent, bodyFacing, type Word } from './fx';
import { BraidPick, braidSide, smooth } from './braidPick';
import { HatStash } from './hatStash';
import { loadJSON, saveJSON } from '../platform/storage';
import { findFood, type FoodKind } from './foods';
import { HOLLOW_DARKEN } from './nestStuff';
import type { MapId } from '../world/Stage';
import type { Yukkuri } from './Yukkuri';

/**
 * 餌集め：小さな餌（木の実・草・虫）をボタンで 1 個ずつ地面に出し、「拾う」で一番近いものを三つ編みで拾って（枝と同じ動き）、
 * 帽子のつばの前へ「ぽいっ」と放ってひと固まりに積み上げる。
 *   落ちる：叩かれた・倒れた・寝転がった・帽子を隠したら、つばの上の餌は全部転がり落ちて地面に散らばる（また拾える）
 *   満杯（CAPACITY 個）なら拾わない。枝を持っている間は三つ編みがふさがっているので拾わない
 * 帽子にしまう（ボタン）：帽子を三つ編みで脱いで地面に逆さに置き（ひっくり返すときつばの餌は転がり落ちる）、
 *   落ちた餌を 1 個ずつ拾って中へ放り込み、かぶり直す（hatStash.ts）。中の餌は見えず、数（STASH_MAX 個まで）だけ覚える。
 *   つばの餌と同じきっかけで、中の餌もこぼれる
 * 拾い方（pickMode。保存する）：
 *   'brim' … 拾ってつばの上に積む（上のとおり）
 *   'hat'  … 帽子に直接入れる：拾うとき帽子をかぶっていれば、先に脱いで地面に逆さに置く（つばの餌は落として先に入れる）。
 *            押すたびに 1 個、一番近い地面の餌を拾い、持ったまま帽子のそばへ戻って放り込む。地面の餌がなくなったら
 *            （または中がいっぱいになったら）かぶり直す
 */
/** held：巣作り（nestBuild.ts）が三つ編みで運んでいる（位置は運ぶ側が決める） */
type ItemState = 'ground' | 'picking' | 'lift' | 'carry' | 'toss' | 'hat' | 'falling' | 'tossIn' | 'inHat' | 'held';
export type PickMode = 'brim' | 'hat';

interface Item {
  kind: FoodKind;
  object: THREE.Group;
  state: ItemState;
  /** つばの上の置き場の番号（帽子に乗っている・放っている間） */
  slot: number;
  /** 地面・つばの上での向き（上向きまわりの回転） */
  yaw: number;
  t: number;
  readonly from: THREE.Vector3;
  readonly vel: THREE.Vector3;
  readonly spin: THREE.Vector3;
  /** 帽子にしまう途中（つばから落とした餌。拾って中へ入れる） */
  stash: boolean;
  /** 置いてある所の高さ（m。地面は 0、餌皿の中は皿の底） */
  base: number;
  /** 巣作りでおうちの横に並べた餌（拾う・帽子に入れる対象から外す） */
  nest: boolean;
  /** うろの中で暗がりに沈めている（材質を沈めた写しに差し替えている） */
  dark: boolean;
  /** 生えている（草・きのこ・お花。地面から立った姿。三つ編みで摘むと、横倒しの摘んだ姿になる） */
  rooted: boolean;
}

/** 巣作りが運ぶ地面の餌の持ち手 */
export interface FoodRef {
  readonly object: THREE.Group;
  /** 地面で占める広さ（上から見た半径。m） */
  readonly r: number;
  /** 片付けられた・ほかで拾われた（もう運べない） */
  gone(): boolean;
  /** 持ち上げる（これから運ぶ。位置は運ぶ側が決める） */
  hold(): void;
  /** （x, z）の地面に置く。nest なら巣に並べた餌として */
  put(x: number, z: number, nest: boolean): void;
}

/** 餌の大きさ（胴の半径に対する比。形は単位の大きさで作る） */
const SIZE = 0.24;
/**
 * つばの前にひと固まりに積む（指示）：山の中心はつばの前（円錐の根元からつばの縁までの PILE_R の所）。
 * 置き場は [横, 前後, 高さ]（餌の大きさが単位。横は帽子の左が +、前後は外が +）。下の段から順に埋める：下 4・中 3・上 1
 */
const PILE_R = 0.5;
const PILE: [number, number, number][] = [
  [-0.45, -0.3, 0], [0.45, -0.3, 0], [-0.45, 0.42, 0], [0.45, 0.42, 0],
  [-0.25, -0.05, 0.78], [0.25, -0.05, 0.78], [0, 0.4, 0.75],
  [0, 0.12, 1.5],
];
const CAPACITY = PILE.length;
const STORAGE_KEY = 'forage';
/** 帽子に直接入れる：持って戻るとき、帽子のつばの縁からこの距離（胴の半径に対する比）の所に止まる。あきらめるまでの時間（秒） */
const CARRY_GAP = 0.9;
const CARRY_GIVE_UP = 20;
/** 帽子に直接入れる：帽子の中心からつばの縁＋この距離（胴の半径に対する比）より近ければ歩かずに放り込む。
 * 行き先からこの距離（同）まで来たら着いたことにする */
const CARRY_NEAR = 1.6;
const ARRIVE = 0.9;
/** 帽子の中にしまえる数 */
export const STASH_MAX = 16;
/** 出す所：体の前へ（胴の半径に対する比。この間でばらつかせる）と、横へのばらつき */
const SPAWN_AHEAD = [2.2, 3.2];
const SPAWN_SIDE = 1.2;
/** 地面に出しておける数 */
const MAX_GROUND = 24;
/** 餌皿に出すとき、置く所を試す数 */
const DISH_TRIES = 12;
/** 放る時間（秒）と、放物線の高さ（胴の半径に対する比） */
const TOSS_TIME = 0.45;
const TOSS_ARC = 0.9;
/** 落ちる：重力（m/s²）と、帽子から外へ・上へ飛ばす速さ（m/s） */
const GRAVITY = 10;
const SPILL_OUT = 0.9;
const SPILL_UP = 1.4;
/** 帽子にしまう：つばの餌を落とす弧（体の前から三つ編みの側への角度 rad。体の中心からの距離は胴の半径に対する比）と、落ちるまでの時間（秒） */
const DROP_FROM = -0.15;
const DROP_TO = 0.8;
const DROP_R = 1.45;
const DROP_CLEAR = 0.4;
const DROP_TIME = 0.55;
/** 体がこれ（rad）より傾いたら落とす */
const SPILL_TILT = 0.9;

const ACORN = { lit: '#b9824a', shade: '#8d5a2c', deep: '#5c3616', rim: '#f0d3b0' };
/** おまんじゅう（「ごはん」と同じ色） */
const MANJU = { lit: '#f3d2a2', shade: '#d9a96e', deep: '#a8723f', rim: '#fff3dc' };
const ACORN_CAP = { lit: '#8a6a44', shade: '#634a2c', deep: '#3e2c18', rim: '#d8c3a6' };
const GRASS = { lit: '#9bd06a', shade: '#6aa043', deep: '#41712a', rim: '#eaf8d0' };
const BUG = { lit: '#5a8a5a', shade: '#2f5a3c', deep: '#173024', rim: '#c9f0d8' };
const BUG_LEG = { lit: '#3a3a30', shade: '#24241e', deep: '#121210', rim: '#88887a' };
/**
 * 食べられるきのこ（傘はこげ茶に白い縁。森の飾りの赤いきのこ・薄茶のきのこと見分けられるよう、色を変える）と、
 * たんぽぽ（黄色い花・緑の茎と葉）
 */
const MUSH_CAP = { lit: '#8f5b32', shade: '#6e4224', deep: '#4b2b16', rim: '#f0d6bc' };
const MUSH_STEM = { lit: '#f3ead8', shade: '#ddd0b6', deep: '#bcae90', rim: '#ffffff' };
const MUSH_GILL = { lit: '#d8c4a2', shade: '#bca684', deep: '#988361', rim: '#fff6e6' };
const PETAL = { lit: '#ffd83a', shade: '#f2b81c', deep: '#c98d10', rim: '#fff6c4' };
const STEM = { lit: '#7fb84f', shade: '#5f9638', deep: '#447026', rim: '#e3f6c9' };
/**
 * 自然の中の餌（マップを開いたときに置く。指示：マップごとに合う種類と場所）。森は Stage.foodSpots（森が決める）、
 * 平地は広場の真ん中のまわりに、草のかたまり・たんぽぽ・虫を散らす。飼育ケースは自然ではないので置かない（餌皿に飼い主が出す）
 */
const OPEN_FOOD: { kind: string; n: number; per: number }[] = [
  { kind: 'grass', n: 3, per: 2 },
  { kind: 'flower', n: 3, per: 1 },
  { kind: 'bug', n: 2, per: 1 },
];
/** 平地で自然の餌を置く範囲（原点からの距離 m）と、ゆっくりから離す距離 */
const OPEN_FOOD_R = [2.2, 6.5];
const WILD_AWAY = 1.2;
/**
 * 自然の中の餌の補充（指示）：実時間 3 分ごと、または地面の自然の餌がなくなったときに、1 個ずつ置き直す。
 * 置くのはカメラに映っていない所だけ。数はマップを開いたときに置いた数まで。置けなければ WILD_RETRY ミリ秒おきに試す
 */
const WILD_REFILL = 180_000;
const WILD_RETRY = 1_000;

export class Forage {
  /** 餌（体と一緒に震えないよう、シーンに直接置く） */
  readonly object = new THREE.Group();
  /** 次に出す餌の種類（'random' でランダム） */
  kindId: 'random' | 'acorn' | 'grass' | 'bug' | 'mushroom' | 'flower' | 'manju' = 'random';
  private readonly items: Item[] = [];
  private readonly picker: BraidPick;
  private readonly stash: HatStash;
  /** 帽子を外すだけ（デバッグ用）：置いたまま、もう一度押されるまで待つ */
  private hatOffOnly = false;
  private mode: PickMode = 'brim';
  /** 帽子に直接入れている途中（帽子を地面に置いてから、かぶり直すまで） */
  private direct = false;
  /** 帽子に直接入れる：まだ拾いに行っていない「拾う」の回数 */
  private pending = 0;
  /** 帽子に直接入れる：持って帽子のそばへ戻っている餌と、その経過時間 */
  private carrying: Item | null = null;
  private carryT = 0;
  private readonly carryStop = new THREE.Vector3();
  private word: Word | null = null;
  /** 自然の中の餌：今のマップ・種類ごとに置いた数（補充はここまで）・前に補充した時刻と、最後に試した時刻（performance.now） */
  private wildMap: MapId | null = null;
  private readonly wildQuota = new Map<string, number>();
  private wildClock = 0;
  private wildTried = 0;
  private readonly mats: Record<string, THREE.Material> = {};
  /** 材質の、うろの中で沈めた写し（使うときに作る） */
  private readonly darkMats = new Map<THREE.Material, THREE.Material>();
  private readonly outline: THREE.Material;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly _p = new THREE.Vector3();
  private readonly _u = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();
  private readonly _f = new THREE.Vector3();

  constructor(private readonly y: Yukkuri) {
    this.mode = loadJSON<{ pickMode?: PickMode }>(STORAGE_KEY)?.pickMode === 'hat' ? 'hat' : 'brim';
    this.picker = new BraidPick(y);
    this.stash = new HatStash(y);
    const mat = (name: string, c: ToonColors, doubleSide = false) => {
      this.mats[name] = createAccessoryMaterial(y.bodyMaterial, c, { rim: 0.25, doubleSide });
    };
    mat('acorn', ACORN);
    mat('cap', ACORN_CAP);
    mat('grass', GRASS, true);
    mat('bug', BUG);
    mat('leg', BUG_LEG);
    mat('manju', MANJU);
    mat('mushCap', MUSH_CAP);
    mat('mushStem', MUSH_STEM);
    mat('gill', MUSH_GILL, true);
    mat('petal', PETAL, true);
    mat('stem', STEM, true);
    this.outline = createAccessoryOutlineMaterial(y.outlineMaterial);
  }

  /** つばの上に乗っている数 */
  get onHat(): number {
    return this.items.filter((i) => i.state === 'hat' || i.state === 'toss').length;
  }

  /** 拾い方（つばに乗せる／帽子に直接入れる。保存する） */
  get pickMode(): PickMode {
    return this.mode;
  }

  set pickMode(m: PickMode) {
    this.mode = m;
    saveJSON(STORAGE_KEY, { pickMode: m });
  }

  /** 帽子の中にしまってある数 */
  get inHat(): number {
    return this.items.filter((i) => i.state === 'inHat' || i.state === 'tossIn' || i.state === 'carry').length;
  }

  /** 地面にある数 */
  get onGround(): number {
    return this.items.filter((i) => i.state === 'ground' && !i.nest).length;
  }

  /** 拾っている途中か（三つ編みと身ぶりを使っている） */
  get busy(): boolean {
    return this.picker.active || this.stash.active;
  }

  /** 餌を 1 個出す（ゆっくりの前の地面に。餌皿のあるマップ（飼育ケース）なら餌皿の中に。種類は kindId） */
  spawn(): void {
    if (this.onGround >= MAX_GROUND) return;
    const y = this.y;
    const R = y.shape.radius;
    const ids = ['acorn', 'grass', 'bug'] as const;
    const kind = findFood(this.kindId === 'random' ? ids[Math.floor(Math.random() * ids.length)] : this.kindId);
    const f = bodyFacing(y);
    const side = new THREE.Vector3(f.z, 0, -f.x);
    const ahead = SPAWN_AHEAD[0] + Math.random() * (SPAWN_AHEAD[1] - SPAWN_AHEAD[0]);
    const p = y.center.clone().addScaledVector(f, R * ahead).addScaledVector(side, R * SPAWN_SIDE * (Math.random() * 2 - 1));
    // ケースの壁の外へは出さない
    y.stage?.limit(p, R * 0.4);
    // 餌皿があれば皿の中（平らな底の上。置く輪は Cage.foodDish）
    const dish = y.stage?.foodDish;
    let base = 0;
    if (dish) {
      // 何か所か試して、すでに置いてある餌から一番離れた所に（重なってめり込まないように）
      let best = -1;
      for (let k = 0; k < DISH_TRIES; k++) {
        const a = Math.random() * Math.PI * 2;
        const r = dish.ring[0] + Math.random() * (dish.ring[1] - dish.ring[0]);
        const x = dish.x + Math.sin(a) * r, z = dish.z + Math.cos(a) * r;
        let near = Infinity;
        for (const it of this.items) if (it.state === 'ground') near = Math.min(near, Math.hypot(it.object.position.x - x, it.object.position.z - z));
        if (near > best) {
          best = near;
          p.set(x, 0, z);
          base = dish.floorAt(r);
        }
      }
    }
    this.add(kind.id, p.x, p.z, base, false);
  }

  /** 餌を 1 個作って（x, z）の地面に置く（rooted なら生えている姿） */
  private add(id: string, x: number, z: number, base: number, rooted: boolean): void {
    const object = this.makeItem(id);
    object.scale.setScalar(this.y.shape.radius * SIZE);
    this.object.add(object);
    const item: Item = {
      kind: findFood(id), object, state: 'ground', slot: -1, yaw: Math.random() * Math.PI * 2, t: 0,
      from: new THREE.Vector3(), vel: new THREE.Vector3(), spin: new THREE.Vector3(), stash: false, base: 0, nest: false, dark: false, rooted,
    };
    this.setRosette(item);
    this.items.push(item);
    this.placeOnGround(item, x, z, base);
  }

  /** 生えている餌を摘む：横倒しの摘んだ姿にする（たんぽぽの根元の葉は地面に残すので消す） */
  private unroot(it: Item): void {
    it.rooted = false;
    this.setRosette(it);
    it.object.quaternion.copy(this.groundQuat(it));
  }

  /** たんぽぽの根元の葉（地面に広がる葉）は、生えている間だけ見せる */
  private setRosette(it: Item): void {
    const r = it.object.getObjectByName('rosette');
    if (r) r.visible = it.rooted;
  }

  /**
   * 自然の中の餌を置く（マップを開いたとき）。生える物（草・きのこ・お花）は生えている姿で。置く所は、行ける範囲の内側で、
   * 物（木・岩・皿）・壁・といれ・根・うろのまわり・ほかの餌に重ならず、ゆっくりから少し離れた所。草は草むらの脇なので草むらは気にしない
   */
  private stockWild(map: MapId): void {
    this.wildMap = map;
    this.wildQuota.clear();
    this.wildClock = performance.now();
    const st = this.y.stage;
    if (!st || map === 'cage') return;
    if (map === 'forest') {
      for (const f of st.foodSpots) this.wildAround(f.kind, f.x, f.z, f.near, f.far, f.n, false);
    } else {
      // 平地：原点のまわりに、まとまり（草は 2 本ずつ寄せて）を散らす
      for (const f of OPEN_FOOD) for (let i = 0; i < f.n; i++) this.wildAround(f.kind, ...this.openSpot(), 0, f.per > 1 ? 0.25 : 0.01, f.per, false);
    }
    for (const it of this.items) {
      if (it.state === 'ground' && !it.nest) this.wildQuota.set(it.kind.id, (this.wildQuota.get(it.kind.id) ?? 0) + 1);
    }
  }

  /** 平地で自然の餌のまとまりを置く点（原点のまわり OPEN_FOOD_R） */
  private openSpot(): [number, number] {
    const a = Math.random() * Math.PI * 2, d = OPEN_FOOD_R[0] + Math.random() * (OPEN_FOOD_R[1] - OPEN_FOOD_R[0]);
    return [Math.sin(a) * d, Math.cos(a) * d];
  }

  /**
   * 自然の中の餌を、点（x, z）のまわり near〜far m の所に n 個置く（置けた数）。生える物（草・きのこ・お花）は生えている姿で。
   * 置く所は、行ける範囲の内側で、物（木・岩・皿）・壁・といれ・根・うろのまわり・ほかの餌に重ならず、ゆっくりから少し離れた所。
   * 草は草むらの脇なので草むらは気にしない。hidden ならカメラに映っていない所だけ（補充のとき）
   */
  private wildAround(id: string, x: number, z: number, near: number, far: number, n: number, hidden: boolean): number {
    const st = this.y.stage;
    if (!st) return 0;
    const s = this.y.shape.radius * SIZE;
    const growing = id === 'grass' || id === 'mushroom' || id === 'flower';
    const fits = (x: number, z: number) => {
      const r = s * 0.8;
      if (!st.inside(x, z, r + 0.1) || st.overlapProp(x, z, r) || st.blocked(x, z, r) || st.inToilet(x, z, -r)) return false;
      if (st.onRoot(x, z, r) || st.nearCave(x, z) || (id !== 'grass' && st.inCover(x, z, r))) return false;
      if (Math.hypot(x - this.y.center.x, z - this.y.center.z) < WILD_AWAY) return false;
      if (hidden && st.seen(x, z, s * 1.5)) return false;
      return this.items.every((i) => Math.hypot(i.object.position.x - x, i.object.position.z - z) > s * 2.2);
    };
    let placed = 0;
    for (let k = 0; k < 60 && placed < n; k++) {
      const a = Math.random() * Math.PI * 2, d = near + Math.random() * (far - near);
      const px = x + Math.sin(a) * d, pz = z + Math.cos(a) * d;
      if (!fits(px, pz)) continue;
      this.add(id, px, pz, 0, growing);
      placed++;
    }
    return placed;
  }

  /**
   * 自然の中の餌の補充（update から）：実時間 WILD_REFILL ごと、または地面の自然の餌がなくなったら、足りない種類を 1 個、
   * カメラに映っていない所に置く。マップを開いたときの数まで（減っていなければ時計を戻すだけ）
   */
  private refillWild(): void {
    const st = this.y.stage;
    if (!st || this.wildMap !== st.map || this.wildQuota.size === 0) return;
    const now = performance.now();
    const left = new Map<string, number>();
    let total = 0;
    for (const it of this.items) {
      if (it.nest || (it.state !== 'ground' && it.state !== 'picking')) continue;
      left.set(it.kind.id, (left.get(it.kind.id) ?? 0) + 1);
      total++;
    }
    // 足りない種類（置いた数より少ないもの。足りない数で重みをつけて選ぶ）
    const short: [string, number][] = [];
    let sum = 0;
    for (const [id, q] of this.wildQuota) {
      const d = q - (left.get(id) ?? 0);
      if (d > 0) {
        short.push([id, d]);
        sum += d;
      }
    }
    if (sum === 0) {
      this.wildClock = now;
      return;
    }
    if (total > 0 && now - this.wildClock < WILD_REFILL) return;
    if (now - this.wildTried < WILD_RETRY) return;
    this.wildTried = now;
    let pick = Math.random() * sum;
    let id = short[0][0];
    for (const [k, d] of short) {
      if ((pick -= d) < 0) {
        id = k;
        break;
      }
    }
    // その種類の置き場所（森は森が決めた所のどれか、平地は原点のまわりのどこか）
    let ok = false;
    if (this.wildMap === 'forest') {
      const spots = st.foodSpots.filter((f) => f.kind === id);
      for (let k = 0; k < spots.length * 2 && !ok; k++) {
        const f = spots[Math.floor(Math.random() * spots.length)];
        ok = this.wildAround(id, f.x, f.z, f.near, f.far, 1, true) > 0;
      }
    } else {
      for (let k = 0; k < 6 && !ok; k++) ok = this.wildAround(id, ...this.openSpot(), 0, 0.25, 1, true) > 0;
    }
    if (ok) this.wildClock = now;
  }

  /** 一番近い地面の餌を拾いに行く（拾い方が「帽子に直接入れる」なら pickIntoHat） */
  pickNearest(): boolean {
    if (this.y.nestBuild.active) return false;
    if (this.mode === 'hat') return this.pickIntoHat();
    const y = this.y;
    if (this.picker.active || this.stash.active) return false;
    if (y.branch.holding || y.branch.busy) {
      this.say(y.line('forageBusy'), 0.2, 1.6);
      return false;
    }
    if (this.onHat >= CAPACITY) {
      this.say(y.line('forageFull'), 0.2, 1.6);
      return false;
    }
    if (!y.outfit.hat) return false;
    let best: Item | null = null;
    let bd = Infinity;
    for (const it of this.items) {
      if (it.state !== 'ground' || it.nest) continue;
      const d = it.object.position.distanceTo(y.center);
      if (d < bd) {
        bd = d;
        best = it;
      }
    }
    if (!best) return false;
    const item = best;
    const ok = this.picker.start({
      grabPoint: () => item.object.position.clone(),
      onLower: () => this.say(y.line('forageLower'), 0.18, 1.0),
      onLift: () => {
        item.state = 'lift';
      },
      onDone: () => this.toss(item),
      onCancel: () => {
        if (item.state === 'picking' || item.state === 'lift') this.dropToGround(item);
      },
    });
    if (!ok) return false;
    item.state = 'picking';
    this.say(y.line('forageGo'), 0.2, 1.4);
    return true;
  }

  /**
   * つばの上の餌と帽子の中の餌を全部落とす（地面に散らばる）。帽子にしまう途中なら、やめて帽子を頭へ戻す
   * （地面に置いた帽子の中身はそのまま）
   */
  spill(say = true): void {
    if (this.stash.active) {
      this.stash.cancel();
      return;
    }
    let n = 0;
    const y = this.y;
    const hat = y.outfit.hat;
    const up = hat ? hat.upVector(this._u).clone() : new THREE.Vector3(0, 1, 0);
    // 中の餌は帽子の口（つばの根元）のあたりから出す
    const mouth = hat ? new THREE.Vector3().setFromMatrixPosition(hat.object.matrix)
      : new THREE.Vector3(y.center.x, y.center.y + y.height * 0.4, y.center.z);
    for (const it of this.items) {
      if (it.state === 'inHat') {
        it.object.visible = true;
        it.object.position.copy(mouth)
          .add(new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).multiplyScalar(y.shape.radius * 0.6));
      } else if (it.state !== 'hat' && it.state !== 'toss') continue;
      n++;
      // 帽子の中心から外へ・上へ飛ばす
      const out = it.object.position.clone().sub(y.center).setY(0);
      if (out.lengthSq() < 1e-6) out.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      out.normalize();
      it.state = 'falling';
      it.slot = -1;
      it.vel.copy(out).multiplyScalar(SPILL_OUT * (0.6 + Math.random() * 0.8)).addScaledVector(up, SPILL_UP * (0.5 + Math.random() * 0.6));
      it.spin.set(Math.random() * 10 - 5, Math.random() * 10 - 5, Math.random() * 10 - 5);
    }
    if (n > 0 && say) this.say(y.line('forageSpill'), 0.22, 1.8);
  }

  /**
   * 餌皿の中にある餌（地面に置いた状態で、皿の中にあるもの）のうち、点 near に一番近いもの。なければ null。
   * 食べる側（DishEat）が使う：pos は餌の位置（動かさないこと）、eaten() で食べ終えた餌を消す
   */
  dishItem(near: THREE.Vector3): { pos: THREE.Vector3; kind: FoodKind; eaten: () => void; gone: () => boolean } | null {
    const dish = this.y.stage?.foodDish;
    if (!dish) return null;
    let best: Item | null = null;
    let bestD = Infinity;
    for (const it of this.items) {
      if (it.state !== 'ground' || it.base <= 0) continue;
      const p = it.object.position;
      if (Math.hypot(p.x - dish.x, p.z - dish.z) > dish.r) continue;
      const d = Math.hypot(p.x - near.x, p.z - near.z);
      if (d < bestD) {
        bestD = d;
        best = it;
      }
    }
    if (!best) return null;
    const it = best;
    return {
      pos: it.object.position,
      kind: it.kind,
      eaten: () => {
        const i = this.items.indexOf(it);
        if (i >= 0) this.items.splice(i, 1);
        this.object.remove(it.object);
      },
      // 拾われた・片付けられた（地面にない）
      gone: () => !this.items.includes(it) || it.state !== 'ground',
    };
  }

  /** 巣作りが運ぶ地面の餌（inNest：巣に並べ終えたものか、まだのものか） */
  nestFoods(inNest: boolean): FoodRef[] {
    return this.items.filter((it) => it.state === 'ground' && it.nest === inNest).map((it) => ({
      object: it.object,
      r: this.y.shape.radius * SIZE * 0.6,
      gone: () => !this.items.includes(it),
      hold: () => {
        it.state = 'held';
        it.base = 0;
      },
      put: (x: number, z: number, nest: boolean) => {
        it.nest = nest;
        this.placeOnGround(it, x, z);
      },
    }));
  }

  /** 巣に並べた印を全部外す（おうちを移したとき：次の巣作りで新しいおうちへ運び直す） */
  forgetNest(): void {
    for (const it of this.items) it.nest = false;
  }

  /** 片付ける（拾う途中ならやめる） */
  clear(): void {
    this.picker.cancel();
    this.stash.cancel();
    for (const it of this.items) this.object.remove(it.object);
    this.items.length = 0;
  }

  /**
   * マップを変えたとき：地面の餌（巣に並べた餌も）を片付ける。帽子のつば・中の餌はそのまま
   * （前のマップの場所に残り、森の巣の餌が飼育ケースの外に出て、次の巣作りで届かずにあきらめていた）
   */
  mapChanged(map: MapId): void {
    this.picker.cancel();
    for (const it of this.items.filter((i) => i.state === 'ground' || i.state === 'falling')) {
      this.object.remove(it.object);
      this.items.splice(this.items.indexOf(it), 1);
    }
    // 自然の中の餌を置く（森・平地）
    this.stockWild(map);
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    const y = this.y;
    this.stash.update(dt);
    this.picker.update(dt);
    this.refillWild();
    if (this.carrying) {
      // 持って帽子のそばへ戻っている：着いたら放り込む（ほかの行き先を指示されても、あきらめても、その場から放る）
      this.carryT += dt;
      const loco = y.locomotion;
      // 行き先のそばまで来たら着いたことにする（行き先ぴったりを狙うと、その周りを回り続けることがある）
      const near = Math.hypot(this.carryStop.x - y.center.x, this.carryStop.z - y.center.z) < y.shape.radius * ARRIVE;
      if (near && loco.hasTarget) loco.stop();
      if ((!loco.hasTarget && loco.idle) || this.carryT > CARRY_GIVE_UP) this.tossCarried();
    } else if (this.stash.down && !this.picker.active && !this.hatOffOnly) {
      if (this.direct) this.directNext();
      else this.fillNext();
    }
    // 倒れた・寝転がった・大きく傾いた・帽子を隠したら、つばの上と帽子の中の餌は落ちる（しまう途中は傾けるので見ない）
    if ((this.onHat > 0 || this.inHat > 0) && !this.stash.active) {
      const tilt = new THREE.Vector3(0, 1, 0).applyQuaternion(y.body.rotation).angleTo(new THREE.Vector3(0, 1, 0));
      if (!y.outfit.hat || y.locomotion.isLying || y.locomotion.tilted || tilt > SPILL_TILT) this.spill();
    }
    for (const it of this.items) {
      // 生えている餌は、三つ編みで持ち上げた（拾われて地面を離れた）ら摘んだ姿に
      if (it.rooted && it.state !== 'ground' && it.state !== 'picking') this.unroot(it);
      this.shade(it);
      it.t += dt;
      if (it.state === 'toss' && it.t >= TOSS_TIME) {
        it.state = 'hat';
        this.say(y.line('forageOnHat'), 0.2, 1.4);
      }
      if (it.state === 'tossIn' && it.t >= TOSS_TIME) {
        it.state = 'inHat';
        it.object.visible = false;
      }
      if (it.state === 'falling') {
        it.vel.y -= GRAVITY * dt;
        it.object.position.addScaledVector(it.vel, dt);
        it.object.rotation.x += it.spin.x * dt;
        it.object.rotation.y += it.spin.y * dt;
        it.object.rotation.z += it.spin.z * dt;
        if (it.object.position.y <= this.groundY(it) && it.vel.y < 0) this.placeOnGround(it, it.object.position.x, it.object.position.z);
      }
    }
  }

  /**
   * 森の大木のうろの中の餌は暗がりに沈める（巣作りでうろの中へ運んだ餌が、暗い床で明るく浮いた）。地面の餌は置いた所、
   * 運んでいる餌は運んでいるゆっくりが中にいるかで決め、材質を沈めた写しと差し替える
   */
  private shade(it: Item): void {
    const st = this.y.stage;
    const p = it.object.position, c = this.y.center;
    const dark = it.state === 'ground' ? !!st?.inHollow(p.x, p.z) : it.state === 'held' && !!st?.inCave(c.x, c.z);
    if (dark === it.dark) return;
    it.dark = dark;
    it.object.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      if (dark) {
        const light = o.material as THREE.Material;
        if (!Object.values(this.mats).includes(light)) return;
        let m = this.darkMats.get(light);
        if (!m) {
          // 写しは光の向きなど体と共有する値もそのまま共有する（clone は値を複製してしまう）。沈める量だけ自分のもの
          const lu = (light as THREE.ShaderMaterial).uniforms;
          m = (light as THREE.ShaderMaterial).clone();
          const u = (m as THREE.ShaderMaterial).uniforms;
          for (const k of Object.keys(lu)) if (k !== 'uDarken') u[k] = lu[k];
          u.uDarken.value = HOLLOW_DARKEN;
          this.darkMats.set(light, m);
        }
        o.material = m;
      } else {
        for (const [light, m] of this.darkMats) if (o.material === m) o.material = light;
      }
    });
  }

  /** 描画の直前に呼ぶ（帽子と三つ編みの位置が決まった後）：拾っている餌は毛先に、つばの上の餌は置き場に付ける */
  sync(): void {
    const y = this.y;
    const hat = y.outfit.hat;
    for (const it of this.items) {
      if (it.state === 'tossIn') {
        // 放物線：毛先から地面に置いた帽子の口へ
        const to = this.stash.mouth(this._p);
        const k = smooth(it.t / TOSS_TIME);
        const p = it.from.clone().lerp(to, k);
        p.y += Math.sin(Math.PI * Math.min(1, it.t / TOSS_TIME)) * y.shape.radius * TOSS_ARC;
        it.object.position.copy(p);
      } else if (it.state === 'lift' || it.state === 'carry') {
        const g = y.outfit.braid?.grip;
        if (g?.ready) it.object.position.copy(g.pos).addScaledVector(g.down, y.shape.radius * SIZE * 0.4);
      } else if ((it.state === 'hat' || it.state === 'toss') && hat) {
        hat.brimSpot(0, PILE_R, this._p, this._u);
        hat.axes(this._s, this._u, this._f);
        const s = y.shape.radius * SIZE;
        const [dx, dz, dh] = PILE[it.slot % PILE.length];
        const to = this._p.clone().addScaledVector(this._s, dx * s).addScaledVector(this._f, dz * s)
          .addScaledVector(this._u, (this.restLift(it.kind.id) + dh) * s);
        const q = this.uprightQuat(it, this._u);
        if (it.state === 'toss') {
          // 放物線：毛先から置き場へ、上へふくらませて
          const k = smooth(it.t / TOSS_TIME);
          const p = it.from.clone().lerp(to, k);
          p.y += Math.sin(Math.PI * Math.min(1, it.t / TOSS_TIME)) * y.shape.radius * TOSS_ARC;
          it.object.position.copy(p);
          it.object.quaternion.slerp(q, Math.min(1, k * 1.5));
        } else {
          it.object.position.copy(to);
          it.object.quaternion.copy(q);
        }
      }
    }
  }

  /**
   * デバッグ用：帽子を脱いで地面に逆さに置くだけ（餌は入れない。つばの餌は転がり落ちて普通の地面の餌になる）。
   * 置いてあるときに呼ぶと、かぶり直す
   */
  toggleHatOff(): boolean {
    if (this.y.nestBuild.active) return false;
    if (this.hatOffOnly && this.stash.down) {
      this.stash.putBack();
      return true;
    }
    const y = this.y;
    if (this.picker.active || this.stash.active || y.branch.holding || y.branch.busy) return false;
    const ok = this.stash.start({
      onTip: () => {
        this.dropPile();
        for (const it of this.items) it.stash = false;
      },
      onDone: () => {
        this.hatOffOnly = false;
      },
      onCancel: () => {
        this.hatOffOnly = false;
      },
    });
    this.hatOffOnly = ok;
    return ok;
  }

  /**
   * 帽子に直接入れる：帽子をかぶっていれば脱いで地面に逆さに置き（つばの餌は落として先に入れる）、一番近い地面の餌を 1 個拾って、
   * 持ったまま帽子のそばへ戻って放り込む。帽子を置いている間に押すと、拾う回数を足す
   */
  private pickIntoHat(): boolean {
    const y = this.y;
    if (this.stash.active && !this.direct) return false; // しまう途中・外すだけ（デバッグ）の途中
    if (y.branch.holding || y.branch.busy) {
      this.say(y.line('forageBusy'), 0.2, 1.6);
      return false;
    }
    if (!y.outfit.hat) return false;
    const waiting = this.items.filter((i) => i.state === 'ground' && !i.stash && !i.nest).length;
    if (waiting <= this.pending) return false;
    if (this.inHat + this.onHat + this.pending >= STASH_MAX) {
      this.say(y.line('stashFull'), 0.2, 1.6);
      return false;
    }
    if (this.direct) {
      this.pending++;
      return true;
    }
    const ok = this.stash.start({
      onTip: () => this.dropPile(),
      onDone: () => {
        this.direct = false;
        this.say(y.line('stashDone'), 0.2, 1.8);
      },
      onCancel: () => this.endDirect(),
    });
    if (!ok) return false;
    this.direct = true;
    this.pending = 1;
    this.say(y.line('forageGo'), 0.2, 1.4);
    return true;
  }

  /** 帽子に直接入れるのをやめた（帽子は頭へ戻る）：拾う途中・持っている餌は地面に落とす */
  private endDirect(): void {
    this.direct = false;
    this.pending = 0;
    this.picker.cancel();
    if (this.carrying) this.dropToGround(this.carrying);
    this.carrying = null;
    for (const it of this.items) it.stash = false;
  }

  /** 帽子に直接入れる：地面に置いた帽子へ次の餌を入れに行く（なければかぶり直す） */
  private directNext(): void {
    const y = this.y;
    if (this.items.some((i) => (i.stash && i.state === 'falling') || i.state === 'tossIn')) return;
    // つばから落とした餌が先（その場で拾って入れる）
    if (this.items.some((i) => i.stash && i.state === 'ground') && this.inHat < STASH_MAX) {
      this.fillNext(false);
      return;
    }
    const ground = this.items.filter((i) => i.state === 'ground' && !i.nest);
    if (ground.length === 0 || this.inHat >= STASH_MAX) {
      if (ground.length > 0) this.say(y.line('stashFull'), 0.2, 1.6);
      this.pending = 0;
      for (const it of this.items) it.stash = false;
      this.stash.putBack();
      return;
    }
    if (this.pending <= 0) return; // 次に「拾う」を押されるまで、帽子は置いたまま待つ
    let item = ground[0];
    for (const it of ground) if (it.object.position.distanceTo(y.center) < item.object.position.distanceTo(y.center)) item = it;
    const target = item;
    const ok = this.picker.start({
      grabPoint: () => target.object.position.clone(),
      onLower: () => this.say(y.line('forageLower'), 0.18, 1.0),
      onLift: () => {
        target.state = 'lift';
      },
      onDone: () => this.carryToHat(target),
      onCancel: () => {
        if (target.state === 'picking' || target.state === 'lift') this.dropToGround(target);
        this.stash.cancel();
      },
    });
    if (!ok) {
      this.stash.cancel();
      return;
    }
    this.pending--;
    target.state = 'picking';
  }

  /** 拾った餌を毛先につけたまま、地面に置いた帽子のそばへ歩いて戻る（着いたら放り込む） */
  private carryToHat(item: Item): void {
    const y = this.y;
    item.state = 'carry';
    this.carrying = item;
    this.carryT = 0;
    const hat = y.outfit.hat!;
    const m = this.stash.placed;
    const hc = new THREE.Vector3().setFromMatrixPosition(m);
    const rim = hat.brimLocal(0, 1, new THREE.Vector3()).setY(0).length() * new THREE.Vector3().setFromMatrixColumn(m, 0).length();
    const away = new THREE.Vector3(y.center.x - hc.x, 0, y.center.z - hc.z);
    if (away.lengthSq() < 1e-6) away.set(1, 0, 0);
    away.normalize();
    const R = y.shape.radius;
    const far = Math.hypot(y.center.x - hc.x, y.center.z - hc.z);
    this.carryStop.copy(hc).addScaledVector(away, rim + R * CARRY_GAP);
    // もう帽子のそばにいれば歩かない（近くの行き先へ歩かせると、その周りを回り続けた）
    if (far > rim + R * CARRY_NEAR) y.locomotion.moveTo(this.carryStop.x, this.carryStop.z);
  }

  /** 帽子のそばに着いた（またはあきらめた）：毛先から帽子の口へ放り込む */
  private tossCarried(): void {
    const item = this.carrying!;
    this.carrying = null;
    item.state = 'tossIn';
    item.t = 0;
    item.from.copy(item.object.position);
    this.say(this.y.line('stashIn'), 0.18, 1.0);
  }

  /** 帽子にしまう：帽子を脱いで地面に逆さに置き、つばの餌を中へ入れて、かぶり直す */
  stashHat(): boolean {
    const y = this.y;
    if (this.picker.active || this.stash.active || !y.outfit.hat || y.nestBuild.active) return false;
    if (y.branch.holding || y.branch.busy) {
      this.say(y.line('forageBusy'), 0.2, 1.6);
      return false;
    }
    if (this.onHat === 0) {
      this.say(y.line('stashNone'), 0.2, 1.6);
      return false;
    }
    if (this.inHat >= STASH_MAX) {
      this.say(y.line('stashFull'), 0.2, 1.6);
      return false;
    }
    const ok = this.stash.start({
      onTip: () => this.dropPile(),
      onDone: () => this.say(y.line('stashDone'), 0.2, 1.8),
      onCancel: () => {
        this.picker.cancel();
        for (const it of this.items) it.stash = false;
      },
    });
    if (ok) this.say(y.line('stashStart'), 0.2, 1.4);
    return ok;
  }

  /**
   * 帽子をひっくり返し始めた：つばの餌を前の地面へ転がり落とす（あとでその場で拾って中へ入れる）。
   * 落ちる所は体の前から三つ編みの側（帽子を置く側）へ寄せた弧の上に並べる（歩かずに届き、置いた帽子にかからない所）
   */
  private dropPile(): void {
    const y = this.y;
    const R = y.shape.radius;
    const f = bodyFacing(y);
    const right = new THREE.Vector3(f.z, 0, -f.x);
    const side = right.multiplyScalar(braidSide(y).dot(right) >= 0 ? 1 : -1);
    const pile = this.items.filter((it) => it.state === 'hat' || it.state === 'toss');
    pile.forEach((it, i) => {
      it.state = 'falling';
      it.slot = -1;
      it.stash = true;
      const a = DROP_FROM + (DROP_TO - DROP_FROM) * (pile.length > 1 ? i / (pile.length - 1) : 0.5);
      const dir = f.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
      // 横に広い体型では体の表面から DROP_CLEAR だけ外（体の下に入ると拾えない）
      const r = Math.max(R * DROP_R, bodyExtent(y, dir) + R * DROP_CLEAR) + R * (Math.random() - 0.5) * 0.15;
      const to = y.center.clone().addScaledVector(dir, r);
      // その所へ DROP_TIME 秒で落ちる速さ
      const p = it.object.position;
      it.vel.set((to.x - p.x) / DROP_TIME, 0, (to.z - p.z) / DROP_TIME);
      it.vel.y = (this.groundY(it) - p.y + 0.5 * GRAVITY * DROP_TIME * DROP_TIME) / DROP_TIME;
      it.spin.set(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4);
    });
  }

  /**
   * 地面に置いた帽子へ、落とした餌を 1 個ずつ入れる（なくなるか、いっぱいになったら、かぶり直しに行く）。
   * finish が false なら、なくなってもかぶり直さない（帽子に直接入れる途中で、つばの餌を先に入れるとき）
   */
  private fillNext(finish = true): void {
    const y = this.y;
    if (this.items.some((i) => i.stash && i.state === 'falling')) return; // 落ちきるまで待つ
    if (this.items.some((i) => i.state === 'tossIn')) return; // 入れ終わるまで待つ
    const rest = this.items.filter((i) => i.stash && i.state === 'ground');
    if (!finish && rest.length === 0) return;
    if (rest.length === 0 || this.inHat >= STASH_MAX) {
      if (rest.length > 0) this.say(y.line('stashFull'), 0.2, 1.6);
      for (const it of this.items) it.stash = false;
      this.stash.putBack();
      return;
    }
    let best = rest[0];
    for (const it of rest) if (it.object.position.distanceTo(y.center) < best.object.position.distanceTo(y.center)) best = it;
    const item = best;
    const ok = this.picker.start({
      grabPoint: () => item.object.position.clone(),
      onLift: () => {
        item.state = 'lift';
      },
      onDone: () => {
        item.state = 'tossIn';
        item.stash = false;
        item.t = 0;
        item.from.copy(item.object.position);
        this.say(y.line('stashIn'), 0.18, 1.0);
      },
      onCancel: () => {
        if (item.state === 'picking' || item.state === 'lift') this.dropToGround(item);
        this.stash.cancel();
      },
    }, true);
    if (ok) item.state = 'picking';
    else this.stash.cancel();
  }

  /** 毛先から帽子のつばの空いている置き場へ放る */
  private toss(item: Item): void {
    const used = new Set(this.items.filter((i) => i !== item && (i.state === 'hat' || i.state === 'toss')).map((i) => i.slot));
    let slot = 0;
    while (used.has(slot) && slot < CAPACITY) slot++;
    item.slot = slot;
    item.state = 'toss';
    item.t = 0;
    item.from.copy(item.object.position);
  }

  /** 拾うのをやめた餌を、その場の地面に戻す */
  private dropToGround(item: Item): void {
    if (item.state === 'lift' || item.state === 'carry') {
      item.state = 'falling';
      item.vel.set(0, 0, 0);
      item.spin.set(0, 0, 0);
    } else item.state = 'ground';
  }

  /** 地面（base を渡せば、その高さの物の上）に置く */
  private placeOnGround(it: Item, x: number, z: number, base = 0): void {
    it.state = 'ground';
    it.base = base;
    it.vel.set(0, 0, 0);
    it.object.quaternion.copy(this.groundQuat(it));
    it.object.position.set(x, this.groundY(it), z);
  }

  /**
   * 地面に置いたときの向き：木の実は横倒し、草は寝かせる、虫は立つ（どれも上向きまわりに yaw）。
   * 生えている草は葉を上へ立て、きのこ・お花は生えていれば立ち、摘んだら横倒し
   */
  private groundQuat(it: Item): THREE.Quaternion {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.yaw);
    const id = it.kind.id;
    const lie = id === 'acorn' || (!it.rooted && (id === 'mushroom' || id === 'flower'));
    if (lie) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
    if (it.rooted && id === 'grass') q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
    return q;
  }

  /** つばの上での向き：帽子の上向きに立てて（木の実は立てる）、yaw だけ回す */
  private uprightQuat(it: Item, up: THREE.Vector3): THREE.Quaternion {
    const align = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    return align.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.yaw));
  }

  /** 地面に置いたときの中心の高さ */
  private groundY(it: Item): number {
    const s = this.y.shape.radius * SIZE;
    if (it.rooted) return it.base; // 生えている物は根元が原点
    const id = it.kind.id;
    // 横倒しのきのこ・お花は、傘・花の半径だけ浮かせる
    const lift = id === 'acorn' ? 0.42 : id === 'mushroom' ? 0.36 : id === 'flower' ? 0.24 : this.restLift(id);
    return lift * s + it.base;
  }

  /** 立てて置いたとき、中心から底までの高さ（単位の大きさ） */
  private restLift(id: string): number {
    return id === 'acorn' ? 0.05 : id === 'grass' ? 0.05 : id === 'manju' ? 0.21 : id === 'mushroom' || id === 'flower' ? 0 : 0.2;
  }

  /** 餌の形（単位の大きさ。中心が原点、上が +y、前が +z） */
  private makeItem(id: string): THREE.Group {
    const g = new THREE.Group();
    const add = (geo: THREE.BufferGeometry, m: string) => {
      this.geometries.push(geo);
      g.add(withOutline(geo, this.mats[m], this.outline));
    };
    if (id === 'acorn') {
      // どんぐり：下が丸くとがった実と、上にかぶさる帽子・軸
      const body = ellipsoid(0.42, 0.5, 0.42, 16);
      body.translate(0, 0.05, 0);
      add(body, 'acorn');
      const cap = new THREE.SphereGeometry(0.46, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      cap.scale(1, 0.55, 1);
      cap.translate(0, 0.32, 0);
      add(cap, 'cap');
      const stem = new THREE.CylinderGeometry(0.05, 0.07, 0.18, 6);
      stem.translate(0, 0.62, 0);
      add(stem, 'cap');
    } else if (id === 'grass') {
      // 草：細長い葉 5 枚を扇に広げて寝かせた束（生えている間は根元を下に立てる。3 枚だと芽にしか見えなかった）
      for (const [a, len] of [[-0.6, 0.8], [-0.3, 1.0], [0, 1.15], [0.3, 0.95], [0.6, 0.75]]) {
        const blade = ellipsoid(0.13, 0.03, len * 0.6, 10);
        blade.translate(0, 0, len * 0.55);
        blade.rotateY(a);
        blade.rotateX(-0.08);
        add(blade, 'grass');
      }
    } else if (id === 'mushroom') {
      // きのこ（根元が原点、上が +y）：白い太めの柄、裏にひだの見える丸い傘
      add(new THREE.CylinderGeometry(0.1, 0.13, 0.5, 10).translate(0, 0.25, 0), 'mushStem');
      const cap = new THREE.SphereGeometry(0.36, 18, 9, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.62, 1).translate(0, 0.46, 0);
      add(cap, 'mushCap');
      add(new THREE.CircleGeometry(0.34, 18).rotateX(Math.PI / 2).translate(0, 0.465, 0), 'gill');
    } else if (id === 'flower') {
      // たんぽぽ（根元が原点、上が +y）：細い茎の先に黄色い花（細い花びらを 2 重に並べた円盤と、ふくらんだ真ん中）、
      // 根元にぎざぎざの葉が地面に広がる（生えている間だけ。rosette）
      add(new THREE.CylinderGeometry(0.03, 0.04, 0.8, 6).translate(0, 0.4, 0), 'stem');
      for (const [n, r, tilt, y0] of [[14, 0.24, 0.25, 0.8], [10, 0.17, 0.55, 0.83]] as const) {
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + (r < 0.2 ? 0.2 : 0);
          const petal = ellipsoid(0.035, 0.012, r / 2, 6).translate(0, 0, r / 2).rotateX(-tilt).rotateY(a).translate(0, y0, 0);
          add(petal, 'petal');
        }
      }
      add(ellipsoid(0.09, 0.06, 0.09, 8).translate(0, 0.86, 0), 'petal');
      const rosette = new THREE.Group();
      rosette.name = 'rosette';
      for (let i = 0; i < 5; i++) {
        const leaf = ellipsoid(0.07, 0.015, 0.32, 8);
        const p = leaf.getAttribute('position') as THREE.BufferAttribute;
        for (let k = 0; k < p.count; k++) p.setX(k, p.getX(k) * (1 + 0.35 * Math.sin(p.getZ(k) * 40))); // ぎざぎざ
        leaf.translate(0, 0.02, 0.3).rotateY((i / 5) * Math.PI * 2 + 0.3);
        this.geometries.push(leaf);
        rosette.add(withOutline(leaf, this.mats.stem, this.outline));
      }
      g.add(rosette);
    } else if (id === 'manju') {
      // おまんじゅう：下がやや平らな丸（「ごはん」の食べ物と同じ形）
      const body = new THREE.SphereGeometry(0.6, 24, 14);
      const p = body.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) < 0 ? p.getY(i) * 0.35 : p.getY(i) * 0.62);
      body.computeVertexNormals();
      add(body, 'manju');
    } else {
      // 虫：つやのある甲羅の胴、小さな頭、細い脚 6 本
      const body = ellipsoid(0.36, 0.24, 0.5, 14);
      body.translate(0, 0.2, -0.05);
      add(body, 'bug');
      const head = ellipsoid(0.2, 0.16, 0.18, 10);
      head.translate(0, 0.16, 0.5);
      add(head, 'leg');
      for (const side of [-1, 1]) {
        for (const z of [-0.25, 0.05, 0.3]) {
          const leg = new THREE.CylinderGeometry(0.025, 0.025, 0.4, 5);
          leg.rotateZ(side * 1.1);
          leg.translate(side * 0.42, 0.06, z);
          add(leg, 'leg');
        }
      }
    }
    return g;
  }

  private say(text: string, size: number, life: number): void {
    const y = this.y;
    const R = y.shape.radius;
    const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * 0.45, y.center.z);
    if (this.word) y.texts.fade(this.word);
    this.word = y.texts.say(text, pos, R * size, life, new THREE.Vector3(0, R * 0.15, 0));
  }
}
