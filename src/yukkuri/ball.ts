import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import { createAccessoryOutlineMaterial } from '../render/outlineMaterial';
import { createBlobShadow } from '../render/blobShadow';
import { tubeAlong, withOutline } from '../character/shapes';
import type { BallCollider, BoxCollider } from '../physics/SoftBody';
import type { ToonColors } from '../render/toonMaterial';
import type { PartSelection } from '../face/parts';
import { loadJSON, saveJSON } from '../platform/storage';
import { bodyExtent, showFace, type Word } from './fx';
import type { MapId } from '../world/Stage';
import type { Yukkuri } from './Yukkuri';

/**
 * ボール（指示：大きさはゆっくりの 2/3 くらい・マップごとに見た目を変え、中身は同じ・各マップに 1 個いつも置く・
 * 体とお互いに当たる・ゆっくりが自分から遊ぶ）。
 *   見た目：平地はビーチボール、森は苔玉、飼育ケースはゴムまり
 *   当たり：体と押し合う（SoftBody.balls。体の頂点は玉の外へ横に押し出され、押し出した分の一部だけ玉が動く＝玉が軽い）。
 *           体が上に乗ることはない（上からのしかかると玉が横へ押し出される）。
 *           玉は地面を転がり（だんだん遅くなる）、壁・当たる物（木・岩・箱）・置いてある物（皿など）・行ける範囲の縁で跳ね返る
 *   遊ぶ：立って何もしていない時間が続くと（PLAY_WAIT 秒）、ボールへ寄り、転がす向きの反対側に回って体ごと押し出して転がし、
 *         止まったら追いかけてまた転がす（PLAY_KICKS 回）。ほかの動きを始めたり、行き先を指示されたりしたらやめる。
 *         体は壁から胴の半径の 1.5 倍より内側にしか行けない（帽子のつば）ので、壁ぎわの玉は少し内側から押して壁に沿って転がし、
 *         壁に斜めに当てて跳ね返らせる。角にはまった玉は、横から顔を押し付けてぐりぐりすると壁に沿ってぽろっと出る
 */
type Phase = 'idle' | 'approach' | 'kick' | 'watch' | 'nudgeGo' | 'nudge';

/** 玉の半径（胴の半径に対する比。直径が体の幅の 2/3） */
const SIZE = 2 / 3;
/** 体に押されたときに玉が受け持つ割合（残りは体が押し返される） */
const SHARE = 0.7;
/** 押されて動いた量を速さにする倍率と、速さの上限（m/s） */
const PUSH_GAIN = 0.9;
const MAX_SPEED = 2.6;
/** 転がり：速さに比例して落ちる割合（1/s）と、一定で落ちる量（m/s²）。止まったとみなす速さ（m/s） */
const ROLL_DRAG = 0.7;
const ROLL_FRICTION = 0.25;
const STOP_SPEED = 0.02;
/** 壁などで跳ね返るときに残す速さの割合 */
const BOUNCE = 0.7;
/** 平地で転がっていける範囲（原点からの半径 m。遠くへ行って戻れなくならないよう） */
const OPEN_LIMIT = 7;
/** マップを開いたときに置く所（よさそうな所。だめならまわりを探す） */
const HOME: Record<MapId, [number, number]> = { open: [1.5, -1.2], cage: [0.6, 0.5], forest: [1.4, 1.2] };

/** 遊び始めるまでの、立って何もしていない時間（秒。この間でばらつかせる） */
const PLAY_WAIT: [number, number] = [8, 20];
/** 1 回の遊びで転がす回数（この間） */
const PLAY_KICKS: [number, number] = [2, 4];
/** 寄って押し出す：玉の後ろに立つときの、体の表面と玉の間（胴の半径に対する比）。そこへの着いたとみなす距離（同） */
const STAND_GAP = 0.3;
const ARRIVE = 0.5;
/** 押し出すときの行き先：玉の中心から転がす向きへ（胴の半径に対する比） */
const KICK_THROUGH = 1.8;
/** 寄るのをあきらめる時間・押し出すのをやめる時間・転がった玉を見ている最長時間（秒） */
const APPROACH_GIVE_UP = 12;
const KICK_TIME = 3.5;
const WATCH_TIME = 3;
/** 転がす向きを選ぶとき、その向きへ転がっていく先として空いていてほしい距離（胴の半径に対する比） */
const ROOM = 3;
/**
 * 角にはまった玉：横に立って顔を押し付け（NUDGE_LEAN 秒かけて上部を玉へずらす。量 NUDGE_BEND は体の高さに対する比）、
 * ぐりぐりすると壁に沿ってぽろっと出る（その速さ SQUIRT m/s）。押し付けたまま NUDGE_HOLD 秒、戻すのに NUDGE_BACK 秒
 */
