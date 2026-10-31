import { Quaternion, Vector3 } from 'three';
import type { SoftBody } from '../physics/SoftBody';

export type MoveMode = 'hop' | 'crawl' | 'moru';

export interface LocomotionParams {
  /** 移動方法：跳ねる・這う・もるんもるん（お尻を突き上げて左右に振りながら這う） */
  mode: MoveMode;
  /** 跳ねて移動できるか（できない体型は mode に関わらず這う） */
  canHop: boolean;
  /** 跳躍の高さ (m) */
  hopHeight: number;
  /** 1回の跳躍で進む距離 (m) */
  hopDistance: number;
  /** 溜めで縮む深さ（縦の倍率） */
  crouchDepth: number;
  /** 溜めの時間 (s) */
  crouchTime: number;
  /** 着地してから次に跳ぶまでの間 (s) */
  restTime: number;
  /** 這うときに前後へ伸びる量（1 = 伸びない） */
  crawlStretch: number;
  /** 這うときに潰れる深さ（縦の倍率） */
  crawlSquash: number;
  /** 這うときに頭（上部）を前に突き出す量（体の高さに対する比） */
  crawlBend: number;
  /** 這うリズム（伸び縮みの回数/秒） */
  crawlRhythm: number;
  /** 向きを変える速さ (rad/s) */
  turnSpeed: number;
  /**
   * 1回の跳躍で顔を向ける最大の角度（度）。溜めの間に背骨を曲げて顔を先に向けるので、
   * 大きくしすぎると皮が足りずにしわが出る
   */
  hopTurnMax: number;
  /** 1回の伸び縮み（這う）で顔を向ける最大の角度（度） */
  crawlTurnMax: number;
  /** 目的地に着いたとみなす距離 (m) */
  arriveRadius: number;
  /** 目的地がないとき、自分で行き先を決めてうろつく */
  wander: boolean;
  /** うろつく範囲（原点からの半径 m） */
  wanderRadius: number;
}

export const DEFAULT_LOCOMOTION: LocomotionParams = {
  mode: 'crawl',
  canHop: true,
  hopHeight: 0.12,
  hopDistance: 0.15,
  crouchDepth: 0.72,
  crouchTime: 0.22,
  restTime: 0.25,
  crawlStretch: 1.1,
  crawlSquash: 0.82,
  crawlBend: 0.15,
  crawlRhythm: 0.35,
  turnSpeed: 2.2,
  hopTurnMax: 30,
  crawlTurnMax: 60,
  arriveRadius: 0.2,
  wander: false,
  wanderRadius: 3,
};

type State = 'idle' | 'crouch' | 'air' | 'land' | 'crawl' | 'moru' | 'recover' | 'lieDown' | 'lying' | 'getUp' | 'koro';

/**
 * 横になる体勢。体の部位は「前面の下部がお腹、底があんよ」。
 *   腹ばい … お腹を地面につける（前に倒れ、顔は前下を向く）
 *   仰向け … お腹を真上に向ける（後ろに倒れ、背中側＝後頭部が地面につく）
 */
export type LyingPose = 'prone' | 'supine';

/** お腹の向き：正面から下へこの角度 (rad) */
const BELLY_DOWN = (35 * Math.PI) / 180;

/** 横になったときの前傾の角度 (rad, + で前)。お腹を真下／真上に向ける */
function lyingLean(pose: LyingPose): number {
  return pose === 'prone' ? Math.PI / 2 - BELLY_DOWN : -(Math.PI / 2 + BELLY_DOWN);
}

const Y_AXIS = new Vector3(0, 1, 0);
const X_AXIS = new Vector3(1, 0, 0);

/**
 * 「Y軸まわりの向き × 体に固定した回転 local」で表される姿勢のうち、current に最も近いものを返す。
 * 横になる・転がる・起き上がるときに、余計に回らない向きを選ぶのに使う
 */
function nearestPose(local: Quaternion, current: Quaternion, out: Quaternion): Quaternion {
  const q = new Quaternion();
  let best = 0;
  let bestAngle = Infinity;
  const search = (from: number, to: number, step: number) => {
    for (let a = from; a <= to; a += step) {
      q.setFromAxisAngle(Y_AXIS, a).multiply(local);
      const ang = q.angleTo(current);
      if (ang < bestAngle) {
        bestAngle = ang;
        best = a;
      }
    }
  };
  search(-Math.PI, Math.PI, Math.PI / 18);
  search(best - Math.PI / 18, best + Math.PI / 18, Math.PI / 180);
  return out.setFromAxisAngle(Y_AXIS, best).multiply(local);
}

/** 腹ばい／仰向けの体に固定した回転 */
function lyingLocal(pose: LyingPose): Quaternion {
  return new Quaternion().setFromAxisAngle(X_AXIS, lyingLean(pose));
}

const STATE_LABEL: Record<State, string> = {
  idle: '待機',
  crouch: '溜め',
  air: '跳躍中',
  land: '着地',
  crawl: '這う',
  moru: 'もるんもるん（移動）',
  recover: '体勢を立て直す',
  lieDown: '横になる',
  lying: '横になっている',
  getUp: '起き上がる',
  koro: 'こーろこーろ',
};

/** これ以上傾いたら転倒とみなして起き上がる (rad) */
const FALLEN = (50 * Math.PI) / 180;
/** 姿勢の段階を終えたとみなす、体と目標の姿勢の差 (rad) */
const POSE_TOLERANCE = (15 * Math.PI) / 180;
/** 指令が目標に届いてから、体が追いつかなくても次の段階へ進むまでの時間 (s) */
const POSE_WAIT = 0.8;
/** 横になる・寝返りで転がる・起き上がる角速度 (rad/s) */
const LIE_SPEED = 1.3;
/**
 * 横になる・転がる・起き上がる間の姿勢を保つ強さの下限。
 * 平たい体型（扁平型）は横倒しにすると元の向きへ戻ろうとする力が強いので、しっかり保つ
 */
const LIE_POSTURE = 0.5;
const ROLL_SPEED = 1.8;
/**
 * 前後の長さが、高さ・横幅の大きい方のこれ倍より長い体型（いもむし型など）は、仰向けになるとき
 * 後ろへ倒れず、長い軸のまわりに横へ転がって背中を地面につける（長い体を縦に起こすのは重くてできない）
 */
const LONG_BODY = 1.4;
const RISE_SPEED = 1.2;
/** 寝転び終えて体も止まったことにする、体の向きの回る速さ（rad/s）と、回る速さをなめらかにする強さ */
const SETTLED_SPIN = 0.25;
const SPIN_SMOOTH = 8;
/** 跳ね起きる（fastRise）ときの、起き上がる速さの倍率 */
const FAST_RISE = 2.5;
/** 身ぶり（体操など）の姿勢を保つ強さ（小さいほど遅れてなめらかに追う） */
const GESTURE_POSTURE = 0.25;
/** 身ぶりで背骨を縦に曲げている間の、形に戻る強さの下限 */
const GESTURE_STIFFNESS = 0.6;
/**
 * もるんもるん：顔を床に付けるほど前へ倒れてお尻を突き上げ、左右に振る。
 * 前へ倒す角度は Locomotion.moruLift（度）。前後に長い体型は体ごと大きく傾けると棒のように斜めに立つので、
 * 傾きは小さくして背骨を縦に曲げる（うんうんたいそうの腹ばいと同じ作り）。その傾き（rad）と曲げ（rad）は、
 * 角度が MORU_LIFT_BASE のときの値で、角度に比例させる
 */
const MORU_LIFT_BASE = 60;
const MORU_PITCH_LONG = 0.55;
const MORU_ARCH_LONG = 1.5;
/** お尻を振る 1 往復の時間（秒）。振る量は Locomotion.moruWag */
const MORU_PERIOD = 1.0;
/** 前へ倒れきるまで（秒。姿勢は強く保つので、指令をこの時間でなめらかに倒す） */
const MORU_TIP = 0.8;
/** 倒れ始めてから振り始めるまで（秒）と、振り幅が揃うまで（秒） */
const MORU_WAG_DELAY = 0.7;
const MORU_WAG_RAMP = 0.8;
/** もるんもるんで這う速さ（m/s。振りの真ん中で一番速く、振り切った所で遅い）と、向きを変える速さの比 */
const MORU_SPEED = 0.16;
const MORU_TURN = 0.5;
/**
 * もるんもるんの間の、形に戻る強さの下限。やわらかい体型（ひよこ・扁平・なすび）は、お尻を振った反動で頭ごと横へ 4 cm ほど揺れる。
 * 0.8 で全体型 1 cm 以内（前後に長い体型の背骨の曲げを保つ GESTURE_STIFFNESS より強い）
 */
