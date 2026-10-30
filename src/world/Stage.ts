import * as THREE from 'three';
import type { BoxCollider } from '../physics/SoftBody';
import { loadJSON, saveJSON } from '../platform/storage';
import { Cage } from './cage';
import { Forest } from './forest';
import type { FloorId } from './floorTextures';

/**
 * マップ（ゆっくりのいる場所）。地面はどのマップも高さ 0 の平らな面（指示）。
 *   平地（open）… これまでの何もない地面。行ける範囲の限りなし
 *   飼育ケース（cage）… ガラスの水槽の中（cage.ts）。行ける範囲はケースの中だけ
 *   森（forest）… 木に囲まれた広場（forest.ts）。洞穴に入るとシルエットだけになる
 * マップごとに、置く物（object）・当たる物（colliders。体を押し返す）・行ける範囲（area）を持つ。
 * 選んだマップと床材は保存する
 */
export type MapId = 'open' | 'cage' | 'forest';
export type { FloorId };

/** 行ける範囲（地面の上の長方形。m） */
export interface Area {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export const MAPS: { id: MapId; label: string }[] = [
  { id: 'open', label: '平地' },
  { id: 'cage', label: '飼育ケース' },
  { id: 'forest', label: '森' },
];
export const FLOORS: { id: FloorId; label: string }[] = [
  { id: 'newspaper', label: '新聞紙' },
  { id: 'sawdust', label: 'おがくず' },
  { id: 'towel', label: 'タオル' },
];

const STORAGE_KEY = 'stage';
/** 平地の空の色（霧） */
const OPEN_SKY = '#f7f4ef';

export class Stage {
  readonly object = new THREE.Group();
  /** 今のマップの当たる物（マップを変えると中身を入れ替える。同じ配列のまま） */
  readonly colliders: BoxCollider[] = [];
  /** マップを変えた後に呼ぶ（体の当たり・居場所を合わせる） */
  onChange: (() => void) | null = null;
  private mapId: MapId = 'open';
  private floorId: FloorId = 'newspaper';
  private cage: Cage | null = null;
  private forest: Forest | null = null;

  constructor(private readonly bodyMaterial: THREE.ShaderMaterial, private readonly outlineMaterial: THREE.ShaderMaterial) {
    const saved = loadJSON<{ map?: MapId; floor?: FloorId }>(STORAGE_KEY);
    if (saved?.floor && FLOORS.some((f) => f.id === saved.floor)) this.floorId = saved.floor;
    if (saved?.map && MAPS.some((m) => m.id === saved.map)) this.build(saved.map);
  }

  get map(): MapId {
    return this.mapId;
  }

  set map(id: MapId) {
    if (id === this.mapId) return;
    this.build(id);
    this.save();
    this.onChange?.();
  }

  /** 飼育ケースの床材 */
  get floor(): FloorId {
    return this.floorId;
  }

  set floor(id: FloorId) {
    this.floorId = id;
    this.cage?.setFloor(id);
    this.save();
  }

  /** 行ける範囲（限りがなければ null） */
  get area(): Readonly<Area> | null {
    return this.cage?.area ?? this.forest?.area ?? null;
  }

  /** 餌皿（飼育ケースのとき。中心・餌を置く輪・内側の底の高さ） */
  get foodDish(): { x: number; z: number; r: number; ring: readonly [number, number]; floorAt: (dist: number) => number } | null {
    return this.cage?.foodDish ?? null;
  }

  /** 水皿（飼育ケースのとき。中心・半径・水面の高さと半径） */
  get waterDish(): { x: number; z: number; r: number; surfaceY: number; surfaceR: number } | null {
    return this.cage?.waterDish ?? null;
  }

  /** といれ（マップごとに形が違う。飼育ケースは砂のトレイ、森は木の根元のくぼみ）：中心と横・奥行き（m）。なければ null */
  get toilet(): { x: number; z: number; w: number; d: number } | null {
    return this.cage?.toilet ?? this.forest?.toilet ?? null;
  }

  /** 点（x, z）がといれの中か（縁から margin m より内側） */
  inToilet(x: number, z: number, margin = 0): boolean {
    const t = this.toilet;
    return !!t && Math.abs(x - t.x) <= t.w / 2 - margin && Math.abs(z - t.z) <= t.d / 2 - margin;
  }

  /** 置いてある物（皿など。体が乗れない所）：中心と半径（m） */
  get props(): readonly { x: number; z: number; r: number }[] {
    return this.cage?.props ?? this.forest?.props ?? [];
  }

  /** 点（x, z）が洞穴の中か（森のとき。中にいるとシルエットだけが見える） */
  inCave(x: number, z: number): boolean {
    return this.forest?.inCave(x, z) ?? false;
  }

  /** 点（x, z）が大木のうろの床の上か（森のとき。巣材を暗がりに沈める・うろの中と外を分ける） */
  inHollow(x: number, z: number): boolean {
    return this.forest?.inHollow(x, z) ?? false;
  }

  /**
   * （fx, fz）から（tx, tz）へ歩くとき、間に大木のうろの幹があれば、入口を通って回る道の途中の点（なければ null）。
   * R は体の半径
   */
  via(fx: number, fz: number, tx: number, tz: number, R: number): { x: number; z: number } | null {
    return this.forest?.via(fx, fz, tx, tz, R) ?? null;
  }

