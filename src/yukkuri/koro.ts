import * as THREE from 'three';
import type { PartSelection } from '../face/parts';
import { loadJSON, saveJSON } from '../platform/storage';
import { pick, showFace, type Word } from './fx';
import type { Yukkuri } from './Yukkuri';

/**
 * こーろこーろ（指示）：宣言して横に転がって遊ぶ。立った向きのまま、体の前向きの軸のまわりに回って、体から見て右か左へ転がる
 * （Locomotion.koroBegin。進むのは体と地面の摩擦まかせ）。帽子はかぶったまま。
 *   転がり方：一方向（決めた向きへ転がり続ける）／往復（turnEvery 秒ごとに折り返す）／その場でゆらゆら（左右に swayWidth 回転ずつ
 *             転がってはゆり戻す。1 往復 turnEvery × 2 秒）／おまかせ（毎回どれか）。
 *             一方向・往復は、転がり始めると同時に前へ lean 度傾き（LEAN_TIME 秒かけて。指示：前は傾き終えてから回していた）、
 *             傾いたまま転がり、回り終えてから体を起こす（指示）。
 *             ゆらゆらは傾かない
 *   向き：右・左・ランダム（体から見て）。決めた向きの先が壁などでふさがっていれば、反対へ
 *   時間：time 秒たったら、近い「立った向き」まで転がって起き、ひとこと言う
 *   始め方：調整パネルのボタン（宣言してから）と、自分から（立って何もしていない時間が続くと。auto）
 *   柔らかさ：転がる間だけ、形に戻る強さ（SoftBody.softness）と皮のゆるさ（skinLoose）に掛ける倍率を変える
 *             （体型によっては、そのままだと固すぎて転がらない・柔らかすぎてつぶれる）
 *   保存：数値（時間・速さ・折り返す間隔・ゆらゆらの幅・前傾・柔らかさ）は体型ごと（指示）。転がり方・向き・自分から遊ぶは全体で 1 つ
 *   移動（指示）：移動方法が「こーろこーろ」のとき、地面をクリックされた・うろつく行き先へ、宣言せずに転がって行く（travel）。
 *             行き先が体の右か左の近い方へ転がり始め、転がりながら行き先へ向きを変える。立った向きになれるのは 1 回転ごとなので
 *             （扁平型で約 3 m）、行き先にいちばん近い立った向きで起き上がり、その場で行き先へ向き直ってから、残りを跳ねる
 *             （跳ねられなければ這う。転がり終えると行き先は体の真横に来るので、そのまま跳ねると行き先のまわりを回り続けた）。
 *             1 回転で進む道のりの TRAVEL_MIN より近い行き先は、はじめから跳ねる・這う。速さ・前傾・柔らかさは一方向と同じ
 */
export type KoroPattern = 'one' | 'shuttle' | 'sway' | 'random';
export type KoroDir = 'right' | 'left' | 'random';

export interface KoroParams {
  pattern: KoroPattern;
  dir: KoroDir;
  /** 転がる時間（秒。起き上がるまでの分は含まない） */
  time: number;
  /** 回る速さ（回転/秒） */
  speed: number;
  /** 往復：折り返すまでの時間（秒）。ゆらゆら：片側へ転がって戻るまでの時間（秒） */
  turnEvery: number;
  /** ゆらゆら：片側へ転がる量（回転） */
  swayWidth: number;
  /** 一方向・往復：転がる前に前へ傾く角度（度） */
  lean: number;
  /** 自分から遊ぶ */
  auto: boolean;
  /** 転がる間の、形に戻る強さの倍率（体型ごと） */
  soft: number;
  /** 転がる間の、皮のゆるさの倍率（体型ごと） */
  skin: number;
}

/** 体型ごとに保存する数値 */
const FIT_KEYS = ['time', 'speed', 'turnEvery', 'swayWidth', 'lean', 'soft', 'skin'] as const;
type Fit = Pick<KoroParams, (typeof FIT_KEYS)[number]>;

