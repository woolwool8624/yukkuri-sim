import * as THREE from 'three';
import { bodyFacing, showFace, type Word } from './fx';
import { BraidPick, smooth } from './braidPick';
import type { FoodRef } from './forage';
import type { NestItem } from './nestStuff';
import type { PartSelection } from '../face/parts';
import type { Yukkuri } from './Yukkuri';

/**
 * 巣作り（指示）：ボタンを押すと、巣が仕上がるまでまとめて運ぶ。おうち（おうちせんげんした所。Yukkuri.home）の地点に
 * べっどを重ねて寝床にし、たからものと食料はその横に固まりで並べる（せんげんした向きから見て、たからものは右・食料は左）。
 *   運ぶ順：べっど → たからもの → 食料（それぞれ近いものから）。食料は地面の餌（餌皿の中も。帽子のつば・中は運ばない）
 *   1 個分：三つ編みで拾う（BraidPick。枝・餌と同じ）→ 置く所へ歩く → 置く（毛先から放して、形を戻しながら置く所へ寄せる）
 *   運び方（指示）：三つ編みは垂らしたまま。べっどは端をつまみ、残りは後ろへ床を引きずる（nestStuff の pose）。
 *   たからもの・食料は硬いので、形を変えずに毛先に付ける
 * 置き終えた物は「巣に置いた」印が付き、次の巣作りでは運ばない（餌集めの「拾う」も巣の餌は拾わない）。おうちを移したら運び直す。
 * やめる：叩かれた・気絶した・寝転がった・地面をクリックした（ほかの行き先）など。運んでいる物はその場に置く
 */
type Phase = 'idle' | 'pick' | 'carry' | 'put' | 'done';

type Target = { kind: 'stuff'; it: NestItem } | { kind: 'food'; f: FoodRef };
/** 上から見た円（置く所が重ならないかを見る） */
type Spot = { x: number; z: number; r: number };

/** 着いたことにする距離（胴の半径に対する比）。この距離に入って NEAR_AFTER 秒たっても着いたことにする（周りを回り続けないよう） */
const ARRIVE = 0.6;
const NEAR = 1.6;
const NEAR_AFTER = 3;
/** あきらめるまでの時間（秒。道のり 1 m ごとに足す） */
const GIVE_UP = 12;
const GIVE_UP_PER_M = 9;
/** 拾う（BraidPick）があきらめるまでの時間の目安（秒）：これより後にやめたら「届かなかった」とみて、その物を飛ばす */
const PICK_GIVE_UP = 14;
/** 立つ所を、置く所から胴の半径のこの倍の所まで来たら、運んでいる物の実際の位置で決め直す */
const REPLAN = 3;
/** 置く：毛先から放して置く所へ寄せる時間（秒） */
const PUT_TIME = 0.6;
/** 引きずる向き：進む向きの後ろから、三つ編みの側へ寄せる割合（真後ろだと体の下に潜った）・追いつく速さ（1 秒あたり） */
const TRAIL_OUT = 0.9;
const TRAIL_RATE = 3;
/** 動いているとみなす速さ（m/s）・速さをならす割合（1 秒あたり） */
const MOVING = 0.15;
const VEL_RATE = 2;
/** 運んでいる物の、体からの位置をならす割合（1 秒あたり） */
const OFFSET_RATE = 4;
/**
 * 置く所（m、飼育ケースの縮尺。nestStuff.size を掛ける）：寝床はおうちの地点に、べっどを真ん中から輪に重ねる
 * （BED_RINGS：輪の半径と数）。たからもの・食料の固まりは、寝床の横へ CLUSTER_SIDE の所を真ん中に、空いた所を内側から詰める
 */
