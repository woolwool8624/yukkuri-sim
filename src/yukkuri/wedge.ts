import * as THREE from 'three';
import type { PartSelection } from '../face/parts';
import { showFace, type Word } from './fx';
import type { LineKey } from './lines';
import type { Yukkuri } from './Yukkuri';

/**
 * 挟まって起き上がれない（指示）：こーろこーろの後などに、餌皿と水皿の間・水皿とケースの角の間で、立ち直れずに倒れて動けなくなる。
 *   見分け方：自分で倒れて（Locomotion.falls。寝転ぶボタンやつつかれて倒れたのは数えない）寝転んでいて、
 *             体のまわりの向かい合う側に、壁・皿などが当たっている（WEDGE_SPREAD より離れた向き同士）
 *   挟まっている間：ときどき起き上がろうとしては倒れ（STRUGGLE_GAP）、起き上がれない・苦しいと言う。顔は力む／苦しむ。
 *                   ストレスが 1 秒あたり Stress.params.stuckRate ずつたまる
 *   抜け出す：まっすぐ立っていられた・まわりに何も当たらなくなった（FREE_TIME 秒続いた）
 *   上限に届いたら：吐餡して（Stress が吐かせる）、吐き終えたら「もっとゆっくりしたかったよ…」と言って死ぬ（Death）
 */
/** 体の表面から外へ、この距離（m）の所に物があれば当たっているとみなす */
const TOUCH = 0.1;
/** 調べる向きの数と、調べる間隔（秒） */
const DIRS = 16;
const CHECK = 0.25;
/** 当たっている向き同士がこれより離れていれば、向かい合う側から挟まれている（rad） */
const WEDGE_SPREAD = (110 * Math.PI) / 180;
/** 挟まっているとみなすまでの時間（秒） */
const ENTER_TIME = 1;
/** 起き上がろうとする間隔（秒。この間でばらつかせる） */
const STRUGGLE_GAP: [number, number] = [3.5, 6];
/** 苦しむセリフの間隔（秒） */
const SAY_GAP = 2.6;
/** ストレスが上限のこの割合を超えたら、ひどく苦しむ */
const AGONY_AT = 0.7;
/** 抜け出したとみなす：まっすぐ（傾きがこれ未満、rad）、またはまわりに当たる物がない状態がこの時間（秒）続いた */
const UPRIGHT = (18 * Math.PI) / 180;
const FREE_TIME = 1.5;

const FACE_STRUGGLE: Partial<PartSelection> = { eyes: 'squeeze', brows: 'strain', mouth: 'grit', strain: 'max', sweat: 'forehead,templeL,cheekR' };
const FACE_PAIN: Partial<PartSelection> = { eyes: 'cry', brows: 'worried', mouth: 'sobWeak', tears: 'few', strain: 'light', pale: 'some', sweat: 'forehead,templeL,templeR' };
const FACE_AGONY: Partial<PartSelection> = { eyes: 'cry', brows: 'worried', mouth: 'sobWeak', tears: 'more', stream: 'few', strain: 'mid', pale: 'some', sweat: 'forehead,templeL,templeR' };

export class Wedge {
  /** 挟まって起き上がれずにいるか */
  stuck = false;
  /** 挟まったまま上限に届いた：吐き終えたら死ぬ */
  private doomed = false;
  private vomitSeen = false;
  /** 自分で倒れたか（Locomotion.falls が増えた。まっすぐ立てたら戻す） */
  private fell = false;
  private falls = 0;
  /** まわりの向かい合う側に物が当たっているか（CHECK ごとに調べ直す）・当たる物があるか */
  private pinched = false;
  private touching = false;
  private checkIn = 0;
  private enterFor = 0;
  private freeFor = 0;
  private tryIn = 0;
  private sayIn = 0;
  private struggleFor = 0;
  private face: Partial<PartSelection> | null = null;
  private word: Word | null = null;
  private lastText = '';

  constructor(private readonly y: Yukkuri) {
    this.falls = y.locomotion.falls;
  }

  /** ストレスが上限に届いた（Stress から。吐かせる前に呼ぶ）：挟まっていれば、吐き終えたら死ぬ */
  doom(): void {
    if (this.stuck) this.doomed = true;
  }