const DEFAULT_KORO: KoroParams = {
  pattern: 'random', dir: 'random', time: 6, speed: 0.5, turnEvery: 1.6, swayWidth: 0.3, lean: 30, auto: true, soft: 1, skin: 1,
};
/** 体型ごとの数値の初期値（調整パネルで合わせた値。2026-10-31 指示。ここにない数値は DEFAULT_KORO） */
const PRESET_FIT: Record<string, Partial<Fit>> = {
  ball: { time: 12, turnEvery: 3, lean: 76, soft: 0.5, skin: 3.2 },
  egg: { time: 12, speed: 0.7, turnEvery: 3, lean: 71, soft: 0.65, skin: 3.5 },
  chick: { time: 16, turnEvery: 4, lean: 35, soft: 0.5, skin: 3.5 },
  flat: { time: 9, speed: 0.35, turnEvery: 3, lean: 75, soft: 0.2, skin: 6.2 },
  eggplant: { time: 9, turnEvery: 3, lean: 75, soft: 0.5, skin: 7 },
  caterpillar: { time: 15, speed: 0.35, turnEvery: 3, lean: 0, soft: 0.35, skin: 10 },
};
const fitDefaults = (id: string): Fit => ({
  ...(Object.fromEntries(FIT_KEYS.map((k) => [k, DEFAULT_KORO[k]])) as Fit),
  ...PRESET_FIT[id],
});

const STORAGE_KEY = 'koro';
const FIT_KEY = 'koroFit';

/** 自分から遊ぶまでの、立って何もしていない時間（秒。この間でばらつかせる） */
const AUTO_WAIT: [number, number] = [12, 30];
/** 決めた向きの先に空いていてほしい距離（胴の半径に対する比） */
const ROOM = 3;
/** 柔らかさを寄せる速さ（1/s） */
const SOFTEN = 6;
/** 転がっている間に言う間隔（秒）と言葉（決まり文句。どの口調でも同じ） */
const SAY_EVERY = 1.8;
const ROLL_WORDS = ['こーろこーろ♪', 'ころころ〜♪', 'こーろこーろ〜', 'ゆ〜ん♪'];
/** 起き上がってから笑顔でいる時間（秒） */
const AFTER_TIME = 1.6;
/** 起き上がる向きに着いたとみなす角度（rad） */
const UPRIGHT = 0.03;

/** 前へ傾く（転がりながら）・体を起こすのにかける時間（秒） */
const LEAN_TIME = 0.5;

/** 移動：1 回転で進む道のりのこの割合より近い行き先は、転がらずに跳ねる・這う（これより遠ければ、1 回転した所の方が近い） */
const TRAVEL_MIN = 0.6;
/** 移動：起き上がった後に行き先へ向き直る速さ（rad/s）・向いたとみなす角度（rad）・あきらめる時間（秒） */
const FACE_TURN = 2.5;
const FACE_OK = 0.12;
const FACE_MAX = 2;
/** 移動：1 rad 転がって進む道のり（胴の半径に対する比）。測れるまでの見込み（その体型で前に測った値があればそれ） */
const PER_RAD = 0.85;
/** 移動：転がる向きを変える速さの上限（rad/s） */
const STEER = 1.2;
/** 移動：この時間（秒）行き先へ近づけなければ（壁などに当たって）起き上がる */
const TRAVEL_STALL = 2.5;

const Y_UP = new THREE.Vector3(0, 1, 0);

const FACE_ROLL: Partial<PartSelection> = { eyes: 'smile', mouth: 'smile' };

type Phase = 'none' | 'roll' | 'finish' | 'unlean' | 'after' | 'face';

