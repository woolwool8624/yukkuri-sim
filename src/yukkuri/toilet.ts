import * as THREE from 'three';
import type { LyingPose } from './locomotion';
import type { Yukkuri } from './Yukkuri';

/**
 * といれでうんうんする：といれのあるマップ（飼育ケース・森）では、うんうんは基本といれでする（指示）。
 *   （寝転がっていれば起き上がる）→ 寄る（といれの手前の縁。指示：奥までまっすぐ進まず、手前で立ち止まる）→ といれを向いて立ち止まる →
 *   出し方をランダムに選ぶ（指示）→（そこで出すと塊がといれに納まらなければ、這って寄る）→ その場で向きを変える →
 *   （寝転ぶ）→（出す前に塊の行き先を見積もり、それでもはみ出す分だけ少しずれる）→
 *   うんうん（Dropping）→ 寝転んで出したら跳ね起きて、跳ねてすっきりー（指示：うんうんたいそうと同じように）
 * 出し方は 3 通り（指示）：
 *   ふりむいて立ったまま … 背中をといれに向けて、体の後ろへ出す
 *   仰向け …………………… といれを向いたまま後ろへ倒れて、元の向きの前（といれの側）へ出す
 *                           （横に転がって塊が体の後ろに出る体型（いもむし型）は、ふりむいてから仰向けになる）
 *   ふりむいて腹ばい …… 背中をといれに向けて前へ倒れ、体の後ろ（といれの側）へ出す
 * どの出し方でも塊がといれの中に納まるようにする：出し方を決めたら、今いる所でその体勢で出した塊の真ん中を見積もり、
 * といれの縁から TOL_IN 内側の範囲に入るならその場で出す。入らなければ、塊の真ん中がといれの真ん中に来る立ち位置へ
 * 這って寄る（扁平型・いもむし型の仰向けは塊が横へ大きくずれる）。
 * 指示（見た目を自然に）：体ごと滑らせて位置を合わせない。前は立ち止まる間・向きを変える間・寝転んだ後に、それぞれ体ごと滑らせていた
 * （向きを変える間に最大 1.35 m）。今は滑るのは、寝転んだ後の見積もりでなおはみ出す分だけ。
 * といれのないマップ（平地）と、うんうんたいそうは、その場でする（指示）
 */
type Phase = 'idle' | 'getUp' | 'approach' | 'stop' | 'move' | 'turn' | 'lie' | 'scoot' | 'poo';
type Pose = 'stand' | LyingPose;

/**
 * 寝転んでから出したときの塊の真ん中：寝転ぶ前に立っていた所からみた [前（+）への距離, 右（+）への距離]（m）。体型ごとに測った値
 * （腹ばいは前へ倒れ、塊は元の位置の後ろ。仰向けは後ろへ倒れ、塊は前の方へ。扁平型・いもむし型の仰向けは横に転がるので、横へずれる）。
 * 立ったままのときは、その場で出したときの行き先を見積もって使う（Dropping.predict）。
 * 表にない体型（ユーザー設定）はボール型の値を胴の半径に合わせて使い、一度寝転んで見積もった値を覚えて次から使う
 */
