import * as THREE from 'three';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import { createAccessoryOutlineMaterial } from '../render/outlineMaterial';
import { withOutline } from '../character/shapes';
import type { BoxCollider } from '../physics/SoftBody';
import type { PartSelection } from '../face/parts';
import { bodyExtent, bodyFacing, showFace, type Word } from './fx';
import { smooth } from './braidPick';
import type { Yukkuri } from './Yukkuri';

/**
 * 段ボール箱（ゆっくりと同じくらいの大きさ）。ボタンで体の前に出し、「押す」で体ごと押して運ぶ。
 *   障害物：体は箱をすり抜けない（SoftBody.boxes。箱の外へ押し出す）。歩いて当たり、行き先が箱の向こうなら止まる（blockWalk）
 *   押す：今いる所から見て手前の面へ回り込み（押す向きは、体から箱への向きに一番近い面の向き）、向きを合わせ、
 *         前のめりに顔を箱へ押し付け（体の前の端が箱の面より SQUISH だけ奥へ入る所まで寄せて、顔をつぶす）、
 *         力むリズム（PULSE 秒ごと）に合わせて、体と箱を一緒に少しずつ前へずらす（じりじり）。PUSH_DIST だけ動いたら止まる。
 *         力み顔（ぎゅっと目をつぶって食いしばる・力み眉・汗）で「ゆっ…ゆっ…」など
 *         這う動き（尺取り虫）で押させると、伸びた前の端が箱に止められて体ごと前へ転がり、帽子が箱に刺さった
 */
type Phase = 'idle' | 'approach' | 'turn' | 'press' | 'push' | 'rest';

/** 箱の大きさ：半分の横幅・奥行き（胴の半径に対する比）と、高さ（体の高さに対する比） */
const HALF = 1.1;
const HEIGHT = 0.75;
/** 出す所：体の表面から箱の手前の面まで（胴の半径に対する比） */
const SPAWN_GAP = 1.2;
/** 押して動かす距離（胴の半径に対する比。体ひとつ分） */
const PUSH_DIST = 2;
/** 押す前に立つ所：体の表面と箱の面の間（胴の半径に対する比）。そこからこの距離まで来たら着いたことにする */
const STAND_GAP = 0.15;
const ARRIVE = 0.6;
/** 向きを合わせる許し（rad）・最長時間（秒）。寄るのをあきらめる時間（秒） */
const TURN_OK = 0.1;
const TURN_MAX = 2.5;
/** 押し付ける前に、底がこれ（m）より低くなるまで待つ */
const SETTLED = 0.002;
const GIVE_UP = 15;
/** 押し付け：体の前の端を箱の面よりこれだけ（胴の半径に対する比）奥へ寄せる（顔がつぶれる）。寄せる時間（秒） */
const SQUISH = 0.12;
const PRESS_TIME = 0.6;
/** 押す：力むリズム（秒）と、1 回で進む距離（胴の半径に対する比）。力む間（リズムの前半）に進み、後半は息を整える */
const PULSE = 0.9;
const PULSE_STEP = 0.16;
/** 押すのをあきらめる時間（秒）。押し終えてからひと息つく時間（秒） */
const PUSH_GIVE_UP = 25;
const REST_TIME = 1.2;
/**
 * 押している間の形（人が足を踏ん張って体を斜めに預けて押すように。底は絶対に地面から浮かせない＝体全体は傾けない）：
 * 箱へ向けて上部を横へずらす量（体の高さに対する比。底は地面に付けたまま）と、縦の縮み（力むたびに少し沈む）。
 * 押し付けるのは顔の右側（ゆっくり自身から見て右＝ローカル -X。三つ編みのない側）。正面で押すと顔が箱に隠れた
 */
const BEND = 0.35;
const PUSH_SQUASH = 0.92;
const SAY_EVERY = 1.8;

const FACE_PUSH: Partial<PartSelection> = { eyes: 'squeeze', brows: 'strain', mouth: 'grit', strain: 'max', sweat: 'forehead,templeL,cheekR' };
const FACE_DONE: Partial<PartSelection> = { eyes: 'normal', brows: 'neutral', mouth: 'smile' };