export class Koro {
  private readonly saved = loadJSON<Partial<KoroParams>>(STORAGE_KEY);
  readonly params: KoroParams = { ...DEFAULT_KORO, ...this.pickSaved() };
  private readonly fits: Record<string, Partial<Fit>> = { ...loadJSON<Record<string, Partial<Fit>>>(FIT_KEY) };
  private presetId = '';
  private phase: Phase = 'none';
  private t = 0;
  /** 今回の転がり方・向き（+1 右・-1 左）・回した角度（rad） */
  private pattern: Exclude<KoroPattern, 'random'> = 'one';
  private sign = 1;
  private angle = 0;
  /** 往復：次に折り返すまで（秒） */
  private flipIn = 0;
  private sayIn = 0;
  /** 体を起こし始めたときの前への傾き（rad） */
  private leanFrom = 0;
  private wait = 0;
  /** 転がる間の柔らかさ（今の値。なめらかに寄せる） */
  private soft = 1;
  private skin = 1;
  private face: Partial<PartSelection> | null = null;
  private word: Word | null = null;
  /** 移動で転がっている（travel）か・行き先・起き上がる向き（回した角度）・近づけずにいる時間・転がり直した回数 */
  private travel = false;
  private readonly travelTo = new THREE.Vector3();
  private finishTo: number | null = null;
  private stall = 0;
  private bestDist = Infinity;
  /** 体型ごとの、前に測った 1 rad あたりに進む道のり（m） */
  private readonly perRadOf: Record<string, number> = {};
  /** 移動：転がった角度と進んだ道のり（1 rad あたりに進む道のりを測る） */
  private rolled = 0;
  private traveled = 0;
  private readonly lastPos = new THREE.Vector3();
  /** 移動：起き上がった後に向き直る向き（rad）と、その姿勢 */
  private faceYaw: number | null = null;
  private readonly facePose = new THREE.Quaternion();

  constructor(private readonly y: Yukkuri) {
    this.newWait();
  }

  /** 転がっている途中か（宣言の後、転がり始めてから起き上がって笑い終えるまで） */
  get active(): boolean {
    return this.phase !== 'none';
  }

  /** 移動で行き先へ転がっている途中か（行き先の印を出しておく） */
  get travelling(): boolean {
    return this.travel;
  }

  /** 転がっているか（転がり始めてから体を起こし終えるまで。起き上がって笑っている間は含まない） */
  get rolling(): boolean {
    return this.phase === 'roll' || this.phase === 'finish' || this.phase === 'unlean';
  }

  private pickSaved(): Partial<KoroParams> {
    const s = this.saved;
    if (!s) return {};
    const { pattern, dir, auto } = s;
    return Object.fromEntries(Object.entries({ pattern, dir, auto }).filter(([, v]) => v !== undefined));
  }

  /** 転がり方・向き・自分から遊ぶを保存する（全体で 1 つ） */
  save(): void {
    const { pattern, dir, auto } = this.params;
    saveJSON(STORAGE_KEY, { pattern, dir, auto });
  }

  /** 体型を切り替える：数値を、その体型で保存したもの（なければ初期値）にする */
  usePreset(id: string): void {
    this.presetId = id;
    // 前は時間・速さなどを全体で 1 つ保存していた：最初に開いた体型に、まだその体型の値がなければ引き継ぐ（一度だけ）
    const old = this.saved as Partial<Fit> | null;
    const legacy = old ? FIT_KEYS.filter((k) => typeof old[k] === 'number') : [];
    if (legacy.length > 0) {
      const f = (this.fits[id] ??= {});
      for (const k of legacy) f[k] ??= old![k];
      saveJSON(FIT_KEY, this.fits);
      for (const k of legacy) delete old![k];
      this.save();
    }
    Object.assign(this.params, fitDefaults(id), this.fits[id]);
  }

  /** 数値を今の体型のものとして保存する（調整パネルで変えたとき） */
  setFit(): void {
    if (!this.presetId) return;
    this.storeFit(this.presetId);
    saveJSON(FIT_KEY, this.fits);
  }

  /** 今の体型の数値を初期値に戻す */
  resetFit(): void {
    Object.assign(this.params, fitDefaults(this.presetId));
    this.setFit();
  }

  /** 今の数値を、別の体型（ユーザー設定など）にも写す */
  copyFitTo(id: string): void {
    this.storeFit(id);
    saveJSON(FIT_KEY, this.fits);
  }

  private storeFit(id: string): void {
    const d = fitDefaults(id);
    const changed: Partial<Fit> = {};
    for (const k of FIT_KEYS) if (this.params[k] !== d[k]) changed[k] = this.params[k];
    if (Object.keys(changed).length > 0) this.fits[id] = changed;
    else delete this.fits[id];
  }