const LYING_MID: Record<string, Record<LyingPose, [number, number]>> = {
  ball: { prone: [-0.78, 0], supine: [0.12, 0] },
  egg: { prone: [-0.79, 0], supine: [0.13, 0] },
  chick: { prone: [-0.95, -0.04], supine: [0.01, -0.01] },
  // 扁平型の仰向けは出口が背中の端になり、出る側を左に決めたときの値（Dropping の仰向けの出口）
  flat: { prone: [-0.9, 0], supine: [-0.5, 1.2] },
  eggplant: { prone: [-0.81, 0.03], supine: [0.26, -0.03] },
  // いもむし型の仰向けは、横へ転がる向きを 1 に決めたときの値（向きがランダムだった頃は右へ 0.67 m の側もあった）
  caterpillar: { prone: [-1.24, 0], supine: [-1.32, -0.45] },
};
/** 出し方：体勢と、ふりむくか */
const WAYS: { pose: Pose; turn: boolean }[] = [
  { pose: 'stand', turn: true },
  { pose: 'supine', turn: false },
  { pose: 'prone', turn: true },
];
/** 寄る：この距離（胴の半径に対する比）まで来たら着いたことにする。あきらめるまでの時間（秒。道のり 1 m ごとに足す） */
const ARRIVE = 0.6;
const GIVE_UP = 12;
const GIVE_UP_PER_M = 9;
/** 手前で立ち止まる：といれの縁から体の真ん中までの間（胴の半径に対する比。縁の外）と、止まっている時間（秒） */
const STOP_OUT = 0.3;
const STOP_TIME = 0.7;
/** 向きを合わせる許し（rad）と最長時間（秒。ふりむくときは長め）。寝転ぶ・起き上がるのを待つ上限（秒） */
const TURN_OK = 0.12;
const TURN_MAX = 2.5;
const TURN_BACK_MAX = 3.5;
const POSE_MAX = 8;
/** 塊の真ん中がこの範囲（といれの縁から TOL_IN m 内側）に入れば、その場で出す */
const TOL_IN = 0.3;
/** 出し方を決めた後に這って寄り直す回数の上限（着いたことにする距離 ARRIVE までずれて着くので、見積もり直して足りなければもう一度） */
const MOVE_TRIES = 2;
/**
 * 寝転んだ後、見積もりでなお塊がはみ出すときにずれる：時間（秒。基本の時間に、1 m あたりの時間を足す）と、一番長い距離（m）
 */
const SCOOT_TIME = 0.3;
const SCOOT_PER_M = 3;
const SCOOT_MAX = 0.4;
/** 仰向けで、ふりむくかを決めるときの重み：ふりむく分（m 相当）と、範囲の縁で寄せられた 1 m あたり */
const PLACE_TURN_COST = 0.3;
const PLACE_CLAMP_COST = 3;

export class ToiletTrip {
  private phase: Phase = 'idle';
  private t = 0;
  private pose: Pose = 'stand';
  /** ふりむくか・もうふりむいたか */
  private turnBack = false;
  private giveUp = GIVE_UP;
  private tries = 0;
  /** といれの方を向く向き（手前の立ち位置から） */
  private facing = 0;
  private heading = 0;
  private readonly stand = new THREE.Vector3();
  /** 寝転ぶ前に立っていた所と向き（寝転んだ後の塊の行き先を覚えるのに使う） */
  private readonly before = new THREE.Vector3();
  private beforeYaw = 0;
  /** 寝転んで見積もった塊の真ん中（体型・体勢ごと。[前, 右]） */
  private readonly learned = new Map<string, [number, number]>();
  /** 位置を合わせる：まだ滑る残り（m）と、滑る時間（秒） */
  private readonly scoot = new THREE.Vector3();
  private scootTime = SCOOT_TIME;
  private readonly orient = new THREE.Quaternion();

  constructor(private readonly y: Yukkuri) {}

  /** といれへ向かっているところから、うんうんを出し終えるまで */
  get active(): boolean {
    return this.phase !== 'idle';
  }

  /**
   * うんうんする：といれがあれば、といれへ行ってする。なければその場で（Dropping.start）。
   * 始められないとき（ほかの動きの途中・気絶中）は false
   */
  start(): boolean {
    const y = this.y;
    const toilet = y.stage?.toilet;
    // といれがない・足焼きで移動できないときは、その場でする
    if (!toilet || y.locomotion.immobile) return y.dropping.start();
    if (this.active || y.dropping.active || y.feeding.active || y.exercise.active || y.vomit.active || y.rest.fainting) return false;
    y.rest.wake(true);
    const loco = y.locomotion;
    if (loco.isLying || loco.tilted) {
      y.getUp();
      this.go('getUp');
    } else this.plan();
    return true;
  }