const NUDGE_LEAN = 0.6;
const NUDGE_HOLD = 0.5;
const NUDGE_BACK = 0.5;
const NUDGE_BEND = 0.3;
const SQUIRT = 1.2;
/** 遊びに行くのは、玉がこれより近いとき（m） */
const PLAY_RANGE = 7;

/** 遊び終えた笑顔を見せる時間（秒） */
const SMILE_TIME = 1.8;
const FACE_PLAY: Partial<PartSelection> = { mouth: 'smile' };
const FACE_DONE: Partial<PartSelection> = { eyes: 'smile', mouth: 'smile' };

const STORAGE_KEY = 'ball';

const BEACH_RED: ToonColors = { lit: '#ef4a3c', shade: '#cf3328', deep: '#9c2219', rim: '#ffd2c8' };
const BEACH_BLUE: ToonColors = { lit: '#3d86e0', shade: '#2a69bd', deep: '#1c4b8a', rim: '#cfe4ff' };
const BEACH_YELLOW: ToonColors = { lit: '#ffd23f', shade: '#efb51f', deep: '#c08a10', rim: '#fff4c4' };
const BEACH_WHITE: ToonColors = { lit: '#fbfaf6', shade: '#e6e2d8', deep: '#c8c1b2', rim: '#ffffff' };
const MOSS: ToonColors = { lit: '#7aa548', shade: '#5c8a34', deep: '#3f6624', rim: '#e0f0c2' };
const MOSS_LIGHT: ToonColors = { lit: '#9cc25e', shade: '#7ba646', deep: '#567d2f', rim: '#eef8d6' };
const TWINE: ToonColors = { lit: '#a8875c', shade: '#8a6b44', deep: '#614a2d', rim: '#e8d6b8' };
/** 苔玉のでこぼこの大きさ（半径に対する比）と模様 */
const MOSS_LUMP = 0.05;
const MOSS_SEED = 1.3;
const RUBBER: ToonColors = { lit: '#ff7a8e', shade: '#e85a72', deep: '#b33a52', rim: '#ffe0e6' };
const RUBBER_BAND: ToonColors = { lit: '#fff6dc', shade: '#efe2bd', deep: '#cdbb8e', rim: '#ffffff' };

export class Ball {
  /** 玉と影（シーンに直接置く） */
  readonly object = new THREE.Group();
  /** 遊び：自分から遊びに行くか（保存する） */
  private autoPlay = true;
  private readonly collider: BallCollider = { x: 0, y: 0, z: 0, r: 0, share: SHARE, moveX: 0, moveZ: 0, contacts: 0 };
  private readonly vel = new THREE.Vector2();
  private readonly spin = new THREE.Quaternion();
  private readonly look = new THREE.Group();
  private readonly shadow = createBlobShadow();
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private builtFor = '';
  private map: MapId | null = null;

  private phase: Phase = 'idle';
  private t = 0;
  private wait = 0;
  private kicks = 0;
  /** 転がす向き（水平の単位ベクトル）・今向かっている所・押し出し始めた玉の位置 */
  private readonly dir = new THREE.Vector2();
  private readonly aim = new THREE.Vector3();
  private readonly kickFrom = new THREE.Vector2();
  /** 角から出す向き（壁に沿う水平の単位ベクトル）・ぐりぐりする身ぶりの向き・もう出したか */
  private readonly escape = new THREE.Vector2();
  private readonly pose = new THREE.Quaternion();
  private squirted = false;
  /** 押せなかった玉の位置（同じ所にある間は、とれないと二度言わない） */
  private readonly stuckAt = new THREE.Vector2(Infinity, Infinity);
  /** 遊び終えた笑顔の残り時間（秒） */
  private smileLeft = 0;
  private word: Word | null = null;
  private face: Partial<PartSelection> | null = null;

  constructor(private readonly y: Yukkuri) {
    this.object.add(this.look, this.shadow);
    this.object.visible = false;
    this.autoPlay = loadJSON<{ auto?: boolean }>(STORAGE_KEY)?.auto ?? true;
    this.newWait();
  }

  /** 自分から遊びに行くか（保存する） */
  get auto(): boolean {
    return this.autoPlay;
  }

  set auto(v: boolean) {
    this.autoPlay = v;
    saveJSON(STORAGE_KEY, { auto: v });
    if (!v) this.stop();
  }

  /** 遊んでいる途中か */
  get busy(): boolean {
    return this.phase !== 'idle';
  }

  /** マップを変えたとき：そのマップの見た目にして、決まった所に置き直す */
  mapChanged(map: MapId): void {
    this.stop();
    this.map = map;
    this.build();
    this.place();
    this.object.visible = true;
    if (!this.y.body.balls.includes(this.collider)) this.y.body.balls.push(this.collider);
  }