// 巣としてまとまって見えるよう、輪は詰めてある（指示。最初は 0.35・0.65・0.9 m で、ばらけて見えた）
const BED_RINGS: [number, number][] = [[0, 1], [0.2, 5], [0.38, 8], [0.55, 12]];
const CLUSTER_SIDE = 0.85;
/** 固まりが寝床に乗らないよう避ける、寝床の広がり（半径。m、飼育ケースの縮尺） */
const BED_SPAN = 0.65;
/**
 * 細長い物（当たり棒・羽根。NestKind.len）を固まりに詰めるとき：寝床のふちに沿う向きに寝かせ、長さに沿って並べた円
 * （真ん中から長さの STICK_DOTS 倍の所に、半径は長さの STICK_DOT_R 倍）で場所を取る。長い棒を丸い物 1 つとして扱うと
 * 広い所を取って固まりから離れ、細い物 1 つとして扱うと両端にほかのたからものが重なった
 */
const STICK_DOTS = [-0.35, 0, 0.35];
const STICK_DOT_R = 0.125;
/** 固まりで隣と空ける間（半径の和に対する比）・内側から探す輪の数 */
const CLUSTER_GAP = 0.85;
const CLUSTER_RINGS = 14;
/** 終わった後の顔を出しておく時間（秒） */
const DONE_TIME = 2.4;

const FACE_DONE: Partial<PartSelection> = { eyes: 'smile', brows: 'neutral', mouth: 'smile' };

export class NestBuild {
  private phase: Phase = 'idle';
  private t = 0;
  private readonly picker: BraidPick;
  private target: Target | null = null;
  /** 運べなかった物（この巣作りの間は飛ばす） */
  private readonly skip = new Set<unknown>();
  /** 置く所・向き・浮かせる高さと、歩いて立つ所 */
  private readonly slot = new THREE.Vector3();
  /** 寝床に重ねる物（べっど）か：置くとき下の物にかぶせて乗せる */
  private bed = false;
  /** 置く向き（決めていなければ null：運んできた向きのまま） */
  private slotYaw: number | null = null;
  /** 運んでいる物を持ち上げた（持ち上げ始めてから、置くまで） */
  private carried = false;
  private readonly stand = new THREE.Vector3();
  private replanned = false;
  private giveUp = GIVE_UP;
  /** 引きずる形の割合・持ち上げたときの向き・引きずる向き（物の +z が向く向き） */
  private b = 0;
  private yaw0 = 0;
  private trail = 0;
  private readonly vel = new THREE.Vector3();
  private readonly prevC = new THREE.Vector3();
  private hasPrev = false;
  /** 運んでいる物の置き場の、体から見た位置（前・横。m） */
  private offF = 0;
  private offS = 0;
  /** 置く：寄せ始めた位置と向き */
  private readonly from = new THREE.Vector3();
  private fromYaw = 0;
  /** 移動を保留しているか（置く間） */
  private holding = false;
  /** 巣を作ったおうち（おうちを移したら、巣に置いた印を外して運び直す） */
  private builtAt: { x: number; z: number } | null = null;
  private moved = 0;
  private ending = false;
  private face: Partial<PartSelection> | null = null;
  private word: Word | null = null;

  constructor(private readonly y: Yukkuri) {
    this.picker = new BraidPick(y);
  }

  /** 巣作りの途中か（最初の物へ向かってから、できあがりの顔を出し終えるまで） */
  get active(): boolean {
    return this.phase !== 'idle';
  }

  /** 今始められないわけ（始められるなら null）：おうちが決まっていない・運ぶ物がない */
  reason(): string | null {
    const y = this.y;
    if (!y.home.current) return y.line('nestNoHome');
    this.checkHome();
    if (!this.nextTarget()) return y.line('nestNone');
    return null;
  }

  /** 始める。始められないとき（おうちがない・運ぶ物がない）はわけを言って false。ほかの動きの途中なら黙って false */
  start(): boolean {
    const y = this.y;
    if (this.active || this.busyElsewhere()) return false;
    const why = this.reason();
    if (why) {
      this.say(why, 1.8);
      return false;
    }
    if (y.stuck()) return false;
    y.rest.wake(true);
    if (y.locomotion.isLying) y.getUp();
    this.skip.clear();
    this.moved = 0;
    this.next();
    return true;
  }