  /** 固定時間刻みで呼ぶ（ストレスの処理より先に） */
  update(dt: number): void {
    const y = this.y;
    const loco = y.locomotion;
    if (y.death.active || y.otabe.active) {
      this.stuck = false;
      return;
    }
    if (loco.falls !== this.falls) {
      this.falls = loco.falls;
      this.fell = true;
    }
    this.checkIn -= dt;
    if (this.checkIn <= 0) {
      this.checkIn = CHECK;
      this.probe();
    }
    const upright = !loco.tilted && tiltOf(y.body.rotation) < UPRIGHT;
    if (!this.stuck) {
      if (upright) this.fell = false;
      // 当たりの調べは体の揺れで一瞬外れることがあるので、外れたら 0 に戻さず、ゆっくり減らす
      this.enterFor = this.fell && loco.isLying && this.pinched && !y.vomit.active ? this.enterFor + dt
        : this.fell && loco.isLying ? Math.max(0, this.enterFor - dt * 0.5) : 0;
      if (this.enterFor >= ENTER_TIME) this.enter();
      return;
    }
    // 上限に届いた：吐き終えるのを待って死ぬ
    if (this.doomed) {
      if (y.vomit.active) this.vomitSeen = true;
      else if (this.vomitSeen || !y.vomit.start()) this.die();
      return;
    }
    y.stress.add(y.stress.params.stuckRate * dt);
    // 抜け出した
    this.freeFor = upright || !this.touching ? this.freeFor + dt : 0;
    if (this.freeFor >= FREE_TIME) {
      this.leave();
      return;
    }
    if (y.vomit.active) return; // 吐いている間は顔も身ぶりも吐餡のもの
    // ときどき起き上がろうとする（起き上がりきれずに傾いたまま立つか、また倒れる）
    this.tryIn -= dt;
    if (this.tryIn <= 0 && loco.isLying && loco.resting) {
      this.tryIn = STRUGGLE_GAP[0] + Math.random() * (STRUGGLE_GAP[1] - STRUGGLE_GAP[0]);
      this.struggleFor = 1.6;
      loco.getUp();
      this.show(FACE_STRUGGLE);
      this.say('stuckStruggle');
      this.sayIn = SAY_GAP;
      return;
    }
    this.struggleFor -= dt;
    const agony = y.stress.value >= y.stress.params.limit * AGONY_AT;
    if (this.struggleFor <= 0) this.show(agony ? FACE_AGONY : FACE_PAIN);
    this.sayIn -= dt;
    if (this.sayIn <= 0) {
      this.sayIn = SAY_GAP;
      this.say(agony ? 'stuckAgony' : 'stuckPain');
    }
  }

  private enter(): void {
    this.stuck = true;
    this.doomed = false;
    this.vomitSeen = false;
    this.freeFor = 0;
    this.tryIn = 1.2;
    this.sayIn = SAY_GAP;
    this.struggleFor = 0;
    this.y.koro.stop();
    this.show(FACE_STRUGGLE);
    this.say('stuckStart');
  }

  private leave(): void {
    this.stuck = false;
    this.fell = false;
    this.clearFace();
    this.say('stuckFree');
    // 抱え出されたなどで、寝転んだまま当たる物がなくなった：起き上がる
    if (this.y.locomotion.isLying) this.y.getUp();
  }

  private die(): void {
    const y = this.y;
    this.stuck = false;
    this.doomed = false;
    this.clearFace();
    if (this.word) y.texts.fade(this.word);
    this.word = null;
    y.greet.say('greetLast');
    y.death.start();
  }

  /** 体のまわりを DIRS の向きで調べ、壁・皿などが当たっている向きを見る */
  private probe(): void {
    const y = this.y;
    const st = y.stage;
    this.pinched = false;
    this.touching = false;
    if (!st) return;
    const hits: number[] = [];
    const d = new THREE.Vector3();
    for (let i = 0; i < DIRS; i++) {
      const a = (i / DIRS) * Math.PI * 2;
      d.set(Math.sin(a), 0, Math.cos(a));
      const r = this.extent(d) + TOUCH;
      const x = y.center.x + d.x * r, z = y.center.z + d.z * r;
      if (st.blocked(x, z, 0.01) || st.overlapProp(x, z, 0.01)) hits.push(a);
    }
    this.touching = hits.length > 0;
    for (let i = 0; i < hits.length && !this.pinched; i++) {
      for (let j = i + 1; j < hits.length; j++) {
        const gap = Math.abs(Math.atan2(Math.sin(hits[i] - hits[j]), Math.cos(hits[i] - hits[j])));
        if (gap >= WEDGE_SPREAD) {
          this.pinched = true;
          break;
        }
      }
    }
  }

  /**
   * 体の表面が、体の中心から水平の向き d へどこまで出ているか（物理の頂点で測る。描く形（bodyMesh）は描くときにしか
   * 更新されないので、描かずに進めると古い形で測って当たりを見落とした）
   */
  private extent(d: THREE.Vector3): number {
    const b = this.y.body;
    const p = b.pos, c = b.center;
    let far = 0;
    for (let i = 0; i < p.length; i += 3) far = Math.max(far, (p[i] - c.x) * d.x + (p[i + 2] - c.z) * d.z);
    return far;
  }

  private show(face: Partial<PartSelection>): void {
    const y = this.y;
    if (this.face && y.face.override !== this.face && y.face.override) return; // ほかの動き（つつかれた顔など）が出している間は譲る
    showFace(y, face);
    this.face = y.face.override;
  }

  private clearFace(): void {
    if (this.face && this.y.face.override === this.face) this.y.face.override = null;
    this.face = null;
  }

  private say(key: LineKey): void {
    const y = this.y;
    const R = y.shape.radius;
    const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * 0.45, y.center.z);
    if (this.word) y.texts.fade(this.word);
    // 同じ言葉を続けて言わない（何度か選び直す）
    let text = y.line(key);
    for (let i = 0; i < 4 && text === this.lastText; i++) text = y.line(key);
    this.lastText = text;
    this.word = y.texts.say(text, pos, R * 0.2, 2.2, new THREE.Vector3(0, R * 0.15, 0));
  }
}

/** 体の傾き（真上からの角度。rad） */
function tiltOf(q: THREE.Quaternion): number {
  return Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (q.x * q.x + q.z * q.z))));
}