  /** そのマップの置き場（HOME）の近くの、置ける所に置き直す（止める） */
  place(): void {
    this.stop();
    const map = this.map ?? 'open';
    const [hx, hz] = HOME[map];
    const c = this.collider;
    const R = this.y.shape.radius;
    let best: [number, number] = [hx, hz];
    search: for (let ring = 0; ring < 12; ring++) {
      for (let k = 0; k < Math.max(1, ring * 6); k++) {
        const a = (k / Math.max(1, ring * 6)) * Math.PI * 2;
        const x = hx + Math.sin(a) * ring * 0.25, z = hz + Math.cos(a) * ring * 0.25;
        if (this.fits(x, z) && Math.hypot(x - this.y.center.x, z - this.y.center.z) > R * 2.5) {
          best = [x, z];
          break search;
        }
      }
    }
    c.x = best[0];
    c.z = best[1];
    c.y = c.r;
    this.vel.set(0, 0);
  }

  /** 玉を中心（x, z）に置けるか：行ける範囲の内側で、当たる物・置いてある物・といれ・うろのまわりに重ならない */
  private fits(x: number, z: number): boolean {
    const st = this.y.stage;
    const r = this.collider.r;
    if (!st) return true;
    if (!st.inside(x, z, r + 0.05) || st.overlapProp(x, z, r) || this.walled(x, z, r + 0.02)) return false;
    return !st.inToilet(x, z, -r) && !st.nearCave(x, z) && !(st.map === 'open' && Math.hypot(x, z) > OPEN_LIMIT - r);
  }

  /** 玉が中心（x, z）まで転がっていけるか（壁・当たる物・置いてある物にかからない。壁にぴったり沿う所も入れる） */
  private rolls(x: number, z: number): boolean {
    const st = this.y.stage;
    const r = this.collider.r - 0.02;
    if (!st) return true;
    return st.inside(x, z, r) && !this.walled(x, z, r) && !st.overlapProp(x, z, r) && !(st.map === 'open' && Math.hypot(x, z) > OPEN_LIMIT - r);
  }

  /**
   * 玉の当たる箱（地面に置いた当たる物のうち、玉の半径より高いもの）。低い箱（飼育ケースの皿）は、置いてある物の円（Stage.props）で当てる
   * （皿の当たりは四角い箱で、角と壁の間に玉がはさまった）
   */
  private walls(): BoxCollider[] {
    return this.y.body.boxes.filter((b) => b.h >= this.collider.r);
  }

  /** 中心（x, z）・半径 r の円が、玉の当たる箱にかかるか */
  private walled(x: number, z: number, r: number): boolean {
    for (const b of this.walls()) {
      const cs = Math.cos(b.yaw), sn = Math.sin(b.yaw);
      const dx = x - b.x, dz = z - b.z;
      const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
      if (Math.hypot(Math.max(0, Math.abs(lx) - b.hx), Math.max(0, Math.abs(lz) - b.hz)) < r) return true;
    }
    return false;
  }