  /** やめる（運んでいる物はその場に置く。顔・身ぶりを戻す） */
  cancel(): void {
    if (!this.active || this.ending) return;
    this.ending = true;
    this.picker.cancel();
    this.dropHere();
    this.end();
    this.ending = false;
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    if (this.phase === 'idle') return;
    const y = this.y;
    const loco = y.locomotion;
    const R = y.shape.radius;
    this.t += dt;
    if (y.rest.fainting || y.rest.sleeping || y.death.active || y.vomit.active || !y.outfit.braid) {
      this.cancel();
      return;
    }
    if (this.target && this.gone(this.target)) {
      // 片付けられた（マップを変えた・「片付ける」を押した）
      this.ending = true;
      this.picker.cancel();
      this.ending = false;
      this.target = null;
      this.carried = false;
      this.releaseHold();
      if (this.phase !== 'done') this.next();
      return;
    }
    this.picker.update(dt);
    this.watchMotion(dt);
    switch (this.phase) {
      case 'pick':
        if (this.picker.lifting) this.b = this.picker.liftK;
        break;
      case 'carry': {
        this.b = Math.min(1, this.b + dt / PUT_TIME);
        if (loco.isLying || loco.tilted) {
          this.cancel();
          break;
        }
        // ほかの行き先を指示された・あきらめた
        if ((loco.hasTarget && loco.target.distanceTo(this.stand) > 1e-3) || this.t > this.giveUp) {
          this.cancel();
          break;
        }
        const far = Math.hypot(this.stand.x - y.center.x, this.stand.z - y.center.z);
        // 置く所に近づいたら、運んでいる物の実際の位置（引きずって後ろへ流れた所）で立つ所を決め直す
        if (!this.replanned && Math.hypot(this.slot.x - y.center.x, this.slot.z - y.center.z) < R * REPLAN) {
          this.replanned = true;
          this.planStand();
          break;
        }
        if (loco.hasTarget && (far < R * ARRIVE || (far < R * NEAR && this.t > NEAR_AFTER))) loco.stop();
        if (!loco.hasTarget && loco.idle) {
          loco.hold();
          this.holding = true;
          this.from.copy(this.placePoint());
          if (this.target?.kind === 'stuff') {
            const it = this.target.it;
            this.fromYaw = it.object.rotation.y;
            // べっど：寝床のほかのべっどにかぶさって乗るよう、置いたときの高さを先に決める（突き抜けないように。置く間に少しずつ乗せる）
            if (this.bed) {
              const under = y.nestStuff.list(true).filter((i) => i.kind.category === 'bedding');
              y.nestStuff.prepareSettle(it, under, this.slot.x, this.slot.z, this.slotYaw ?? it.object.rotation.y);
            }
          }
          this.go('put');
        }
        break;
      }
      case 'put':
        if (this.t >= PUT_TIME) this.place();
        break;
      case 'done':
        if (this.t >= DONE_TIME) this.end();
        break;
    }
  }

  /** 描画の直前に呼ぶ（三つ編みの毛先が決まった後）：運んでいる物を毛先に付ける・置く所へ寄せる */
  sync(): void {
    const tg = this.target;
    if (!tg || (this.phase !== 'pick' && this.phase !== 'carry' && this.phase !== 'put')) return;
    if (this.phase === 'pick' && !this.picker.lifting) return;
    const y = this.y;
    const grip = y.outfit.braid?.grip;
    if (!grip?.ready && this.phase !== 'put') return;
    const ns = y.nestStuff;
    if (this.phase === 'put') {
      // 毛先から放し、形を戻しながら置く所へ寄せる
      const k = smooth(this.t / PUT_TIME);
      const to = new THREE.Vector3(this.slot.x, tg.kind === 'stuff' ? 0 : this.from.y * (1 - k), this.slot.z);
      const p = this.from.clone().lerp(to, k);
      if (tg.kind === 'stuff') {
        tg.it.object.position.copy(p);
        if (this.slotYaw !== null) tg.it.object.rotation.y = lerpAngle(this.fromYaw, this.slotYaw, k);
        tg.it.settled = this.bed ? k : 0;
        ns.reshape(tg.it, 1 - k);
      } else tg.f.object.position.copy(p);
      return;
    }
    if (tg.kind === 'stuff') {
      const yaw = ns.drags(tg.it) ? lerpAngle(this.yaw0, this.trail, this.b) : this.yaw0;
      ns.pose(tg.it, grip!.pos, yaw, this.b);
    } else {
      tg.f.object.position.copy(grip!.pos).addScaledVector(grip!.down, tg.f.r * 0.6);
    }
  }