  /** 宣言してから転がる（調整パネルのボタン・自分から）。始められなければ false */
  declare(): boolean {
    const y = this.y;
    if (this.active || !this.free()) return false;
    return y.greet.declare('declareKoro', () => !this.active, () => this.start());
  }

  /** 転がり始める（宣言の後） */
  start(): boolean {
    const y = this.y;
    // 帽子が頭から落ちてかぶり直すまでは転がらない
    if (this.active || y.hatFall.active) return false;
    if (y.locomotion.held) y.locomotion.release();
    if (!y.locomotion.koroBegin()) return false;
    const p = this.params;
    this.pattern = p.pattern === 'random' ? pick(['one', 'shuttle', 'sway'] as const) : p.pattern;
    this.sign = p.dir === 'right' ? 1 : p.dir === 'left' ? -1 : Math.random() < 0.5 ? 1 : -1;
    // 決めた向きの先がふさがっていれば反対へ（どちらもふさがっていればそのまま）
    if (!this.room(this.sign) && this.room(-this.sign)) this.sign = -this.sign;
    this.travel = false;
    this.finishTo = null;
    this.angle = 0;
    this.flipIn = p.turnEvery;
    this.sayIn = 0.4;
    this.soft = y.body.softness;
    this.skin = y.body.skinLoose;
    showFace(y, FACE_ROLL);
    this.face = y.face.override;
    this.go('roll');
    return true;
  }

  /**
   * 移動で転がり始める（宣言しない）：行き先が体の右か左の近い方へ。近すぎる・ほかの動きの途中なら、跳ねる・這うに任せる
   */
  private startTravel(): void {
    const y = this.y;
    const loco = y.locomotion;
    const to = loco.target;
    const dx = to.x - y.center.x, dz = to.z - y.center.z;
    if (this.active || !this.free() || y.hatFall.active || Math.hypot(dx, dz) < this.perRadGuess() * Math.PI * 2 * TRAVEL_MIN) {
      loco.koroDecline();
      return;
    }
    this.travelTo.set(to.x, 0, to.z);
    if (!loco.koroBegin()) {
      loco.koroDecline();
      return;
    }
    this.travel = true;
    this.beginRoll();
    // 体から見て右＝ローカル -X のワールドの向き。行き先がそちらなら右へ
    const yaw = y.body.yaw;
    this.sign = -Math.cos(yaw) * dx + Math.sin(yaw) * dz >= 0 ? 1 : -1;
  }

  /** 転がり始めの数を揃える（遊ぶ・移動の共通） */
  private beginRoll(): void {
    const y = this.y;
    this.pattern = 'one';
    this.angle = 0;
    this.finishTo = null;
    this.flipIn = this.params.turnEvery;
    this.sayIn = 0.4;
    this.soft = y.body.softness;
    this.skin = y.body.skinLoose;
    this.stall = 0;
    this.bestDist = Infinity;
    this.rolled = 0;
    this.traveled = 0;
    this.lastPos.copy(y.center);
    showFace(y, FACE_ROLL);
    this.face = y.face.override;
    this.go('roll');
  }

  /** やめる（その場で起き上がる） */
  stop(): void {
    if (this.phase === 'none') return;
    if (this.phase === 'face') {
      this.endFace();
      return;
    }
    this.y.locomotion.koroEnd();
    this.clearFace();
    this.phase = 'none';
    this.travel = false;
    this.newWait();
  }