  /** 固定時間刻みで呼ぶ（遊び。行き先を移動の処理より先に指示する） */
  update(dt: number): void {
    if (!this.object.visible) return;
    const y = this.y;
    const loco = y.locomotion;
    const R = y.shape.radius;
    const c = this.collider;
    if (this.phase === 'idle') {
      if (this.smileLeft > 0 && (this.smileLeft -= dt) <= 0) this.clearFace();
      if (!this.autoPlay || !this.free() || loco.hasTarget) return;
      if (loco.idleTime < this.wait) return;
      if (Math.hypot(c.x - y.center.x, c.z - y.center.z) > PLAY_RANGE) {
        this.newWait();
        return;
      }
      this.clearFace();
      if (!this.startApproach()) {
        // 角にはまって押せない：同じ所にある間は一度だけ言う
        if (Math.hypot(c.x - this.stuckAt.x, c.z - this.stuckAt.y) > R * 0.2) this.say(y.line('ballStuck'), 0.2, 1.8);
        this.stuckAt.set(c.x, c.z);
        this.newWait();
        return;
      }
      this.kicks = PLAY_KICKS[0] + Math.floor(Math.random() * (PLAY_KICKS[1] - PLAY_KICKS[0] + 1));
      this.say(y.line('ballGo'), 0.2, 1.6);
      this.setFace(FACE_PLAY);
      return;
    }
    this.t += dt;
    // ほかの動きを始めた・行き先を指示された・倒れた：やめる
    const ours = !loco.hasTarget || loco.target.distanceTo(this.aim) < 1e-3;
    if (!this.free() || !ours) {
      this.stop();
      return;
    }
    switch (this.phase) {
      case 'approach': {
        // 玉が転がっていれば、立つ所を追って決め直す（押せなくなった向きは選び直す。押せる向きがなければやめる）
        if (!this.canPush(this.aim) && !this.chooseDir()) {
          this.finish(false);
          break;
        }
        this.standPoint(this.aim);
        if (!loco.hasTarget || loco.target.distanceTo(this.aim) > R * 0.2) loco.moveTo(this.aim.x, this.aim.z);
        this.aim.copy(loco.target);
        if (Math.hypot(this.aim.x - y.center.x, this.aim.z - y.center.z) < R * ARRIVE) {
          // 玉の向こうへ向かって押し出す
          this.kickFrom.set(c.x, c.z);
          loco.moveTo(c.x + this.dir.x * (c.r + R * KICK_THROUGH), c.z + this.dir.y * (c.r + R * KICK_THROUGH));
          this.aim.copy(loco.target);
          this.go('kick');
        } else if (this.t > APPROACH_GIVE_UP) this.finish(false);
        break;
      }
      case 'kick': {
        const moved = Math.hypot(c.x - this.kickFrom.x, c.z - this.kickFrom.y);
        if (moved > c.r * 0.8 || !loco.hasTarget || this.t > KICK_TIME) {
          loco.stop();
          if (moved > c.r * 0.3) this.say(y.line('ballKick'), 0.2, 1.2);
          this.go('watch');
        }
        break;
      }
      case 'nudgeGo': {
        // 玉が動いた（ほかの何かに押された）なら、ふつうに転がしに行く
        if (Math.hypot(c.x - this.kickFrom.x, c.z - this.kickFrom.y) > c.r * 0.5) {
          if (!this.startApproach()) this.finish(false);
          break;
        }
        if (Math.hypot(this.aim.x - y.center.x, this.aim.z - y.center.z) < R * ARRIVE) {
          loco.stop();
          this.squirted = false;
          // ぐりぐりの間は体と押し合わない（体は壁から離れた側にしか立てず、触れると玉を角へ押し込んで、出ていくのを止めた）
          this.touch(false);
          this.say(y.line('ballNudge'), 0.2, 1.4);
          this.go('nudge');
        } else if (this.t > APPROACH_GIVE_UP) this.finish(false);
        break;
      }
      case 'nudge': {
        // 顔を押し付けてぐりぐり → ぽろっと出る → 体を戻す
        const back = NUDGE_LEAN + NUDGE_HOLD;
        if (this.t < back) this.nudgePose(Math.min(1, this.t / NUDGE_LEAN));
        else {
          if (!this.squirted) {
            this.squirted = true;
            this.vel.set(this.escape.x * SQUIRT, this.escape.y * SQUIRT);
            this.say(y.line('ballKick'), 0.2, 1.2);
          }
          const k = 1 - Math.min(1, (this.t - back) / NUDGE_BACK);
          if (k > 0) this.nudgePose(k);
          else {
            this.clearPose();
            this.touch(true);
            this.go('watch');
          }
        }
        break;
      }
      case 'watch': {
        // 転がっていくのを見て、止まったら（止まりかけたら）追いかける
        if (this.vel.length() > 0.15 && this.t < WATCH_TIME) break;
        this.kicks--;
        if (this.kicks <= 0) this.finish(true);
        else {
          if (!this.startApproach()) this.finish(true);
          else if (Math.random() < 0.5) this.say(y.line('ballChase'), 0.2, 1.3);
        }
        break;
      }
    }
  }

