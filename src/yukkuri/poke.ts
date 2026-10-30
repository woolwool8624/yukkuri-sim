import * as THREE from 'three';
import { SWEAT_SPOTS, selectedIds, type PartSelection } from '../face/parts';
import { bodyFacing, showFace, type Word } from './fx';
import { loadJSON, saveJSON } from '../platform/storage';
import type { LineKey } from './lines';
import type { Yukkuri } from './Yukkuri';

/**
 * つつかれた・叩かれたときの反応（叩くはつつくの強いもの。Shift＋クリック）：
 *   ・体：つついた所を短い間押し続けてへこませ、離すと弾んで戻る。体全体も押された向きへ少し揺れる
 *     （一瞬だけ速さを足すと、形に戻る力ですぐ打ち消されて、へこみがほとんど見えない）
 *   ・顔：驚いた顔と文字をしばらく出す。続けてつつかれるほど（連打）、泣き顔 → 泣き目で食いしばり → 叫びと変わり、
 *     汗・涙が増える。食べている・うんうん・体操の最中は、その動きの顔を優先して体の動きだけにする
 *   ・叩く：つつくより広く深く、長く押してへこませ、体全体を押し飛ばして、しばらく震える。
 *     段階の顔を出し終えても、動きが止まって落ち着いてからしばらくは泣き顔のまま、ときどきすすり泣く（初めのうちは小刻みに震える）。
 *     連打の数を多く足し、顔は叩く用の段階（最初から痛がって泣き叫び、続けると白目・青ざめ）。
 *     当たった所に「バシッ」などの音の文字を出す
 *   ・倒れる・転がる：つつく・叩くたびに「押された量」をため（つつく 1、叩く slapWeight。間を空けると減る）、
 *       立っているとき … toppleHits に届いたら、押された向きへ倒れる（Locomotion.knockDown）
 *       寝転んでいるとき … rollHits に届いたら、押された向きへ「ごろん」と転がる（腹ばい⇔仰向け。叩いて届いたら 2 回）。
 *                         転がり終えたら近い方の寝転びに落ち着く（Locomotion.knock）
 *     届くまでは、押されて揺れるだけ
 */

/** 押し続ける時間（秒）と、強さ 1 あたり・1 秒あたりに足す速さ（m/s）、押す範囲（胴の半径に対する比） */
const PUSH_TIME = 0.15;
const PUSH_GAIN = 60;
const PUSH_RADIUS = 1.0;
/** 体全体を押された向きへ揺らす速さ（強さ 1 あたり、m/s。水平の向きだけ） */
const SHOVE = 0.06;
/** 連打の数え方：つつくたびに 1 足し、1 秒あたりこれだけ減らす（間を空けると落ち着いていく） */
const HIT_DECAY = 0.7;

/** 寝転んでいるときに叩いて転がるときの回数（半回転ずつ。つつくと 1 回）。前は 2 回だった（指示で 1 回に） */
const SLAP_TURNS = 1;
/**
 * 叩かれた後の泣き顔：段階の顔を出し終えても、動きが止まって落ち着いて（立って止まっているか寝転がり終えて）から
 * この時間（秒）は泣き顔のまま、ときどきすすり泣く。叩かれるたびに数え直す
 */
const SLAP_CRY_TIME = 16;
/** 泣き顔のうち、初めのこの時間（秒。落ち着いてから数える）は小刻みに震える。振れ幅（胴の半径に対する比）と、収める時間（秒） */
const SLAP_CRY_SHAKE = 12;
const CRY_TREMBLE = 0.008;
const CRY_TREMBLE_FADE = 1;
const SLAP_SOB_EVERY = 2.6;
const CRY_FACE: Partial<PartSelection> = { eyes: 'cry', brows: 'worried', mouth: 'sob' };
const CRY_AT_LEAST: Partial<PartSelection> = { tears: 'lots', stream: 'few' };
const CRY_SWEAT = ['forehead', 'templeL', 'templeR'];
/** 倒れる・転がるまでの回数の調整値（調整パネルの「動きの調整」→「つつく・叩く」。保存する） */
export interface PokeParams {
  /** 立っているとき、押された量がこれに届いたら倒れる（つつく回数で数える） */
  toppleHits: number;
  /** 寝転んでいるとき、押された量がこれに届いたら転がる（つつく回数で数える） */
  rollHits: number;
  /** 叩く 1 回が、つつく何回分か */
  slapWeight: number;
}
export const DEFAULT_POKE: PokeParams = { toppleHits: 2, rollHits: 3, slapWeight: 2 };
const STORAGE_KEY = 'poke';
/**
 * 押された量の減り方：最後に押されてから PUSHED_HOLD 秒は減らさず、そのあと 1 秒あたり PUSHED_DECAY 減らす
 * （続けて押しているうちは数えた分のまま。すぐ減らすと、押す間に減って決めた回数で届かない）
 */