const MORU_STIFFNESS = 0.8;
/** もるんもるんで這うとき、接地面の皮をゆるめる強さ（接地面の硬さが 0 のとき、皮の伸びやすさを 1 + これ 倍） */
const MORU_CONTACT_SKIN = 12;
/** もるんもるんで這うとき、横向きの速さを消す速さ（1/秒） */
const MORU_SIDE_DAMP = 12;
/**
 * もるんもるんの姿勢を保つ強さ。お尻だけをずらした形は、全体としては少し横を向いたように読み取られるので、
 * 弱く保つとその分だけ体ごと回ってしまう（お尻を振るたびに頭が逆へ振れて、転がるように見える）。強く保って体の向きは動かさない
 */
const MORU_POSTURE = 1;
/**
 * 寝転んでいるときにつつかれた・叩かれた（knock）：押された向きへ「ごろん」と半回転転がる（寝返りと同じく姿勢の指令を回す）。
 * 回る速さ（rad/s）は押す強さ（m/s）のこれ倍（KNOCK_ROLL_MIN〜KNOCK_ROLL_MAX）。転がり終えたら近い方の寝転びに落ち着き、
 * 転がした向きがほぼ真っすぐ立った向き（傾きが KNOCK_STAND より小さい）なら立つ（前後に長い体型の、背中を下にした仰向けから転がったとき）。
 * 何回も転がるときは、1 回ずつ落ち着いてから次を転がる（続けて 2 回分回すと、ひよこ・扁平・いもむし型は体が付いてこられず、
 * 半回転ほどで元の側へ戻った）。速さも、4 以上ではこれらの体型が転がりきれなかった
 */
const KNOCK_ROLL_GAIN = 1.1;
const KNOCK_ROLL_MIN = 2.5;
const KNOCK_ROLL_MAX = 3.5;
const KNOCK_STAND = (30 * Math.PI) / 180;
/** つつかれて転がるとき、底がこの回転（半回転に対する比）までに真下に来るなら、そこで止めて立ち上がる */
const KNOCK_STAND_TURN = 0.75;
/** 押された向きと底の向き（水平）の開きがこれより小さければ、底の向きへ転がして立たせる */
const KNOCK_STAND_SIDE = (70 * Math.PI) / 180;
/** 立っているときに押されて倒れる（knockDown）ときの、倒れる速さ（rad/s。自分から横になるときより速い） */
const KNOCK_DOWN_SPEED = 3.2;
/** 起き上がってから、倒れても寝転ばず立て直す猶予（秒） */
const RISE_GRACE = 1.5;
/** 前後に長い体型が倒れたとき、長い軸のまわりにこれ（rad）より転がっていれば、横に転がりきって仰向けになる */
const FALL_ROLL = Math.PI / 4;
/** 起き上がり完了とみなす傾き (rad) */
const RECOVERED = (10 * Math.PI) / 180;

/**
 * 移動しながら向きを変えるときの、1回に進む距離の倍率。
 * 目的地が正面なら 1、真横なら約 0.5、真後ろなら最小値。後ろの目的地へは小刻みに進みながら振り向く
 * （大回りしたり、目的地のまわりを回り続けたりしないように）
 */
/** 跳び出した直後に体をひねる速さ (rad/s) */
const HOP_TWIST_SPEED = 9;

function headingFactor(yawErr: number): number {
  return Math.max(0.15, (Math.cos(yawErr) + 1) / 2);
}
/**
 * 跳躍中（溜め・空中・着地）の姿勢を保つ強さの下限。
 * 後部が重い体型（ひよこ型・なすび型）は縮むと前に回転しやすいので、踏ん張って姿勢を保つ
 */
const HOP_POSTURE = 0.5;
/** 空中での姿勢を保つ強さの下限（跳び出した直後のひねりを空中で終えるため） */
const AIR_POSTURE = 0.85;
/** 跳ぶ高さの下限 (m)。これより低いと柔らかい底が地面から離れられない */
export const MIN_HOP_HEIGHT = 0.12;

/**
 * 移動の制御。ソフトボディの「筋肉」入力（伸縮・前傾・向き・底の滑り）を時間変化させて体を動かす。
 * 跳躍の踏み切りだけは地面を蹴る力として全体に速度を与える。
 */
export class Locomotion {
  readonly target = new Vector3();
  hasTarget = false;
  /**
   * ほかの動き（食べるなど）をしている。うろつかず、行き先を指示されても動かずに覚えておき、
   * release() で動き出す
   */
  private holding = false;
  /**
   * 立って止まっている間の身ぶりの指令（体操など）。null でいつもの立ち姿。
   *   orientation … 体の姿勢（向き・傾き）。squash … 縦の伸び（1 = そのまま、>1 で伸びる）
   *   arch … 背骨を縦に曲げる角度（rad。+ で後ろ、- で前を持ち上げる。省くと 0）
   *   bend … 上部（頭）を前へずらす量（底は地面に付けたまま。体の高さに対する比。省くと 0）
   *   bendSide … 上部を横（ローカル +X 側。- で -X 側）へずらす量（同。省くと 0）
   *   stretch … 前後の伸び（1 = そのまま。省くと 1）
   *   pin … 底を地面から離さない（物を押すときなど）
   * 移動中・寝転がっている間は使わない。身ぶりの間は転倒とみなして起き直さない
   */
  gesture: { orientation: Quaternion; squash: number; arch?: number; bend?: number; bendSide?: number; stretch?: number; pin?: boolean } | null = null;
  /**
   * もるんもるん：立って止まっている間、お尻を突き上げて左右に振る。移動するときも、そのままもるんもるんで這う
   * （移動方法が mode = 'moru' のときは、移動している間だけもるんもるんになる）
   */
  moru = false;
  /**
   * もるんもるんでお尻を横へ振る量（片側。体の前後の長さに対する比）。お尻だけをずらし、体の向き・頭は振らない。
   * 調整パネルの「もるんもるん」→「左右の揺れ幅」（Moru が設定を渡す）
   */
  moruWag = 0.35;
  /** もるんもるんで尻を上げる角度（度。前へ倒す角度）。調整パネルの「もるんもるん」→「尻を上げる角度」 */
  moruLift = 60;
  /**
   * もるんもるんで這うときの接地面の柔らかさ（形に戻る強さに掛ける倍率）と、床へ押し付ける強さ（m/s²）。
   * 体を床に押し付けて進むので、床に着いた所（顔の側は除く）だけ柔らかくつぶし、振りに合わせて押し付ける（Moru が設定を渡す）
   */
  moruContactSoft = 0.15;
  /** もるんもるんで、お尻を丸い玉に寄せるときの玉の大きさと、後ろへ寄せる量（Moru が体型ごとの設定を渡す） */
  moruDomeSize = 1;
  moruDomeBack = 0.3;
  moruPress = 7;
  /** もるんもるんの振りの、振り切った回数（振り切るたびに 1 増える）と、その向き（+1 で体の右へ振った） */
  wagBeats = 0;
  wagSide = 1;
  /** 動けない間に指示された行き先がある（target に入っている） */
  deferred = false;
  /**
   * 今の行き先へ向かうときの移動方法（moveTo で指定。null で設定 params.mode どおり）。
   * 着いた・止めた・ほかの行き先を指定したら戻る。もるんもるんの最中はそちらが優先
   */
  private targetMode: MoveMode | null = null;
  private state: State = 'idle';
  private t = 0;
  private airborne = false;
  private squash = 1;
  private stretch = 1;
  private bend = 0;
  /** 這う動作の今回の伸び縮みの大きさ（目的地が近いと小さくする） */
  private crawlAmp = 1;
  private lean = 0;
  private idleFor = 0;
  private idleWait = 2;
  /** 横になる向き（+1 腹ばい / -1 仰向け） */
  private lieSign = 1;
  /**
   * 横になる・寝返り・起き上がるときの姿勢の指令。
   *   立ち姿 ⇔ 腹ばい／仰向け … phaseTarget へそのまま前後に倒れる・起き上がる
   *   腹ばい ⇔ 仰向け（寝返り） … 体を横たえた向きの水平な軸まわりに 180° 転がる
   */
  private readonly poseCmd = new Quaternion();
  private readonly phaseTarget = new Quaternion();
  /** 寝返り中か */
  private rolling = false;
  private readonly rollStart = new Quaternion();
  private readonly rollAxis = new Vector3();
  private rollAngle = 0;
  private rollSign = 1;
  /** 今回の転がりで回る角度 (rad)。寝返りは 180° */
  private rollTotal = Math.PI;
  /** 横に転がって仰向けになっている（起き上がるとき・腹ばいへ寝返るときも横に転がって戻す） */
  private rolledOnBack = false;
  /** 横に転がって起きたあと、続けて腹ばいへ倒れる */
  private proneAfterRoll = false;
  /** 起き上がってからの猶予（秒）。この間に倒れても寝転ばず立て直す */
  private riseGrace = 0;
  private readonly _rq = new Quaternion();
  /**
   * こーろこーろ：始めた時の立った向き・回す軸（水平。体の前向き）・前へ傾ける軸（水平。体の右左）。
   * 回した角度 koroAngle と前へ傾けた角度 koroLean は、呼ぶ側が毎ステップ決める
   */
  private readonly koroStart = new Quaternion();
  private readonly koroAxis = new Vector3();
  private readonly koroLeanAxis = new Vector3();
  private readonly _lq = new Quaternion();
  koroAngle = 0;
  koroLean = 0;
  /** 今の転がりの速さ（rad/s）と、つつかれて転がっている最中か（転がり終えたら近い方の寝転びに落ち着かせる） */
  private rollSpeed = ROLL_SPEED;
  private knockRoll = false;
  /** 横になる（倒れる・起き上がる）ときの姿勢の速さ（押されて倒れるときだけ速い） */
  private lieSpeed = LIE_SPEED;
  /** つつかれて、この後に続けて転がる回数と、その向き・強さ */
  private knockQueue = 0;
  private readonly knockDir = new Vector3();
  private knockPower = 0;
  /** 姿勢の指令が目標に届いてからの時間 */
  private reachedFor = 0;
  /** 指令中の向き（目標の向きへ turnSpeed で近づける） */
  private cmdYaw: number | null = null;
  private readonly prevCenter = new Vector3();
  private readonly velocity = new Vector3();
  /** 今回の跳躍：踏み切り地点・進む距離・頂点の高さ・立ち姿勢の重心の高さ */
  private readonly hopFrom = new Vector3();
  private hopDist = 0;
  /**
   * 今回の跳躍の方向転換。溜めの間に背骨を曲げて顔を hopYaw0 + hopTurn へ向け、
   * そちらへ跳び、空中で体をひねって顔の向きに追いつかせる（曲げは戻す）
   */
  private hopYaw0 = 0;
  private hopTurn = 0;
  /** 今回の跳躍の方向（= hopYaw0 + hopTurn） */
  private hopYaw = 0;
  private hopDirX = 0;
  private hopDirZ = 1;
  /**
   * 這う動作の今回の伸び縮みでの方向転換。
   *   伸びる … 後ろの端を固定し、体を横に曲げて頭を新しい向きへ突き出す（体の向きは回さない）
   *   縮む   … 頭の端を固定し、横の曲げを戻しながら体の向きを crawlTurn だけ回す（後部が弧を描いてついてくる）
   */
  private crawlTurn = 0;
  private crawlYaw0 = 0;
  private sideBend = 0;
  /** 縦への曲げ（身ぶりで後ろを持ち上げるときだけ） */
  private arch = 0;
  private apexY = 0;
  private standY = 0;
  private readonly _v = new Vector3();
  /** 這う動作の今回の伸び縮みを始めた位置（1回で進んだ距離を測る） */
  private readonly cycleFrom = new Vector3();
  /** もるんもるんの姿勢になってからの時間・振りの時計・向き（その場で振るときの基準）と、姿勢の指令 */
  private moruT = 0;
  /** 前のステップでもるんもるんの姿勢だったか（抜けたときに、倒れたとみなさず立て直すため） */
  private wasMoru = false;
  private wagClock = 0;
  private moruYaw = 0;
  private readonly moruCmd = new Quaternion();
  private readonly _mq = new Quaternion();