  /** 次の物を拾いに行く（べっど → たからもの → 食料、それぞれ近いものから）。なければできあがり */
  private next(): void {
    const tg = this.nextTarget();
    this.target = tg;
    if (!tg) {
      this.finishAll();
      return;
    }
    const y = this.y;
    const ns = y.nestStuff;
    const grab = () => (tg.kind === 'stuff' ? ns.grabPoint(tg.it) : tg.f.object.position.clone().setY(0));
    const line = tg.kind === 'food' ? 'nestFood' : tg.it.kind.category === 'bedding' ? 'nestBed' : 'nestTreasure';
    this.b = 0;
    this.go('pick');
    const ok = this.picker.start({
      grabPoint: grab,
      onLower: () => this.say(y.line(line), 1.4),
      onLift: () => {
        this.carried = true;
        if (tg.kind === 'stuff') {
          ns.hold(tg.it);
          this.yaw0 = tg.it.object.rotation.y;
        } else tg.f.hold();
        this.trail = this.yaw0;
      },
      onDone: () => this.startCarry(),
      onCancel: () => {
        if (this.ending) return;
        const loco = y.locomotion;
        // 届かずにあきらめた：その物は飛ばして次へ。ほかの行き先を指示された・寝転がった：巣作りをやめる
        if (this.t > PICK_GIVE_UP && !loco.isLying) {
          this.dropHere();
          this.skip.add(tg.kind === 'stuff' ? tg.it : tg.f.object);
          this.target = null;
          this.next();
        } else this.cancel();
      },
    });
    if (!ok) this.cancel();
  }

  /** 拾い終えた：置く所を決めて歩き出す */
  private startCarry(): void {
    const tg = this.target!;
    this.chooseSlot(tg);
    this.replanned = false;
    this.measureOffset(1);
    this.go('carry');
    this.planStand();
  }

  /** 立つ所：置く所へ向かって歩いたとき、運んでいる物（体から見て前 offF・横 offS の所）がちょうど置く所に来る所 */
  private planStand(): void {
    const y = this.y;
    const h = new THREE.Vector3(this.slot.x - y.center.x, 0, this.slot.z - y.center.z);
    if (h.lengthSq() < 1e-6) h.copy(bodyFacing(y));
    h.normalize();
    const side = new THREE.Vector3(h.z, 0, -h.x);
    this.stand.copy(this.slot).addScaledVector(h, -this.offF).addScaledVector(side, -this.offS);
    const loco = y.locomotion;
    loco.moveTo(this.stand.x, this.stand.z);
    this.stand.copy(loco.target);
    this.giveUp = this.t + GIVE_UP + GIVE_UP_PER_M * Math.hypot(this.stand.x - y.center.x, this.stand.z - y.center.z);
  }

  /** 置く：置く所に元の形で置き、巣に置いた印を付けて次へ */
  private place(): void {
    const tg = this.target!;
    const ns = this.y.nestStuff;
    if (tg.kind === 'stuff') {
      tg.it.settled = this.bed ? 1 : 0;
      ns.put(tg.it, this.slot.x, this.slot.z, this.slotYaw ?? tg.it.object.rotation.y, true);
    }
    else tg.f.put(this.slot.x, this.slot.z, true);
    this.target = null;
    this.carried = false;
    this.moved++;
    this.releaseHold();
    this.next();
  }