const PUSHED_HOLD = 1.5;
const PUSHED_DECAY = 0.5;
/** 叩く：押す時間・押す範囲（胴の半径に対する比）・体全体を揺らす速さ（強さ 1 あたり）・足す連打の数 */
const SLAP_TIME = 0.22;
const SLAP_RADIUS = 1.5;
const SLAP_SHOVE = 0.12;
const SLAP_HITS = 2.2;
/** 叩いた後の震え（振れ幅は胴の半径に対する比。時間（秒）で収まる） */
const SLAP_TREMBLE = 0.025;
const SLAP_TREMBLE_TIME = 1.4;
/** 叩いた音の文字（どれかを出す） */
const SLAP_SOUNDS = ['バシッ', 'バチンッ', 'ベチッ'];

/** 連打の段階ごとの反応（hits がこの値以上で、この段階） */
interface Level {
  hits: number;
  face: Partial<PartSelection>;
  /** 選んでいるものがこれより少ないときだけ足す（涙など） */
  atLeast: Partial<PartSelection>;
  /** 汗を出す場所（選んでいる場所に足す） */
  sweat: string[];
  /** 言うこと（セリフの場面。キャラクターと口調で選ぶ） */
  line: LineKey;
  /** 顔を出しておく時間（秒） */
  time: number;
}

const LEVELS: Level[] = [
  {
    hits: 0, face: { eyes: 'squeeze', brows: 'worried', mouth: 'openSmall' }, atLeast: {}, sweat: [],
    line: 'poke1', time: 1.1,
  },
  {
    hits: 1.6, face: { eyes: 'tearyNarrow', brows: 'worried', mouth: 'sob' }, atLeast: { tears: 'few' },
    sweat: ['forehead', 'templeL', 'templeR'], line: 'poke2', time: 1.6,
  },
  {
    hits: 3.4, face: { eyes: 'cry', brows: 'worried', mouth: 'grit' }, atLeast: { tears: 'more', stream: 'few' },
    sweat: ['forehead', 'templeL', 'templeR', 'cheekL', 'cheekR'], line: 'poke3', time: 2.2,
  },
  {
    hits: 5.2, face: { eyes: 'cry', brows: 'worried', mouth: 'wail' }, atLeast: { tears: 'lots', stream: 'lots' },
    sweat: ['forehead', 'templeL', 'templeR', 'cheekL', 'cheekR', 'mouthL', 'mouthR'], line: 'poke4', time: 3.0,
  },
];

/** 叩かれたときの段階（hits は叩く・つつくの連打の数を合わせたもの） */
const SLAP_LEVELS: Level[] = [
  {
    hits: 0, face: { eyes: 'squeeze', brows: 'worried', mouth: 'wail' }, atLeast: { tears: 'more' },
    sweat: ['forehead', 'templeL', 'templeR', 'cheekL', 'cheekR'], line: 'slap1', time: 2.0,
  },
  {
    hits: 3, face: { eyes: 'cry', brows: 'worried', mouth: 'wail' }, atLeast: { tears: 'lots', stream: 'few' },
    sweat: ['forehead', 'templeL', 'templeR', 'cheekL', 'cheekR', 'mouthL', 'mouthR'], line: 'slap2', time: 2.6,
  },
  {
    hits: 6, face: { eyes: 'shock', brows: 'worried', mouth: 'wail' }, atLeast: { tears: 'lots', stream: 'lots', pale: 'some' },
    sweat: ['forehead', 'templeL', 'templeR', 'cheekL', 'cheekR', 'mouthL', 'mouthR', 'bodyL', 'bodyR'], line: 'slap3', time: 3.0,
  },
  {
    hits: 9, face: { eyes: 'cry', brows: 'worried', mouth: 'wail', strain: 'max' }, atLeast: { tears: 'lots', stream: 'lots', pale: 'lots' },
    sweat: ['forehead', 'templeL', 'templeR', 'cheekL', 'cheekR', 'mouthL', 'mouthR', 'bodyL', 'bodyC', 'bodyR'], line: 'slap4', time: 3.5,
  },
];