  constructor(private readonly body: SoftBody, readonly params: LocomotionParams) {
    this.prevCenter.copy(body.center);
    this.standY = body.center.y;
  }

  get stateLabel(): string {
    if (this.state === 'lying' || this.state === 'lieDown') {
      const pose = this.lieSign > 0 ? '腹ばい' : '仰向け';
      return this.state === 'lying' ? pose : `${pose}になる`;
    }
    if (this.state === 'idle' && this.moru && !this.gesture) return 'もるんもるん';
    return STATE_LABEL[this.state];
  }

  /** もるんもるんの姿勢をとっているか（その場で振っている・もるんもるんで這っている） */
  get inMoruPose(): boolean {
    return this.state === 'moru' || (this.state === 'idle' && this.moru && !this.gesture);
  }

  /**
   * 横になる。立っていれば前（腹ばい）・後ろ（仰向け）へそのまま倒れ、
   * 反対の体勢で横になっていれば、起き上がらずに寝返りで切り替える。移動中なら移動をやめる。
   * side：前後に長い体型が仰向けになるとき、横へ転がる向き（1 / -1。0 ならランダム。といれで塊の出る所を決めるのに使う）
   */
  lieDown(pose: LyingPose, passive = false, side = 0): void {
    if (this.immobile && !passive) return;
    const b = this.body;
    this.knockQueue = 0; // つつかれて続けて転がる分は、ほかの指示が来たらやめる
    this.lieSpeed = LIE_SPEED;
    const sign = pose === 'prone' ? 1 : -1;
    const lying = this.state === 'lieDown' || this.state === 'lying';
    this.hasTarget = false;
    if (lying && sign === this.lieSign) return; // すでにその体勢
    this.lieSign = sign;
    this.reachedFor = 0;
    if (lying && this.rolledOnBack) {
      // 横に転がって仰向けになっていれば、横に転がって起きてから前へ倒れる（腹ばいへ）
      this.startRoll(this.forwardAxis(this.poseCmd), Math.random() < 0.5 ? 1 : -1);
      this.rolledOnBack = false;
      this.proneAfterRoll = sign > 0;
    } else if (lying) {
      // 寝返り：体を横たえた向き（頭の向きを水平にしたもの）を軸に、丸太のように 180° 転がる。
      // お腹は前面の下部にあるので、この転がりで腹ばい（お腹が真下）と仰向け（お腹が真上）が入れ替わる
      this.rolling = true;
      this.rollStart.copy(this.poseCmd);
      this.rollAxis.set(0, 1, 0).applyQuaternion(this.poseCmd);
      this.rollAxis.y = 0;
      if (this.rollAxis.lengthSq() < 1e-6) this.rollAxis.set(0, 0, 1).applyQuaternion(this.poseCmd).setY(0);
      this.rollAxis.normalize();
      this.rollAngle = 0;
      this.rollTotal = Math.PI;
      this.rollSign = Math.random() < 0.5 ? 1 : -1;
      this.phaseTarget.setFromAxisAngle(this.rollAxis, Math.PI).multiply(this.rollStart);
    } else if (pose === 'supine' && this.isLongBody()) {
      // 前後に長い体：長い軸のまわりに横へ転がって、背中を地面につける
      this.poseCmd.copy(b.rotation);
      this.startRoll(this.forwardAxis(b.rotation), side !== 0 ? Math.sign(side) : Math.random() < 0.5 ? 1 : -1);
      this.rolledOnBack = true;
    } else {
      // 立ち姿から：今の向きのまま、前（腹ばい）・後ろ（仰向け）へ倒れる
      this.rolling = false;
      this.rolledOnBack = false;
      this.poseCmd.copy(b.rotation);
      this.phaseTarget.setFromAxisAngle(Y_AXIS, b.yaw).multiply(lyingLocal(pose));
    }
    this.go('lieDown');
  }

  /**
   * 倒れた（傾きが FALLEN を超えた）：立て直さず、今の姿勢から近い方の寝転び（腹ばい・仰向け）へなめらかに移る。
   * 前後に長い体型が横へ倒れたときは、そのまま転がりきって仰向けになる（横に転がった仰向け）。移動はやめる
   */
  private fallOver(): void {
    const b = this.body;
    this.hasTarget = false;
    this.reachedFor = 0;
    this.proneAfterRoll = false;
    if (this.isLongBody()) {
      // 長い軸のまわりにどれだけ転がっているか（getUp と同じ測り方）
      const axis = this.forwardAxis(b.rotation);
      const yaw = Math.atan2(axis.x, axis.z);
      const right = new Vector3(1, 0, 0).applyAxisAngle(Y_AXIS, yaw);
      const up = new Vector3(0, 1, 0).applyQuaternion(b.rotation);
      const rolled = Math.atan2(-up.dot(right), up.y);
      if (Math.abs(rolled) > FALL_ROLL) {
        this.lieSign = -1;
        this.poseCmd.setFromAxisAngle(axis, rolled).multiply(new Quaternion().setFromAxisAngle(Y_AXIS, yaw));
        this.startRoll(axis, rolled > 0 ? 1 : -1, Math.PI - Math.abs(rolled));
        this.rolledOnBack = true;
        this.go('lieDown');
        return;
      }
    }
    // 腹ばい・仰向けそれぞれで、今の姿勢に一番近い向きのものを比べ、近い方へ
    const prone = nearestPose(lyingLocal('prone'), b.rotation, new Quaternion());
    const supine = nearestPose(lyingLocal('supine'), b.rotation, new Quaternion());
    const toProne = prone.angleTo(b.rotation) <= supine.angleTo(b.rotation);
    this.lieSign = toProne ? 1 : -1;
    this.rolling = false;
    this.rolledOnBack = false;
    this.poseCmd.copy(b.rotation);
    this.phaseTarget.copy(toProne ? prone : supine);
    this.go('lieDown');
  }