  /** 運んでいる物をその場に置く（巣に置いた印は付けない） */
  private dropHere(): void {
    const tg = this.target;
    if (!tg || this.gone(tg) || !this.carried) return;
    this.carried = false;
    const p = this.placePoint();
    if (tg.kind === 'stuff') this.y.nestStuff.put(tg.it, p.x, p.z, tg.it.object.rotation.y, false);
    else tg.f.put(p.x, p.z, false);
    this.target = null;
  }

  /** 次に運ぶ物（運べなかった物を除く） */
  private nextTarget(): Target | null {
    const y = this.y;
    const c = y.center;
    const near = <T>(list: T[], pos: (v: T) => THREE.Vector3): T | null => {
      let best: T | null = null, bd = Infinity;
      for (const v of list) {
        if (this.skip.has(v) || this.skip.has((v as { object?: unknown }).object)) continue;
        const p = pos(v);
        const d = Math.hypot(p.x - c.x, p.z - c.z);
        if (d < bd) {
          bd = d;
          best = v;
        }
      }
      return best;
    };
    const loose = y.nestStuff.list(false);
    for (const cat of ['bedding', 'treasure'] as const) {
      const it = near(loose.filter((i) => i.kind.category === cat), (i) => i.object.position);
      if (it) return { kind: 'stuff', it };
    }
    const f = near(y.forage.nestFoods(false), (v) => v.object.position);
    return f ? { kind: 'food', f } : null;
  }

  /** 置く所を決める：べっどはおうちの寝床の輪、たからものは右横・食料は左横の固まりの空いた所 */
  private chooseSlot(tg: Target): void {
    const y = this.y;
    const home = y.home.current!;
    const s = y.nestStuff.size;
    const f = new THREE.Vector3(Math.sin(home.yaw), 0, Math.cos(home.yaw));
    // ゆっくりから見た右（前 × 上）
    const right = new THREE.Vector3(-f.z, 0, f.x);
    const center = new THREE.Vector3(home.x, 0, home.z);
    this.slotYaw = null;
    this.bed = false;
    if (tg.kind === 'stuff' && tg.it.kind.category === 'bedding') {
      const n = y.nestStuff.list(true).filter((i) => i.kind.category === 'bedding').length;
      let k = n, ring = 0;
      while (ring < BED_RINGS.length - 1 && k >= BED_RINGS[ring][1]) k -= BED_RINGS[ring++][1];
      const [r, count] = BED_RINGS[ring];
      const a = home.yaw + (k / count) * Math.PI * 2 + ring * 0.4 + (ring === BED_RINGS.length - 1 ? Math.random() : 0);
      const rr = y.nestStuff.radius(tg.it);
      // 壁（うろの幹など）にかかる・おうちとうろの中と外が違うなら、おうちの側へ寄せる
      for (let t = 1; t >= 0; t -= 0.1) {
        this.slot.set(center.x + Math.sin(a) * r * s * t, 0, center.z + Math.cos(a) * r * s * t);
        if (this.reachable(this.slot.x, this.slot.z, rr * 0.5)) break;
      }
      y.stage?.limit(this.slot, rr * 0.5);
      this.bed = true;
      return;
    }
    const treasure = tg.kind === 'stuff';
    const mid = center.clone().addScaledVector(right, (treasure ? 1 : -1) * CLUSTER_SIDE * s);
    // 場所の取り方（上から見た円の集まり）：細長い物は寝床のふちに沿う向きの棒、ほかは丸
    const stickYaw = (x: number, z: number) => {
      const out = new THREE.Vector3(x - home.x, 0, z - home.z);
      if (out.lengthSq() < 1e-6) out.copy(right);
      return Math.atan2(out.z, -out.x);
    };
    const stickDots = (len: number, x: number, z: number, yaw: number): Spot[] =>
      STICK_DOTS.map((d) => ({ x: x + Math.sin(yaw) * d * len * s, z: z + Math.cos(yaw) * d * len * s, r: STICK_DOT_R * len * s }));
    const footprint = (i: NestItem): Spot[] => {
      const p = i.object.position;
      return i.kind.len ? stickDots(i.kind.len, p.x, p.z, i.object.rotation.y) : [{ x: p.x, z: p.z, r: y.nestStuff.radius(i) }];
    };
    const len = tg.kind === 'stuff' ? tg.it.kind.len ?? 0 : 0;
    const stick = len > 0;
    const r = tg.kind === 'stuff' ? (stick ? STICK_DOT_R * len * s : y.nestStuff.radius(tg.it)) : tg.f.r;
    const shape = (x: number, z: number): Spot[] => (stick ? stickDots(len, x, z, stickYaw(x, z)) : [{ x, z, r }]);
    const taken: Spot[] = treasure
      ? y.nestStuff.list(true).filter((i) => i.kind.category === 'treasure').flatMap(footprint)
      : y.forage.nestFoods(true).map((v) => ({ x: v.object.position.x, z: v.object.position.z, r: v.r }));
    taken.push({ x: home.x, z: home.z, r: BED_SPAN * s });
    this.slot.copy(this.clusterSpot(mid, r, shape, taken));
    if (stick) this.slotYaw = stickYaw(this.slot.x, this.slot.z);
  }