  /** 点（x, z）が洞穴（大木のうろ）の幹の近くか（森のとき。中も含む） */
  nearCave(x: number, z: number): boolean {
    return this.forest?.nearCave(x, z) ?? false;
  }

  /** 苔の生える所（森のとき）：物のすぐ脇の点と、物のふちに沿う向き */
  get mossSites(): readonly { x: number; z: number; tx: number; tz: number }[] {
    return this.forest?.mossSites ?? [];
  }

  /** 中心（x, z）・半径 r の円が、草むら・茂み（当たらないが、中の物が隠れる）にかかるか（森のとき） */
  inCover(x: number, z: number, r: number): boolean {
    return !!this.forest?.covers.some((c) => Math.hypot(x - c.x, z - c.z) < c.r + r);
  }

  /** 中心（x, z）・半径 r の円が、当たる物（壁・うろの幹・木・岩・皿など。colliders の箱）にかかるか */
  blocked(x: number, z: number, r: number): boolean {
    for (const b of this.colliders) {
      const cs = Math.cos(b.yaw), sn = Math.sin(b.yaw);
      const dx = x - b.x, dz = z - b.z;
      // 箱のローカル（SoftBody の solveBoxes と同じ向き）で、箱の一番近い所までの距離
      const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
      const ex = Math.max(0, Math.abs(lx) - b.hx), ez = Math.max(0, Math.abs(lz) - b.hz);
      if (Math.hypot(ex, ez) < r) return true;
    }
    return false;
  }

  /** 空と遠くの色（霧） */
  get sky(): string {
    return this.forest?.sky ?? OPEN_SKY;
  }

  /**
   * 点 p（x, z）を行ける範囲の内側へ寄せる（範囲の縁から、横は margin m・奥行きは marginZ m 内側まで）。寄せたら true
   */
  limit(p: { x: number; z: number }, margin: number, marginZ = margin): boolean {
    const a = this.area;
    if (!a) return false;
    const x = THREE.MathUtils.clamp(p.x, a.minX + margin, a.maxX - margin);
    const z = THREE.MathUtils.clamp(p.z, a.minZ + marginZ, a.maxZ - marginZ);
    let moved = x !== p.x || z !== p.z;
    p.x = x;
    p.z = z;
    // 森：木・切り株・岩・倒木の上なら、その外へ（体の半径ほど離す。飼育ケースの皿は、横付けして食べるので寄せない）
    if (this.forest) {
      const keep = margin / 1.5;
      for (const o of this.forest.props) {
        const dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz), r = o.r + keep;
        if (d >= r) continue;
        const k = d > 1e-6 ? r / d : 1;
        p.x = o.x + (d > 1e-6 ? dx * k : r);
        p.z = o.z + dz * k;
        moved = true;
      }
      // 大木のうろの幹（壁）の上なら、近い側（うろの中か外）へ。寄せて範囲の外へ出たら範囲の内側へ戻す
      // （幹の裏の角は、幹と範囲の縁の間が体より狭く、行けない）
      if (this.forest.pushOutOfHollow(p, keep)) {
        moved = true;
        p.x = THREE.MathUtils.clamp(p.x, a.minX + margin, a.maxX - margin);
        p.z = THREE.MathUtils.clamp(p.z, a.minZ + marginZ, a.maxZ - marginZ);
      }
    }
    return moved;
  }

  /** 点（x, z）が行ける範囲の縁から、横は margin m・奥行きは marginZ m より内側か */
  inside(x: number, z: number, margin = 0, marginZ = margin): boolean {
    const a = this.area;
    return !a || (x >= a.minX + margin && x <= a.maxX - margin && z >= a.minZ + marginZ && z <= a.maxZ - marginZ);
  }

  /** 中心（x, z）・半径 r の円が、置いてある物（皿など）と重なるなら、その物（重なりの深さ順で一番深いもの） */
  overlapProp(x: number, z: number, r: number): { x: number; z: number; r: number } | null {
    let best: { x: number; z: number; r: number } | null = null;
    let depth = 0;
    for (const p of this.props) {
      const d = p.r + r - Math.hypot(x - p.x, z - p.z);
      if (d > depth) {
        depth = d;
        best = p;
      }
    }
    return best;
  }

  /** 毎フレーム（カメラの位置で見え方を変える物があれば） */
  update(camera: THREE.Camera, target?: THREE.Vector3): void {
    this.cage?.update(camera.position);
    this.forest?.update(camera, target);
  }

  private build(id: MapId): void {
    this.mapId = id;
    if (this.cage) {
      this.object.remove(this.cage.object);
      this.cage.dispose();
      this.cage = null;
    }
    if (this.forest) {
      this.object.remove(this.forest.object);
      this.forest.dispose();
      this.forest = null;
    }
    this.colliders.length = 0;
    if (id === 'cage') {
      this.cage = new Cage(this.bodyMaterial, this.outlineMaterial, this.floorId);
      this.object.add(this.cage.object);
      this.colliders.push(...this.cage.colliders);
    } else if (id === 'forest') {
      this.forest = new Forest(this.bodyMaterial, this.outlineMaterial);
      this.object.add(this.forest.object);
      this.colliders.push(...this.forest.colliders);
    }
  }

  private save(): void {
    saveJSON(STORAGE_KEY, { map: this.mapId, floor: this.floorId });
  }
}