  /** やめる（滑る・寝転ぶ途中ならそのまま。うんうんを出し始めていれば、それは Dropping に任せる） */
  cancel(): void {
    if (!this.active) return;
    this.end();
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    if (this.phase === 'idle') return;
    const y = this.y;
    const loco = y.locomotion;
    const R = y.shape.radius;
    this.t += dt;
    if (y.rest.fainting && this.phase !== 'poo') {
      this.cancel();
      return;
    }
    switch (this.phase) {
      case 'getUp':
        if ((loco.idle && !loco.tilted) || this.t > POSE_MAX) this.plan();
        break;
      case 'approach': {
        // ほかの行き先を指示された・あきらめた（その場でもしない）
        if ((loco.hasTarget && loco.target.distanceTo(this.stand) > 1e-3) || this.t > this.giveUp) {
          this.end();
          break;
        }
        if (loco.hasTarget && Math.hypot(this.stand.x - y.center.x, this.stand.z - y.center.z) < R * ARRIVE) loco.stop();
        if (!loco.hasTarget && loco.idle && !loco.tilted) {
          loco.hold();
          this.heading = this.facing;
          this.go('stop');
        }
        break;
      }
      case 'move': {
        // 出し方を決めた後、塊がといれに納まる立ち位置へ歩いて寄る
        if ((loco.hasTarget && loco.target.distanceTo(this.stand) > 1e-3) || this.t > this.giveUp) {
          this.end();
          break;
        }
        if (loco.hasTarget && Math.hypot(this.stand.x - y.center.x, this.stand.z - y.center.z) < R * ARRIVE) loco.stop();
        if (!loco.hasTarget && loco.idle && !loco.tilted) {
          loco.hold();
          if (this.tries < MOVE_TRIES && !this.fits(y.center, this.heading)) this.moveTo(this.stand);
          else this.go('turn');
        }
        break;
      }
      case 'stop':
      case 'turn': {
        // その場で向きを変える（体ごと滑らせない）
        this.orient.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.heading);
        loco.gesture = { orientation: this.orient, squash: 1 };
        const err = Math.abs(Math.atan2(Math.sin(this.heading - y.body.yaw), Math.cos(this.heading - y.body.yaw)));
        if (this.phase === 'stop') {
          // といれを向いて立ち止まる（ここで出し方を決める）
          if ((err < TURN_OK && this.t > STOP_TIME) || this.t > TURN_MAX + STOP_TIME) {
            const way = WAYS[Math.floor(Math.random() * WAYS.length)];
            this.pose = way.pose;
            this.turnBack = way.turn;
            if (this.turnBack) this.heading = this.facing + Math.PI;
            this.tries = 0;
            // 今いる所で出して納まるなら、その場で。納まらなければ歩いて寄る
            if (this.place()) this.go('turn');
            else {
              if (loco.gesture?.orientation === this.orient) loco.gesture = null;
              this.moveTo(this.stand);
            }
          }
          break;
        }
        if ((err < TURN_OK && this.t > 0.3) || this.t > (this.turnBack ? TURN_BACK_MAX : TURN_MAX)) {
          if (loco.gesture?.orientation === this.orient) loco.gesture = null;
          // 向きを変える間に体の真ん中がずれることがある（前後に長い体型はふりむくと大きく動く）。今の所と向きで見積もり直し、
          // 納まらなければ歩いて寄り直す
          if (this.tries < MOVE_TRIES && !this.fits(y.center, y.body.yaw)) {
            this.place();
            this.moveTo(this.stand);
            break;
          }
          if (this.pose === 'stand') this.aim();
          else {
            this.before.set(y.center.x, 0, y.center.z);
            this.beforeYaw = y.body.yaw;
            // 前後に長い体型の仰向けは横へ転がる。向きを決めておく（ランダムだと塊が左右どちらへずれるか分からない）
            loco.lieDown(this.pose, false, 1);
            this.go('lie');
          }
        }
        break;
      }
      case 'lie':
        // 体が姿勢に付いてきてから見積もる（転がっている途中だと、塊の行き先の見積もりも外れる）
        if ((loco.settled && this.t > 0.5) || this.t > POSE_MAX) this.aim();
        break;
      case 'scoot': {
        // はみ出す分を、時間に合わせてなめらかにずれる（体ごと動かす）
        const k = Math.min(1, dt / Math.max(dt, this.scootTime - this.t + dt));
        const dx = this.scoot.x * k, dz = this.scoot.z * k;
        y.body.translate(dx, dz);
        this.scoot.x -= dx;
        this.scoot.z -= dz;
        if (this.t >= this.scootTime) {
          // うんうんを出す（Dropping が出し終わるまで移動を保留する）
          loco.release();
          // 寝転んで出したら、出し終わって跳ね起きてからすっきりー（指示：うんうんたいそうと同じように）
          if (y.dropping.start({ springUp: true })) this.go('poo');
          else this.end();
        }
        break;
      }
      case 'poo':
        if (!y.dropping.active) this.end();
        break;
    }
  }

  /**
   * 立ち位置を決めて歩き出す：といれの手前の縁の外（今いる所の側）。といれの真ん中を向く。
   * その側が行ける範囲の縁（ケースの壁ぎわ）にかかるなら、反対の側から
   */
  private plan(): void {
    const y = this.y;
    const t = y.stage?.toilet;
    if (!t) {
      this.end();
      return;
    }
    const R = y.shape.radius;
    const c = y.center;
    let a = Math.hypot(t.x - c.x, t.z - c.z) > 0.05 ? Math.atan2(t.x - c.x, t.z - c.z) : y.body.yaw;
    // 向き a でといれへ向かうときの、手前の縁の外の立ち位置（真ん中から、向きの逆へ縁までの距離 + 少し）
    const at = (h: number) => {
      const fx = Math.sin(h), fz = Math.cos(h);
      const edge = Math.min(t.w / 2 / Math.max(Math.abs(fx), 1e-6), t.d / 2 / Math.max(Math.abs(fz), 1e-6));
      const d = edge + R * STOP_OUT;
      return new THREE.Vector3(t.x - fx * d, 0, t.z - fz * d);
    };
    if (!y.stage!.inside(at(a).x, at(a).z, y.stageMargin)) a += Math.PI;
    this.facing = a;
    this.stand.copy(at(a));
    const loco = y.locomotion;
    if (Math.hypot(this.stand.x - c.x, this.stand.z - c.z) < R * ARRIVE) {
      loco.stop();
      loco.hold();
      this.heading = a;
      this.go('stop');
      return;
    }
    loco.moveTo(this.stand.x, this.stand.z);
    this.stand.copy(loco.target);
    this.giveUp = GIVE_UP + GIVE_UP_PER_M * Math.hypot(this.stand.x - c.x, this.stand.z - c.z);
    this.go('approach');
  }

  /**
   * 出し方を決めたら：塊の真ん中がといれの真ん中に来る立ち位置（向きは heading）を見積もって stand に入れる
   * （行ける範囲の外なら内側へ寄せる）。今いる所で出しても納まるなら true（その場で出す）
   */
  private place(): boolean {
    const y = this.y;
    const t = y.stage?.toilet;
    const mid = this.midOffset();
    if (!t || !mid) return true;
    const standFor = (h: number) => {
      if (this.fits(y.center, h, mid)) return { p: y.center.clone().setY(0), cost: 0, here: true };
      const f = new THREE.Vector3(Math.sin(h), 0, Math.cos(h)), r = new THREE.Vector3(f.z, 0, -f.x);
      const p = new THREE.Vector3(t.x, 0, t.z).addScaledVector(f, -mid[0]).addScaledVector(r, -mid[1]);
      const want = p.clone();
      y.stage!.limit(p, y.stageMargin);
      // 寄る道のり＋範囲の縁で寄せられた分（大きく寄せられると塊が外れる）
      return { p, cost: Math.hypot(p.x - y.center.x, p.z - y.center.z) + want.distanceTo(p) * PLACE_CLAMP_COST, here: false };
    };
    let best = standFor(this.heading);
    if (this.pose === 'supine') {
      // 仰向けは、塊が体の前に出るか後ろに出るか（横に転がるいもむし型は 1.3 m 後ろ）が体型で違う。
      // といれを向いたままだと奥へ回り込む体型は、ふりむいて仰向けになる（近くで済む方。ふりむく分を少し足して比べる）
      const back = standFor(this.heading + Math.PI);
      if (back.cost + PLACE_TURN_COST < best.cost) {
        best = back;
        this.heading += Math.PI;
        this.turnBack = true;
      }
    }
    this.stand.copy(best.p);
    return best.here;
  }

  /** 体の真ん中 c・向き h で今の出し方をしたとき、塊の真ん中がといれの縁から TOL_IN 内側に入るか */
  private fits(c: THREE.Vector3, h: number, mid = this.midOffset()): boolean {
    const t = this.y.stage?.toilet;
    if (!t || !mid) return true;
    const f = new THREE.Vector3(Math.sin(h), 0, Math.cos(h)), r = new THREE.Vector3(f.z, 0, -f.x);
    const x = c.x + f.x * mid[0] + r.x * mid[1], z = c.z + f.z * mid[0] + r.z * mid[1];
    return Math.abs(x - t.x) <= t.w / 2 - TOL_IN && Math.abs(z - t.z) <= t.d / 2 - TOL_IN;
  }

  /**
   * 出し方を決めた後に、立ち位置 p へ這って寄る（移動の保留を解いて行き先を出す）。すぐそばへ跳ねると行き過ぎては戻り、
   * 行き先の周りを回り続けて着かなかった（森で 18 秒回って時間切れ）。這うとゆっくり真っすぐ寄れる
   */
  private moveTo(p: THREE.Vector3): void {
    const y = this.y;
    const loco = y.locomotion;
    loco.release();
    loco.moveTo(p.x, p.z, 'crawl');
    this.stand.copy(loco.target);
    this.tries++;
    this.giveUp = GIVE_UP + GIVE_UP_PER_M * Math.hypot(this.stand.x - y.center.x, this.stand.z - y.center.z);
    this.go('move');
  }

  /** 立っている所からみた塊の真ん中 [前, 右]（m）。立ったままならその場で見積もり、寝転ぶなら覚えた値か体型ごとの値 */
  private midOffset(): [number, number] | null {
    const y = this.y;
    if (this.pose === 'stand') {
      const p = y.dropping.predict();
      if (!p) return null;
      return this.relative((p.start.x + p.end.x) / 2, (p.start.z + p.end.z) / 2, y.center, y.body.yaw);
    }
    const known = this.learned.get(`${y.presetId}/${this.pose}`) ?? LYING_MID[y.presetId]?.[this.pose];
    if (known) return known;
    const k = y.shape.radius / 0.5;
    const b = LYING_MID.ball[this.pose];
    return [b[0] * k, b[1] * k];
  }

  /** 点（x, z）を、c に向き yaw で立った体からみた [前, 右]（m）にする */
  private relative(x: number, z: number, c: THREE.Vector3, yaw: number): [number, number] {
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const dx = x - c.x, dz = z - c.z;
    return [dx * fx + dz * fz, dx * fz - dz * fx];
  }

  /** 出す直前：今の体勢で出したときの塊の真ん中を見積もり、といれの縁から TOL_IN 内側の範囲からはみ出す分だけずれる（たいていは 0） */
  private aim(): void {
    const y = this.y;
    const t = y.stage?.toilet;
    const p = y.dropping.predict();
    this.scoot.set(0, 0, 0);
    if (t && p) {
      const mx = (p.start.x + p.end.x) / 2, mz = (p.start.z + p.end.z) / 2;
      // 寝転んだときの行き先を覚える（次からはこの値で立ち位置を決める）
      if (this.pose !== 'stand') this.learned.set(`${y.presetId}/${this.pose}`, this.relative(mx, mz, this.before, this.beforeYaw));
      const hw = t.w / 2 - TOL_IN, hd = t.d / 2 - TOL_IN;
      this.scoot.set(THREE.MathUtils.clamp(mx, t.x - hw, t.x + hw) - mx, 0, THREE.MathUtils.clamp(mz, t.z - hd, t.z + hd) - mz);
      if (this.scoot.length() > SCOOT_MAX) this.scoot.setLength(SCOOT_MAX);
    }
    this.scootTime = SCOOT_TIME + SCOOT_PER_M * this.scoot.length();
    y.locomotion.hold();
    this.go('scoot');
  }

  private end(): void {
    const loco = this.y.locomotion;
    if (loco.gesture?.orientation === this.orient) loco.gesture = null;
    // 寄る・向きを合わせる・滑る途中でやめたら、移動の保留を解く（うんうんの途中なら Dropping が解く）
    if (this.phase === 'stop' || this.phase === 'move' || this.phase === 'turn' || this.phase === 'lie' || this.phase === 'scoot') loco.release();
    this.phase = 'idle';
  }

  private go(phase: Phase): void {
    this.phase = phase;
    this.t = 0;
  }
}