const KRAFT = { lit: '#d8a866', shade: '#b98a4f', deep: '#8c6536', rim: '#f2d8ae' };
const TAPE = { lit: '#c99b5c', shade: '#a97e45', deep: '#7d5a2e', rim: '#ead0a2' };

export class PushBox {
  /** 箱（シーンに直接置く） */
  readonly object = new THREE.Group();
  private readonly collider: BoxCollider = { x: 0, z: 0, yaw: 0, hx: 0, hz: 0, h: 0, contacts: 0 };
  private placed = false;
  private phase: Phase = 'idle';
  private t = 0;
  private moved = 0;
  /** 押し付けで寄せる残りの距離（m） */
  private pressLeft = 0;
  private sayIn = 0;
  /** 箱に当たって止まったときの一言の待ち（秒） */
  private bumpWait = 0;
  private word: Word | null = null;
  private face: Partial<PartSelection> | null = null;
  /** 押す向き（水平の単位ベクトル）・向き（rad）・押し始めた所 */
  private readonly dir = new THREE.Vector3();
  private heading = 0;
  private readonly stand = new THREE.Vector3();
  private readonly pose = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private builtFor = -1;

  constructor(private readonly y: Yukkuri) {
    this.object.visible = false;
  }

  /** 箱が出ているか */
  get shown(): boolean {
    return this.placed;
  }

  /** 押している途中か */
  get busy(): boolean {
    return this.phase !== 'idle';
  }

  /**
   * 箱を体の前に出す（出ていれば置き直す）。前に置くと行ける範囲（ケースの壁）からはみ出す・皿に重なる・壁に寄せると体に重なるなら、
   * 斜め前・横・後ろの順に置ける所を探す（どこもだめなら前に、壁の内側へ寄せて置く）
   */
  spawn(): void {
    const y = this.y;
    this.stop();
    this.build();
    const f = bodyFacing(y);
    const d = bodyExtent(y, f) + y.shape.radius * (SPAWN_GAP + HALF);
    const base = Math.atan2(f.x, f.z);
    const stage = y.stage;
    const c = this.collider;
    const p = { x: 0, z: 0 };
    for (const k of [0, 1, -1, 2, -2, 3, -3, 4, 0]) {
      const a = base + (k * Math.PI) / 4;
      c.yaw = a;
      p.x = y.center.x + Math.sin(a) * d;
      p.z = y.center.z + Math.cos(a) * d;
      if (!stage) break;
      const [ex, ez] = this.extent();
      stage.limit(p, ex, ez);
      const clear = !stage.overlapProp(p.x, p.z, this.reach()) && Math.hypot(p.x - y.center.x, p.z - y.center.z) > d * 0.85;
      if (clear) break;
    }
    c.x = p.x;
    c.z = p.z;
    this.placed = true;
    this.object.visible = true;
    if (!y.body.boxes.includes(this.collider)) y.body.boxes.push(this.collider);
    this.sync();
  }

  /** 箱の中心から、地面の上で一番遠い角まで（m。向きによらない） */
  private reach(): number {
    return Math.hypot(this.collider.hx, this.collider.hz);
  }

  /** 今の向きの箱が地面の上で占める、中心から横（x）・奥行き（z）の幅（m） */
  private extent(): [number, number] {
    const c = this.collider;
    const cs = Math.abs(Math.cos(c.yaw)), sn = Math.abs(Math.sin(c.yaw));
    return [c.hx * cs + c.hz * sn, c.hx * sn + c.hz * cs];
  }

  /** 箱を中心（x, z）に置けるか：まるごと行ける範囲（ケースの壁）の内側で、皿などに重ならない */
  private canBeAt(x: number, z: number): boolean {
    const stage = this.y.stage;
    if (!stage) return true;
    const [ex, ez] = this.extent();
    // 皿との重なりは、箱を内に収まる円（半分の幅の小さい方）で見る（角の円で見ると、離れていても止まる）
    return stage.inside(x, z, ex, ez) && !stage.overlapProp(x, z, Math.min(this.collider.hx, this.collider.hz));
  }

