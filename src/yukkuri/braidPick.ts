import * as THREE from 'three';
import { bodyExtent, bodyFacing } from './fx';
import type { Yukkuri } from './Yukkuri';

/**
 * 三つ編みで物を拾う動き（枝・餌で共通）：
 *   寄る（物が三つ編みの側の真横・少し前に来る所へ横付け）→ 向きを合わせる → かがむ（三つ編みの側へ傾けて少し沈み、
 *   毛先をつかむ所へ下ろす）→ 沿わせる（止まる）→ 持ち上げる（体を起こしながら三つ編みを戻す）
 * 視線は、寄ってから持ち上げ終わるまで、つかむ所を見る。
 * 呼ぶ側は start で「つかむ所」と知らせ（コールバック）を渡し、毎ステップ update を呼ぶ。持ち上げる間の物の位置は呼ぶ側が
 * 三つ編みの毛先（Braid.grip）と liftK から決める
 */
export interface PickHooks {
  /** つかむ所（ワールド。毎回呼ぶ。物が動けば追う） */
  grabPoint: () => THREE.Vector3;
  /** かがみ始めた（つかむ所を決め直すならここで） */
  onLower?: () => void;
  /** 沿わせ終えて、持ち上げ始めた */
  onLift?: () => void;
  /** 持ち上げ終えた */
  onDone?: () => void;
  /** 途中でやめた（気絶した・三つ編みを隠した・ほかの行き先を指示された・あきらめた） */
  onCancel?: () => void;
}

type Phase = 'idle' | 'approach' | 'turn' | 'lower' | 'touch' | 'lift';

/** 横付け：物が体の真横（三つ編みの側）、中心からこの距離（胴の半径に対する比）・少し前に来る所で止まる */
const SIDE_GAP = 1.25;
const SIDE_AHEAD = 0.15;
/** 止まる所が皿などに重なるかを見る、体の底の広がり（胴の半径に対する比） */
const PROP_CLEAR = 0.8;
/**
 * 止まる所が皿などにかかるとき、行ける向きを探す刻み（rad）と、左右それぞれ何刻みまで回すか（12 刻みでちょうど反対側）。
 * どの向きもだめなら、物から SIDE_GAP_FAR（胴の半径に対する比）まで離れて探す
 */
const PROP_TRY_STEP = Math.PI / 12;
const PROP_TRIES = 12;
const SIDE_GAP_FAR = 1.45;
/** 止まる所がこれより近ければ（胴の半径に対する比）歩かずにその場で向きだけ変える（すぐ後ろへは回り込めず、近くを回り続ける） */
const NEAR_ENOUGH = 1.0;
/** 向きを合わせる：差がこれ（rad）より小さくなるか、この時間（秒）たったら、かがむ */
const TURN_OK = 0.15;
const TURN_MAX = 2.5;
/**
 * あきらめるまでの時間（秒）：これに、寄る道のり 1 m ごとに GIVE_UP_PER_M 秒を足す（飼育ケースの端から皿までで 15 秒を超えた。
 * なすび型は 1 m に 7 秒ほどかかる）
 */
const GIVE_UP = 15;
const GIVE_UP_PER_M = 9;
/** かがむ（三つ編みを下ろす）時間・沿わせて止まる時間・持ち上げる時間（秒） */
const LOWER_TIME = 0.5;
const TOUCH_TIME = 0.25;
export const LIFT_TIME = 0.6;
/** その場で拾う（stay）とき：物が三つ編みの側のこの角度（rad）だけ前に来る向きへ回る。かがむ・沿わせる・持ち上げるのはこの倍率の時間で */
const STAY_AHEAD = 0.2;
const STAY_PACE = 0.7;
/** 物が体の表面からこの距離（胴の半径に対する比）より近ければ、歩かずにその場で拾う */
const STAY_REACH = 0.9;
/** かがむとき、三つ編みの側へ傾ける角度（rad）と沈み込み（縦の倍率） */
const LEAN = 0.26;
const CROUCH = 0.92;

