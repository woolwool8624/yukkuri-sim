import * as THREE from 'three';
import { bodyExtent, bodyFacing } from './fx';
import { braidSide, smooth } from './braidPick';
import type { Yukkuri } from './Yukkuri';

/**
 * 帽子を脱いで地面に逆さに置き、またかぶる動き（餌を帽子の中にしまうのに使う）：
 *   つかむ（三つ編みの毛先を三つ編みの側のつばの縁へ）→ 脱ぐ（つかんだ所を軸に、外へ向けてひっくり返しながら、
 *   三つ編みの側の地面へ下ろす）→ 放す → （呼ぶ側が餌を入れる）→ 戻る（脱いだ所へ戻り、向きも戻す）→
 *   つかむ → かぶる（脱ぐのを逆に）→ 放す
 * 帽子は WitchHat.carry で動かす。三つ編みは Braid.reachTarget でつかんだ所に付ける。つかんでいる間はつかむ所を見る。
 * 途中でやめたときは、帽子は三つ編みを使わずに頭へ戻る（snap）
 * 置く所が皿やケースの壁にかかるときは、先に広い所へ少し歩いてから脱ぐ（clear。3 回移ってもだめならやめる）
 */
type Phase = 'idle' | 'clear' | 'grab' | 'off' | 'letGo' | 'down' | 'back' | 'turn' | 'regrab' | 'on' | 'letGo2' | 'snap';

/** つかむ所：三つ編みの側のつばの、円錐の根元から縁までのこの割合の所 */
const GRAB_R = 0.85;
/** 置く所：つかむ所が体の中心から三つ編みの側へこの距離・前へこの距離（胴の半径に対する比）。帽子は外側に広がる */
const PUT_SIDE = 1.35;
/** 置いた帽子のつばの縁と体の表面の間にあける隙間（胴の半径に対する比）。横に広い体型では PUT_SIDE より外へ置く */
const PUT_GAP = 0.15;
const PUT_AHEAD = 0.25;
/**
 * 逆さに置いたときの、つばの根元の地面からの高さ（帽子の大きさに対する比）。置きながら円錐をつぶす（WitchHat.crush）ので、
 * つぶした円錐の先がちょうど地面に着く高さ（元の高さ 1.4 だと円錐の先で逆立ちして見えた）
 */
const PUT_HEIGHT = 0.5;
/** 脱ぐとき、この進みから円錐をつぶし始める（かぶるときは逆に、始めのこの割合までに戻す） */
const CRUSH_FROM = 0.55;
/** かぶる向きのまま置くときの、つばの根元の地面からの高さ（帽子の大きさに対する比。つばの縁が地面に着く） */
export const UPRIGHT_HEIGHT = 0.14;
/** かぶる向きのまま置くときの、つばの縁と体の表面の間（胴の半径に対する比） */
const UPRIGHT_GAP = 0.6;
/** ひっくり返す途中に持ち上げる高さ（胴の半径に対する比） */
const ARC = 0.55;
/** 時間（秒）：つかむ・脱ぐ（かぶる）・放す・頭へ戻る（やめたとき） */
const GRAB_TIME = 0.45;
const FLIP_TIME = 1.3;
const LET_TIME = 0.35;
const SNAP_TIME = 0.4;
/** 下ろすとき三つ編みの側へ傾ける角度（rad） */
const LEAN = 0.22;
/** 戻る：あきらめるまでの時間（秒）と、向きを合わせる許し（rad）・最長時間（秒） */
const BACK_GIVE_UP = 25;
/** 戻る：脱いだ所からこの距離（胴の半径に対する比）まで来たら着いたことにする（向きは arrived で合わせ、ずれは「かぶる」の始めに吸収する） */
const ARRIVE = 0.9;
/** 戻ったとき、つかむ所が三つ編みの側のこの角度（rad）だけ前に来る向きへ回る */
const BACK_AHEAD = 0.2;
const TURN_OK = 0.12;
const TURN_MAX = 2.5;
/** つばの餌を落とし始める所（ひっくり返す進みの割合） */
const TIP_AT = 0.22;
/** 置く所が皿・壁にかかるとき：広い所へ歩く距離（胴の半径に対する比）・移り直す回数・あきらめるまでの時間（秒） */
const CLEAR_STEP = 2.2;
const CLEAR_TRIES = 3;
const CLEAR_GIVE_UP = 12;