  /** 固定時間刻みで呼ぶ（姿勢の指令を移動の処理より先に決める） */
  update(dt: number): void {
    const y = this.y;
    const loco = y.locomotion;
    const p = this.params;
    if (this.phase === 'none') {
      // 移動方法が「こーろこーろ」で、行き先へ向かいたい
      if (loco.koroWanted) {
        this.startTravel();
        return;
      }
      // 自分から遊ぶ：立って何もしていない時間が続いたら
      if (p.auto && this.free() && !loco.hasTarget && loco.idleTime > this.wait) {
        this.newWait();
        this.declare();
      }
      return;
    }
    this.t += dt;
    if (this.phase === 'face') {
      this.faceTarget(dt);
      return;
    }
    if (this.phase === 'after') {
      if (this.t > AFTER_TIME) {
        this.clearFace();
        this.phase = 'none';
        this.newWait();
      }
      return;
    }
    // 移動の途中で行き先を指示し直された：こーろこーろで向かう行き先なら、そちらへ向かい直す
    if (this.travel && loco.koroing && loco.hasTarget && this.phase === 'roll' && loco.koroWantedFor()) {
      this.travelTo.set(loco.target.x, 0, loco.target.z);
      loco.koroTake();
      this.finishTo = null; // 起き上がる向きも決め直す
      this.stall = 0;
      this.bestDist = Infinity;
    }
    // ほかの動きに移った・行き先を指示された・つつかれて転がった：やめる
    if (!loco.koroing || loco.hasTarget || loco.held || !this.othersFree()) {
      this.stop();
      return;
    }
    this.soften(dt);
    const w = p.speed * Math.PI * 2;
    const lean = (p.lean * Math.PI) / 180;
    // 前へ傾く量（なめらかに 0→1）
    const ease = (t: number) => {
      const k = Math.min(1, t / LEAN_TIME);
      return k * k * (3 - 2 * k);
    };
    if (this.phase === 'unlean') {
      // 回り終えてから体を起こす
      loco.koroLean = this.leanFrom * (1 - ease(this.t));
      loco.koroAngle = this.angle;
      if (this.t >= LEAN_TIME) this.end();
      return;
    }
    if (this.phase === 'roll') {
      // 一方向・往復は、転がり始めると同時に前へ傾いていく（ゆらゆらは傾かない）
      loco.koroLean = this.pattern === 'sway' ? 0 : lean * ease(this.t);
      switch (this.pattern) {
        case 'one':
          this.angle += this.sign * w * dt;
          if (this.travel && this.finishTo !== null) {
            // 移動の最後の 1 回転：一方向と同じに前傾したまま同じ速さで転がり、立った向きに着いたら体を起こす
            // （起き上がりの回し方（finish）は前傾せず速く回るので、1 回転だけの移動では前傾しないまま回って見えた）
            this.aimRoll(dt);
            if ((this.angle - this.finishTo) * this.sign >= 0) {
              this.angle = this.finishTo;
              loco.koroAngle = this.angle;
              this.leanFrom = loco.koroLean;
              this.go('unlean');
              return;
            }
          } else if (this.travel) this.steer(dt, w);
          break;
        case 'shuttle':
          this.angle += this.sign * w * dt;
          this.flipIn -= dt;
          if (this.flipIn <= 0) {
            this.sign = -this.sign;
            this.flipIn = p.turnEvery;
          }
          break;
        case 'sway':
          // 片側へ swayWidth 回転転がって戻る（1 往復 turnEvery × 2 秒）
          this.angle = this.sign * p.swayWidth * Math.PI * 2 * Math.sin((Math.PI * this.t) / p.turnEvery);
          break;
      }
      this.sayIn -= dt;
      if (this.sayIn <= 0) {
        this.say(pick(ROLL_WORDS), 0.2, 1.4);
        this.sayIn = SAY_EVERY;
      }
      if (!this.travel && this.t >= p.time) this.go('finish');
    } else {
      // 起き上がる：近い「立った向き」（1 回転ごと）まで回す（移動では、決めておいた先の立った向きまで）
      const target = this.finishTo ?? Math.round(this.angle / (Math.PI * 2)) * Math.PI * 2;
      const d = target - this.angle;
      const step = Math.max(w, Math.PI) * dt;
      if (Math.abs(d) <= Math.max(step, UPRIGHT)) {
        this.angle = target;
        loco.koroAngle = this.angle;
        // 前へ傾いていれば、回り終えてから体を起こす
        if (loco.koroLean > 1e-3) {
          // 傾ききる前に時間が来たときも、その傾きからなめらかに起こす
          this.leanFrom = loco.koroLean;
          this.go('unlean');
        }
        else this.end();
        return;
      }
      this.angle += Math.sign(d) * step;
      if (this.travel) this.aimRoll(dt);
    }
    loco.koroAngle = this.angle;
  }