export class BraidPick {
  private phase: Phase = 'idle';
  private t = 0;
  private hooks: PickHooks | null = null;
  /** 拾いに行く行き先と、着いたら向く向き（rad）・三つ編みの側（体の右 +1・左 -1） */
  private readonly approachTarget = new THREE.Vector3();
  private heading = 0;
  private side = 1;
  /** かがむ・沿わせる・持ち上げる時間の倍率 */
  private pace = 1;
  private readonly pose = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  /** あきらめるまでの時間（秒。寄る道のりで変わる） */
  private giveUp = GIVE_UP;

  constructor(private readonly y: Yukkuri) {}

  /** 拾っている途中か */
  get active(): boolean {
    return this.phase !== 'idle';
  }

  /** 持ち上げている途中か（物を毛先につけて動かす間） */
  get lifting(): boolean {
    return this.phase === 'lift';
  }

  /** 持ち上げの進み（0〜1） */
  get liftK(): number {
    return this.phase === 'lift' ? smooth(this.t / (LIFT_TIME * this.pace)) : 0;
  }

  /**
   * 拾い始める。三つ編みがないとき・気絶中・ほかに拾っている途中は false。
   * stay：歩かずに、その場で物が三つ編みの側に来る向きへ回って拾う（近くにあると分かっている物。手早く）
   */
  start(hooks: PickHooks, stay = false): boolean {
    const y = this.y;
    if (this.active || !y.outfit.braid || y.rest.fainting) return false;
    // 足焼きで移動できなければ、三つ編みが届く所の物だけ拾う（寄れないので）。寝転がっていれば起き上がれないので拾わない
    if (y.locomotion.immobile && y.locomotion.isLying && y.stuck()) return false;
    if (y.locomotion.immobile) {
      const g = hooks.grabPoint();
      const dir = new THREE.Vector3(g.x - y.center.x, 0, g.z - y.center.z);
      const d = dir.length();
      if (!stay && !(d > 1e-6 && d < bodyExtent(y, dir.divideScalar(d)) + y.shape.radius * STAY_REACH) && y.stuck()) return false;
    }
    y.rest.wake(true);
    if (y.locomotion.isLying) y.getUp();
    this.hooks = hooks;
    this.phase = 'approach';
    this.t = 0;
    // 三つ編みが届く近さなら歩かない（歩いて横付けしようとすると、行き先が体のすぐそばになって近くを回り続け、あきらめていた）
    const p = hooks.grabPoint();
    const dir = new THREE.Vector3(p.x - y.center.x, 0, p.z - y.center.z);
    const d = dir.length();
    if (!stay && d > 1e-6 && d < bodyExtent(y, dir.divideScalar(d)) + y.shape.radius * STAY_REACH) stay = true;
    this.pace = stay ? STAY_PACE : 1;
    if (stay && !y.locomotion.isLying) {
      this.faceSideways(hooks.grabPoint());
      y.locomotion.stop();
      this.startTurn();
      return true;
    }
    this.goNear(hooks.grabPoint());
    if (Math.hypot(this.approachTarget.x - y.center.x, this.approachTarget.z - y.center.z) < y.shape.radius * NEAR_ENOUGH && !y.locomotion.isLying) {
      y.locomotion.stop();
      this.startTurn();
    }
    return true;
  }