  /**
   * 置く所にしてよいか：中心（x, z）・半径 r の円が壁（うろの幹・木・岩など）にかからず、おうちと同じ側（うろの中か外か）にある
   * （寝床の輪や固まりが、うろの壁の向こう側に出た）
   */
  private reachable(x: number, z: number, r: number): boolean {
    const st = this.y.stage;
    const home = this.y.home.current;
    if (!st) return true;
    if (st.blocked(x, z, r + 0.03)) return false;
    return !home || st.inHollow(x, z) === st.inHollow(home.x, home.z);
  }

  /** 固まりの置き場：真ん中 mid から内側の輪から順に、隣と重ならず、行ける範囲の内側で皿・といれ・壁にかからない所 */
  private clusterSpot(mid: THREE.Vector3, r: number, shape: (x: number, z: number) => Spot[], taken: Spot[]): THREE.Vector3 {
    const st = this.y.stage;
    const step = Math.max(r, 0.04) * 1.1;
    const fits = (x: number, z: number) => shape(x, z).every((c) => {
      if (st && (!st.inside(c.x, c.z, c.r + 0.05) || st.overlapProp(c.x, c.z, c.r + 0.05) || st.inToilet(c.x, c.z, -c.r))) return false;
      if (!this.reachable(c.x, c.z, c.r)) return false;
      return taken.every((o) => Math.hypot(c.x - o.x, c.z - o.z) >= (c.r + o.r) * CLUSTER_GAP);
    });
    for (let ring = 0; ring <= CLUSTER_RINGS; ring++) {
      const n = ring === 0 ? 1 : ring * 6;
      const a0 = Math.random() * Math.PI * 2;
      for (let i = 0; i < n; i++) {
        const a = a0 + (i / n) * Math.PI * 2;
        const x = mid.x + Math.sin(a) * ring * step, z = mid.z + Math.cos(a) * ring * step;
        if (fits(x, z)) return new THREE.Vector3(x, 0, z);
      }
    }
    // 見つからなければ真ん中（範囲の内側へ寄せて）
    const p = mid.clone();
    st?.limit(p, r);
    return p;
  }