  /** 箱が行ける範囲（ケースの壁）の内側にあり、皿などに重ならないか */
  fits(): boolean {
    return this.canBeAt(this.collider.x, this.collider.z);
  }

  /** 片付ける */
  clear(): void {
    this.stop();
    this.placed = false;
    this.object.visible = false;
    const i = this.y.body.boxes.indexOf(this.collider);
    if (i >= 0) this.y.body.boxes.splice(i, 1);
  }

  /** 押す：手前の面へ回り込み、向きを合わせて、PUSH_DIST だけ押す。箱がない・ほかの動きの途中・気絶中は false */
  push(): boolean {
    const y = this.y;
    if (!this.placed || this.busy || y.rest.fainting || y.branch.busy || y.forage.busy) return false;
    if (y.stuck()) return false;
    y.rest.wake(true);
    if (y.locomotion.isLying) y.getUp();
    // 押す向き：体から箱への向きに一番近い面の向き
    const c = this.collider;
    const to = new THREE.Vector3(c.x - y.center.x, 0, c.z - y.center.z);
    let best = -Infinity;
    for (let k = 0; k < 4; k++) {
      const a = c.yaw + (k * Math.PI) / 2;
      const n = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
      const d = n.dot(to);
      if (d > best) {
        best = d;
        this.dir.copy(n);
      }
    }
    // 体の右（ローカル -X）が押す向きを向く向き：ローカル -X のワールドの向きは (-cos h, 0, sin h)
    this.heading = Math.atan2(this.dir.z, -this.dir.x);
    // 立つ所：押す面の外、体の前の端が面に触れる手前
    const R = y.shape.radius;
    const half = R * HALF;
    // 横向きで押すので、体の横幅（今の向きの横）で離れておく
    const f = bodyFacing(y);
    const reach = bodyExtent(y, new THREE.Vector3(f.z, 0, -f.x));
    this.stand.set(c.x, 0, c.z).addScaledVector(this.dir, -(half + reach + R * STAND_GAP));
    this.go('approach');
    if (Math.hypot(this.stand.x - y.center.x, this.stand.z - y.center.z) < R * ARRIVE) {
      y.locomotion.stop();
      y.locomotion.hold();
      this.go('turn');
    } else y.locomotion.moveTo(this.stand.x, this.stand.z);
    this.say(y.line('boxGo'), 0.2, 1.4);
    return true;
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    if (this.phase === 'idle') {
      this.blockWalk(dt);
      return;
    }
    const y = this.y;
    const loco = y.locomotion;
    const R = y.shape.radius;
    this.t += dt;
    if (y.rest.fainting || (loco.isLying && this.phase !== 'approach')) {
      this.stop();
      return;
    }
    switch (this.phase) {
      case 'approach': {
        if ((loco.hasTarget && loco.target.distanceTo(this.stand) > 1e-3) || this.t > GIVE_UP) {
          this.stop();
          break;
        }
        // そばまで来たら着いたことにする（ぴったりを狙うと、その周りを回り続けることがある）
        if (loco.hasTarget && Math.hypot(this.stand.x - y.center.x, this.stand.z - y.center.z) < R * ARRIVE) loco.stop();
        if (!loco.hasTarget && loco.idle && !loco.tilted) {
          loco.hold();
          this.go('turn');
        }
        break;
      }
      case 'turn': {
        this.setPose(0);
        const err = Math.abs(Math.atan2(Math.sin(this.heading - y.body.yaw), Math.cos(this.heading - y.body.yaw)));
        // 跳ねて寄った直後は、体（底）がまだ地面に着ききっていないことがある。着いてから押し付ける（底を浮かせて押さない）
        const settled = this.bottomLift() < SETTLED || this.t > TURN_MAX + 1.5;
        if (((err < TURN_OK && this.t > 0.3) || this.t > TURN_MAX) && settled) {
          // 押し付け：体の前の端が箱の面より SQUISH だけ奥へ入る所まで寄せる
          const c = this.collider;
          const front = y.center.x * this.dir.x + y.center.z * this.dir.z + bodyExtent(y, this.dir);
          const near = c.x * this.dir.x + c.z * this.dir.z - R * HALF;
          this.pressLeft = Math.max(0, near - front + R * SQUISH);
          showFace(y, FACE_PUSH);
          this.face = y.face.override;
          this.go('press');
        }
        break;
      }
      case 'press': {
        const k = smooth(this.t / PRESS_TIME);
        this.setPose(k, k);
        const step = Math.min(this.pressLeft, (this.pressLeft / Math.max(dt, PRESS_TIME - this.t + dt)) * dt);
        y.body.translate(this.dir.x * step, this.dir.z * step);
        this.pressLeft -= step;
        if (this.t >= PRESS_TIME) {
          this.moved = 0;
          this.sayIn = 0.3;
          this.go('push');
        }
        break;
      }
      case 'push': {
        // 力むリズム：前半に体と箱を一緒に進め、沈み込む。後半は息を整える
        const u = (this.t % PULSE) / PULSE;
        const effort = u < 0.5 ? Math.sin(u * 2 * Math.PI) : 0;
        this.setPose(1, 1 + effort * 0.6);
        const speed = (PULSE_STEP * R * Math.PI) / PULSE; // 前半の sin を積むと 1 回で PULSE_STEP
        let step = Math.min(R * PUSH_DIST - this.moved, speed * effort * dt);
        const c = this.collider;
        // 壁や皿に当たる所で止める（それ以上は押せない）
        const wall = step > 0 && !this.canBeAt(c.x + this.dir.x * step, c.z + this.dir.z * step);
        if (wall) step = 0;
        c.x += this.dir.x * step;
        c.z += this.dir.z * step;
        y.body.translate(this.dir.x * step, this.dir.z * step);
        this.moved += step;
        this.sayIn -= dt;
        if (this.sayIn <= 0) {
          this.say(y.line('boxPush'), 0.2, 1.2);
          this.sayIn = SAY_EVERY;
        }
        if (this.moved >= R * PUSH_DIST - 1e-6 || this.t > PUSH_GIVE_UP || wall) {
          this.clearFace();
          showFace(y, FACE_DONE);
          this.face = y.face.override;
          // 壁や皿に当たって、ほとんど動かせなかった
          this.say(y.line(wall && this.moved < R * 0.3 ? 'boxStuck' : 'boxDone'), 0.22, 1.8);
          this.go('rest');
        }
        break;
      }
      case 'rest': {
        // 体を起こしてひと息
        const k = 1 - smooth(this.t / 0.5);
        this.setPose(k, k);
        if (this.t > REST_TIME) this.stop();
        break;
      }
    }
  }

