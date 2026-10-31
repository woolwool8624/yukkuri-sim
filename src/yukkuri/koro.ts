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

const FACE_ROLL: Partial<PartSelection> = { eyes: 'smile', mouth: 'smile' };

type Phase = 'none' | 'roll' | 'finish' | 'unlean' | 'after';

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

  constructor(private readonly y: Yukkuri) {
    this.newWait();
  }

  /** 転がっている途中か（宣言の後、転がり始めてから起き上がって笑い終えるまで） */
  get active(): boolean {
    return this.phase !== 'none';
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
    if (this.active) return false;
    if (y.locomotion.held) y.locomotion.release();
    if (!y.locomotion.koroBegin()) return false;
    const p = this.params;
    this.pattern = p.pattern === 'random' ? pick(['one', 'shuttle', 'sway'] as const) : p.pattern;
    this.sign = p.dir === 'right' ? 1 : p.dir === 'left' ? -1 : Math.random() < 0.5 ? 1 : -1;
    // 決めた向きの先がふさがっていれば反対へ（どちらもふさがっていればそのまま）
    if (!this.room(this.sign) && this.room(-this.sign)) this.sign = -this.sign;
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

  /** やめる（その場で起き上がる） */
  stop(): void {
    if (this.phase === 'none') return;
    this.y.locomotion.koroEnd();
    this.clearFace();
    this.phase = 'none';
    this.newWait();
  }

  /** 固定時間刻みで呼ぶ（姿勢の指令を移動の処理より先に決める） */
  update(dt: number): void {
    const y = this.y;
    const loco = y.locomotion;
    const p = this.params;
    if (this.phase === 'none') {
      // 自分から遊ぶ：立って何もしていない時間が続いたら
      if (p.auto && this.free() && !loco.hasTarget && loco.idleTime > this.wait) {
        this.newWait();
        this.declare();
      }
      return;
    }
    this.t += dt;
    if (this.phase === 'after') {
      if (this.t > AFTER_TIME) {
        this.clearFace();
        this.phase = 'none';
        this.newWait();
      }
      return;
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
      if (this.t >= p.time) this.go('finish');
    } else {
      // 起き上がる：近い「立った向き」（1 回転ごと）まで回す
      const target = Math.round(this.angle / (Math.PI * 2)) * Math.PI * 2;
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
    }
    loco.koroAngle = this.angle;
  }

  /** 転がり終えて立つ（体勢を立て直す）→ひとこと */
  private end(): void {
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
    return this.othersFree() && !this.y.greet.busy;
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