export interface StashHooks {
  /** ひっくり返し始めた（つばの上の物を落とす） */
  onTip?: () => void;
  /** 地面に置いて三つ編みを放した（ここから呼ぶ側が中へ入れる。終わったら putBack を呼ぶ） */
  onDown?: () => void;
  /** かぶり終えた */
  onDone?: () => void;
  /** 途中でやめた（帽子は頭へ戻る） */
  onCancel?: () => void;
}

export class HatStash {
  private phase: Phase = 'idle';
  private t = 0;
  private hooks: StashHooks | null = null;
  private tipped = false;
  /** 始めたときの体の前の向き（水平）・三つ編みの側（水平）・立っていた所・向き（rad） */
  private readonly front = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private sideSign = 1;
  private readonly spot = new THREE.Vector3();
  private heading = 0;
  /** つかむ所（帽子の座標） */
  private readonly grabLocal = new THREE.Vector3();
  /** 置いたときにつかむ所（ワールド）と、回す向き（+1/-1） */
  private readonly putGrab = new THREE.Vector3();
  /** 置いたときの帽子の中心（地面の上）と、つばの半径（m） */
  private readonly putCenter = new THREE.Vector3();
  private putRim = 0;
  private turnSign = 1;
  /** 広い所へ移った回数と、その行き先 */
  private clearTries = 0;
  private readonly clearTo = new THREE.Vector3();
  /** 戻る行き先（脱いだ所。ケースの壁ぎわでは行ける範囲の内側へ寄った所） */
  private readonly backTo = new THREE.Vector3();
  /** かぶる向きのまま置く（逆さにしない） */
  private upright = false;
  /** 地面に置いた帽子の置き場（行列） */
  private readonly ground = new THREE.Matrix4();
  /** やめたときの帽子の置き場（ここから頭へ戻る） */
  private readonly from = new THREE.Matrix4();
  private fromCrush = 0;
  private readonly carry = new THREE.Matrix4();
  private readonly pose = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(private readonly y: Yukkuri) {}

  /** 帽子を外している途中か（始めてからかぶり終えるまで。頭へ戻る途中も含む） */
  get active(): boolean {
    return this.phase !== 'idle';
  }

  /** 帽子を地面に置いて、呼ぶ側が中へ入れるのを待っているか */
  get down(): boolean {
    return this.phase === 'down';
  }

  /** 地面に置いた帽子の置き場（行列） */
  get placed(): THREE.Matrix4 {
    return this.ground;
  }