export class Poke {
  private pushLeft = 0;
  /** 今押している範囲（胴の半径に対する比） */
  private pushRadius = PUSH_RADIUS;
  /** 叩いた後の震えの残り時間（0 なら震えていない） */
  private trembleLeft = 0;
  private readonly point = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  /** 顔を出している残り時間（0 なら出していない） */
  private faceLeft = 0;
  /** 叩かれた後の泣き顔の残り時間（落ち着いてから減る。0 なら泣いていない）と、次にすすり泣くまで */
  private cryLeft = 0;
  private sobIn = 0;
  /** 連打の数（つつくたびに 1 足し、時間とともに減る） */
  private hits = 0;
  /** 押された量（倒れる・転がるまでの数え方）と、数えているのが立っているときか寝転んでいるときか */
  private pushed = 0;
  private pushedLying = false;
  /** 最後に押されてからの時間（秒） */
  private sincePush = 0;
  /** 最後につつかれた・叩かれてからの時間（秒） */
  get sincePoke(): number {
    return this.sincePush;
  }
  readonly params: PokeParams = { ...DEFAULT_POKE, ...loadJSON<Partial<PokeParams>>(STORAGE_KEY) };
  /** 文字を出す向き（見る人から見て左右交互。重ならないように） */
  private side = 1;
  /** 前に出した文字（続けてつつかれたら、新しい文字と重ならないよう早めに消す） */
  private word: Word | null = null;

  constructor(private readonly y: Yukkuri) {}

  /** 点 point（ワールド）を向き dir に強さ strength（m/s）でつつく */
  start(point: THREE.Vector3, dir: THREE.Vector3, strength: number): void {
    this.hit(point, dir, strength, false);
  }

  /** 点 point（ワールド）を向き dir に強さ strength（m/s）で叩く（つつくより激しく反応する） */
  slap(point: THREE.Vector3, dir: THREE.Vector3, strength: number): void {
    this.hit(point, dir, strength, true);
  }

  /** 叩いた所に音の文字（体の表面から少し手前に出す。dir は叩いた向きの単位ベクトル） */
  private slapSound(point: THREE.Vector3, dir: THREE.Vector3): void {
    const y = this.y;
    const R = y.shape.radius;
    const at = point.clone().addScaledVector(dir, -R * 0.15);
    const sound = SLAP_SOUNDS[Math.floor(Math.random() * SLAP_SOUNDS.length)];
    y.texts.say(sound, at.clone().add(new THREE.Vector3(0, R * 0.35, 0)), R * 0.32, 0.7, new THREE.Vector3(0, R * 0.5, 0));
  }