  /**
   * 押していないとき：歩いて箱に当たり、行き先が箱の向こう（当たっている面の奥）なら、そこで止まる
   * （止めないと、箱に体を押し付けたまま進もうとし続ける）
   */
  private blockWalk(dt: number): void {
    const y = this.y;
    const loco = y.locomotion;
    this.bumpWait = Math.max(0, this.bumpWait - dt);
    if (!this.placed || this.collider.contacts === 0 || !loco.hasTarget) return;
    // 体の中心に一番近い箱の側面の点から、体の中心への向き（当たっている面の外向き）
    const c = this.collider;
    const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
    const dx = y.center.x - c.x, dz = y.center.z - c.z;
    const lx = THREE.MathUtils.clamp(dx * cs - dz * sn, -c.hx, c.hx);
    const lz = THREE.MathUtils.clamp(dx * sn + dz * cs, -c.hz, c.hz);
    const px = c.x + lx * cs + lz * sn, pz = c.z - lx * sn + lz * cs;
    const nx = y.center.x - px, nz = y.center.z - pz;
    if ((loco.target.x - y.center.x) * nx + (loco.target.z - y.center.z) * nz >= 0) return;
    loco.stop();
    if (this.bumpWait === 0) {
      this.say(y.line('boxBump'), 0.2, 1.4);
      this.bumpWait = 4;
    }
  }