  /**
   * 移動：転がる向きを行き先へ回し、着く所で立った向きになるよう起き上がり始める所を決める
   * （次の立った向きまでに進む道のりが、残りの道のりに届いたら起き上がる）。近づけなくなったら（壁などに当たって）起き上がる
   */
  private steer(dt: number, w: number): void {
    const y = this.y;
    const loco = y.locomotion;
    const dx = this.travelTo.x - y.center.x, dz = this.travelTo.z - y.center.z;
    const dist = Math.hypot(dx, dz);
    const err = this.aimRoll(dt);
    // 1 rad あたりに進む道のりを測る（体型ごとに覚えておく）
    this.rolled += w * dt;
    this.traveled += Math.hypot(y.center.x - this.lastPos.x, y.center.z - this.lastPos.z);
    this.lastPos.copy(y.center);
    if (this.rolled > 2) this.perRadOf[this.presetId] = this.traveled / this.rolled;
    const perRad = this.perRadGuess();
    const full = Math.PI * 2;
    // 次の立った向き（転がる向きの先）
    const next = this.sign > 0 ? Math.ceil(this.angle / full) * full : Math.floor(this.angle / full) * full;
    const left = Math.abs(next - this.angle) * perRad;
    // 次の立った向きの方が、その次より行き先に近い・行き先が後ろへ回った（通り過ぎた）：次の立った向きで起き上がる
    if (left + full * perRad * 0.5 >= dist || dist <= loco.params.arriveRadius || Math.abs(err) > Math.PI * 0.75) {
      this.finishTo = next; // ここからは roll のまま、この向きまで転がって体を起こす
      return;
    }
    if (dist < this.bestDist - 0.02) {
      this.bestDist = dist;
      this.stall = 0;
    } else if ((this.stall += dt) > TRAVEL_STALL) {
      this.finishTo = null;
      this.go('finish');
    }
  }

  /** 移動：転がる向きを行き先へ回す（STEER まで）。回す前の、行き先とのずれ（rad）を返す */
  private aimRoll(dt: number): number {
    const y = this.y;
    const loco = y.locomotion;
    const dx = this.travelTo.x - y.center.x, dz = this.travelTo.z - y.center.z;
    // 転がる向き：立った向きの、体から見て右（sign = 1）か左
    const yaw = loco.koroYaw;
    const heading = Math.atan2(-Math.cos(yaw) * this.sign, Math.sin(yaw) * this.sign);
    const err = Math.atan2(Math.sin(Math.atan2(dx, dz) - heading), Math.cos(Math.atan2(dx, dz) - heading));
    const max = STEER * dt;
    // 行き先が後ろへ回った（通り過ぎた）ときは回さない
    if (Math.abs(err) < Math.PI / 2) loco.koroSteer(Math.max(-max, Math.min(max, err)));
    return err;
  }

  /** 移動：起き上がったら、その場で行き先へ向き直り、残りを跳ねる（跳ねられなければ這う）。もう着いていれば終わる */
  private faceTarget(dt: number): void {
    const y = this.y;
    const loco = y.locomotion;
    // 行き先を指示し直された・ほかの動きが始まった：任せる
    if (loco.hasTarget || loco.held || !this.othersFree()) {
      this.endFace();
      return;
    }
    if (loco.tilted || !loco.idle) {
      this.t = 0; // 体勢を立て直している間は待つ
      return;
    }
    const dx = this.travelTo.x - y.center.x, dz = this.travelTo.z - y.center.z;
    if (Math.hypot(dx, dz) <= loco.params.arriveRadius) {
      this.endFace();
      return;
    }
    const want = Math.atan2(dx, dz);
    this.faceYaw ??= y.body.yaw;
    const d = Math.atan2(Math.sin(want - this.faceYaw), Math.cos(want - this.faceYaw));
    this.faceYaw += Math.sign(d) * Math.min(Math.abs(d), FACE_TURN * dt);
    this.facePose.setFromAxisAngle(Y_UP, this.faceYaw);
    loco.gesture = { orientation: this.facePose, squash: 1 };
    const err = Math.abs(Math.atan2(Math.sin(want - y.body.yaw), Math.cos(want - y.body.yaw)));
    if ((err < FACE_OK && Math.abs(d) < 1e-3) || this.t > FACE_MAX) {
      this.endFace();
      loco.moveTo(this.travelTo.x, this.travelTo.z, 'hop');
    }
  }

