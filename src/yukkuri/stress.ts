import * as THREE from 'three';
import { loadJSON, saveJSON } from '../platform/storage';
import type { FoodQuality } from './foods';
import type { Yukkuri } from './Yukkuri';

/**
 * ストレス：嫌なことでたまり、上限に届くと吐餡する。吐くと半分に減る。
 *   ・つつかれる … 1 回 poke（つつくを 1 として数える）
 *   ・叩かれる   … 1 回 slap
 *   ・うんうん・吐いた餡子の近くにいる … 1 秒あたり nearRate（体の縁から nearDist m 以内）
 *   ・挟まって起き上がれない … 1 秒あたり stuckRate（Wedge が足す。挟まったまま上限に届くと、吐いた後に死ぬ）
 * 吐いている・うんうんしている間は、近くの汚れでたまらない（自分が出している最中のもので増えないように）。
 * 上限に届いても吐けないとき（うんうんの最中など）は、上限のまま待って吐けるようになったら吐く。
 * 食べ物を食べ終える（しあわせー）と、食べ物の品質に応じて params.meal だけ減る（途中でやめたら減らない）。
 * ストレスを受けない（つつかれず・叩かれず・汚れの近くにいない）まま calmAfter 秒たつと、1 秒あたり recover ずつ減っていく。
 * 体型によっては下限がある（PRESET_FLOOR。それより下がらない。吐いて半分にしても下限で止まる）
 */
export interface StressParams {
  /** これに届いたら吐餡する */
  limit: number;
  /** つつかれたとき・叩かれたときに足す量 */
  poke: number;
  slap: number;
  /** うんうん・吐いた餡子の近くにいるとき、1 秒あたりに足す量 */
  nearRate: number;
  /** 「近く」とみなす距離（体の縁から。m） */
  nearDist: number;
  /** 挟まって起き上がれないとき、1 秒あたりに足す量 */
  stuckRate: number;
  /** ストレスを受けないままこの時間（秒）たったら減り始める */
  calmAfter: number;
  /** 減り始めてから、1 秒あたりに減る量 */
  recover: number;
  /** 食べ終えたときに減る量（食べ物の品質ごと） */
  meal: Record<FoodQuality, number>;
}
/** 食べ終えたときに減る量の初期値。今あるのは中間品質だけ。低品質・高品質は仮の値（種類を足すときに決める） */
const DEFAULT_MEAL: Record<FoodQuality, number> = { low: 5, normal: 20, high: 40 };
export const DEFAULT_STRESS: StressParams = {
  limit: 100, poke: 1, slap: 2, nearRate: 1, nearDist: 0.5, stuckRate: 3, calmAfter: 10, recover: 0.5, meal: { ...DEFAULT_MEAL },
};
const STORAGE_KEY = 'stress';
/** 体型ごとのストレスの下限（書いていない体型は 0。ボール型・たまご型・ユーザー設定）。値は指示 */
const PRESET_FLOOR: Record<string, number> = { caterpillar: 50, flat: 40, eggplant: 20, chick: 10 };
/** 吐餡したときに残す割合 */
const AFTER_VOMIT = 0.5;
/** 汚れが近くにあるかを調べる間隔（秒。塊の数が多いので毎ステップは見ない） */
const NEAR_CHECK = 0.25;

export class Stress {
  readonly params: StressParams = loadParams();
  /** 今のストレス（0〜上限） */
  value = 0;
  /** 汚れが近くにあるか（NEAR_CHECK ごとに調べ直す） */
  near = false;
  private checkIn = 0;
  /** 最後にストレスを受けてからの時間（秒） */
  calmFor = 0;

  constructor(private readonly y: Yukkuri) {}

  save(): void {
    saveJSON(STORAGE_KEY, this.params);
  }

  /** 今の体型の下限（上限を超えないようにする） */
  get floor(): number {
    return Math.min(PRESET_FLOOR[this.y.presetId] ?? 0, this.params.limit);
  }

  add(amount: number): void {
    if (amount > 0) this.calmFor = 0;
    this.value = Math.min(this.params.limit, Math.max(this.floor, this.value + amount));
  }