  private hit(point: THREE.Vector3, dir: THREE.Vector3, strength: number, slap: boolean): void {
    const y = this.y;
    const R = y.shape.radius;
    // 二つに割れた後：当たった半分が固いまま揺れるだけ（叩いたら音の文字も）。顔・声・ストレスはなし
    if (y.otabe.split) {
      y.otabe.hit(point, dir, strength);
      if (slap) this.slapSound(point, dir.clone().normalize());
      return;
    }
    const dead = y.death.active; // 死んでいく途中・死んだ後は、体が押される・へこむだけ（起きない・ストレス・顔・声なし）
    if (!dead) y.rest.wake(true); // 眠っていたら起きる（顔はつつかれた反応にする）
    this.point.copy(point);
    this.velocity.copy(dir).normalize().multiplyScalar(strength);
    this.pushLeft = slap ? SLAP_TIME : PUSH_TIME;
    this.pushRadius = slap ? SLAP_RADIUS : PUSH_RADIUS;
    // 体全体も押された向きへ（地面へ押し込まないよう水平だけ）
    const shove = this.velocity.clone().setY(0).multiplyScalar(slap ? SLAP_SHOVE : SHOVE);
    y.body.addVelocity(shove.x, 0, shove.z);
    if (dead) return;
    this.hits += slap ? SLAP_HITS : 1;
    y.stress.add(slap ? y.stress.params.slap : y.stress.params.poke);
    if (slap) {
      y.forage.spill(); // 叩かれると帽子のつばの餌は落ちる
      y.nestBuild.cancel(); // 巣作りはやめる（運んでいる物はその場に落とす）
    }
    // 押された量をためて、届いたら倒れる（立っているとき）・転がる（寝転んでいるとき）
    this.knockOver(slap, strength);
    if (slap) this.slapSound(point, this.velocity.clone().normalize());
    // 枝を持っていてつつかれたら、痛がる代わりに枝を振って威嚇し返す（叩かれたときは痛がる）
    if (!slap && y.branch.counter()) return;
    // 顔（ほかの動きが顔を使っていなければ）
    if (this.busy()) return;
    if (slap) {
      this.trembleLeft = SLAP_TREMBLE_TIME;
      this.cryLeft = SLAP_CRY_TIME;
      this.sobIn = SLAP_SOB_EVERY;
    }
    const levels = slap ? SLAP_LEVELS : LEVELS;
    let level = levels[0];
    for (const l of levels) if (this.hits >= l.hits) level = l;
    // 叩かれた後につつかれたら、叩かれた顔のまま（つつく段階の顔に戻すと、痛がり方が急に軽くなる）
    if (!slap && (this.trembleLeft > 0 || this.cryLeft > 0)) return;
    showFace(y, level.face, level.atLeast);
    if (level.sweat.length > 0 && y.face.override) {
      const on = new Set([...selectedIds(y.face.settings.parts.sweat), ...level.sweat]);
      y.face.override.sweat = SWEAT_SPOTS.filter((s) => on.has(s.id)).map((s) => s.id).join(',');
    }
    this.faceLeft = level.time;
    // 文字：頭の上の少し横（続けて出すときは左右交互にずらして、前の文字と重ならないように）
    const facing = bodyFacing(y);
    const sideDir = new THREE.Vector3(-facing.z, 0, facing.x);
    this.side = -this.side;
    const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * 0.15, y.center.z)
      .addScaledVector(facing, R * 0.6).addScaledVector(sideDir, this.side * R * 0.5);
    if (this.word) y.texts.fade(this.word);
    this.word = y.texts.say(y.line(level.line), pos, R * (slap ? 0.38 : 0.3), level.time, new THREE.Vector3(0, R * 0.25, 0).addScaledVector(sideDir, this.side * R * 0.15));
  }

  /** 調整値を保存する */
  save(): void {
    saveJSON(STORAGE_KEY, this.params);
  }

  /**
   * 押された量をため、届いたら倒れる・転がる。立っているときと寝転んでいるときは別に数える
   * （倒れた直後から転がるまでの数を数え直す）
   */
  private knockOver(slap: boolean, strength: number): void {
    const loco = this.y.locomotion;
    const lying = loco.tilted; // 寝転んでいる（寝転ぶ・起き上がる途中も）
    if (lying !== this.pushedLying) {
      this.pushedLying = lying;
      this.pushed = 0;
    }
    this.pushed += slap ? this.params.slapWeight : 1;
    this.sincePush = 0;
    const need = lying ? this.params.rollHits : this.params.toppleHits;
    if (this.pushed + 1e-6 < need) return;
    const done = lying
      ? loco.knock(this.velocity.x, this.velocity.z, strength, slap ? SLAP_TURNS : 1)
      : loco.knockDown(this.velocity.x, this.velocity.z);
    if (done) {
      this.pushed = 0;
      // 倒れたら、次は寝転んだまま数える
      if (!lying) this.pushedLying = true;
    }
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    const y = this.y;
    this.sincePush += dt;
    if (this.sincePush > PUSHED_HOLD) this.pushed = Math.max(0, this.pushed - PUSHED_DECAY * dt);
    this.hits = Math.max(0, this.hits - HIT_DECAY * dt);
    if (this.pushLeft > 0) {
      const k = Math.min(dt, this.pushLeft) * PUSH_GAIN;
      this.pushLeft -= dt;
      y.body.addLocalVelocity(this.point.x, this.point.y, this.point.z, y.shape.radius * this.pushRadius,
        this.velocity.x * k, this.velocity.y * k, this.velocity.z * k);
    }
    if (this.trembleLeft > 0) {
      this.trembleLeft = Math.max(0, this.trembleLeft - dt);
      // ほかの動きが震えを使い出したら任せる
      if (this.busy()) this.trembleLeft = 0;
      else y.tremble = SLAP_TREMBLE * (this.trembleLeft / SLAP_TREMBLE_TIME);
    }
    if (this.faceLeft > 0) {
      this.faceLeft -= dt;
      // ほかの動きが始まって顔を使い出したら、そちらに任せる
      if (this.busy()) this.faceLeft = 0;
      else if (this.faceLeft <= 0 && this.cryLeft <= 0) y.face.override = null;
    }
    this.cry(dt);
  }

  /** 叩かれた後の泣き顔：段階の顔を出し終えたら泣き顔にし、落ち着いてから SLAP_CRY_TIME 秒で戻す */
  private cry(dt: number): void {
    if (this.cryLeft <= 0) return;
    const y = this.y;
    // ほかの動きが顔を使い出したら任せる（震えもそちらに任せる）
    if (this.busy()) {
      this.cryLeft = 0;
      return;
    }
    const loco = y.locomotion;
    // 転がっている・倒れている途中は減らさない（動きが止まってから数える）
    if (loco.idle || loco.resting) this.cryLeft -= dt;
    // 小刻みに震える（落ち着いてから SLAP_CRY_SHAKE 秒まで。終わりはなめらかに収める）。叩かれた直後の大きな震えのほうが強ければそちら
    const shakeLeft = this.cryLeft - (SLAP_CRY_TIME - SLAP_CRY_SHAKE);
    const shake = shakeLeft > 0 ? CRY_TREMBLE * Math.min(1, shakeLeft / CRY_TREMBLE_FADE) : 0;
    if (this.trembleLeft <= 0) y.tremble = shake;
    else y.tremble = Math.max(y.tremble, shake);
    if (this.faceLeft > 0) return; // 段階の顔を出している間はそのまま
    if (this.cryLeft <= 0) {
      y.face.override = null;
      return;
    }
    if (y.face.override?.mouth !== CRY_FACE.mouth) {
      showFace(y, CRY_FACE, CRY_AT_LEAST);
      if (y.face.override) {
        const on = new Set([...selectedIds(y.face.settings.parts.sweat), ...CRY_SWEAT]);
        y.face.override.sweat = SWEAT_SPOTS.filter((s) => on.has(s.id)).map((s) => s.id).join(',');
      }
    }
    // ときどきすすり泣く（顔の横に小さく）
    this.sobIn -= dt;
    if (this.sobIn <= 0) {
      this.sobIn = SLAP_SOB_EVERY;
      const R = y.shape.radius;
      const facing = bodyFacing(y);
      const sideDir = new THREE.Vector3(-facing.z, 0, facing.x);
      this.side = -this.side;
      const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.4, y.center.z)
        .addScaledVector(facing, R * 0.6).addScaledVector(sideDir, this.side * R * 0.6);
      if (this.word) y.texts.fade(this.word);
      this.word = y.texts.say(y.line('slapSob'), pos, R * 0.22, 1.8,
        new THREE.Vector3(0, R * 0.12, 0));
    }
  }

  /** 食べている・うんうん・体操・吐いている最中か（その動きの顔を優先する） */
  private busy(): boolean {
    const y = this.y;
    return y.feeding.active || y.dropping.active || y.exercise.active || y.vomit.active || y.rest.fainting;
  }
}