  /** 地面に置いた帽子の口（ワールド。物を放り込む所） */
  mouth(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0.25, 0).applyMatrix4(this.ground);
  }

  /**
   * 脱ぎ始める。帽子・三つ編みがないとき・気絶中・倒れているときは false。
   * upright：逆さにせず、かぶる向きのまま置く（持ち上げながら水平に半回転させて、つかんだ縁を体の側にして横の地面へ）
   */
  start(hooks: StashHooks, upright = false): boolean {
    const y = this.y;
    const hat = y.outfit.hat, braid = y.outfit.braid;
    // 帽子が頭から外れている（落ちて地面にある）ときは始めない
    if (this.active || !hat || hat.carry || !braid || !braid.grip.ready || y.rest.fainting || y.locomotion.isLying || y.locomotion.tilted) return false;
    y.rest.wake(true);
    this.hooks = hooks;
    this.tipped = false;
    this.upright = upright;
    y.locomotion.stop();
    y.locomotion.hold();
    this.clearTries = 0;
    this.begin();
    return true;
  }

  /** 今いる所・向きで置く所を決めて、脱ぎ始める。置く所が皿・壁にかかるなら、先に広い所へ歩く */
  private begin(): void {
    const y = this.y;
    const hat = y.outfit.hat!;
    this.aim();
    if (!this.putClear()) {
      if (this.clearTries >= CLEAR_TRIES) {
        this.cancel();
        return;
      }
      this.clearTries++;
      this.walkClear();
      return;
    }
    hat.lined = !this.upright;
    this.go('grab');
  }

  /** 置く所を決める（今いる所・向きから） */
  private aim(): void {
    const y = this.y;
    const hat = y.outfit.hat!;
    this.front.copy(bodyFacing(y));
    const right = new THREE.Vector3(this.front.z, 0, -this.front.x);
    this.sideSign = braidSide(y).dot(right) >= 0 ? 1 : -1;
    this.side.copy(right).multiplyScalar(this.sideSign);
    this.spot.set(y.center.x, 0, y.center.z);
    this.heading = y.body.yaw;
    // つかむ所：三つ編みの側を向いたつばの上。三つ編みの側の向きを帽子の座標へ移して角度を取る
    // （帽子の軸の左右の呼び名に頼ると反対側をつかみ、帽子が頭を越えて体の上に置かれた）
    const d = this.side.clone().transformDirection(hat.worn.clone().invert());
    hat.brimLocal(Math.atan2(d.x, d.z), GRAB_R, this.grabLocal);
    this.planPut();
  }

  /** 置く所が空いているか：置いた帽子のつばがケースの壁の内側に収まり、皿などに重ならない */
  private putClear(): boolean {
    const stage = this.y.stage;
    if (!stage) return true;
    const c = this.putCenter, r = this.putRim;
    return stage.inside(c.x, c.z, r) && !stage.overlapProp(c.x, c.z, r);
  }

  /** 広い所へ歩く：置く所と反対の向き（壁・皿から離れる向き）へ、ケースの真ん中へ少し寄せて */
  private walkClear(): void {
    const y = this.y;
    const R = y.shape.radius;
    const away = new THREE.Vector3(y.center.x - this.putCenter.x, 0, y.center.z - this.putCenter.z);
    if (away.lengthSq() < 1e-8) away.copy(this.side).negate();
    away.normalize();
    const a = y.stage?.area;
    if (a) {
      const mid = new THREE.Vector3((a.minX + a.maxX) / 2 - y.center.x, 0, (a.minZ + a.maxZ) / 2 - y.center.z);
      if (mid.lengthSq() > 1e-8) away.addScaledVector(mid.normalize(), 0.5).normalize();
    }
    this.clearTo.set(y.center.x, 0, y.center.z).addScaledVector(away, R * CLEAR_STEP);
    y.stage?.limit(this.clearTo, y.stageMargin);
    y.locomotion.release();
    y.locomotion.moveTo(this.clearTo.x, this.clearTo.z);
    this.clearTo.copy(y.locomotion.target);
    this.go('clear');
  }

  /**
   * 地面にかぶる向きのまま置かれた帽子（置き場 ground。頭から落ちたときなど）を拾ってかぶる：帽子のそばへ行き、
   * つかむ所が三つ編みの側に来る向きへ回り、つかんでかぶる（脱いだ帽子をかぶり直すのと同じ。「戻る」から始める）
   */
  pickUp(ground: THREE.Matrix4, hooks: StashHooks): boolean {
    const y = this.y;
    const hat = y.outfit.hat, braid = y.outfit.braid;
    if (this.active || !hat || !braid || !braid.grip.ready || y.rest.fainting || y.locomotion.isLying || y.locomotion.tilted) return false;
    y.rest.wake(true);
    this.hooks = hooks;
    this.tipped = true;
    this.upright = true;
    hat.lined = false;
    this.ground.copy(ground);
    hat.carry = this.carry.copy(ground);
    // 三つ編みの側（aim と同じ決め方。体に対して決まる）
    this.front.copy(bodyFacing(y));
    const right = new THREE.Vector3(this.front.z, 0, -this.front.x);
    this.sideSign = braidSide(y).dot(right) >= 0 ? 1 : -1;
    this.side.copy(right).multiplyScalar(this.sideSign);
    this.heading = y.body.yaw;
    // つかむ所：つばの、ゆっくりに一番近い側
    const d = y.center.clone().applyMatrix4(ground.clone().invert());
    hat.brimLocal(Math.atan2(d.x, d.z), GRAB_R, this.grabLocal);
    const g = this.grabLocal.clone().applyMatrix4(ground);
    this.putGrab.copy(g);
    // 立つ所：つかむ所から帽子の外へ、体の半分ほど離れた所
    const c = new THREE.Vector3().setFromMatrixPosition(ground);
    const out = g.clone().sub(c).setY(0);
    if (out.lengthSq() < 1e-8) out.copy(this.side).negate();
    out.normalize();
    this.spot.copy(g).setY(0).addScaledVector(out, bodyExtent(y, out) + y.shape.radius * PUT_GAP);
    y.stage?.limit(this.spot, y.stageMargin);
    y.locomotion.stop();
    this.phase = 'down';
    this.putBack();
    return true;
  }

  /** 中へ入れ終えた：脱いだ所へ戻ってかぶり直す */
  putBack(): void {
    if (this.phase !== 'down') return;
    const y = this.y;
    this.go('back');
    y.locomotion.release();
    y.locomotion.moveTo(this.spot.x, this.spot.z);
    this.backTo.copy(y.locomotion.target);
    // 行き先がもうそばなら歩かない
    if (Math.hypot(this.backTo.x - y.center.x, this.backTo.z - y.center.z) < y.shape.radius * ARRIVE) {
      y.locomotion.stop();
      this.arrived();
    }
  }

  /**
   * 脱いだ所のそばへ戻った：その場で、置いた帽子のつかむ所が三つ編みの側（少し前）に来る向きへ回る。
   * 脱いだ所ぴったりには戻れないので（跳ねて向きを変えながら近づくと、行き先の周りを回り続けることがある）、向きで合わせる。
   * かぶるときに回す軸（体の前の向き）も、その向きに合わせ直す
   */
  private arrived(): void {
    const y = this.y;
    y.locomotion.hold();
    const g = this.grabLocal.clone().applyMatrix4(this.ground);
    const a = Math.atan2(g.x - y.center.x, g.z - y.center.z);
    this.heading = a - this.sideSign * (Math.PI / 2 - BACK_AHEAD);
    this.front.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.side.set(this.front.z, 0, -this.front.x).multiplyScalar(this.sideSign);
    this.go('turn');
  }

  /** やめる（帽子は頭へ戻る） */
  cancel(): void {
    if (!this.active || this.phase === 'snap') return;
    const y = this.y;
    const hat = y.outfit.hat;
    this.releaseBody();
    const hooks = this.hooks;
    if (hat?.carry) {
      this.from.copy(hat.carry);
      this.fromCrush = hat.crush;
      this.go('snap');
    } else this.finish();
    hooks?.onCancel?.();
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    if (!this.active) return;
    const y = this.y;
    const hat = y.outfit.hat, braid = y.outfit.braid;
    if (!hat) {
      this.finish();
      return;
    }
    this.t += dt;
    if (this.phase === 'snap') {
      const k = smooth(this.t / SNAP_TIME);
      hat.carry = blend(this.from, hat.worn, k, this.carry);
      hat.crush = this.fromCrush * (1 - k);
      if (this.t >= SNAP_TIME) this.finish();
      return;
    }
    if (!braid || y.rest.fainting || y.locomotion.isLying) {
      this.cancel();
      return;
    }
    switch (this.phase) {
      case 'clear': {
        const loco = y.locomotion;
        // ほかの行き先を指示された・あきらめた
        if ((loco.hasTarget && Math.hypot(loco.target.x - this.clearTo.x, loco.target.z - this.clearTo.z) > 1e-3) || this.t > CLEAR_GIVE_UP) {
          this.cancel();
          break;
        }
        if (loco.hasTarget && Math.hypot(this.clearTo.x - y.center.x, this.clearTo.z - y.center.z) < y.shape.radius * ARRIVE) loco.stop();
        if (!loco.hasTarget && loco.idle && !loco.tilted) {
          loco.hold();
          this.begin();
        }
        break;
      }
      case 'grab': {
        const k = smooth(this.t / GRAB_TIME);
        this.setPose(0);
        braid.reachTarget.copy(this.grabLocal).applyMatrix4(hat.worn);
        braid.reachAmount = k;
        y.lookAt(braid.reachTarget);
        if (this.t >= GRAB_TIME) this.go('off');
        break;
      }
      case 'off': {
        const k = Math.min(1, this.t / FLIP_TIME);
        hat.carry = this.flipPose(k, hat.worn, this.carry);
        hat.crush = this.upright ? 0 : smooth((k - CRUSH_FROM) / (1 - CRUSH_FROM));
        braid.reachTarget.copy(this.grabLocal).applyMatrix4(hat.carry);
        braid.reachAmount = 1;
        y.lookAt(braid.reachTarget);
        this.setPose(smooth((k - 0.5) / 0.5));
        if (!this.tipped && smooth(k) > TIP_AT) {
          this.tipped = true;
          this.hooks?.onTip?.();
        }
        if (this.t >= FLIP_TIME) {
          this.ground.copy(hat.carry);
          this.go('letGo');
        }
        break;
      }
      case 'letGo':
      case 'letGo2': {
        const k = smooth(this.t / LET_TIME);
        braid.reachAmount = 1 - k;
        this.setPose(this.phase === 'letGo' ? 1 - k : 0);
        y.lookAt(null);
        if (this.t >= LET_TIME) {
          braid.reachAmount = 0;
          if (this.phase === 'letGo') {
            this.releaseBody();
            this.go('down');
            this.hooks?.onDown?.();
          } else {
            const hooks = this.hooks;
            this.releaseBody();
            this.finish();
            hooks?.onDone?.();
          }
        }
        break;
      }
      case 'down':
        hat.carry = this.carry.copy(this.ground);
        break;
      case 'back': {
        hat.carry = this.carry.copy(this.ground);
        const loco = y.locomotion;
        // ほかの行き先を指示された・あきらめた
        if ((loco.hasTarget && Math.hypot(loco.target.x - this.backTo.x, loco.target.z - this.backTo.z) > 1e-3) || this.t > BACK_GIVE_UP) {
          this.cancel();
          break;
        }
        // 脱いだ所のそばまで来たら着いたことにする（ぴったりを狙うと、その周りを回り続けることがある）
        if (loco.hasTarget && Math.hypot(this.backTo.x - y.center.x, this.backTo.z - y.center.z) < y.shape.radius * ARRIVE) loco.stop();
        if (!loco.hasTarget && loco.idle && !loco.tilted) this.arrived();
        break;
      }
      case 'turn': {
        hat.carry = this.carry.copy(this.ground);
        const err = Math.abs(Math.atan2(Math.sin(this.heading - y.body.yaw), Math.cos(this.heading - y.body.yaw)));
        this.setPose(0);
        if ((err < TURN_OK && this.t > 0.3) || this.t > TURN_MAX) this.go('regrab');
        break;
      }
      case 'regrab': {
        hat.carry = this.carry.copy(this.ground);
        const k = smooth(this.t / GRAB_TIME);
        this.setPose(k);
        braid.reachTarget.copy(this.grabLocal).applyMatrix4(this.ground);
        braid.reachAmount = k;
        y.lookAt(braid.reachTarget);
        if (this.t >= GRAB_TIME) this.go('on');
        break;
      }
      case 'on': {
        const k = Math.min(1, this.t / FLIP_TIME);
        // 脱ぐのを逆に。戻った所・向きのずれは始めの少しの間に置いた形から寄せる
        const live = this.flipPose(1 - k, hat.worn, new THREE.Matrix4());
        hat.carry = blend(this.ground, live, smooth(k / 0.25), this.carry);
        hat.crush = this.upright ? 0 : 1 - smooth(k / (1 - CRUSH_FROM));
        braid.reachTarget.copy(this.grabLocal).applyMatrix4(hat.carry);
        braid.reachAmount = 1;
        y.lookAt(braid.reachTarget);
        this.setPose(1 - smooth(k / 0.5));
        if (this.t >= FLIP_TIME) {
          hat.carry = null;
          this.go('letGo2');
        }
        break;
      }
    }
  }

  /**
   * 脱ぐ進み k（0 でかぶっている・1 で地面に逆さ）の帽子の置き場。worn：今かぶっている置き場。
   * つかむ所を軸に、体の前の向きのまわりで外へ回し（半回転）、軸はかぶった所から置く所へ、途中を持ち上げて運ぶ
   */
  private flipPose(k: number, worn: THREE.Matrix4, out: THREE.Matrix4): THREE.Matrix4 {
    const R = this.y.shape.radius;
    const g = this.grabLocal.clone().applyMatrix4(worn);
    // 回すのは先に、運ぶのは後から（頭から持ち上げてから外へ下ろす）
    const turn = smooth(Math.min(1, k * 1.15));
    const move = smooth(k);
    const pivot = g.clone().lerp(this.putGrab, move);
    pivot.y += Math.sin(Math.PI * Math.min(1, k * 1.1)) * R * ARC;
    const rot = this.upright ? new THREE.Matrix4().makeRotationY(Math.PI * turn)
      : new THREE.Matrix4().makeRotationAxis(this.front, this.turnSign * Math.PI * turn);
    return out.makeTranslation(pivot.x, pivot.y, pivot.z).multiply(rot)
      .multiply(new THREE.Matrix4().makeTranslation(-g.x, -g.y, -g.z)).multiply(worn);
  }

  /** 置く所と回す向きを決める（つかむ所を体の三つ編みの側に、つばの根元を地面から PUT_HEIGHT に） */
  private planPut(): void {
    const y = this.y;
    const hat = y.outfit.hat!;
    const R = y.shape.radius;
    const worn = hat.worn;
    const g = this.grabLocal.clone().applyMatrix4(worn);
    const c = new THREE.Vector3().setFromMatrixPosition(worn).sub(g);
    // 外へ回す向き：四半回転のとき、帽子の中心がつかむ所より上に来る向き
    const up = (s: number) => c.clone().applyAxisAngle(this.front, (s * Math.PI) / 2).y;
    this.turnSign = up(1) >= up(-1) ? 1 : -1;
    const flipped = this.upright ? c.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
      : c.clone().applyAxisAngle(this.front, this.turnSign * Math.PI);
    const scale = new THREE.Vector3().setFromMatrixColumn(worn, 1).length();
    // つばの縁はつかむ所よりさらに外へ出ている。その縁が体の表面より外に来るように（重なると体の輪郭線がつばを突き抜けて見えた）
    const edge = this.grabLocal.clone().multiplyScalar(1 / Math.hypot(this.grabLocal.x, this.grabLocal.z));
    const rim = hat.brimLocal(Math.atan2(edge.x, edge.z), 1, new THREE.Vector3());
    const overhang = Math.hypot(rim.x - this.grabLocal.x, rim.z - this.grabLocal.z) * scale;
    // かぶる向きのまま置くときは少し遠くへ（おたべなさいで、割れて外へ傾く半分がつばに当たらないように）
    const out = Math.max(R * PUT_SIDE, bodyExtent(y, this.side) + overhang + R * (this.upright ? UPRIGHT_GAP : PUT_GAP));
    this.putGrab.copy(this.spot).addScaledVector(this.side, out).addScaledVector(this.front, R * PUT_AHEAD);
    this.putGrab.y = (this.upright ? UPRIGHT_HEIGHT : PUT_HEIGHT) * scale - flipped.y;
    this.putCenter.copy(this.putGrab).add(flipped).setY(0);
    this.putRim = hat.brimLocal(0, 1, new THREE.Vector3()).setY(0).length() * scale;
  }

  /** 身ぶり：始めた向きを向き、三つ編みの側へ lean の割合だけ傾ける */
  private setPose(lean: number): void {
    this.euler.set(0, this.heading, -this.sideSign * LEAN * lean);
    this.pose.setFromEuler(this.euler);
    this.y.locomotion.gesture = { orientation: this.pose, squash: 1 - 0.06 * lean };
  }

  private go(phase: Phase): void {
    this.phase = phase;
    this.t = 0;
  }

  /** 三つ編み・身ぶり・移動の保留を戻す */
  private releaseBody(): void {
    const y = this.y;
    const braid = y.outfit.braid;
    if (braid) braid.reachAmount = 0;
    y.lookAt(null);
    if (y.locomotion.gesture?.orientation === this.pose) y.locomotion.gesture = null;
    y.locomotion.release();
  }

  private finish(): void {
    const hat = this.y.outfit.hat;
    if (hat) {
      hat.carry = null;
      hat.crush = 0;
      hat.lined = true;
    }
    this.phase = 'idle';
    this.hooks = null;
  }
}

/** 行列 a から b へ k の割合だけ寄せる（位置・向き・大きさを別々に） */
export function blend(a: THREE.Matrix4, b: THREE.Matrix4, k: number, out: THREE.Matrix4): THREE.Matrix4 {
  const pa = new THREE.Vector3(), qa = new THREE.Quaternion(), sa = new THREE.Vector3();
  const pb = new THREE.Vector3(), qb = new THREE.Quaternion(), sb = new THREE.Vector3();
  a.decompose(pa, qa, sa);
  b.decompose(pb, qb, sb);
  return out.compose(pa.lerp(pb, k), qa.slerp(qb, k), sa.lerp(sb, k));
}