  /**
   * つつかれた・叩かれた：寝転んでいれば、押された水平の向き (dirX, dirZ) へ「ごろん」と turns 回（半回転ずつ）転がる。
   * 速さは押す強さ power（m/s）で決まる。転がっている最中にまたつつかれたら、同じ向きならもう 1 回分転がる。
   * 寝転ぶ途中・起き上がる途中・ほかの動き（うんうん・吐餡など）の最中は転がらない。転がったら true
   */
  knock(dirX: number, dirZ: number, power: number, turns = 1): boolean {
    if (this.holding) return false;
    if (this.state === 'lieDown' && this.knockRoll) {
      // 転がっている最中：転がり終えたら、続けて転がる（1 回ずつ）
      this.knockQueue += turns;
      this.knockDir.set(dirX, 0, dirZ);
      this.knockPower = power;
      return true;
    }
    if (this.state !== 'lying') return false;
    const len = Math.hypot(dirX, dirZ);
    if (len < 0.1) return false; // 真上から押した（転がる向きが決まらない）
    // 押された向きへ転がる回り方（上の面が押された向きへ進む）：軸は 真上 × 押された向き
    const axis = new Vector3(dirZ / len, 0, -dirX / len);
    if (this.isLongBody()) {
      // 前後に長い体型は、長い軸のまわりに丸太のように転がる（前後に転がすと長い体が縦に起きる）。
      // 向きは、押された向きの、長い軸に直交する成分の側（ほぼ真っすぐ前後から押したら、どちらかへ）
      const long = this.forwardAxis(this.poseCmd);
      const side = new Vector3(dirX / len, 0, dirZ / len).cross(long).y;
      // 上の面が押された向きへ進む向き（長い軸 × 真上 が押された向きと同じ側）。(長い軸 × 真上)・押された向き ＝ side
      const sign = Math.abs(side) > 0.05 ? Math.sign(side) : Math.random() < 0.5 ? 1 : -1;
      axis.copy(long).multiplyScalar(sign);
    }
    const speed = Math.min(KNOCK_ROLL_MAX, Math.max(KNOCK_ROLL_MIN, KNOCK_ROLL_GAIN * power));
    this.hasTarget = false;
    this.reachedFor = 0;
    this.proneAfterRoll = false;
    // 横に転がって仰向けになっている体型も、ここからは普通の寝転びとして扱う（転がり終えたら近い方を選び直す）
    this.rolledOnBack = false;
    // 底が押された側を向いていれば、半回転せずに底が真下に来る所まで転がって立ち上がる（腹ばい・仰向けに加えて、直立にもなる）。
    // 体の下向き b を軸のまわりに θ 回したときの高さが一番低くなる θ を求め、半回転より手前で、ほぼ真下に来るならそこまで
    const b = this._v.set(0, -1, 0).applyQuaternion(this.poseCmd);
    // 底が押された向きの側（KNOCK_STAND_SIDE 以内）を向いていれば、押された向きでなく底の向きへ転がす
    // （頬を下にして横から押す・前後に長い体型が長い軸のまわりに転がると、底が真下に来ず、いつまでも立てない）
    const hx = b.x, hz = b.z, h = Math.hypot(hx, hz);
    if (h > 0.3 && (hx * dirX + hz * dirZ) / (h * len) > Math.cos(KNOCK_STAND_SIDE)) axis.set(hz / h, 0, -hx / h);
    const par = axis.clone().multiplyScalar(b.dot(axis));
    const perp = b.clone().sub(par);
    const cross = new Vector3().crossVectors(axis, perp);
    let stand = Math.atan2(-cross.y, -perp.y);
    if (stand < 0) stand += Math.PI * 2;
    const lowest = -(par.y + perp.y * Math.cos(stand) + cross.y * Math.sin(stand));
    const toStand = stand > 0.05 && stand < Math.PI * KNOCK_STAND_TURN && lowest > Math.cos(KNOCK_STAND);
    this.startRoll(axis, 1, toStand ? stand : Math.PI);
    this.rollSpeed = speed;
    this.knockRoll = true;
    this.lieSign = -this.lieSign;
    // 残りは、転がり終えて落ち着いてから（'lying' で）続ける
    this.knockQueue = turns - 1;
    this.knockDir.set(dirX, 0, dirZ);
    this.knockPower = power;
    this.go('lieDown');
    return true;
  }

  /**
   * 立っているときに押されて倒れる：押された水平の向き (dirX, dirZ) へ倒れる（後ろから押されたら前へ倒れて腹ばい、
   * 前から押されたら後ろへ倒れて仰向け）。ほかの動きの最中・もるんもるんの最中・寝転んでいるときは倒れない。倒れたら true
   */
  knockDown(dirX: number, dirZ: number): boolean {
    if (this.holding || this.isLying || this.state === 'getUp' || this.inMoruPose) return false;
    const b = this.body;
    const forward = Math.sin(b.yaw) * dirX + Math.cos(b.yaw) * dirZ;
    this.gesture = null;
    this.lieDown(forward >= 0 ? 'prone' : 'supine', true);
    this.lieSpeed = KNOCK_DOWN_SPEED;
    return true;
  }

  /** 横になっていれば、そのまま体を起こして起き上がる（横に転がって仰向けになっていれば、横に転がって戻る） */
  getUp(): void {
    if (this.state !== 'lieDown' && this.state !== 'lying') return;
    if (this.immobile) return; // 足焼きで移動できなければ、自分から起き上がらない
    const b = this.body;
    this.knockQueue = 0;
    this.knockRoll = false;
    this.rolling = false;
    this.proneAfterRoll = false;
    this.reachedFor = 0;
    this.poseCmd.copy(b.rotation);
    if (this.rolledOnBack) {
      // 長い軸のまわりに横へ転がって戻る（向きの近い立ち姿を探すと、どれもほぼ 180° 離れていて縦に起き上がることがある）。
      // 今どれだけ転がっているか（体の上の向きの、長い軸のまわりの角度）を測り、近い方へその分だけ戻して真っすぐ立つ
      const axis = this.forwardAxis(b.rotation);
      const yaw = Math.atan2(axis.x, axis.z);
      const right = new Vector3(1, 0, 0).applyAxisAngle(Y_AXIS, yaw);
      const up = new Vector3(0, 1, 0).applyQuaternion(b.rotation);
      const rolled = Math.atan2(-up.dot(right), up.y);
      this.poseCmd.setFromAxisAngle(axis, rolled).multiply(new Quaternion().setFromAxisAngle(Y_AXIS, yaw));
      this.startRoll(axis, rolled > 0 ? -1 : 1, Math.abs(rolled));
      if (this.fastRise) this.rollSpeed = ROLL_SPEED * FAST_RISE;
      this.rolledOnBack = false;
    } else {
      nearestPose(new Quaternion(), b.rotation, this.phaseTarget);
    }
    this.go('getUp');
  }