  /** 体の速さと、引きずる向き・運んでいる物の体からの位置を追う */
  private watchMotion(dt: number): void {
    const y = this.y;
    const c = y.center;
    if (this.hasPrev && dt > 0) {
      this.vel.lerp(c.clone().sub(this.prevC).setY(0).divideScalar(dt), Math.min(1, dt * VEL_RATE));
    }
    this.prevC.copy(c);
    this.hasPrev = true;
    if (this.phase !== 'pick' && this.phase !== 'carry') return;
    // 引きずる向き：進む向きの後ろ（止まっている間は体の後ろ）を、三つ編みの側へ少し寄せる
    const back = this.vel.length() > MOVING ? this.vel.clone().normalize().negate() : bodyFacing(y).negate();
    const g = y.outfit.braid?.grip;
    const out = g?.ready ? new THREE.Vector3(g.pos.x - c.x, 0, g.pos.z - c.z) : new THREE.Vector3();
    out.addScaledVector(back, -out.dot(back));
    if (out.lengthSq() > 1e-6) out.normalize();
    const dir = back.addScaledVector(out, TRAIL_OUT).normalize();
    this.trail = lerpAngle(this.trail, Math.atan2(dir.x, dir.z), Math.min(1, dt * TRAIL_RATE));
    if (this.phase === 'carry' && this.vel.length() > MOVING) this.measureOffset(Math.min(1, dt * OFFSET_RATE));
  }

  /** 運んでいる物の置き場を、体の進む向きから見た前・横で測る（k の割合で寄せる） */
  private measureOffset(k: number): void {
    const y = this.y;
    const h = this.vel.length() > MOVING ? this.vel.clone().normalize() : bodyFacing(y);
    const side = new THREE.Vector3(h.z, 0, -h.x);
    const v = this.placePoint().sub(y.center).setY(0);
    this.offF += (v.dot(h) - this.offF) * k;
    this.offS += (v.dot(side) - this.offS) * k;
  }

  /** 運んでいる物の置き場（べっどは引きずった形を戻したときの真ん中、ほかは物の位置） */
  private placePoint(): THREE.Vector3 {
    const tg = this.target;
    if (!tg) return this.y.center.clone();
    return (tg.kind === 'stuff' ? tg.it.object.position : tg.f.object.position).clone();
  }

  private gone(tg: Target): boolean {
    return tg.kind === 'stuff' ? this.y.nestStuff.gone(tg.it) : tg.f.gone();
  }

  /** ほかの動きの途中か（巣作りを始めない） */
  private busyElsewhere(): boolean {
    const y = this.y;
    return y.feeding.active || y.dropping.active || y.toilet.active || y.cleanup.active || y.grill.active || y.exercise.active
      || y.vomit.active || y.rest.fainting || y.death.active || y.otabe.active || y.dishEat.active
      || y.forage.busy || y.branch.holding || y.branch.busy || y.box.busy;
  }

  /** おうちを移していたら、巣に置いた印を外す（新しいおうちへ運び直す） */
  private checkHome(): void {
    const h = this.y.home.current;
    if (!h) return;
    if (this.builtAt && (this.builtAt.x !== h.x || this.builtAt.z !== h.z)) {
      this.y.nestStuff.forgetNest();
      this.y.forage.forgetNest();
    }
    this.builtAt = { x: h.x, z: h.z };
  }

  /** 全部運び終えた：にっこりして一言 */
  private finishAll(): void {
    const y = this.y;
    if (this.moved > 0) {
      showFace(y, FACE_DONE);
      this.face = y.face.override;
      this.say(y.line('nestDone'), DONE_TIME);
    }
    this.go('done');
  }

  private end(): void {
    const y = this.y;
    if (this.face && y.face.override === this.face) y.face.override = null;
    this.face = null;
    y.lookAt(null);
    this.releaseHold();
    this.target = null;
    this.phase = 'idle';
  }

  private releaseHold(): void {
    if (!this.holding) return;
    this.holding = false;
    this.y.locomotion.release();
  }

  private go(phase: Phase): void {
    this.phase = phase;
    this.t = 0;
  }

  private say(text: string, life: number): void {
    const y = this.y;
    const R = y.shape.radius;
    const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * 0.45, y.center.z);
    if (this.word) y.texts.fade(this.word);
    this.word = y.texts.say(text, pos, R * 0.2, life, new THREE.Vector3(0, R * 0.15, 0));
  }
}

/** 角度 a から b へ、t の割合だけ近い回りで寄せる */
function lerpAngle(a: number, b: number, t: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}