  /** 品質 quality の食べ物を食べ終えた：その分減らす（下限より下にはしない） */
  ate(quality: FoodQuality): void {
    this.value = Math.max(this.floor, this.value - this.params.meal[quality]);
  }

  /** 吐餡した（理由を問わず）：半分に減らす（下限より下にはしない） */
  vomited(): void {
    this.value = Math.max(this.floor, this.value * AFTER_VOMIT);
  }

  /** いちばん低くする（下限のある体型は下限まで） */
  reset(): void {
    this.value = this.floor;
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    const y = this.y;
    // 吐いている・うんうんの最中・といれへ運んでいる間は、近くの汚れでたまらない（運ぶ間は拾うたびにたまる）
    const busy = y.vomit.active || y.dropping.active || y.cleanup.active;
    // 体型を切り替えて下限が上がったら、すぐ下限まで上げる
    if (this.value < this.floor) this.value = this.floor;
    this.checkIn -= dt;
    if (this.checkIn <= 0) {
      this.checkIn = NEAR_CHECK;
      this.near = this.dirtNear(); // 出している最中のものは数えない（Dropping.near・Vomit.near）
    }
    if (this.near && !busy) this.add(this.params.nearRate * dt);
    // ストレスを受けないまましばらくたったら、少しずつ減らす（汚れが近ければ、吐いている間なども減らさない）
    if (!this.near) this.calmFor += dt;
    if (!this.near && this.calmFor >= this.params.calmAfter) this.value = Math.max(this.floor, this.value - this.params.recover * dt);
    // 上限に届いたら吐く（吐けなければ、吐けるようになるまで毎ステップ試す）。
    // 上限を下限以下にしたときは吐かない（吐いても下限＝上限のままで、吐き続けてしまう）
    if (this.value >= this.params.limit && this.floor < this.params.limit && !y.vomit.active) {
      y.wedge.doom(); // 挟まって起き上がれないまま届いたら、吐いた後に死ぬ
      y.vomit.start();
    }
  }

  /** うんうん・吐いた餡子のどれかが、体の縁から nearDist 以内にあるか（水平に見る） */
  private dirtNear(): boolean {
    return this.dirtWithin(this.y.body.center, this.reach() + this.params.nearDist);
  }

  /** 体の広がり：重心から一番遠い頂点までの水平距離（m。前後に長い体型も覆う） */
  reach(): number {
    const b = this.y.body;
    const c = b.center;
    let reach = 0;
    const p = b.pos;
    for (let i = 0; i < p.length; i += 3) reach = Math.max(reach, Math.hypot(p[i] - c.x, p[i + 2] - c.z));
    return reach;
  }

  /** うんうん・吐いた餡子のどれかが、水平に見て点 c から radius 以内にあるか */
  dirtWithin(c: THREE.Vector3, radius: number): boolean {
    return this.y.dropping.near(c, radius) || this.y.vomit.near(c, radius);
  }

  /**
   * 点 c から汚れを避ける向き（水平の単位ベクトル）。近い汚れほど強く押し返す向きを足し合わせる。
   * 汚れがなければ体の後ろ向き
   */
  dirtAway(c: THREE.Vector3): THREE.Vector3 {
    const out = new THREE.Vector3();
    const add = (x: number, z: number) => {
      const dx = c.x - x, dz = c.z - z;
      const d2 = Math.max(dx * dx + dz * dz, 0.01);
      out.x += dx / d2;
      out.z += dz / d2;
    };
    this.y.dropping.forEachPoint(add);
    this.y.vomit.forEachPoint(add);
    if (out.lengthSq() < 1e-8) {
      const yaw = this.y.body.yaw;
      out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    }
    return out.normalize();
  }
}

/** 保存した調整値を読む（食べ物の品質ごとの量は、品質ごとに初期値と混ぜる。品質を足しても前の保存が使える） */
function loadParams(): StressParams {
  const saved = loadJSON<Partial<StressParams>>(STORAGE_KEY) ?? {};
  return { ...DEFAULT_STRESS, ...saved, meal: { ...DEFAULT_MEAL, ...saved.meal } };
}