  /** 体の底（静止形状の高さの下 3%）の頂点の、地面からの一番高い所（m） */
  private bottomLift(): number {
    const b = this.y.body;
    const rest = b.rest;
    let lo = Infinity, hi = -Infinity;
    for (let i = 1; i < rest.length; i += 3) {
      lo = Math.min(lo, rest[i]);
      hi = Math.max(hi, rest[i]);
    }
    const cut = lo + (hi - lo) * 0.03;
    let lift = 0;
    for (let i = 1; i < rest.length; i += 3) if (rest[i] < cut) lift = Math.max(lift, b.pos[i]);
    return lift;
  }

  /** 描画の直前に呼ぶ（帽子の置き場が決まった後） */
  sync(): void {
    if (!this.placed) return;
    if (this.builtFor !== this.y.outfit.builds) this.build();
    const c = this.collider;
    this.object.position.set(c.x, 0, c.z);
    this.object.rotation.set(0, c.yaw, 0);
  }

  /** やめる（身ぶり・顔・移動を戻す） */
  private stop(): void {
    if (this.phase === 'idle') return;
    const loco = this.y.locomotion;
    if (loco.gesture?.orientation === this.pose) loco.gesture = null;
    loco.release();
    this.clearFace();
    this.phase = 'idle';
  }

  private clearFace(): void {
    if (this.face && this.y.face.override === this.face) this.y.face.override = null;
    this.face = null;
  }

  private go(phase: Phase): void {
    this.phase = phase;
    this.t = 0;
  }

  /** 身ぶり：右側を押す向きへ向け（体は傾けない）、lean の割合だけ上部を箱の側（右）へずらし、squash の割合だけ縦に縮む */
  private setPose(lean: number, squash = 0): void {
    this.euler.set(0, this.heading, 0);
    this.pose.setFromEuler(this.euler);
    this.y.locomotion.gesture = {
      orientation: this.pose, squash: 1 + (PUSH_SQUASH - 1) * squash, bendSide: -BEND * lean,
      pin: this.phase === 'press' || this.phase === 'push' || this.phase === 'rest',
    };
  }

  /** 箱の形を作る（体型の大きさに合わせる。体型を変えたら作り直す） */
  private build(): void {
    const y = this.y;
    this.builtFor = y.outfit.builds;
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    this.object.clear();
    if (this.materials.length === 0) {
      this.materials.push(
        createAccessoryMaterial(y.bodyMaterial, KRAFT, { rim: 0.2 }),
        createAccessoryMaterial(y.bodyMaterial, TAPE, { rim: 0.2 }),
        createAccessoryOutlineMaterial(y.outlineMaterial),
      );
    }
    const [kraft, tape, outline] = this.materials;
    const R = y.shape.radius;
    const hx = R * HALF, hz = R * HALF, h = y.height * HEIGHT;
    this.collider.hx = hx;
    this.collider.hz = hz;
    this.collider.h = h;
    const add = (g: THREE.BufferGeometry, m: THREE.Material, line = true) => {
      this.geometries.push(g);
      this.object.add(withOutline(g, m, line ? outline : null));
    };
    // 箱：上のふたは左右から閉じて、真ん中の合わせ目をテープでとめる
    const body = new THREE.BoxGeometry(hx * 2, h, hz * 2);
    body.translate(0, h / 2, 0);
    add(body, kraft);
    const strip = new THREE.BoxGeometry(hx * 0.32, h * 0.01, hz * 2.02);
    strip.translate(0, h + h * 0.004, 0);
    add(strip, tape, false);
    // テープは前後の面にも少し垂らす
    for (const s of [-1, 1]) {
      const end = new THREE.BoxGeometry(hx * 0.32, h * 0.22, h * 0.01);
      end.translate(0, h * 0.89, s * (hz + h * 0.004));
      add(end, tape, false);
    }
  }

  private say(text: string, size: number, life: number): void {
    const y = this.y;
    const R = y.shape.radius;
    const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * 0.45, y.center.z);
    if (this.word) y.texts.fade(this.word);
    this.word = y.texts.say(text, pos, R * size, life, new THREE.Vector3(0, R * 0.15, 0));
  }
}