  private endFace(): void {
    const loco = this.y.locomotion;
    if (loco.gesture?.orientation === this.facePose) loco.gesture = null;
    this.phase = 'none';
    this.newWait();
  }

  /** 1 rad 転がって進む道のり（m）の見込み */
  private perRadGuess(): number {
    return this.perRadOf[this.presetId] ?? this.y.shape.radius * PER_RAD;
  }

  /** 転がり終えて立つ（体勢を立て直す）→ひとこと */
  private end(): void {
    if (this.travel) {
      // 移動：ひとことは言わずに立ち、行き先へ向き直ってから残りを跳ねる（faceTarget）
      this.y.locomotion.koroEnd();
      this.clearFace();
      this.travel = false;
      this.faceYaw = null;
      this.go('face');
      return;
    }
    this.y.locomotion.koroEnd();
    this.say(this.y.line('koroDone'), 0.22, 1.8);
    this.go('after');
  }

  /** 転がる間の柔らかさに寄せる（眠る・気絶の処理が毎ステップ 1 へ戻そうとするので、こちらの値で上書きする） */
  private soften(dt: number): void {
    const b = this.y.body;
    const k = Math.min(1, dt * SOFTEN);
    this.soft += (this.params.soft - this.soft) * k;
    this.skin = Math.exp(Math.log(this.skin) + (Math.log(this.params.skin) - Math.log(this.skin)) * k);
    b.softness = this.soft;
    b.skinLoose = this.skin;
  }

  /** 向き sign（+1 右・-1 左）の先が空いているか（行ける範囲の内側で、当たる物・置いてある物にかからない） */
  private room(sign: number): boolean {
    const y = this.y;
    const st = y.stage;
    if (!st) return true;
    const yaw = y.body.yaw;
    // 体から見て右＝ローカル -X のワールドの向き
    const rx = -Math.cos(yaw) * sign, rz = Math.sin(yaw) * sign;
    const R = y.shape.radius;
    for (let k = 1; k <= 3; k++) {
      const d = (R * ROOM * k) / 3;
      const x = y.center.x + rx * d, z = y.center.z + rz * d;
      if (!st.inside(x, z, y.stageMargin * 0.8) || st.blocked(x, z, R * 0.8) || st.overlapProp(x, z, R * 0.8)) return false;
    }
    return true;
  }

  /** 何もしていない（立っていて、ほかの動きをしていない）か */
  private free(): boolean {
    const loco = this.y.locomotion;
    if (loco.held || loco.tilted || loco.immobile || loco.gesture || loco.moru) return false;
    // 挟まって起き上がれずにいる間は転がらない（傾いたまま立っているときも）
    return this.othersFree() && !this.y.greet.busy && !this.y.wedge.stuck;
  }

  /** ほかの動きをしていないか */
  private othersFree(): boolean {
    const y = this.y;
    if (y.death.active || y.otabe.active || y.rest.active || y.puku.active || y.flee.active || y.vomit.active) return false;
    if (y.feeding.active || y.dishEat.active || y.toilet.active || y.cleanup.active || y.grill.active || y.dropping.active) return false;
    if (y.exercise.active || y.moru.active || y.nestBuild.active || y.box.busy || y.branch.busy || y.forage.busy || y.ball.busy) return false;
    return !y.branch.holding;
  }

  private newWait(): void {
    this.wait = AUTO_WAIT[0] + Math.random() * (AUTO_WAIT[1] - AUTO_WAIT[0]);
  }

  private go(phase: Phase): void {
    this.phase = phase;
    this.t = 0;
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
}