  /** 固定時間刻みで呼ぶ（体の物理の後。体に押された分を速さにして、転がす） */
  physics(dt: number): void {
    if (!this.object.visible) return;
    const c = this.collider;
    // 体に押されて動いた分（SoftBody.solveBalls）を速さに
    if (c.moveX !== 0 || c.moveZ !== 0) {
      this.vel.x += (c.moveX / dt) * PUSH_GAIN;
      this.vel.y += (c.moveZ / dt) * PUSH_GAIN;
      c.moveX = c.moveZ = 0;
    }
    let sp = this.vel.length();
    if (sp > MAX_SPEED) this.vel.multiplyScalar(MAX_SPEED / sp);
    // 転がり：だんだん遅くなる
    sp = this.vel.length();
    if (sp > 0) {
      const next = Math.max(0, sp * Math.exp(-ROLL_DRAG * dt) - ROLL_FRICTION * dt);
      this.vel.multiplyScalar(next < STOP_SPEED ? 0 : next / sp);
    }
    const px = c.x, pz = c.z;
    c.x += this.vel.x * dt;
    c.z += this.vel.y * dt;
    c.y = c.r;
    // 当たりを何度か解く（一度だけだと、壁と物の間で押し合って入り込んだまま残ることがある）
    for (let i = 0; i < 3; i++) this.collide();
    // 転がった分だけ回す（地面に接した所が滑らない回り方）
    const dx = c.x - px, dz = c.z - pz, d = Math.hypot(dx, dz);
    if (d > 1e-6) {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(dz / d, 0, -dx / d), d / c.r);
      this.spin.premultiply(q);
    }
  }

  /** 壁・当たる物・置いてある物・行ける範囲の縁から押し出し、跳ね返す */
  private collide(): void {
    const c = this.collider;
    const r = c.r;
    const y = this.y;
    const bounce = (nx: number, nz: number, pen: number) => {
      c.x += nx * pen;
      c.z += nz * pen;
      const vn = this.vel.x * nx + this.vel.y * nz;
      if (vn < 0) {
        this.vel.x -= (1 + BOUNCE) * vn * nx;
        this.vel.y -= (1 + BOUNCE) * vn * nz;
      }
    };
    // 当たる物（地面に置いた箱：壁・うろの幹・木・岩・段ボール箱など）
    for (const b of this.walls()) {
      const cs = Math.cos(b.yaw), sn = Math.sin(b.yaw);
      const dx = c.x - b.x, dz = c.z - b.z;
      const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
      const qx = THREE.MathUtils.clamp(lx, -b.hx, b.hx), qz = THREE.MathUtils.clamp(lz, -b.hz, b.hz);
      let ex = lx - qx, ez = lz - qz;
      let d = Math.hypot(ex, ez);
      if (d >= r) continue;
      if (d < 1e-6) {
        // 中心が箱の中：浅い面から外へ
        const px = b.hx - Math.abs(lx), pz = b.hz - Math.abs(lz);
        if (px < pz) {
          ex = Math.sign(lx) || 1;
          ez = 0;
          d = -px;
        } else {
          ex = 0;
          ez = Math.sign(lz) || 1;
          d = -pz;
        }
      } else {
        ex /= d;
        ez /= d;
      }
      // ローカル → ワールド
      bounce(ex * cs + ez * sn, -ex * sn + ez * cs, r - d);
    }
    const st = y.stage;
    if (!st) return;
    // 置いてある物（皿・切り株など。円）
    for (const p of st.props) {
      const dx = c.x - p.x, dz = c.z - p.z, d = Math.hypot(dx, dz);
      if (d >= p.r + r || d < 1e-6) continue;
      bounce(dx / d, dz / d, p.r + r - d);
    }
    // 行ける範囲の縁（平地は原点から OPEN_LIMIT）
    const a = st.area;
    if (a) {
      if (c.x < a.minX + r) bounce(1, 0, a.minX + r - c.x);
      if (c.x > a.maxX - r) bounce(-1, 0, c.x - (a.maxX - r));
      if (c.z < a.minZ + r) bounce(0, 1, a.minZ + r - c.z);
      if (c.z > a.maxZ - r) bounce(0, -1, c.z - (a.maxZ - r));
    } else {
      const d = Math.hypot(c.x, c.z);
      if (d > OPEN_LIMIT - r) bounce(-c.x / d, -c.z / d, d - (OPEN_LIMIT - r));
    }
  }

  /** 描画の直前に呼ぶ */
  sync(): void {
    if (!this.object.visible) return;
    if (this.builtFor !== this.buildKey()) {
      this.build();
      // 大きさが変わったら置き直す（体型を変えた）
      this.collider.y = this.collider.r;
    }
    const c = this.collider;
    this.look.position.set(c.x, c.y, c.z);
    this.look.quaternion.copy(this.spin);
    this.shadow.position.set(c.x, 0.002, c.z);
    const s = c.r * 2.3;
    this.shadow.scale.set(s, 1, s);
  }

  /** 遊びをやめる（顔・移動を戻す） */
  stop(): void {
    if (this.phase === 'idle') return;
    const loco = this.y.locomotion;
    if (loco.hasTarget && loco.target.distanceTo(this.aim) < 1e-3) loco.stop();
    this.clearPose();
    this.clearFace();
    this.touch(true);
    this.phase = 'idle';
    this.newWait();
  }

  /** 体と押し合うか（玉が出ている間） */
  private touch(on: boolean): void {
    const balls = this.y.body.balls;
    const i = balls.indexOf(this.collider);
    if (on && i < 0 && this.object.visible) balls.push(this.collider);
    if (!on && i >= 0) balls.splice(i, 1);
  }

  /** 何もしていない（ほかの動きをしていない・立っている・動ける）か */
  private free(): boolean {
    const y = this.y;
    const loco = y.locomotion;
    if (loco.held || loco.tilted || loco.immobile || (loco.gesture && loco.gesture.orientation !== this.pose) || loco.moru) return false;
    if (y.death.active || y.otabe.active || y.rest.active || y.puku.active || y.flee.active || y.vomit.active) return false;
    if (y.feeding.active || y.dishEat.active || y.toilet.active || y.cleanup.active || y.grill.active || y.dropping.active) return false;
    if (y.exercise.active || y.moru.active || y.nestBuild.active || y.box.busy || y.branch.busy || y.forage.busy || y.greet.busy || y.koro.active) return false;
    if (y.wedge.stuck) return false; // 挟まって起き上がれずにいる間は遊ばない
    return !y.branch.holding;
  }

  /** 転がす向きを決めて、玉の後ろへ寄る（押せる向きがなければ false） */
  private startApproach(): boolean {
    if (!this.chooseDir()) return this.startNudge();
    const y = this.y;
    this.standPoint(this.aim);
    y.locomotion.moveTo(this.aim.x, this.aim.z);
    this.aim.copy(y.locomotion.target);
    this.go('approach');
    return true;
  }

  /**
   * 転がす向きを決める（押せる向きがなければ false）。体から玉への向きに近い向きほど良い（回り込まずに済む）。
   * 選べるのは、その向きへ転がっていく先が少しでも空いていて、玉の後ろの立つ所（行ける所へ寄せた所）から
   * その向きへ進むと体が玉に当たる向き。壁ぎわの玉は、壁から少し内側に立って、玉の内側を押して壁に沿って転がす
   * （体は壁から胴の半径の 1.5 倍より内側にしか行けないので、玉の真後ろに立てない）。角にはまった玉は押せない（startNudge）
   */
  private chooseDir(): boolean {
    const y = this.y;
    const c = this.collider;
    const tx = c.x - y.center.x, tz = c.z - y.center.z, tl = Math.hypot(tx, tz) || 1;
    const p = new THREE.Vector3();
    let best = -Infinity;
    const keep = this.dir.clone();
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      this.dir.set(Math.sin(a), Math.cos(a));
      const run = this.travel(this.dir);
      if (run.steps === 0 || !this.canPush(p)) continue;
      // 転がった先が角に近い向きは選びにくく（角に入ると押せなくなる）
      const score = (this.dir.x * tx + this.dir.y * tz) / tl + run.steps * 0.4 - run.bounces * 0.2 - (this.cornered(run.end) ? 4 : 0) + Math.random() * 0.4;
      if (score > best) {
        best = score;
        keep.copy(this.dir);
      }
    }
    this.dir.copy(keep);
    return best > -Infinity;
  }

  /**
   * 玉を向き d0 へ転がしたときの見積もり：ROOM の長さを 6 歩に分けて進め、壁などに当たれば跳ね返った向きで続ける。
   * 進めた歩数・跳ね返った回数・着いた所
   */
  private travel(d0: THREE.Vector2): { steps: number; bounces: number; end: THREE.Vector2 } {
    const c = this.collider;
    const step = (this.y.shape.radius * ROOM) / 6;
    const p = new THREE.Vector2(c.x, c.z);
    const d = d0.clone();
    let steps = 0, bounces = 0;
    for (let i = 0; i < 6; i++) {
      if (this.rolls(p.x + d.x * step, p.y + d.y * step)) {
        p.addScaledVector(d, step);
        steps++;
        continue;
      }
      // 跳ね返る：横か奥行きの向きを返して進めるほうへ（返した向きは跳ね返りで弱まる）。押した向きへまだ進む跳ね返りだけ
      // （後ろへ戻る跳ね返りは、押している体にぶつかって止まる。角へ押し込むと、それしかない）
      const fx = new THREE.Vector2(-d.x * BOUNCE, d.y).normalize(), fz = new THREE.Vector2(d.x, -d.y * BOUNCE).normalize();
      const next = [fx, fz].find((f) => f.dot(d0) > 0.1 && this.rolls(p.x + f.x * step, p.y + f.y * step));
      if (!next) break;
      d.copy(next);
      bounces++;
      p.addScaledVector(d, step);
      steps++;
    }
    return { steps, bounces, end: p };
  }

  /** 中心 p の玉が角に近いか（前後左右のうち 2 つ以上が、すぐ先で転がれない） */
  private cornered(p: THREE.Vector2): boolean {
    const k = this.y.shape.radius * 1.2;
    let n = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!this.rolls(p.x + dx * k, p.y + dz * k)) n++;
    return n >= 2;
  }

  /**
   * 角にはまった玉を出しに行く（出せなければ false）：出す向きは、前後左右のうち玉が転がっていける向き（壁に沿う向き）。
   * 立つ所は、玉の横（出す向きと直角）の行ける所で、玉が出ていく道に体が重ならない所
   */
  private startNudge(): boolean {
    const y = this.y;
    const c = this.collider;
    const R = y.shape.radius;
    const s = new THREE.Vector3();
    let best = -Infinity;
    for (const [ex, ez] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let room = 0;
      for (let k = 1; k <= 4; k++) if (this.rolls(c.x + ex * R * 0.5 * k, c.z + ez * R * 0.5 * k)) room++;
      if (room < 2) continue;
      for (const sg of [1, -1]) {
        const qx = -ez * sg, qz = ex * sg;
        s.set(c.x + qx * (c.r + R + 0.12), 0, c.z + qz * (c.r + R + 0.12));
        y.stage?.limit(s, y.stageMargin);
        // 顔を押し付けて届く近さ
        if (Math.hypot(s.x - c.x, s.z - c.z) > c.r + R * 1.6) continue;
        // 玉の出ていく道に体が重ならない
        let clear = true;
        for (let t = 0.35; t <= 1.3; t += 0.15) if (Math.hypot(s.x - (c.x + ex * t), s.z - (c.z + ez * t)) < c.r + R * 0.95) clear = false;
        if (!clear) continue;
        const score = room + Math.random() * 0.5;
        if (score > best) {
          best = score;
          this.escape.set(ex, ez);
          this.aim.copy(s);
        }
      }
    }
    if (best === -Infinity) return false;
    y.locomotion.moveTo(this.aim.x, this.aim.z);
    this.aim.copy(y.locomotion.target);
    this.kickFrom.set(c.x, c.z);
    this.go('nudgeGo');
    return true;
  }

  /** 角の玉へ顔を押し付ける身ぶり（lean：0〜1） */
  private nudgePose(lean: number): void {
    const y = this.y;
    const c = this.collider;
    this.pose.setFromEuler(new THREE.Euler(0, Math.atan2(c.x - y.center.x, c.z - y.center.z), 0, 'YXZ'));
    y.locomotion.gesture = { orientation: this.pose, squash: 1 - 0.05 * lean, bend: NUDGE_BEND * lean, pin: true };
  }

  /** 今の向き（dir）で押せるか：立つ所（p に入れる）が玉の後ろにあり、そこからその向きへ進むと体が玉に当たり、立つ所が物の上でない */
  private canPush(p: THREE.Vector3): boolean {
    const c = this.collider;
    const R = this.y.shape.radius;
    this.standPoint(p);
    const vx = c.x - p.x, vz = c.z - p.z;
    const along = vx * this.dir.x + vz * this.dir.y;
    const side = Math.abs(vx * this.dir.y - vz * this.dir.x);
    const st = this.y.stage;
    return along > R * 0.6 && side < c.r + R * 0.45 && !(st && (st.blocked(p.x, p.z, R * 0.8) || st.overlapProp(p.x, p.z, R * 0.8)));
  }

  /** 玉の後ろ（転がす向きの反対側）の、体の表面が玉から少し離れる所。行ける範囲の内側へ寄せる */
  private standPoint(out: THREE.Vector3): void {
    const y = this.y;
    const c = this.collider;
    const back = new THREE.Vector3(-this.dir.x, 0, -this.dir.y);
    const d = c.r + bodyExtent(y, back.clone().negate()) + y.shape.radius * STAND_GAP;
    out.set(c.x + back.x * d, 0, c.z + back.z * d);
    y.stage?.limit(out, y.stageMargin);
  }

  /** 遊び終える（楽しかった：笑顔でひとこと） */
  private finish(happy: boolean): void {
    const y = this.y;
    this.clearPose();
    this.clearFace();
    if (happy) {
      this.say(y.line('ballDone'), 0.22, 1.8);
      // 笑顔はひとことの間だけ
      this.setFace(FACE_DONE);
      this.smileLeft = SMILE_TIME;
    }
    this.phase = 'idle';
    this.newWait();
  }

  private newWait(): void {
    this.wait = PLAY_WAIT[0] + Math.random() * (PLAY_WAIT[1] - PLAY_WAIT[0]);
  }

  private go(phase: Phase): void {
    this.phase = phase;
    this.t = 0;
  }

  private clearPose(): void {
    const loco = this.y.locomotion;
    if (loco.gesture?.orientation === this.pose) loco.gesture = null;
  }

  private setFace(face: Partial<PartSelection>): void {
    showFace(this.y, face);
    this.face = this.y.face.override;
  }

  private clearFace(): void {
    if (this.face && this.y.face.override === this.face) this.y.face.override = null;
    this.face = null;
  }

  private say(text: string, size: number, life: number): void {
    const y = this.y;
    const R = y.shape.radius;
    const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * 0.45, y.center.z);
    if (this.word) y.texts.fade(this.word);
    this.word = y.texts.say(text, pos, R * size, life, new THREE.Vector3(0, R * 0.15, 0));
  }

  private buildKey(): string {
    return `${this.map}|${this.y.outfit.builds}`;
  }

  /** 見た目を作る（マップごと・体型の大きさに合わせる） */
  private build(): void {
    const y = this.y;
    this.builtFor = this.buildKey();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.look.clear();
    const r = y.shape.radius * SIZE;
    this.collider.r = r;
    const outline = createAccessoryOutlineMaterial(y.outlineMaterial);
    this.materials.push(outline);
    const mat = (colors: ToonColors) => {
      const m = createAccessoryMaterial(y.bodyMaterial, colors, { rim: 0.25 });
      this.materials.push(m);
      return m;
    };
    const add = (g: THREE.BufferGeometry, m: THREE.Material, line: boolean) => {
      this.geometries.push(g);
      this.look.add(withOutline(g, m, line ? outline : null));
    };
    if (this.map === 'forest') {
      // 苔玉：でこぼこした苔の玉に、明るい苔のふくらみをところどころ。麻ひもを十字に巻く
      add(lumpySphere(r, MOSS_LUMP, 3, MOSS_SEED), mat(MOSS), true);
      const light = mat(MOSS_LIGHT);
      for (let i = 0; i < 14; i++) {
        const u = (i + 0.5) / 14, th = Math.acos(1 - 2 * u), ph = i * 2.39996;
        const n = new THREE.Vector3(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph));
        const s = r * (0.22 + 0.1 * Math.abs(Math.sin(i * 3.7)));
        const g = lumpySphere(s, 0.15, 1, i * 0.9);
        g.scale(1, 0.45, 1);
        g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n));
        g.translate(n.x * r * 0.93, n.y * r * 0.93, n.z * r * 0.93);
        add(g, light, false);
      }
      // 麻ひも：でこぼこの表面に沿わせる（まん丸の輪にすると、出っ張りに潜り、くぼみで浮いた）
      const twine = mat(TWINE);
      for (const rot of [0, Math.PI / 2]) {
        const g = tubeAlong((t) => {
          const a = t * Math.PI * 2;
          const v = new THREE.Vector3(Math.sin(a), Math.cos(a), 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), rot);
          return v.multiplyScalar(r * lumpK(v, MOSS_LUMP, MOSS_SEED) + r * 0.015);
        }, () => r * 0.028, 96, 6);
        add(g, twine, false);
      }
    } else if (this.map === 'cage') {
      // ゴムまり：つやのある色の玉に、まわりを一周する明るい帯
      add(new THREE.SphereGeometry(r, 32, 20), mat(RUBBER), true);
      const band = new THREE.SphereGeometry(r * 1.004, 32, 4, 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.16);
      add(band, mat(RUBBER_BAND), false);
    } else {
      // ビーチボール：赤・青・黄を白ではさんだ 6 枚のはぎ合わせに、上下の白い丸
      const cols = [BEACH_RED, BEACH_WHITE, BEACH_BLUE, BEACH_WHITE, BEACH_YELLOW, BEACH_WHITE];
      const outer = new THREE.SphereGeometry(r, 36, 20);
      this.geometries.push(outer);
      this.look.add(new THREE.Mesh(outer, outline));
      const ms = new Map<ToonColors, THREE.Material>();
      cols.forEach((col, i) => {
        if (!ms.has(col)) ms.set(col, mat(col));
        add(new THREE.SphereGeometry(r, 6, 20, (i / 6) * Math.PI * 2, Math.PI / 3), ms.get(col)!, false);
      });
      const white = ms.get(BEACH_WHITE)!;
      for (const s of [1, -1]) {
        const cap = new THREE.SphereGeometry(r * 1.006, 24, 4, 0, Math.PI * 2, 0, Math.PI * 0.13);
        if (s < 0) cap.rotateX(Math.PI);
        add(cap, white, false);
      }
    }
  }
}

/** でこぼこした玉（半径 r・でこぼこの大きさ amp（半径に対する比）・細かさ detail・模様をずらす seed） */
function lumpySphere(r: number, amp: number, detail: number, seed: number): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(1, detail);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  // 頂点を共有させて、なめらかな法線にする
  const g = mergeVertices(ico);
  ico.dispose();
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const k = lumpK(v, amp, seed);
    p.setXYZ(i, v.x * r * k, v.y * r * k, v.z * r * k);
  }
  g.computeVertexNormals();
  return g;
}

/** でこぼこした玉の、向き v（単位ベクトル）での半径の倍率 */
function lumpK(v: THREE.Vector3, amp: number, seed: number): number {
  return 1 + amp * (Math.sin(v.x * 5.3 + seed) * Math.sin(v.y * 4.7 + seed * 1.7) + 0.6 * Math.sin(v.z * 8.1 + v.x * 2.3 + seed * 0.4));
}