  /** 前後の長さが、高さ・横幅の大きい方の LONG_BODY 倍より長い体型か（静止形状で測る） */
  isLongBody(): boolean {
    const r = this.body.rest;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < r.length; i += 3) {
      x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]);
      y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]);
      z0 = Math.min(z0, r[i + 2]); z1 = Math.max(z1, r[i + 2]);
    }
    return z1 - z0 > LONG_BODY * Math.max(x1 - x0, y1 - y0);
  }

  /** 姿勢 q の体の前（長い軸）の向きを水平にしたもの */
  private forwardAxis(q: Quaternion): Vector3 {
    const f = new Vector3(0, 0, 1).applyQuaternion(q).setY(0);
    if (f.lengthSq() < 1e-6) f.set(0, 1, 0).applyQuaternion(q).setY(0);
    if (f.lengthSq() < 1e-6) f.set(0, 0, 1);
    return f.normalize();
  }

  /** 今の姿勢の指令から、水平な軸 axis のまわりに sign の向きへ total (rad) 転がり始める */
  private startRoll(axis: Vector3, sign: number, total = Math.PI): void {
    this.rolling = true;
    this.rollSpeed = ROLL_SPEED;
    this.knockRoll = false;
    this.rollStart.copy(this.poseCmd);
    this.rollAxis.copy(axis);
    this.rollAngle = 0;
    this.rollSign = sign;
    this.rollTotal = total;
    this.phaseTarget.setFromAxisAngle(this.rollAxis, sign * total).multiply(this.rollStart);
  }

  /** 立って待機している（移動・体勢の切り替えをしていない）か */
  get idle(): boolean {
    return this.state === 'idle';
  }

  /** 立って待機し続けている時間（秒）。待機していなければ 0 */
  get idleTime(): number {
    return this.state === 'idle' ? this.idleFor : 0;
  }

  /** 横になり終えて止まっている（倒れ込み・寝返りの途中ではない）か */
  get resting(): boolean {
    return this.state === 'lying';
  }

  /**
   * 寝転び終えて、体も止まったか。寝転び終えた（resting）直後でも、体はまだ付いてきている途中のことがある
   * （いもむし型が横に転がって仰向けになると、指令に着いた時点で体は 80° 遅れて転がっていた）。
   * 遅れの大きさでは決めない（体型によっては止まっても 20〜40° 遅れたまま）。回る速さが SETTLED_SPIN より遅くなったら
   */
  get settled(): boolean {
    return this.resting && this.spin < SETTLED_SPIN;
  }
  /** 体の向きの回る速さ（rad/s。なめらかにしたもの） */
  private spin = 0;
  private readonly prevRotation = new Quaternion();

  /** 横になっている体勢（倒れ込み中を含む）。立っていれば null */
  get lyingPose(): LyingPose | null {
    return this.isLying ? (this.lieSign > 0 ? 'prone' : 'supine') : null;
  }

  /** 体を倒している（倒れ込み・横になっている・起き上がりの途中・こーろこーろ）か。跳ねる・這うときのつぶれとは別 */
  get tilted(): boolean {
    return this.isLying || this.state === 'getUp' || this.state === 'koro';
  }

  /** こーろこーろで転がっている途中か */
  get koroing(): boolean {
    return this.state === 'koro';
  }

  /**
   * こーろこーろを始める：立った向きのまま、体の前向きの軸のまわりに koroAngle だけ回した姿勢を指令し続ける（横へ転がる。
   * 正の角度で、上の面が体から見て右＝ローカル -X へ倒れる＝右へ転がる）。進むのは体と地面の摩擦まかせ。
   * 寝転んでいる・ほかの動きの途中は始めない（false）
   */
  koroBegin(): boolean {
    if (this.holding || this.immobile || this.isLying || this.state === 'getUp' || this.state === 'air') return false;
    const yaw = this.body.yaw;
    this.koroStart.setFromAxisAngle(Y_AXIS, yaw);
    this.koroAxis.set(Math.sin(yaw), 0, Math.cos(yaw));
    // 真上 × 前 のまわりに正に回すと、上の面が前へ倒れる
    this.koroLeanAxis.set(Math.cos(yaw), 0, -Math.sin(yaw));
    this.koroAngle = 0;
    this.koroLean = 0;
    this.poseCmd.copy(this.koroStart);
    this.gesture = null;
    this.hasTarget = false;
    this.go('koro');
    return true;
  }

  /** こーろこーろを終える：立った向きへ戻す（途中でやめたときは、体勢を立て直すのに任せる） */
  koroEnd(): void {
    if (this.state !== 'koro') return;
    this.poseCmd.copy(this.koroStart);
    this.riseGrace = RISE_GRACE;
    this.go('recover');
  }

  /** 横に転がって仰向けになっている（倒れ込み中を含む）か。前後に長い体型の仰向け */
  get rolledBack(): boolean {
    return this.rolledOnBack && this.isLying;
  }

  /** 横になっている（倒れ込み中を含む）か */
  get isLying(): boolean {
    return this.state === 'lieDown' || this.state === 'lying';
  }

  /** つつかれて転がって立ち上がった回数（足焼き：ホットプレートの上で立ったかを見るのに使う） */
  knockStands = 0;
  /** 次に起き上がるのを速く（跳ね起きる。うんうんの後のすっきりー）。起き上がり終えたら戻す */
  fastRise = false;

  /** 跳ねられない（足焼きで底が焼けた）：跳ねる指示でも這う */
  noHop = false;
  /**
   * 移動できない（足焼きで底が焼けた）：行き先の指示を受け付けない（うろつきもしない）。自分から体勢も変えない
   * （腹ばい・仰向けになる・起き上がる・寝返る）。つつかれて倒れる・転がるのは受け身なので起きる（倒れたら起き上がれない）
   */
  immobile = false;

  /** 行き先を行ける範囲の内側へ寄せる（マップに壁があるとき。Yukkuri が渡す） */
  limit: ((p: Vector3) => void) | null = null;
  /**
   * 行き先との間に回り込む物（森の大木のうろの幹）があれば、その手前で向かう道の途中の点（なければ null。Yukkuri が渡す）。
   * 毎回、今いる所から決め直す（覚えておく道はない）
   */
  route: ((from: Vector3, to: Vector3) => { x: number; z: number } | null) | null = null;
  /** 今向かっている点（行き先か、道の途中の点） */
  private readonly aim = new Vector3();

  /** 行き先を決める。mode を渡すと、そこへ向かう間だけその移動方法にする（跳ねられない体型は這う） */
  moveTo(x: number, z: number, mode: MoveMode | null = null): void {
    if (this.immobile) {
      this.stop();
      return;
    }
    this.target.set(x, 0, z);
    this.limit?.(this.target);
    this.targetMode = mode;
    this.idleFor = 0;
    if (this.holding) this.deferred = true;
    else this.hasTarget = true;
  }

  stop(): void {
    this.hasTarget = false;
    this.targetMode = null;
    this.deferred = false;
  }

  /** ほかの動きが移動を保留しているか（hold から release まで） */
  get held(): boolean {
    return this.holding;
  }

  /** ほかの動きを始める：今の移動をやめ、終わるまで動かない */
  hold(): void {
    this.holding = true;
    if (this.hasTarget) this.deferred = true;
    this.hasTarget = false;
  }

  /** ほかの動きが終わった：その間に指示された行き先があれば動き出す */
  release(): void {
    this.holding = false;
    if (this.deferred) this.hasTarget = true;
    this.deferred = false;
  }

  /** 体を置き直したときなどに、移動・体勢を待機状態に戻す（横になっていても立った状態に戻る） */
  reset(): void {
    this.hasTarget = false;
    this.targetMode = null;
    this.cmdYaw = null;
    this.squash = 1;
    this.stretch = 1;
    this.bend = 0;
    this.sideBend = 0;
    this.arch = 0;
    this.lean = 0;
    const act = this.body.actuation;
    act.squash = 1;
    act.stretch = 1;
    act.bend = 0;
    act.sideBend = 0;
    act.tailSway = 0;
    act.tailDome = 0;
    act.arch = 0;
    act.lean = 0;
    act.yaw = null;
    act.anchor = null;
    act.pivot = null;
    act.slideFriction = null;
    act.uprightMin = null;
    act.stiffnessMin = null;
    act.stiffnessMode = 'normal';
    act.contactSoft = null;
    act.contactPress = 0;
    act.contactSkin = 1;
    act.orientation = null;
    this.rolling = false;
    this.knockRoll = false;
    this.knockQueue = 0;
    this.go('idle');
  }

  update(dt: number, gravity: number): void {
    const b = this.body;
    const p = this.params;
    const act = b.actuation;
    this.t += dt;
    this.velocity.subVectors(b.center, this.prevCenter).divideScalar(dt);
    this.prevCenter.copy(b.center);
    // 体の向きの回る速さ（なめらかにする）
    this.spin += (b.rotation.angleTo(this.prevRotation) / dt - this.spin) * Math.min(1, dt * SPIN_SMOOTH);
    this.prevRotation.copy(b.rotation);

    // 目的地までの距離と向き（間にうろの幹があれば、道の途中の点へ向かう。距離は途中の点を通った道のり）
    const via = this.hasTarget ? this.route?.(b.center, this.target) ?? null : null;
    this.aim.set(via ? via.x : this.target.x, 0, via ? via.z : this.target.z);
    const dx = this.aim.x - b.center.x;
    const dz = this.aim.z - b.center.z;
    const dist = Math.hypot(dx, dz) + (via ? Math.hypot(this.target.x - via.x, this.target.z - via.z) : 0);
    const wantYaw = Math.atan2(dx, dz);
    const yawErr = wrapAngle(wantYaw - b.yaw);
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
    const needsMove = this.hasTarget && dist > p.arriveRadius;

    let squashGoal = 1;
    let leanGoal = 0;
    let rate = 8; // 伸縮の追従の速さ (1/s)
    let stretchGoal = 1;
    let bendGoal = 0;
    let sideGoal = 0;
    let archGoal = 0;
    act.slideFriction = null;
    act.fitGoal = false;
    act.bendSide = 0;
    act.pinBottom = false;
    act.anchor = null;
    act.pivot = null;
    act.uprightMin = null;
    act.stiffnessMin = null;
    act.orientation = null;
    act.tailSway = 0;
    act.tailDome = 0;
    act.contactSoft = null;
    act.contactPress = 0;
    act.contactSkin = 1;
    if (this.hasTarget) {
      // 向きを変えるのは決まった瞬間だけ（常に回し続けると機械的で、宙に浮いて見える）
      //   跳ねる … 跳び出した直後に、踏み切りで決めた方向へ素早く体をひねる
      //   這う   … 体を横に曲げて頭から向きを変える（'crawl' で指令する）。
      //            大きな方向転換も、伸び縮みを繰り返して弧を描きながら向きを変える
      if (this.cmdYaw === null) this.cmdYaw = b.yaw;
      if (this.state === 'air') {
        const err = wrapAngle(this.hopYaw - this.cmdYaw);
        const maxStep = HOP_TWIST_SPEED * dt;
        this.cmdYaw += Math.max(-maxStep, Math.min(maxStep, err));
      }
    } else {
      this.cmdYaw = null;
    }
    act.yaw = this.cmdYaw;

    // 転倒したら、何をしていても中断して起き上がる
    const tilt = tiltOf(b);
    // （自分から横になる・起き上がる途中は除く）
    const selfLying = this.state === 'lieDown' || this.state === 'lying' || this.state === 'getUp' || this.state === 'koro';
    // 倒れすぎたら、近い方の寝転び（腹ばい・仰向け）へそのまま移る。
    // 起き上がった直後（起き上がりきれずに傾いたまま立った）だけは、寝転びと起き上がりを繰り返さないよう立て直す
    this.riseGrace = Math.max(0, this.riseGrace - dt);
    // もるんもるんをやめた・もるんもるんで這ってきて着いた：大きく傾いたままなので、寝転ばずに立て直す
    const moruNow = this.inMoruPose;
    if (this.wasMoru && !moruNow) this.riseGrace = RISE_GRACE;
    this.wasMoru = moruNow;
    if (this.state !== 'recover' && this.state !== 'air' && !selfLying && !this.gesture && !this.inMoruPose && tilt > FALLEN) {
      if (this.riseGrace > 0) this.go('recover');
      else this.fallOver();
    }
    let leanRate = 6; // 前傾の追従の速さ (1/s)

    // 立ち姿勢の重心の高さ（跳躍の基準）。止まっている間だけ更新する
    // （連続跳躍中は着地の反動で上下しているので使わない）
    if (this.state === 'idle') {
      this.standY += (b.center.y - this.standY) * Math.min(1, dt * 5);
    }

    // もるんもるんの姿勢でないときは、振りの時計を戻し、今の向きをその場で振るときの基準にしておく
    if (!this.inMoruPose) {
      this.moruT = 0;
      this.wagClock = 0;
      this.moruYaw = this.cmdYaw ?? b.yaw;
    }

    switch (this.state) {
      case 'lieDown': {
        // 立ち姿から倒れる、または寝返りで転がる
        // （つつかれて転がるときは、途中で体が遅れて元の側へ戻らないよう、姿勢を強く保って回しきる）
        act.uprightMin = this.knockRoll ? 1 : LIE_POSTURE;
        squashGoal = 0.95;
        const done = this.rolling ? this.followRoll(dt) : this.followPose(dt, this.lieSpeed);
        if (done && this.proneAfterRoll) {
          // 横に転がって起きた：続けて前へ倒れて腹ばいになる
          this.proneAfterRoll = false;
          this.rolling = false;
          this.reachedFor = 0;
          const f = this.forwardAxis(this.poseCmd);
          this.phaseTarget.setFromAxisAngle(Y_AXIS, Math.atan2(f.x, f.z)).multiply(lyingLocal('prone'));
        } else if (done && this.knockRoll) {
          // つつかれて転がり終えた：近い方の寝転びに落ち着く（転がした向きがほぼ立った向きなら立つ）。
          // 体は指令に遅れて付いてくるので、判定は体でなく指令の向きで（前後に長い体型が背中を下にした仰向けから転がると、
          // お腹が下＝立った向きになるが、その時点の体はまだ 40° ほど傾いていて、寝転びの側を選んで転がり戻っていた）
          this.knockRoll = false;
          this.rolling = false;
          this.rollSpeed = ROLL_SPEED;
          const cmdUp = this._v.set(0, 1, 0).applyQuaternion(this.poseCmd).y;
          if (cmdUp > Math.cos(KNOCK_STAND)) {
            this.knockQueue = 0;
            this.knockStands++;
            this.riseGrace = RISE_GRACE;
            this.go('recover');
          } else this.fallOver();
        } else if (done) {
          this.rolling = false;
          this.go('lying');
        }
        act.orientation = this.poseCmd;
        break;
      }
      case 'lying': {
        act.uprightMin = LIE_POSTURE;
        this.lieSpeed = LIE_SPEED;
        act.orientation = this.poseCmd;
        // つつかれて、続けて転がる分が残っていれば転がる
        if (this.knockQueue > 0) {
          const rest = this.knockQueue;
          this.knockQueue = 0;
          this.knock(this.knockDir.x, this.knockDir.z, this.knockPower, rest);
          break;
        }
        // 行き先ができたら起き上がってから向かう
        if (this.hasTarget) this.getUp();
        break;
      }
      case 'getUp': {
        // 少し縮んで踏ん張り、そのまま体を起こす
        act.uprightMin = LIE_POSTURE;
        squashGoal = 0.92;
        const risen = this.rolling ? this.followRoll(dt) : this.followPose(dt, RISE_SPEED * (this.fastRise ? FAST_RISE : 1));
        if (risen && (tilt < RECOVERED || this.reachedFor > 2)) {
          this.rolling = false;
          this.fastRise = false;
          // 起き上がりきれなくても、倒れていれば「体勢を立て直す」が引き継ぐ（しばらくは倒れても寝転ばない）
          this.riseGrace = RISE_GRACE;
          this.go('idle');
          break;
        }
        act.orientation = this.poseCmd;
        break;
      }
      case 'koro': {
        // こーろこーろ：前へ koroLean だけ傾けた姿勢を、前向きの軸のまわりに koroAngle だけ回して、強く保って指令する
        // （体が遅れて戻らないよう）
        act.uprightMin = 1;
        squashGoal = 0.95;
        this._lq.setFromAxisAngle(this.koroLeanAxis, this.koroLean);
        this._rq.setFromAxisAngle(this.koroAxis, this.koroAngle);
        this.poseCmd.copy(this._rq).multiply(this._lq).multiply(this.koroStart);
        act.orientation = this.poseCmd;
        break;
      }
      case 'recover': {
        // 体をやや縮めて踏ん張り、全力で姿勢を戻す
        act.uprightMin = 1;
        squashGoal = 0.9;
        if (tilt < RECOVERED && this.t > 0.3) this.go('idle');
        break;
      }
      case 'idle': {
        this.idleFor += dt;
        if (!this.hasTarget && p.wander && !this.holding && this.idleFor > this.idleWait) {
          const a = Math.random() * Math.PI * 2;
          const r = Math.sqrt(Math.random()) * p.wanderRadius;
          this.moveTo(Math.cos(a) * r, Math.sin(a) * r);
          break; // 新しい行き先への判断は次のステップで行う
        }
        // 向きを変えてから動くのではなく、すぐに動き出して進みながら向きを変える
        if (needsMove) this.go(this.moveState());
        else if (this.hasTarget) this.arrive();
        else if (this.gesture) {
          // 身ぶり：指令の姿勢へなめらかに寄せ、縦に伸び縮みする
          act.orientation = this.gesture.orientation;
          act.uprightMin = GESTURE_POSTURE;
          squashGoal = this.gesture.squash;
          archGoal = this.gesture.arch ?? 0;
          bendGoal = this.gesture.bend ?? 0;
          stretchGoal = this.gesture.stretch ?? 1;
          // 大きく曲げるときは、やわらかい体型でも曲げた形を保てるように形に戻る強さを上げる
          if (archGoal !== 0 || bendGoal !== 0 || this.gesture.bendSide) act.stiffnessMin = GESTURE_STIFFNESS;
          // 上部を前へずらしたまま立つ：体の回転を曲げた形と比べて求める（静止形状と比べると前へ傾いたと読まれ、体ごと倒れる）
          act.bendSide = this.gesture.bendSide ?? 0;
          if (bendGoal !== 0 || act.bendSide !== 0) act.fitGoal = true;
          if (this.gesture.pin) act.pinBottom = true;
          rate = 6;
        } else if (this.moru) {
          // その場でもるんもるん：頭の先を支点にして、お尻を左右に振る
          const g = this.moruPose(dt, this.moruYaw, true);
          sideGoal = g.side;
          archGoal = g.arch;
          rate = 6;
        }
        break;
      }
      case 'moru': {
        // もるんもるんで這う：お尻を振りながら、振りに合わせて前へずりずり進む。向きは少しずつ目的地へ回す
        if (!needsMove) {
          this.arrive();
          break;
        }
        // 途中で跳ねる・這うを指定し直したら切り替える
        const next = this.moveState();
        if (next !== 'moru') {
          this.go(next);
          break;
        }
        const maxTurn = p.turnSpeed * MORU_TURN * dt;
        this.cmdYaw = (this.cmdYaw ?? b.yaw) + Math.max(-maxTurn, Math.min(maxTurn, wrapAngle(wantYaw - (this.cmdYaw ?? b.yaw))));
        act.yaw = this.cmdYaw;
        const g = this.moruPose(dt, this.cmdYaw, false);
        sideGoal = g.side;
        archGoal = g.arch;
        // 床に押し付けて進む：床に着いた所だけ柔らかくつぶし、振りの真ん中（前へずる所）で強く押し付ける
        act.contactSoft = this.moruContactSoft;
        act.contactPress = this.moruPress * g.surge;
        // 皮も接地面だけゆるめる（形に戻る強さを下げるだけでは、皮の張りで丸いまま残る）。柔らかくするほどゆるめる
        act.contactSkin = 1 + MORU_CONTACT_SKIN * (1 - this.moruContactSoft);
        rate = 6;
        // 振りの真ん中で一番速く、振り切った所で遅い。目的地が近い（着けるよう 4 割は残す）・横や後ろにあるほど遅い
        const yawNow = wrapAngle(wantYaw - this.cmdYaw);
        const speed = MORU_SPEED * g.surge * Math.max(0.4, Math.min(1, dist / 0.3)) * headingFactor(yawNow);
        // 前向きの速さをそろえる（地面の摩擦と、前へ倒した姿勢を保つ力で、少しずつ押すだけでは後ろへずれていく）。
        // 床に着いた所は前へだけ滑りやすくする（通常の摩擦だと、押した分がそのまま止められて進まない）。
        // 「前」は体の向きなので、お尻を振ると左右にぶれて体が横へ滑り、振りと共振して揺れが大きくなっていく。
        // 横向きの速さは強めに消す（お尻の振りは体の回転なので、重心が横へ動かなくても見える）
        const mx = Math.sin(this.cmdYaw), mz = Math.cos(this.cmdYaw);
        const v = b.meanVelocity(this._v);
        const dv = speed - (v.x * mx + v.z * mz);
        const lat = (v.x * mz - v.z * mx) * Math.min(1, dt * MORU_SIDE_DAMP);
        b.addVelocity(mx * dv - mz * lat, 0, mz * dv + mx * lat);
        act.slideFriction = 0.05;
        break;
      }
      case 'crouch': {
        // 着地の反動で浮いている間は溜めを進めない
        if (b.groundContacts === 0) this.t -= dt;
        const k = Math.min(Math.max(this.t, 0) / p.crouchTime, 1);
        squashGoal = 1 - (1 - p.crouchDepth) * easeOut(k);
        leanGoal = 0.1 + 0.05 * k;
        rate = 30;
        // 背骨を曲げている間は姿勢を最大の強さで保つ（曲がった体を「回った」と読み取って
        // 体ごと回り始めるのを防ぐ。這うときと同じ）
        act.uprightMin = 1;
        // 溜めながら背骨を曲げて、顔（頭）を先に跳ぶ方向へ向ける。体の向きはまだ変えない
        sideGoal = this.hopTurn * easeOut(k);
        this.cmdYaw = this.hopYaw0;
        act.yaw = this.cmdYaw;
        if (k >= 1) {
          // 踏み切り：地面を蹴って離陸する。正確な軌道は離陸後に合わせる（'air' を参照）
          const hopHeight = Math.max(p.hopHeight, MIN_HOP_HEIGHT);
          // 顔が向いている方向（溜めで決めた向き）へ跳ぶ。
          // 目的地がそれより横や後ろにあるほど小さく跳んで、次の跳躍で向きを合わせる
          this.hopYaw = this.hopYaw0 + this.hopTurn;
          this.hopDirX = Math.sin(this.hopYaw);
          this.hopDirZ = Math.cos(this.hopYaw);
          const errAfter = wrapAngle(Math.atan2(dx, dz) - this.hopYaw);
          this.hopDist = Math.min(p.hopDistance, dist) * headingFactor(errAfter);
          this.apexY = this.standY + hopHeight;
          this.hopFrom.copy(b.center);
          const vy = Math.sqrt(2 * gravity * hopHeight);
          const vf = this.hopDist / ((2 * vy) / gravity);
          // 溜めで縮みながら下向きに動いているので、速度は足すのではなく狙いの値にそろえる
          const v = b.meanVelocity(this._v);
          b.addVelocity(this.hopDirX * vf - v.x, vy - v.y, this.hopDirZ * vf - v.z);
          this.airborne = false;
          this.go('air');
        }
        break;
      }
      case 'air': {
        // 地面を離れるまでは縮んだまま（伸びる動きで地面を押すと跳躍量が狂う）。
        // 離れたら空中で縦に伸び、落ち始めたら元に戻して着地に備える
        const rising = this.velocity.y > 0;
        squashGoal = !this.airborne ? this.squash : rising ? 1.12 : 1.0;
        leanGoal = 0.1;
        rate = 25;
        // 空中では体のひねりを着地までに終えられるよう、姿勢をより強く保つ
        act.uprightMin = AIR_POSTURE;
        // 体が顔の向きに追いつく分だけ背骨の曲げを戻す（顔は跳ぶ方向を向いたまま）
        sideGoal = wrapAngle(this.hopYaw - (this.cmdYaw ?? this.hopYaw));
        // 上昇中は底を前に滑らせる（伸びた底が地面を叩いても勢いを失わない）
        if (rising) act.slideFriction = 0.02;
        // 離陸の判定：底が完全に離れたか、重心が立ち姿勢の高さを超えて上昇している
        // （大きく柔らかい体は底が地面に触れたまま跳ぶことがある）。
        // 一度離陸してから、落ちてきて接地したら着地とする
        if (b.groundContacts === 0 || (rising && b.center.y > this.standY)) this.airborne = true;
        // 上昇中は毎ステップ軌道を合わせ直す（空中で伸びた底が地面を押して余分に加速するのを打ち消す）
        if (this.airborne && rising && b.center.y < this.apexY - 0.005) this.alignTrajectory(gravity, this.hopDirX, this.hopDirZ);
        if ((this.airborne && !rising && b.groundContacts > 0) || this.t > 2) this.go('land');
        break;
      }
      case 'land': {
        // 着地の潰れは物理で自然に起きる。少しだけ自分でも沈み込む
        // 前傾は保つ（接地中に傾きを戻すと底が前に滑ろうとして体が後ろへ押し戻される）
        squashGoal = this.t < 0.08 ? 0.92 : 1;
        leanGoal = 0.1;
        rate = 12;
        act.uprightMin = HOP_POSTURE;
        if (this.t > p.restTime) {
          if (!needsMove) this.arrive();
          else this.go(this.moveState());
        }
        break;
      }
      case 'crawl': {
        // 尺取り虫の動き：
        //   前半 … 後ろの底で踏ん張り、潰れながら頭（上部）を前に突き出して伸びる
        //   後半 … 前の底で踏ん張り、後部を引き寄せながら頭を起こして元の形に戻る
        const cycles = this.t * p.crawlRhythm;
        const u = cycles % 1;
        if (cycles >= 1) {
          // 1回の伸び縮みが終わったところでだけ、止まるかを判断する。
          // 次の1回で進む距離より目的地が近ければ、そこで止まる（通り過ぎない）。
          // 向きは這いながら変えるので、目的地が横や後ろにあるほど小さく伸び縮みする
          // 1回で進んだ距離は、向いている方向へ進んだ分だけで測る
          const stride = Math.max(0, (b.center.x - this.cycleFrom.x) * fx + (b.center.z - this.cycleFrom.z) * fz);
          this.cycleFrom.copy(b.center);
          if (!needsMove || dist < stride * 0.5) { this.arrive(); break; }
          // 途中で移動方法を変えた（跳ねる・もるんもるんを指定し直した）ら、1 回の伸び縮みを終えたところで切り替える
          const next = this.moveState();
          if (next !== 'crawl') { this.go(next); break; }
          this.t = u / p.crawlRhythm;
          this.planCrawlTurn(yawErr);
          const fullStride = stride / Math.max(this.crawlAmp, 0.15);
          this.crawlAmp = Math.min(1, dist / Math.max(fullStride, 0.1)) * headingFactor(yawErr - this.crawlTurn);
        }
        const extending = u < 0.5;
        const k = smooth(extending ? u * 2 : 1 - (u - 0.5) * 2);
        // 方向転換：伸びる間に背骨を曲げて頭（顔）ごと新しい向きへ向け、
        // 縮む間に曲げを戻しながら体の向きを回す（頭はその向きのまま、後部がついてくる）
        sideGoal = this.crawlTurn * k;
        this.cmdYaw = extending ? this.crawlYaw0 : this.crawlYaw0 + this.crawlTurn * (1 - k);
        act.yaw = this.cmdYaw;
        squashGoal = 1 - (1 - p.crawlSquash) * k * this.crawlAmp;
        stretchGoal = 1 + (p.crawlStretch - 1) * k * this.crawlAmp;
        bendGoal = p.crawlBend * k * this.crawlAmp;
        act.anchor = extending ? 'rear' : 'front';
        act.pivot = extending ? 'rear' : 'front';
        // 端を固定して伸び縮みすると体がせん断されて前のめりになるので、姿勢を強めに保つ
        act.uprightMin = 1;
        rate = 15;
        break;
      }
    }

    // 状況ごとに形に戻る強さを切り替える
    act.stiffnessMode =
      this.state === 'crouch' || this.state === 'air' || this.state === 'land' ? 'hop'
        : this.state === 'lieDown' || this.state === 'lying' || this.state === 'getUp'
          ? (this.lieSign > 0 ? 'prone' : 'supine')
          : 'normal';

    const s = Math.min(1, dt * rate);
    this.squash += (squashGoal - this.squash) * s;
    this.stretch += (stretchGoal - this.stretch) * s;
    this.bend += (bendGoal - this.bend) * s;
    this.sideBend += (sideGoal - this.sideBend) * s;
    this.arch += (archGoal - this.arch) * s;
    this.lean += (leanGoal - this.lean) * Math.min(1, dt * leanRate);
    act.squash = this.squash;
    act.stretch = this.stretch;
    act.bend = this.bend;
    act.sideBend = this.sideBend;
    act.arch = this.arch;
    act.lean = this.lean;
  }

  /**
   * 全体の平均速度をそろえ、頂点の高さ apexY を通って
   * 立ち姿勢の高さで残りの距離ちょうどに着地する放物線に乗せる。
   * 全頂点に同じ速度を足すので、体の変形・揺れはそのまま残る。
   */
  private alignTrajectory(g: number, fx: number, fz: number): void {
    const b = this.body;
    const c = b.center;
    const up = Math.max(this.apexY - c.y, 0);
    const down = Math.max(this.apexY - this.standY, 0.01);
    const vy = Math.sqrt(2 * g * up);
    const flight = vy / g + Math.sqrt((2 * down) / g);
    const done = (c.x - this.hopFrom.x) * fx + (c.z - this.hopFrom.z) * fz;
    const vf = Math.max(this.hopDist - done, 0) / flight;
    const v = b.meanVelocity(this._v);
    b.addVelocity(fx * vf - v.x, vy - v.y, fz * vf - v.z);
  }

  /**
   * 姿勢の指令を目標へ一定の角速度で回す。指令が目標に届き、体も追いついたら true。
   * 体が追いつかないまま長く経ったら（引っかかり等）先へ進める
   */
  private followPose(dt: number, speed: number): boolean {
    this.poseCmd.rotateTowards(this.phaseTarget, speed * dt);
    if (this.poseCmd.angleTo(this.phaseTarget) > 1e-3) {
      this.reachedFor = 0;
      return false;
    }
    this.reachedFor += dt;
    const bodyClose = this.body.rotation.angleTo(this.phaseTarget) < POSE_TOLERANCE;
    return bodyClose || this.reachedFor > POSE_WAIT;
  }

  /** 寝返り：水平な軸まわりに一定の角速度で 180° 転がす。転がり終えて体も追いついたら true */
  private followRoll(dt: number): boolean {
    this.rollAngle = Math.min(this.rollTotal, this.rollAngle + this.rollSpeed * dt);
    this._rq.setFromAxisAngle(this.rollAxis, this.rollSign * this.rollAngle);
    this.poseCmd.copy(this._rq).multiply(this.rollStart);
    if (this.rollAngle < this.rollTotal) return false;
    this.reachedFor += dt;
    const bodyClose = this.body.rotation.angleTo(this.poseCmd) < POSE_TOLERANCE;
    return bodyClose || this.reachedFor > POSE_WAIT;
  }

  private moveState(): State {
    const mode = this.targetMode ?? this.params.mode;
    if (this.moru || mode === 'moru') return 'moru';
    return mode === 'hop' && this.params.canHop && !this.noHop ? 'crouch' : 'crawl';
  }

  /**
   * もるんもるんの姿勢：前へ倒れてお尻を突き上げ、お尻の部分だけを左右に振る（体の後ろ側かつ下側を横へずらす。体の向き・頭は動かさない）。
   * still：その場で振る（頭の先を支点にして、頭の位置を動かさない）。
   * 返す値：背骨の横曲げ・縦曲げの目標と、今の振りでの進む速さの比（振りの真ん中で 1）
   */
  private moruPose(dt: number, yaw: number, still: boolean): { side: number; arch: number; surge: number } {
    const act = this.body.actuation;
    this.moruT += dt;
    const ramp = smooth(Math.min(1, Math.max(0, (this.moruT - MORU_WAG_DELAY) / MORU_WAG_RAMP)));
    if (ramp > 0) {
      const before = this.wagClock;
      this.wagClock += dt;
      // 振り切った（sin の山・谷を越えた）回数を数える
      const beat = (t: number) => Math.floor((t - MORU_PERIOD / 4) / (MORU_PERIOD / 2));
      if (beat(this.wagClock) > beat(before)) {
        this.wagBeats++;
        this.wagSide = Math.sin((2 * Math.PI * (this.wagClock - dt * 0.5)) / MORU_PERIOD) > 0 ? 1 : -1;
      }
    }
    const phase = (2 * Math.PI * this.wagClock) / MORU_PERIOD;
    const wag = this.moruWag * ramp * Math.sin(phase);
    const long = this.isLongBody();
    const tip = smooth(Math.min(1, this.moruT / MORU_TIP));
    const lift = this.moruLift / MORU_LIFT_BASE;
    const pitch = (long ? MORU_PITCH_LONG * lift : (this.moruLift * Math.PI) / 180) * tip;
    this._mq.setFromAxisAngle(X_AXIS, pitch);
    this.moruCmd.setFromAxisAngle(Y_AXIS, yaw).multiply(this._mq);
    act.orientation = this.moruCmd;
    act.uprightMin = MORU_POSTURE;
    act.tailSway = wag;
    // お尻の先を太らせる（前へ倒すにつれて。先細りの卵形の端が、先へ行くほど太るように）
    // お尻を丸い玉にする（前へ倒すにつれて）。前後に長い体型（いもむし型）は背骨ごと曲げてお尻を上げるので、
    // 調整のしかたが違う。別に作るまで使わない
    act.tailDome = long ? 0 : tip;
    act.tailDomeSize = this.moruDomeSize;
    act.tailDomeBack = this.moruDomeBack;
    // 形を保つ強さを上げる（やわらかいままだと、お尻を振った反動で頭ごと横へ 2〜4 cm 揺れる）
    act.stiffnessMin = MORU_STIFFNESS;
    // 倒れきってから頭の先を支点にする（倒れる途中から留めると、頭が前へ出られず体が後ろへずれる）
    if (still && this.moruT > MORU_WAG_DELAY) act.pivot = 'front';
    return { side: 0, arch: (long ? MORU_ARCH_LONG * lift : 0) * tip, surge: 0.35 + 0.65 * Math.abs(Math.cos(phase)) };
  }

  /** 這う動作の次の伸び縮みで変える向きを決める */
  private planCrawlTurn(yawErr: number): void {
    this.crawlYaw0 = this.cmdYaw ?? this.body.yaw;
    const max = (this.params.crawlTurnMax * Math.PI) / 180;
    this.crawlTurn = Math.max(-max, Math.min(max, yawErr));
  }

  private arrive(): void {
    this.hasTarget = false;
    this.targetMode = null;
    this.go('idle');
  }

  private go(s: State): void {
    const wasMoru = this.inMoruPose;
    this.state = s;
    this.t = 0;
    if (s === 'moru') {
      // その場で振っていたなら、その向きのまま這い出す
      this.cmdYaw = wasMoru ? this.moruYaw : this.body.yaw;
      if (!wasMoru) this.moruT = 0;
    }
    if (s === 'crouch') {
      // 跳ぶ前に、今回の跳躍で向ける方向を決める（今の向きから最大 hopTurnMax まで目的地側へ）
      const b = this.body;
      const c = b.center;
      const yawErr = wrapAngle(Math.atan2(this.aim.x - c.x, this.aim.z - c.z) - b.yaw);
      this.hopYaw0 = b.yaw;
      const max = (this.params.hopTurnMax * Math.PI) / 180;
      this.hopTurn = Math.max(-max, Math.min(max, yawErr));
      this.cmdYaw = b.yaw;
    }
    if (s === 'crawl') {
      const b = this.body;
      const c = b.center;
      const dx = this.aim.x - c.x, dz = this.aim.z - c.z;
      const yawErr = wrapAngle(Math.atan2(dx, dz) - b.yaw);
      this.cmdYaw = b.yaw;
      this.planCrawlTurn(yawErr);
      this.crawlAmp = Math.min(1, Math.hypot(dx, dz) / 0.35) * headingFactor(yawErr - this.crawlTurn);
      this.cycleFrom.copy(c);
    }
    if (s === 'idle') {
      this.idleFor = 0;
      this.idleWait = 1 + Math.random() * 3;
      // もるんもるんで這ってきて、続けてその場で振るなら、今の向きを振る基準にする（姿勢はそのまま）
      if (wasMoru && this.cmdYaw !== null) this.moruYaw = this.cmdYaw;
    }
  }
}

/** 体の傾き（鉛直からの角度, rad） */
function tiltOf(b: SoftBody): number {
  const q = b.rotation;
  return Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (q.x * q.x + q.z * q.z))));
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** 0→1 をなめらかにつなぐ（始めと終わりがゆっくり） */
function smooth(k: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * k);
}

function easeOut(k: number): number {
  return 1 - (1 - k) * (1 - k);
}