  /** 途中でやめる（身ぶり・三つ編み・視線を戻し、移動の保留を解く） */
  cancel(): void {
    if (!this.active) return;
    const hooks = this.hooks;
    this.finish();
    hooks?.onCancel?.();
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    if (!this.active) return;
    const y = this.y;
    this.t += dt;
    const hooks = this.hooks!;
    if (y.rest.fainting || !y.outfit.braid) {
      this.cancel();
      return;
    }
    const loco = y.locomotion;
    const braid = y.outfit.braid;
    y.lookAt(hooks.grabPoint());
    switch (this.phase) {
      case 'approach':
        // ほかの行き先を指示された・あきらめた
        if ((loco.hasTarget && loco.target.distanceTo(this.approachTarget) > 1e-3) || this.t > this.giveUp) {
          this.cancel();
          break;
        }
        if (!loco.hasTarget && loco.idle && !loco.tilted) this.startTurn();
        break;
      case 'turn': {
        const err = Math.abs(Math.atan2(Math.sin(this.heading - y.body.yaw), Math.cos(this.heading - y.body.yaw)));
        this.setPose(0, 0);
        if ((err < TURN_OK && this.t > 0.3) || this.t > TURN_MAX) {
          this.phase = 'lower';
          this.t = 0;
          hooks.onLower?.();
        }
        break;
      }
      case 'lower': {
        const k = smooth(this.t / (LOWER_TIME * this.pace));
        this.setPose(k, k);
        braid.reachTarget.copy(hooks.grabPoint());
        braid.reachAmount = k;
        if (this.t >= LOWER_TIME * this.pace) {
          this.phase = 'touch';
          this.t = 0;
        }
        break;
      }
      case 'touch':
        this.setPose(1, 1);
        braid.reachTarget.copy(hooks.grabPoint());
        if (this.t >= TOUCH_TIME * this.pace) {
          this.phase = 'lift';
          this.t = 0;
          hooks.onLift?.();
        }
        break;
      case 'lift': {
        const k = smooth(this.t / (LIFT_TIME * this.pace));
        this.setPose(1 - k, 1 - k);
        braid.reachAmount = 1 - k;
        if (this.t >= LIFT_TIME * this.pace) {
          this.finish();
          hooks.onDone?.();
        }
        break;
      }
    }
  }

  private finish(): void {
    const y = this.y;
    const loco = y.locomotion;
    if (this.phase === 'approach') {
      if (loco.hasTarget && loco.target.distanceTo(this.approachTarget) < 1e-3) loco.stop();
    } else {
      const braid = y.outfit.braid;
      if (braid) braid.reachAmount = 0;
      if (loco.gesture?.orientation === this.pose) loco.gesture = null;
      loco.release();
    }
    y.lookAt(null);
    this.phase = 'idle';
    this.hooks = null;
  }

  /** 身ぶり：拾う向き（heading）を向き、三つ編みの側へ lean の割合だけ傾けて、crouch の割合だけ沈む */
  private setPose(lean: number, crouch: number): void {
    // 体の右（ローカル +x）が三つ編みの側なら、右を下げる＝z 軸まわりに負へ回す
    this.euler.set(0, this.heading, -this.side * LEAN * lean);
    this.pose.setFromEuler(this.euler);
    this.y.locomotion.gesture = { orientation: this.pose, squash: 1 + (CROUCH - 1) * crouch };
  }

  private startTurn(): void {
    this.y.locomotion.hold();
    this.phase = 'turn';
    this.t = 0;
  }

  /** その場で拾う向き：物が三つ編みの側の、少し前に来る向き */
  private faceSideways(p: THREE.Vector3): void {
    const y = this.y;
    const f = bodyFacing(y);
    this.side = braidSide(y).dot(new THREE.Vector3(f.z, 0, -f.x)) >= 0 ? 1 : -1;
    // 体の右（side +1）の向きの角度は heading + π/2
    const a = Math.atan2(p.x - y.center.x, p.z - y.center.z);
    this.heading = a - this.side * (Math.PI / 2 - STAY_AHEAD);
  }

  /**
   * 拾いに行く行き先：物が三つ編みの側の真横（少し前）に来る所。向く向きは今いる所から物へ向かう向き
   * （そこへ向かって歩けば、着いたときおおむねその向きを向いている）
   */
  private goNear(p: THREE.Vector3): void {
    const y = this.y;
    const R = y.shape.radius;
    const f = bodyFacing(y);
    const right = new THREE.Vector3(f.z, 0, -f.x);
    this.side = braidSide(y).dot(right) >= 0 ? 1 : -1;
    const toward = new THREE.Vector3(p.x - y.center.x, 0, p.z - y.center.z);
    if (toward.lengthSq() < 1e-6) toward.copy(f);
    toward.normalize();
    this.heading = Math.atan2(toward.x, toward.z);
    const sideThen = new THREE.Vector3(toward.z, 0, -toward.x).multiplyScalar(this.side);
    const t = p.clone().addScaledVector(sideThen, -R * SIDE_GAP).addScaledVector(toward, -R * SIDE_AHEAD);
    // 止まる所が皿など（体が乗れない物）にかかるなら、その物の外側（物の中心から拾う物を通って外）に横付けする。
    // 外側がケースの壁ぎわやほかの皿で行けなければ、向きを左右へ回して行ける所を探す（皿の真ん中の餌で奥の壁の外に、
    // 水皿の側の餌で水皿の上に寄ろうとした）。
    // 向きは、拾う物が三つ編みの側に来る向き（寄った所が皿に止められて着かず、あきらめていた）
    const stage = y.stage;
    // 基準にするのは拾う物が載っている物（止まる所が一番深く重なる物にすると、隣の水皿を基準にして水皿の上に寄ろうとした）
    const prop = stage?.overlapProp(t.x, t.z, R * PROP_CLEAR) ? (stage.overlapProp(p.x, p.z, 0) ?? stage.overlapProp(t.x, t.z, R * PROP_CLEAR)) : null;
    if (stage && prop) {
      // 寄れば押し出されて止まるのでかかってもよいのは、拾う物が載っている物だけ（床の物で基準の皿にかかるのを許すと、
      // 餌皿と水皿の間の物で水皿の上に寄ろうとして着かず、あきらめていた）
      const onProp = stage.overlapProp(p.x, p.z, 0);
      const base = new THREE.Vector3(p.x - prop.x, 0, p.z - prop.z);
      // 物のほぼ真ん中なら、今いる側から
      if (base.lengthSq() < (R * 0.1) ** 2) base.copy(toward).negate();
      const a0 = Math.atan2(base.x, base.z);
      const out = new THREE.Vector3(), c = new THREE.Vector3();
      // 行ける範囲の内側で、ほかの皿（隣の水皿など）にかからない所。向きは PROP_TRY_STEP ずつ左右へ回し（皿の間は行ける向きが狭い）、
      // どの向きもだめなら少し離れて探す。それでもなければ、一番かからない所
      let best = Infinity;
      for (const gap of [SIDE_GAP, SIDE_GAP_FAR]) {
        for (let k = 0; k <= PROP_TRIES && best > 0; k++) {
          for (const sgn of k === 0 || k === PROP_TRIES ? [1] : [1, -1]) {
            const a = a0 + sgn * k * PROP_TRY_STEP;
            c.set(Math.sin(a), 0, Math.cos(a));
            const x = p.x + c.x * R * gap, z = p.z + c.z * R * gap;
            let over = stage.inside(x, z, y.stageMargin) ? 0 : 1;
            for (const q of stage.props) if (q !== onProp) over = Math.max(over, q.r + R * PROP_CLEAR - Math.hypot(x - q.x, z - q.z));
            if (over < best) {
              best = over;
              out.copy(c);
              t.set(x, 0, z);
            }
            if (best <= 0) break;
          }
        }
        if (best <= 0) break;
      }
      // 体の右（side +1）が拾う物（-out）を向く：右 = (f.z, -f.x) = -out × side
      const right = out.clone().multiplyScalar(-this.side);
      this.heading = Math.atan2(-right.z, right.x);
    }
    y.locomotion.moveTo(t.x, t.z);
    this.approachTarget.copy(y.locomotion.target);
    this.giveUp = GIVE_UP + GIVE_UP_PER_M * Math.hypot(this.approachTarget.x - y.center.x, this.approachTarget.z - y.center.z);
  }
}

/** 三つ編みのある側（水平の単位ベクトル。体の中心から毛先へ。毛先がまだなければ体の左） */
export function braidSide(y: Yukkuri): THREE.Vector3 {
  const facing = bodyFacing(y);
  const g = y.outfit.braid?.grip;
  const v = g?.ready ? g.pos.clone().sub(y.center).setY(0) : new THREE.Vector3(facing.z, 0, -facing.x);
  v.addScaledVector(facing, -v.dot(facing)); // 前後の成分は除く
  if (v.lengthSq() < 1e-6) v.set(facing.z, 0, -facing.x);
  return v.normalize();
}

export function smooth(t: number): number {
  t = Math.min(1, Math.max(0, t));
  return t * t * (3 - 2 * t);
}
