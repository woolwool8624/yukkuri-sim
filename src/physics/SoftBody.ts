import { Quaternion, Vector3 } from 'three';

/**
 * XPBD（Extended Position Based Dynamics）による表面メッシュのソフトボディ。
 * 拘束：辺の長さ（皮の張り）／体積保存（あんこ）／シェイプマッチング（弾力）／地面
 *
 * 描画には依存しない（three からは数学クラスのみ使用）。
 */
/** 底を地面に留めるとき、留める頂点の高さの範囲（静止形状の高さに対する比） */
const PIN_BOTTOM = 0.03;

/** 地面に置いた箱（当たる物）。底は地面。中心 (x, z)・向き yaw（Y 軸まわり）・半分の横幅 hx（ローカル x）・半分の奥行き hz（ローカル z）・高さ h */
export interface BoxCollider {
  x: number;
  z: number;
  yaw: number;
  hx: number;
  hz: number;
  h: number;
  /** 直近ステップで当たっていた頂点の数 */
  contacts: number;
}

/**
 * 地面を転がる玉（当たる物。ボール）。中心 (x, y, z)・半径 r。体と押し合う：体の頂点は玉の外へ横に押し出し、
 * 押し出した量の share の割合だけ玉が反対へ動く（玉は体より軽い）。動いた量は moveX・moveZ にためる（玉の側が速さにして取り出す）
 */
export interface BallCollider {
  x: number;
  y: number;
  z: number;
  r: number;
  share: number;
  moveX: number;
  moveZ: number;
  /** 直近ステップで当たっていた頂点の数 */
  contacts: number;
}

export interface SoftBodyParams {
  /** 重力加速度 (m/s²) */
  gravity: number;
  /** 1ステップあたりの分割数（多いほど硬く安定） */
  substeps: number;
  /** 皮の伸びやすさ（XPBD コンプライアンス、0 で伸びない） */
  edgeCompliance: number;
  /** 体積の変わりやすさ（0 で体積完全保存） */
  volumeCompliance: number;
  /** 元の形に戻る強さ（1/60秒あたり、0〜1） */
  shapeStiffness: number;
  /** 跳躍中（溜め・空中・着地）の形に戻る強さ */
  hopStiffness: number;
  /** 腹ばいの間（倒れ込み・腹ばいの姿勢・起き上がり）の形に戻る強さ */
  proneStiffness: number;
  /** 仰向けの間（倒れ込み・仰向けの姿勢・起き上がり）の形に戻る強さ */
  supineStiffness: number;
  /** 姿勢を保つ強さ（傾きだけを直立に戻す。1/60秒あたり、0〜1） */
  upright: number;
  /** 揺れの減衰 (1/s)。全体の移動には効かず、体の変形・揺れだけを抑える */
  damping: number;
  /**
   * 弾み（0〜1）。元の形に戻る動きのうち、跳ね返りや揺れの勢いに変わる割合。
   * 1 でゴムまりのように跳ね返り、0 に近いほど餅のように「潰れて、じわっと戻る」
   */
  bounce: number;
  /** 地面の摩擦（0〜1） */
  friction: number;
}

export const DEFAULT_SOFTBODY: SoftBodyParams = {
  gravity: 10,
  substeps: 2,
  edgeCompliance: 0.009,
  volumeCompliance: 0.0025,
  shapeStiffness: 0.5,
  hopStiffness: 0.5,
  proneStiffness: 0.5,
  supineStiffness: 0.5,
  upright: 0.06,
  damping: 5,
  bounce: 0.1,
  friction: 0.67,
};

export class SoftBody {
  readonly n: number;
  readonly pos: Float32Array;
  readonly prev: Float32Array;
  readonly vel: Float32Array;
  /** 静止形状（重心を原点とする） */
  readonly rest: Float32Array;
  readonly invMass: Float32Array;
  readonly tris: Uint32Array;
  readonly edges: Uint32Array;
  readonly edgeLen: Float32Array;
  /** 体の伸縮（actuation）を反映した、今の辺の目標長さ */
  private readonly edgeTarget: Float32Array;

  /** シェイプマッチングの結果：現在の回転と重心 */
  readonly rotation = new Quaternion();
  readonly center = new Vector3();

  /** 目標体積の倍率（呼吸・膨らみ等の外部入力） */
  volumeScale = 1;
  restVolume = 0;
  /** 渡された静止形状の重心（rest はこれを引いた座標） */
  readonly restCentroid = new Vector3();
  /**
   * 柔らかさの倍率：形に戻る強さ（どの状況の値にも）に掛ける。1 でそのまま、小さいほど柔らかい（眠る・気絶）。
   * actuation と違い、移動の処理が毎ステップ戻さない
   */
  softness = 1;
  /** 皮のゆるさの倍率：皮の伸びやすさ（edgeCompliance）に掛ける。1 でそのまま、大きいほど皮が伸びてへたる（眠る・気絶） */
  skinLoose = 1;
  /**
   * 柔らかくするとき（softness・skinLoose）に頭の形を保つ割合（0〜1）。頭の重み（setHeadWeights）が 1 の所は、
   * この割合だけ柔らかくするのを打ち消す（頭が崩れると帽子が食い込んで跳ね上がる・フリルが頭を突き抜ける）
   */
  headKeep = 0;
  /** 頂点ごとの頭の重み（0〜1。頭の中ほど 1） */
  private headW: Float32Array = new Float32Array(0);

  /** 頂点ごとの頭の重みを渡す（静止形状を変えたら渡し直す） */
  setHeadWeights(w: Float32Array): void {
    this.headW = w;
  }
  /** 頂点ごとの形に戻る強さ・皮のゆるさ（頂点ごとに違うときだけ作る） */
  private kv: Float32Array = new Float32Array(0);
  private lv: Float32Array = new Float32Array(0);
  /** 直近ステップで地面に触れていた頂点の数 */
  groundContacts = 0;
  /** 地面に置いた箱（体はすり抜けない。箱の外へ押し出す） */
  readonly boxes: BoxCollider[] = [];
  /** 地面を転がる玉（体と押し合う） */
  readonly balls: BallCollider[] = [];

  /**
   * 体の「筋肉」による入力。シェイプマッチングの目標形状を変えることで体を動かす。
   * （外から押すのではなく、自分の形を変える）
   */
  readonly actuation = {
    /** 縦方向の伸縮（1 = 静止形状、<1 で縮む）。横は体積が保たれるよう自動で広がる */
    squash: 1,
    /** 前後方向の伸び（1 = そのまま、>1 で前後に伸びて左右が細る） */
    stretch: 1,
    /**
     * 上部（頭）を前へ曲げる量。底は動かさず、上にいくほど前にずれて少し下がる
     * （体全体を回す lean と違い、底は地面に付いたまま）。値は体の高さに対する頭頂の前方移動の比
     */
    bend: 0,
    /** bend の横向き：上部をローカル +X 側へずらす量（- で -X 側）。底は地面に付けたまま。値は体の高さに対する頭頂の横移動の比 */
    bendSide: 0,
    /**
     * 横への曲げ（rad）。体の前後の軸（背骨）を弧状に曲げ、各断面を背骨の向きに合わせて回す。
     * 尻尾側はまっすぐのまま胴の中ほどで曲がり、頭の部分は丸ごとこの角度だけ横（+ でローカル +X 側）を向く。
     * ずらすのではなく回すので、顔（両目）がそろって新しい向きを向く。0 でまっすぐ
     */
    sideBend: 0,
    /**
     * お尻を横へ振る量（体の前後の長さに対する比。+ でローカル +X 側へ）。体の後ろ側かつ下側（お尻）だけを横へずらし、
     * 前側と上側（顔・頭・帽子の付く所）は動かさない（もるんもるん）
     */
    tailSway: 0,
    /**
     * お尻を丸い玉に寄せる量（0〜1。0 でそのまま）。体の後ろ上に見えない球を置き、体の後ろ側ほど皮をその球の表面へ寄せる
     * （頭・顔の側は動かさない）。お尻がとがらず、まんまるの大きな玉になる（もるんもるん）
     */
    tailDome: 0,
    /**
     * 体をふくらませる量（0 でそのまま。ぷくー）。全体を大きくし、下半分ほど左右・前後に張り出させる（下ぶくれ）。
     * 底は地面に付けたまま上へ伸ばす。ふくらんだ分だけ体積も増やす
     */
    inflate: 0,
    /** ふくらませるとき、下半分を余分に張り出させる割合（0 で全体を同じだけ） */
    inflateWide: 0,
    /** 玉の大きさ（静止形状の平均半径に対する比） */
    tailDomeSize: 1,
    /** 玉の中心を後ろへ寄せる量（静止形状の平均半径に対する比。体の後ろ向き＝前へ倒した体では上かつ後ろ） */
    tailDomeBack: 0.3,
    /**
     * 縦への曲げ（rad）。背骨（前後の軸）を縦の弧に曲げる。0 でまっすぐ。
     *   + … 後ろを持ち上げる。前 25% はまっすぐのまま胴の中ほどで曲がり、後ろ 25% は丸ごとこの角度だけ上を向く（お尻を突き上げる）
     *   - … 前を持ち上げる。後ろ 25% はまっすぐのまま、前 25% が丸ごと上を向く（頭の側を起こして反り返る）
     */
    arch: 0,
    /** 前方への傾き (rad)。前方は体のローカル +Z */
    lean: 0,
    /**
     * 体の今の回転を、静止形状でなく目標形状（actuation を反映した形）と比べて求める。
     * 上部を前へずらす（bend）など形を大きく変えたまま立っているとき、静止形状と比べると「体ごと前へ傾いた」と読まれ、
     * 起こす力と曲げる力が重なって体全体が倒れる（底が浮く）。false でいつもどおり
     */
    fitGoal: false,
    /** 底（静止形状の高さの下から PIN_BOTTOM まで）の頂点を地面から離さない（物を押すときなど。底を浮かせてはいけない動き） */
    pinBottom: false,
    /** 向きたい方向 (rad, Y軸まわり)。null なら今の向きを保つ */
    yaw: null as number | null,
    /** 前方にだけ滑りやすくする底の摩擦（null で通常の摩擦） */
    slideFriction: null as number | null,
    /**
     * 底の踏ん張り（尺取り虫の動き）。'front' は重心より前の底を、'rear' は後ろの底を地面に固定し、
     * 反対側の底は前にだけ滑らせる。null で通常の摩擦
     */
    anchor: null as 'front' | 'rear' | null,
    /**
     * 伸縮の支点。'rear' なら後端、'front' なら前端を、指定した瞬間の位置に留めたまま形を変える
     * （重心まわりではなく端を支点に伸び縮みする）。null で重心まわり
     */
    pivot: null as 'front' | 'rear' | null,
    /** 姿勢を保つ強さの下限（一時的に踏ん張って姿勢を保つとき。null で通常） */
    uprightMin: null as number | null,
    /** 形に戻る強さの下限（体を大きく曲げた形を保つときなど。null で通常） */
    stiffnessMin: null as number | null,
    /**
     * 接地面の柔らかさ（0〜1）：床に触れている所（と床のすぐ上）だけ、形に戻る強さにこれを掛ける。
     * 顔の付く前側（静止形状の前 CONTACT_FACE_FROM〜TO）は柔らかくしない（顔の絵がゆがまないように）。null で通常
     */
    contactSoft: null as number | null,
    /** 接地面を床へ押し付ける加速度（m/s²。contactSoft と同じ所に、同じ重みで）。0 で押さない */
    contactPress: 0,
    /** 接地面の皮のゆるさ（皮の伸びやすさに掛ける倍率。contactSoft と同じ所に、同じ重みで）。1 でそのまま */
    contactSkin: 1,
    /** 形に戻る強さをどの状況の値にするか */
    stiffnessMode: 'normal' as 'normal' | 'hop' | 'prone' | 'supine',
    /** 目標の姿勢（回転）。指定すると yaw・lean の代わりにこの姿勢へ近づける（横になる・転がる等） */
    orientation: null as Quaternion | null,
  };
  private pivotSide: 'front' | 'rear' | null = null;
  /** 支点の地面上の位置（ワールド x, z） */
  private pivotX = 0;
  private pivotZ = 0;
  /** 静止形状の前後方向の範囲（ローカル z） */
  /** 静止形状の前後の位置（0 = 後端、1 = 前端）。接地面を柔らかくするときに顔の側を外す */
  private frontness: Float32Array = new Float32Array(0);
  /** 静止形状の前後の範囲と、重心から頂点までの平均の距離（お尻の玉の大きさの基準） */
  private restZMin = 0;
  private restZMax = 0;
  private restRadius = 1;
  /** お尻の玉に寄せる動き（頂点ごと）と、それを作ったときの大きさ・位置（変わったら作り直す） */
  private domeDelta = new Float32Array(0);
  private domeKey = '';
  /** お尻を玉に寄せきったときの体積の、静止形状に対する比 */
  private domeVolume = 1;
  /** ふくらませた目標の形の体積の、静止形状に対する比（ぷくー） */
  private inflateVolume = 1;
  private restYMin = 0;
  private restYMax = 0;
  /** actuation を反映した目標形状（ローカル、重心が原点）とその前後の範囲 */
  private readonly goalLocal: Float32Array;
  private goalZMin = 0;
  private goalZMax = 0;
  /** 目標形状の前端・後端の点（ローカル、重心が原点） */
  private readonly goalFront = new Vector3();
  private readonly goalRear = new Vector3();
  /** 前端・後端の点として使う頂点（静止形状で最も前・最も後ろの頂点） */
  private frontIdx = 0;
  private rearIdx = 0;
  /** 背骨の弧の表（横への曲げに使う） */
  private readonly spineX = new Float32Array(SPINE_SAMPLES + 1);
  private readonly spineZ = new Float32Array(SPINE_SAMPLES + 1);
  private readonly spineA = new Float32Array(SPINE_SAMPLES + 1);

  private readonly grads: Float32Array;
  /** 直近の部分ステップでシェイプマッチングが各頂点を動かした量 */
  private readonly smDelta: Float32Array;
  // 作業用
  private readonly _a0 = new Vector3();
  private readonly _a1 = new Vector3();
  private readonly _a2 = new Vector3();
  private readonly _r0 = new Vector3();
  private readonly _r1 = new Vector3();
  private readonly _r2 = new Vector3();
  private readonly _t = new Vector3();
  private readonly _dq = new Quaternion();
  private readonly _twist = new Quaternion();
  private readonly _tilt = new Quaternion();
  private static readonly X_AXIS = new Vector3(1, 0, 0);

  constructor(restPositions: Float32Array, triangles: Uint32Array, totalMass = 1) {
    this.n = restPositions.length / 3;
    this.tris = triangles;
    this.pos = new Float32Array(restPositions);
    this.prev = new Float32Array(restPositions);
    this.vel = new Float32Array(restPositions.length);
    this.rest = new Float32Array(restPositions.length);
    this.grads = new Float32Array(restPositions.length);
    this.smDelta = new Float32Array(restPositions.length);
    this.invMass = new Float32Array(this.n).fill(this.n / totalMass);

    // 三角形から重複のない辺を作る
    const seen = new Set<number>();
    const edges: number[] = [];
    for (let t = 0; t < triangles.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = triangles[t + e];
        const b = triangles[t + ((e + 1) % 3)];
        const key = Math.min(a, b) * this.n + Math.max(a, b);
        if (!seen.has(key)) {
          seen.add(key);
          edges.push(a, b);
        }
      }
    }
    this.edges = new Uint32Array(edges);
    this.edgeLen = new Float32Array(edges.length / 2);
    this.edgeTarget = new Float32Array(edges.length / 2);
    this.goalLocal = new Float32Array(restPositions.length);
    this.setRestShape(restPositions);
  }

  /** 静止形状を差し替える（現在の位置は保つ） */
  setRestShape(restPositions: Float32Array): void {
    const c = centroid(restPositions, this.restCentroid);
    for (let i = 0; i < this.n * 3; i += 3) {
      this.rest[i] = restPositions[i] - c.x;
      this.rest[i + 1] = restPositions[i + 1] - c.y;
      this.rest[i + 2] = restPositions[i + 2] - c.z;
    }
    for (let e = 0; e < this.edgeLen.length; e++) {
      this.edgeLen[e] = dist(this.rest, this.edges[2 * e], this.edges[2 * e + 1]);
    }
    this.restVolume = this.volume(this.rest);
    let zLo = Infinity, zHi = -Infinity;
    for (let i = 0; i < this.n; i++) {
      const z = this.rest[3 * i + 2];
      if (z < zLo) { zLo = z; this.rearIdx = i; }
      if (z > zHi) { zHi = z; this.frontIdx = i; }
    }
    this.restYMin = Infinity;
    this.restYMax = -Infinity;
    for (let i = 1; i < this.rest.length; i += 3) {
      this.restYMin = Math.min(this.restYMin, this.rest[i]);
      this.restYMax = Math.max(this.restYMax, this.rest[i]);
    }
    this.frontness = new Float32Array(this.n);
    const zSpan = Math.max(zHi - zLo, 1e-6);
    for (let i = 0; i < this.n; i++) this.frontness[i] = (this.rest[3 * i + 2] - zLo) / zSpan;
    this.restZMin = zLo;
    this.restZMax = zHi;
    let rSum = 0;
    for (let i = 0; i < this.n * 3; i += 3) rSum += Math.hypot(this.rest[i], this.rest[i + 1], this.rest[i + 2]);
    this.restRadius = rSum / Math.max(1, this.n);
    this.domeKey = ''; // 形が変わったので、お尻の玉の動きも作り直す
    this.inflateKey = '';
    this.updateActuatedShape();
  }

  /** 静止形状のまま指定位置に置き直す（重心が (x,y,z) に来る） */
  reset(x: number, y: number, z: number): void {
    for (let i = 0; i < this.n * 3; i += 3) {
      this.pos[i] = this.rest[i] + x;
      this.pos[i + 1] = this.rest[i + 1] + y;
      this.pos[i + 2] = this.rest[i + 2] + z;
    }
    this.prev.set(this.pos);
    this.vel.fill(0);
    this.rotation.identity();
    this.center.set(x, y, z);
  }

  /** 体ごと水平にずらす（速さは変えない。物を押して一緒に進むときなど） */
  translate(dx: number, dz: number): void {
    for (let i = 0; i < this.n * 3; i += 3) {
      this.pos[i] += dx;
      this.pos[i + 2] += dz;
      this.prev[i] += dx;
      this.prev[i + 2] += dz;
    }
    this.center.x += dx;
    this.center.z += dz;
  }

  /** 全体の平均速度 */
  meanVelocity(out: Vector3): Vector3 {
    out.set(0, 0, 0);
    for (let i = 0; i < this.n * 3; i += 3) {
      out.x += this.vel[i]; out.y += this.vel[i + 1]; out.z += this.vel[i + 2];
    }
    return out.divideScalar(this.n);
  }

  /** 全体に速度を加える */
  addVelocity(vx: number, vy: number, vz: number): void {
    for (let i = 0; i < this.n * 3; i += 3) {
      this.vel[i] += vx;
      this.vel[i + 1] += vy;
      this.vel[i + 2] += vz;
    }
  }

  /** 点 (px,py,pz) の周囲 radius 以内の頂点に、距離で減衰する速度を加える */
  addLocalVelocity(px: number, py: number, pz: number, radius: number, vx: number, vy: number, vz: number): void {
    const r2 = radius * radius;
    for (let i = 0; i < this.n; i++) {
      const dx = this.pos[3 * i] - px, dy = this.pos[3 * i + 1] - py, dz = this.pos[3 * i + 2] - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      const f = 1 - Math.sqrt(d2) / radius;
      const w = f * f;
      this.vel[3 * i] += vx * w;
      this.vel[3 * i + 1] += vy * w;
      this.vel[3 * i + 2] += vz * w;
    }
  }

  step(dt: number, p: SoftBodyParams): void {
    const sub = Math.max(1, Math.round(p.substeps));
    const h = dt / sub;
    // 1/60 秒あたりの値を部分ステップあたりに換算
    const mode = this.actuation.stiffnessMode;
    const stiffness = Math.max(this.actuation.stiffnessMin ?? 0,
      mode === 'hop' ? p.hopStiffness
        : mode === 'prone' ? p.proneStiffness
          : mode === 'supine' ? p.supineStiffness
            : p.shapeStiffness);
    const shapeK = 1 - Math.pow(1 - stiffness * this.softness, dt * 60 / sub);
    const hardK = 1 - Math.pow(1 - stiffness, dt * 60 / sub);
    const upright = Math.max(p.upright, this.actuation.uprightMin ?? 0);
    const uprightK = 1 - Math.pow(1 - upright, dt * 60 / sub);
    const damp = Math.max(0, 1 - p.damping * h);
    const { pos, prev, vel, invMass, n } = this;
    this.updateActuatedShape();
    // 接地面を柔らかくする・押し付ける：頂点ごとの重み（床からの高さと、顔の側を外す重み）
    const soft = this.actuation.contactSoft;
    const press = this.actuation.contactPress;
    const contact = soft !== null || press > 0 ? this.contactWeights() : null;
    // 頂点ごとの形に戻る強さ（頭は柔らかくしすぎない・接地面は柔らかく）と皮のゆるさ。どちらもなければ null（全体で同じ）
    const head = this.headKeep > 0 && this.headW.length === n && (this.softness < 1 || this.skinLoose !== 1);
    const cs = contact && soft !== null ? soft : 1;
    let kv: Float32Array | null = null;
    let lv: Float32Array | null = null;
    if (head || (contact && cs < 1)) {
      kv = this.kv.length === n ? this.kv : (this.kv = new Float32Array(n));
      for (let i = 0; i < n; i++) {
        const keep = head ? this.headKeep * this.headW[i] : 0;
        kv[i] = (shapeK + (hardK - shapeK) * keep) * (contact ? 1 - (1 - cs) * contact[i] : 1);
      }
    }
    const cskin = this.actuation.contactSkin;
    if (head || (contact && cskin !== 1)) {
      lv = this.lv.length === n ? this.lv : (this.lv = new Float32Array(n));
      for (let i = 0; i < n; i++) {
        const keep = head ? this.headKeep * this.headW[i] : 0;
        lv[i] = (1 + (this.skinLoose - 1) * (1 - keep)) * (contact ? 1 + (cskin - 1) * contact[i] : 1);
      }
    }

    for (let s = 0; s < sub; s++) {
      for (let i = 0; i < n; i++) {
        if (invMass[i] === 0) continue;
        const k = 3 * i;
        vel[k + 1] -= (p.gravity + (contact ? press * contact[i] : 0)) * h;
        prev[k] = pos[k]; prev[k + 1] = pos[k + 1]; prev[k + 2] = pos[k + 2];
        pos[k] += vel[k] * h;
        pos[k + 1] += vel[k + 1] * h;
        pos[k + 2] += vel[k + 2] * h;
      }

      this.solveEdges((p.edgeCompliance * (lv ? 1 : this.skinLoose)) / (h * h), lv);
      this.solveVolume(p.volumeCompliance / (h * h));
      this.solveShapeMatching(shapeK, uprightK, kv);
      this.solveGround(p.friction);
      if (this.boxes.length > 0) this.solveBoxes();
      if (this.balls.length > 0) this.solveBalls();

      // 速度を更新する。元の形に戻る動き（シェイプマッチングの補正）は、
      // 弾みの割合だけを速度に残す（残りは位置だけを戻し、跳ね返りの勢いにしない）
      const sm = this.smDelta;
      const keep = (1 - Math.min(Math.max(p.bounce, 0), 1)) / h;
      let mx = 0, my = 0, mz = 0;
      for (let i = 0; i < n * 3; i += 3) {
        vel[i] = (pos[i] - prev[i]) / h - sm[i] * keep;
        vel[i + 1] = (pos[i + 1] - prev[i + 1]) / h - sm[i + 1] * keep;
        vel[i + 2] = (pos[i + 2] - prev[i + 2]) / h - sm[i + 2] * keep;
        mx += vel[i]; my += vel[i + 1]; mz += vel[i + 2];
      }
      // 全体の平均速度からのずれ（揺れ）だけを減衰させる
      mx /= n; my /= n; mz /= n;
      for (let i = 0; i < n * 3; i += 3) {
        vel[i] = mx + (vel[i] - mx) * damp;
        vel[i + 1] = my + (vel[i + 1] - my) * damp;
        vel[i + 2] = mz + (vel[i + 2] - mz) * damp;
      }
    }
  }

  /** ふくらませた静止形状の体積の比（量が変わったときだけ測り直す） */
  private inflateVolumeAt(inflate: number, wide: number): number {
    const key = inflate.toFixed(3) + ',' + wide.toFixed(3);
    if (key === this.inflateKey) return this.inflateVolume;
    this.inflateKey = key;
    const { rest, n } = this;
    const y0 = this.restYMin;
    const H = Math.max(this.restYMax - y0, 1e-6);
    const p = this.inflateTmp.length === n * 3 ? this.inflateTmp : (this.inflateTmp = new Float32Array(n * 3));
    for (let i = 0; i < n * 3; i += 3) {
      const [kx, kz] = inflateAt((rest[i + 1] - y0) / H, inflate, wide);
      p[i] = rest[i] * kx;
      p[i + 1] = y0 + (rest[i + 1] - y0) * (1 + inflate * INFLATE_UP);
      p[i + 2] = rest[i + 2] * kz;
    }
    return this.volume(p) / Math.max(this.restVolume, 1e-9);
  }
  private inflateKey = '';
  private inflateTmp = new Float32Array(0);

  /**
   * お尻を丸い玉に寄せる動き（頂点ごと、静止形状の座標で）。
   *   1. 玉の中心から見て、体の表面が玉より内側にある所だけ玉の表面まで押し出す（玉と体を「なめらかに足し合わせた」形。
   *      玉より外にはみ出している所は引っ込めない）。境目は滑らかな最大値でつなぐ
   *   2. 体の後ろ側ほど強く（前端から TAIL_DOME_FROM〜TO の間でなめらかに。頭・顔の側は動かさない）
   *   3. 隣り合う頂点どうしで何回かならし、でこぼこを消す（玉を大きくすると、押し出す量が頂点ごとにばらついて波打った）
   *   4. 全体の平均を差し引く（重心がずれると、形に戻る力で体が押し出される）
   */
  private domeShape(size: number, back: number): Float32Array {
    const key = size.toFixed(4) + ',' + back.toFixed(4);
    const n = this.n;
    if (this.domeKey === key && this.domeDelta.length === n * 3) return this.domeDelta;
    this.domeKey = key;
    const rest = this.rest;
    const dd = this.domeDelta.length === n * 3 ? this.domeDelta : (this.domeDelta = new Float32Array(n * 3));
    const R = this.restRadius * size;
    const cz = -this.restRadius * back;
    const zSpan = Math.max(this.restZMax - this.restZMin, 1e-6);
    const soft = this.restRadius * TAIL_DOME_BLEND;
    for (let i = 0; i < n * 3; i += 3) {
      const x = rest[i], y = rest[i + 1], z = rest[i + 2];
      const w = smoothstep(TAIL_DOME_FROM, TAIL_DOME_TO, (this.restZMax - z) / zSpan);
      const dx = x, dy = y, dz = z - cz;
      const d = Math.hypot(dx, dy, dz);
      let ex = 0, ey = 0, ez = 0;
      if (w > 0 && d > 1e-6) {
        // 滑らかな最大値：d と R の大きい方へ寄せる（差が小さい所はなめらかにつなぐ）
        const m = (d + R + Math.sqrt((d - R) * (d - R) + soft * soft)) * 0.5;
        const k = (m / d - 1) * w;
        ex = dx * k; ey = dy * k; ez = dz * k;
      }
      dd[i] = ex; dd[i + 1] = ey; dd[i + 2] = ez;
    }
    // 隣り合う頂点どうしでならす
    const { edges } = this;
    const sum = new Float32Array(n * 3);
    const cnt = new Float32Array(n);
    for (let it = 0; it < TAIL_DOME_SMOOTH; it++) {
      sum.fill(0);
      cnt.fill(0);
      for (let e = 0; e < edges.length; e += 2) {
        const a = 3 * edges[e], b = 3 * edges[e + 1];
        sum[a] += dd[b]; sum[a + 1] += dd[b + 1]; sum[a + 2] += dd[b + 2];
        sum[b] += dd[a]; sum[b + 1] += dd[a + 1]; sum[b + 2] += dd[a + 2];
        cnt[a / 3]++; cnt[b / 3]++;
      }
      for (let i = 0; i < n; i++) {
        if (cnt[i] === 0) continue;
        const j = 3 * i;
        dd[j] = (dd[j] + sum[j] / cnt[i]) * 0.5;
        dd[j + 1] = (dd[j + 1] + sum[j + 1] / cnt[i]) * 0.5;
        dd[j + 2] = (dd[j + 2] + sum[j + 2] / cnt[i]) * 0.5;
      }
    }
    let mx = 0, my = 0, mz = 0;
    for (let i = 0; i < n * 3; i += 3) { mx += dd[i]; my += dd[i + 1]; mz += dd[i + 2]; }
    mx /= n; my /= n; mz /= n;
    for (let i = 0; i < n * 3; i += 3) { dd[i] -= mx; dd[i + 1] -= my; dd[i + 2] -= mz; }
    const moved = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) moved[i] = rest[i] + dd[i];
    this.domeVolume = this.volume(moved) / Math.max(this.restVolume, 1e-9);
    return dd;
  }

  /**
   * actuation（伸縮・曲げ）を反映した目標形状を作る。
   * 皮の基準の長さも同じ形から求める（体を変形させている間に皮が突っ張ってしわになるのを防ぐ）
   */
  private updateActuatedShape(): void {
    const act = this.actuation;
    const { rest, edges, edgeLen, edgeTarget, goalLocal: g, n } = this;
    const sy = act.squash;
    const sxz = 1 / Math.sqrt(Math.max(sy, 0.2));
    const st = Math.max(act.stretch, 0.2);
    const sx = sxz / st, sz = sxz * st;
    const y0 = this.restYMin;
    const H = Math.max(this.restYMax - y0, 1e-6);
    const bend = act.bend;
    const bendSide = act.bendSide;
    const side = act.sideBend;
    const tail = act.tailSway;
    const arch = act.arch;
    const dome = act.tailDome;
    // 玉に寄せたぶんの動き（頂点ごと。大きさ・位置が変わったときだけ作り直し、寄せる量 dome を掛けて使う）
    const dd = dome > 1e-5 ? this.domeShape(act.tailDomeSize, act.tailDomeBack) : null;
    const inflate = Math.max(0, act.inflate);
    const wide = act.inflateWide;

    let gzMin = Infinity, gzMax = -Infinity;
    for (let i = 0; i < n * 3; i += 3) {
      const t = (rest[i + 1] - y0) / H; // 0(底)〜1(頭頂)
      const t2 = t * t;
      let rx = rest[i], ry = rest[i + 1], rz = rest[i + 2];
      // お尻を丸い玉に寄せる
      if (dd) {
        rx += dd[i] * dome;
        ry += dd[i + 1] * dome;
        rz += dd[i + 2] * dome;
      }
      // ふくらませる：下半分（高さ 35% あたりが一番）ほど横と前後へ張り出し、上へは控えめに伸ばす（底は地面に付けたまま）
      if (inflate > 1e-5) {
        const [kx, kz] = inflateAt(t, inflate, wide);
        rx *= kx;
        rz *= kz;
        ry = y0 + (ry - y0) * (1 + inflate * INFLATE_UP);
      }
      g[i] = rx * sx + bendSide * H * t2;
      g[i + 1] = ry * sy - (bend + Math.abs(bendSide)) * 0.45 * H * sy * t2;
      g[i + 2] = rz * sz + bend * H * t2;
      gzMin = Math.min(gzMin, g[i + 2]);
      gzMax = Math.max(gzMax, g[i + 2]);
    }

    // 横への曲げ：背骨（前後の軸）を弧にして、各断面を背骨の向きに合わせて回す
    if (Math.abs(side) > 1e-5) {
      const D = Math.max(gzMax - gzMin, 1e-6);
      const N = SPINE_SAMPLES;
      const sx_ = this.spineX, sz_ = this.spineZ, sa = this.spineA;
      sx_[0] = 0; sz_[0] = gzMin; sa[0] = 0;
      for (let j = 1; j <= N; j++) {
        // 尻尾側（後ろ 15%）はまっすぐ、胴の中ほどで曲がり、頭（前 30%）は丸ごと side だけ回る
        sa[j] = side * smoothstep(0.15, 0.7, j / N);
        const am = (sa[j - 1] + sa[j]) * 0.5;
        sx_[j] = sx_[j - 1] + (D / N) * Math.sin(am);
        sz_[j] = sz_[j - 1] + (D / N) * Math.cos(am);
      }
      for (let i = 0; i < n * 3; i += 3) {
        const f = ((g[i + 2] - gzMin) / D) * N;
        const j = Math.min(Math.max(Math.floor(f), 0), N - 1);
        const w = f - j;
        const px = sx_[j] + (sx_[j + 1] - sx_[j]) * w;
        const pz = sz_[j] + (sz_[j + 1] - sz_[j]) * w;
        const a = sa[j] + (sa[j + 1] - sa[j]) * w;
        // 背骨上の点から、背骨に直交する横方向へ元の横位置だけ離す
        const lx = g[i];
        g[i] = px + lx * Math.cos(a);
        g[i + 2] = pz - lx * Math.sin(a);
      }
    }

    // お尻を横へ振る：後ろ側ほど、下側ほど大きく横へずらす（顔・頭・帽子の付く所は動かさない）。
    // 重みは静止形状で決める（縮んだり曲げたりしても、振る範囲が揺れないように）
    if (Math.abs(tail) > 1e-5) {
      let zMin = Infinity, zMax = -Infinity;
      for (let i = 2; i < n * 3; i += 3) {
        zMin = Math.min(zMin, rest[i]); zMax = Math.max(zMax, rest[i]);
      }
      const D = Math.max(zMax - zMin, 1e-6);
      for (let i = 0; i < n * 3; i += 3) {
        const rear = smoothstep(TAIL_REAR_FROM, TAIL_REAR_TO, (zMax - rest[i + 2]) / D);
        const low = 1 - smoothstep(TAIL_LOW_FROM, TAIL_LOW_TO, (rest[i + 1] - y0) / H);
        g[i] += tail * D * rear * low;
      }
    }

    // 縦への曲げ：背骨を前端から後ろへたどって縦の弧にし、各断面を背骨の向きに合わせて回す
    if (Math.abs(arch) > 1e-5) {
      let zMin = Infinity, zMax = -Infinity;
      for (let i = 0; i < n * 3; i += 3) {
        zMin = Math.min(zMin, g[i + 2]);
        zMax = Math.max(zMax, g[i + 2]);
      }
      const D = Math.max(zMax - zMin, 1e-6);
      const N = SPINE_SAMPLES;
      // 背骨を、地面に付けたままにする端（+ なら前端、- なら後端）から反対の端へたどる。
      // dir：たどる向き（前後の軸の向き。前端からなら -1）。sx_ に高さ、sz_ に前後の位置、sa に上向きの角度を入れる
      const dir = arch > 0 ? -1 : 1;
      const amount = Math.abs(arch);
      const sy_ = this.spineX, sz_ = this.spineZ, sa = this.spineA;
      sy_[0] = 0; sz_[0] = dir < 0 ? zMax : zMin; sa[0] = 0;
      for (let j = 1; j <= N; j++) {
        sa[j] = amount * smoothstep(0.25, 0.75, j / N);
        const am = (sa[j - 1] + sa[j]) * 0.5;
        sy_[j] = sy_[j - 1] + (D / N) * Math.sin(am);
        sz_[j] = sz_[j - 1] + dir * (D / N) * Math.cos(am);
      }
      for (let i = 0; i < n * 3; i += 3) {
        const f = ((dir < 0 ? zMax - g[i + 2] : g[i + 2] - zMin) / D) * N;
        const j = Math.min(Math.max(Math.floor(f), 0), N - 1);
        const w = f - j;
        const py = sy_[j] + (sy_[j + 1] - sy_[j]) * w;
        const pz = sz_[j] + (sz_[j + 1] - sz_[j]) * w;
        const a = sa[j] + (sa[j + 1] - sa[j]) * w;
        // 背骨上の点から、背骨に直交する向き（上向きを、たどる向きと反対へ a だけ倒した向き）へ元の高さだけ離す
        const ly = g[i + 1];
        g[i + 1] = py + ly * Math.cos(a);
        g[i + 2] = pz - dir * ly * Math.sin(a);
      }
      // 曲げた形は全体として少し傾いて見える。この傾きを残すと、体の向き（今の形を元の形に重ねる回転）が
      // その分だけ傾いたと読まれ、その上にまた曲げた形を置くので、前へ回り続けてしまう。
      // 元の形にいちばん重なる左右の軸まわりの傾きを求めて戻す（曲げは縦と前後の面の中だけなので 2 次元で求まる）
      let my = 0, mz = 0;
      for (let i = 0; i < n * 3; i += 3) { my += g[i + 1]; mz += g[i + 2]; }
      my /= n; mz /= n;
      let sc = 0, ss = 0;
      for (let i = 0; i < n * 3; i += 3) {
        const gy = g[i + 1] - my, gz = g[i + 2] - mz, ry = rest[i + 1], rz = rest[i + 2];
        sc += gy * ry + gz * rz;
        ss += gz * ry - gy * rz;
      }
      const tilt = Math.atan2(ss, sc); // 元の形を左右の軸まわりに tilt 回すと曲げた形に重なる
      const ct = Math.cos(tilt), st2 = Math.sin(tilt);
      for (let i = 0; i < n * 3; i += 3) {
        const gy = g[i + 1] - my, gz = g[i + 2] - mz;
        g[i + 1] = my + gy * ct + gz * st2;
        g[i + 2] = mz - gy * st2 + gz * ct;
      }
    }

    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n * 3; i += 3) {
      cx += g[i]; cy += g[i + 1]; cz += g[i + 2];
    }
    // 重心を原点に戻す（曲げで重心がずれた分を全体の移動に変えない）
    cx /= n; cy /= n; cz /= n;
    let zMin = Infinity, zMax = -Infinity;
    for (let i = 0; i < n * 3; i += 3) {
      g[i] -= cx; g[i + 1] -= cy; g[i + 2] -= cz;
      zMin = Math.min(zMin, g[i + 2]);
      zMax = Math.max(zMax, g[i + 2]);
    }
    this.goalZMin = zMin;
    this.goalZMax = zMax;
    // 前端・後端の点は決まった頂点で追う（曲げても同じ部位を支点にできる）
    const fi = 3 * this.frontIdx, ri = 3 * this.rearIdx;
    this.goalFront.set(g[fi], g[fi + 1], g[fi + 2]);
    this.goalRear.set(g[ri], g[ri + 1], g[ri + 2]);

    // ふくらませた形の体積（ふくらませ以外の変形はおおむね体積を保つので、ふくらませだけを測る）
    if (inflate > 1e-5) {
      const k = 1 + inflate;
      this.inflateVolume = this.inflateVolumeAt(inflate, wide);
      if (!Number.isFinite(this.inflateVolume)) this.inflateVolume = k * k * (1 + inflate * INFLATE_UP);
    }
    // 何も変形していなければ、皮の基準の長さは静止形状のまま（お尻の玉も変形に数える。数え忘れると、お尻を左右に振って
    // 真ん中を通る瞬間だけ皮が元の形に引っ張られ、カクッと動いた）
    const identity = Math.abs(sy - 1) + Math.abs(st - 1) + Math.abs(bend) + Math.abs(bendSide) + Math.abs(side) + Math.abs(tail) + Math.abs(arch)
      + (dd ? dome : 0) + inflate < 1e-4;
    if (identity) {
      edgeTarget.set(edgeLen);
      return;
    }
    for (let e = 0; e < edgeLen.length; e++) {
      const a = 3 * edges[2 * e], b = 3 * edges[2 * e + 1];
      const dx = g[a] - g[b], dy = g[a + 1] - g[b + 1], dz = g[a + 2] - g[b + 2];
      edgeTarget[e] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
  }

  /** lv：頂点ごとの皮のゆるさ（両端の平均を伸びやすさに掛ける）。null なら全体で同じ */
  private solveEdges(alpha0: number, lv: Float32Array | null = null): void {
    const { pos, invMass, edges, edgeTarget: edgeLen } = this;
    for (let e = 0; e < edgeLen.length; e++) {
      const a = edges[2 * e], b = edges[2 * e + 1];
      const wa = invMass[a], wb = invMass[b];
      const w = wa + wb;
      if (w === 0) continue;
      const alpha = lv ? alpha0 * 0.5 * (lv[a] + lv[b]) : alpha0;
      const dx = pos[3 * a] - pos[3 * b];
      const dy = pos[3 * a + 1] - pos[3 * b + 1];
      const dz = pos[3 * a + 2] - pos[3 * b + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-9) continue;
      const C = len - edgeLen[e];
      const s = -C / (w + alpha) / len;
      pos[3 * a] += dx * s * wa; pos[3 * a + 1] += dy * s * wa; pos[3 * a + 2] += dz * s * wa;
      pos[3 * b] -= dx * s * wb; pos[3 * b + 1] -= dy * s * wb; pos[3 * b + 2] -= dz * s * wb;
    }
  }

  private solveVolume(alpha: number): void {
    const { pos, tris, grads, invMass, n } = this;
    grads.fill(0);
    let vol = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const i0 = 3 * tris[t], i1 = 3 * tris[t + 1], i2 = 3 * tris[t + 2];
      const x0 = pos[i0], y0 = pos[i0 + 1], z0 = pos[i0 + 2];
      const x1 = pos[i1], y1 = pos[i1 + 1], z1 = pos[i1 + 2];
      const x2 = pos[i2], y2 = pos[i2 + 1], z2 = pos[i2 + 2];
      // cross(p1,p2), cross(p2,p0), cross(p0,p1) がそれぞれ p0,p1,p2 の勾配（×1/6）
      const c12x = y1 * z2 - z1 * y2, c12y = z1 * x2 - x1 * z2, c12z = x1 * y2 - y1 * x2;
      const c20x = y2 * z0 - z2 * y0, c20y = z2 * x0 - x2 * z0, c20z = x2 * y0 - y2 * x0;
      const c01x = y0 * z1 - z0 * y1, c01y = z0 * x1 - x0 * z1, c01z = x0 * y1 - y0 * x1;
      vol += x0 * c12x + y0 * c12y + z0 * c12z;
      grads[i0] += c12x; grads[i0 + 1] += c12y; grads[i0 + 2] += c12z;
      grads[i1] += c20x; grads[i1 + 1] += c20y; grads[i1 + 2] += c20z;
      grads[i2] += c01x; grads[i2 + 1] += c01y; grads[i2 + 2] += c01z;
    }
    vol /= 6;
    let wsum = 0;
    for (let i = 0; i < n; i++) {
      const k = 3 * i;
      const g2 = (grads[k] * grads[k] + grads[k + 1] * grads[k + 1] + grads[k + 2] * grads[k + 2]) / 36;
      wsum += invMass[i] * g2;
    }
    if (wsum === 0) return;
    // お尻を玉に寄せている間は、玉で増えた分だけ体積も増やす（静止時の体積のままだと、膨らませた目標の形と押し合ってしわが寄る）
    const dome = this.actuation.tailDome > 1e-5 ? 1 + (this.domeVolume - 1) * this.actuation.tailDome : 1;
    const inflated = this.actuation.inflate > 1e-5 ? this.inflateVolume : 1;
    const C = vol - this.restVolume * this.volumeScale * dome * inflated;
    const lambda = -C / (wsum + alpha) / 6;
    for (let i = 0; i < n; i++) {
      const w = invMass[i] * lambda;
      const k = 3 * i;
      pos[k] += grads[k] * w; pos[k + 1] += grads[k + 1] * w; pos[k + 2] += grads[k + 2] * w;
    }
  }

  /** Müller et al. 2005 のシェイプマッチング。回転は反復法の極分解（2016）で求める */
  /**
   * 接地面の重み（頂点ごと 0〜1）：床から体の高さの CONTACT_HEIGHT 以内ほど 1 に近く、
   * 静止形状で前側（顔の付く所）ほど 0 に近い
   */
  private contactWeights(): Float32Array {
    const { pos, n } = this;
    const w = this.contactW.length === n ? this.contactW : (this.contactW = new Float32Array(n));
    const band = (this.restYMax - this.restYMin) * CONTACT_HEIGHT;
    for (let i = 0; i < n; i++) {
      const low = 1 - smoothstep(0, band, pos[3 * i + 1]);
      const face = smoothstep(CONTACT_FACE_FROM, CONTACT_FACE_TO, this.frontness[i]);
      w[i] = low * (1 - face);
    }
    return w;
  }
  private contactW = new Float32Array(0);

  /** kv：頂点ごとの形に戻る強さ（null なら全体で k） */
  private solveShapeMatching(k: number, uprightK: number, kv: Float32Array | null = null): void {
    const { pos, n } = this;
    const rest = this.actuation.fitGoal ? this.goalLocal : this.rest;
    const c = centroid(pos, this.center);

    // A = Σ (x - c) q^T を列ベクトル a0,a1,a2 として持つ
    const a0 = this._a0.set(0, 0, 0), a1 = this._a1.set(0, 0, 0), a2 = this._a2.set(0, 0, 0);
    for (let i = 0; i < n * 3; i += 3) {
      const px = pos[i] - c.x, py = pos[i + 1] - c.y, pz = pos[i + 2] - c.z;
      const qx = rest[i], qy = rest[i + 1], qz = rest[i + 2];
      a0.x += px * qx; a0.y += py * qx; a0.z += pz * qx;
      a1.x += px * qy; a1.y += py * qy; a1.z += pz * qy;
      a2.x += px * qz; a2.y += py * qz; a2.z += pz * qz;
    }

    const q = this.rotation;
    const r0 = this._r0, r1 = this._r1, r2 = this._r2, w = this._t;
    for (let it = 0; it < 8; it++) {
      r0.set(1, 0, 0).applyQuaternion(q);
      r1.set(0, 1, 0).applyQuaternion(q);
      r2.set(0, 0, 1).applyQuaternion(q);
      const denom = Math.abs(r0.dot(a0) + r1.dot(a1) + r2.dot(a2)) + 1e-9;
      w.crossVectors(r0, a0);
      const wx = w.x, wy = w.y, wz = w.z;
      w.crossVectors(r1, a1);
      const ux = w.x, uy = w.y, uz = w.z;
      w.crossVectors(r2, a2);
      w.set((wx + ux + w.x) / denom, (wy + uy + w.y) / denom, (wz + uz + w.z) / denom);
      const angle = w.length();
      if (angle < 1e-9) break;
      this._dq.setFromAxisAngle(w.divideScalar(angle), angle);
      q.premultiply(this._dq).normalize();
    }

    if (k <= 0) {
      this.smDelta.fill(0);
      return;
    }
    // 目標の回転：現在の回転を「望む姿勢（向き＋前傾、または指定の姿勢）」へ uprightK だけ近づける
    const act = this.actuation;
    const goal = this._dq.copy(q);
    if (uprightK > 0) {
      if (act.orientation) {
        this._twist.copy(act.orientation);
      } else {
        const yaw = act.yaw ?? this.yaw;
        this._twist.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
        this._tilt.setFromAxisAngle(SoftBody.X_AXIS, act.lean);
        this._twist.multiply(this._tilt);
      }
      if (goal.dot(this._twist) < 0) this._twist.set(-this._twist.x, -this._twist.y, -this._twist.z, -this._twist.w);
      goal.slerp(this._twist, uprightK);
    }
    // 目標形状（actuation を反映済みのローカル形状）を目標の回転で置く
    const gl = this.goalLocal;
    r0.set(1, 0, 0).applyQuaternion(goal);
    r1.set(0, 1, 0).applyQuaternion(goal);
    r2.set(0, 0, 1).applyQuaternion(goal);

    // 端を支点にする場合：目標形状をずらして、支点側の端（前端／後端の点）を地面上の固定位置に合わせる。
    // 前後だけでなく左右も合わせるので、体の向きが変わると固定した端を中心に体が回る
    // （縮む段階で頭の端を中心に向きを変え、後部が弧を描いて頭の後ろに並ぶ）
    let ox = 0, oz = 0;
    const tip = (side: 'front' | 'rear') => (side === 'rear' ? this.goalRear : this.goalFront);
    const tipX = (t: Vector3) => c.x + r0.x * t.x + r1.x * t.y + r2.x * t.z;
    const tipZ = (t: Vector3) => c.z + r0.z * t.x + r1.z * t.y + r2.z * t.z;
    if (act.pivot !== this.pivotSide) {
      this.pivotSide = act.pivot;
      if (act.pivot !== null) {
        this.pivotX = tipX(tip(act.pivot));
        this.pivotZ = tipZ(tip(act.pivot));
      }
    }
    if (this.pivotSide !== null) {
      // 送る量には上限を設ける（何かの拍子に体が弾き飛ばされないように）
      const t = tip(this.pivotSide);
      let dx = this.pivotX - tipX(t), dz = this.pivotZ - tipZ(t);
      const maxShift = (this.goalZMax - this.goalZMin) * 0.25;
      const len = Math.hypot(dx, dz);
      if (len > maxShift) {
        dx *= maxShift / len;
        dz *= maxShift / len;
      }
      ox = dx;
      oz = dz;
    }
    // 頂点ごとに強さを変えるとき（接地面を柔らかくする）は、補正の合計が 0 にならず体全体が押される
    // （目標の形に届かない所が片寄っていると、その向きへ進み続ける）。平均を差し引いて、全体は動かさない
    const varied = kv !== null;
    let sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < n; i++) {
      if (this.invMass[i] === 0) continue;
      const j = 3 * i;
      const qx = gl[j], qy = gl[j + 1], qz = gl[j + 2];
      const gx = c.x + ox + r0.x * qx + r1.x * qy + r2.x * qz;
      const gy = c.y + r0.y * qx + r1.y * qy + r2.y * qz;
      const gz = c.z + oz + r0.z * qx + r1.z * qy + r2.z * qz;
      const ki = kv ? kv[i] : k;
      // 端を支点にした送り（ox, oz）は這うための推進なので、弾みの対象から外す
      const dx = (gx - ox - pos[j]) * ki, dy = (gy - pos[j + 1]) * ki, dz = (gz - oz - pos[j + 2]) * ki;
      this.smDelta[j] = dx;
      this.smDelta[j + 1] = dy;
      this.smDelta[j + 2] = dz;
      sx += dx; sy += dy; sz += dz;
    }
    if (varied) {
      sx /= n; sy /= n; sz /= n;
    } else {
      sx = sy = sz = 0;
    }
    for (let i = 0; i < n; i++) {
      if (this.invMass[i] === 0) continue;
      const j = 3 * i;
      const sm = this.smDelta;
      sm[j] -= sx; sm[j + 1] -= sy; sm[j + 2] -= sz;
      pos[j] += sm[j] + ox * k;
      pos[j + 1] += sm[j + 1];
      pos[j + 2] += sm[j + 2] + oz * k;
    }
  }

  private solveGround(friction: number): void {
    const { pos, prev, n } = this;
    const slide = this.actuation.slideFriction;
    const anchor = this.actuation.anchor;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const c = this.center;
    let contacts = 0;
    for (let i = 0; i < n; i++) {
      const k = 3 * i;
      if (pos[k + 1] >= 0) {
        // 底を地面に留める：浮いた底の頂点を地面へ戻す（接地として摩擦も掛ける）
        if (!this.actuation.pinBottom || this.rest[k + 1] > this.restYMin + (this.restYMax - this.restYMin) * PIN_BOTTOM) continue;
      }
      pos[k + 1] = 0;
      // 接地中は水平方向の移動を摩擦で減らす
      const dx = pos[k] - prev[k], dz = pos[k + 2] - prev[k + 2];
      if (anchor !== null) {
        // 踏ん張る側は地面にほぼ固定、反対側は前にだけ滑る
        const s = (pos[k] - c.x) * fx + (pos[k + 2] - c.z) * fz;
        const planted = anchor === 'front' ? s > 0 : s < 0;
        if (planted) {
          // 踏ん張る側は前後方向の滑りだけを止める。横方向は通常の摩擦にして、
          // 這いながら向きを変えても固定した端を中心に体が振り回されないようにする
          const along = dx * fx + dz * fz;
          const sx = dx - fx * along, sz = dz - fz * along;
          pos[k] -= fx * along * 0.98 + sx * friction;
          pos[k + 2] -= fz * along * 0.98 + sz * friction;
        } else {
          const fwd = Math.max(dx * fx + dz * fz, 0);
          const ox = dx - fx * fwd, oz = dz - fz * fwd;
          pos[k] -= ox * friction + fx * fwd * 0.03;
          pos[k + 2] -= oz * friction + fz * fwd * 0.03;
        }
      } else if (slide === null) {
        pos[k] -= dx * friction;
        pos[k + 2] -= dz * friction;
      } else {
        // 前向きの成分だけ摩擦を弱くする（這うときの底の使い方）
        const along = dx * fx + dz * fz;
        const fwd = Math.max(along, 0);
        const ox = dx - fx * fwd, oz = dz - fz * fwd;
        pos[k] -= ox * friction + fx * fwd * slide;
        pos[k + 2] -= oz * friction + fz * fwd * slide;
      }
      contacts++;
    }
    this.groundContacts = contacts;
  }

  /**
   * 箱の中に入った頂点を、横 4 面のうち浅い面から外へ押し出す。上の面には乗せない（体は箱より背が高いので、押し付けると
   * はみ出した頭が上の面に支えられて持ち上がり、そのまま箱に乗り上げた）
   */
  private solveBoxes(): void {
    const { pos, n } = this;
    for (const b of this.boxes) {
      const cs = Math.cos(b.yaw), sn = Math.sin(b.yaw);
      let contacts = 0;
      for (let i = 0; i < n; i++) {
        const k = 3 * i;
        const y = pos[k + 1];
        if (y >= b.h) continue;
        const dx = pos[k] - b.x, dz = pos[k + 2] - b.z;
        // 箱のローカル：x = 横、z = 奥行き（yaw だけ回した向き）
        const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
        const px = b.hx - Math.abs(lx), pz = b.hz - Math.abs(lz);
        if (px <= 0 || pz <= 0) continue;
        let ox = 0, oz = 0;
        if (px < pz) ox = Math.sign(lx) * px;
        else oz = Math.sign(lz) * pz;
        // ローカル → ワールド
        pos[k] += ox * cs + oz * sn;
        pos[k + 2] += -ox * sn + oz * cs;
        contacts++;
      }
      b.contacts = contacts;
    }
  }

  /**
   * 玉の中に入った頂点を、横（水平）へ玉の外まで押し出し、押し出した分の share の割合だけ玉を反対へずらす。
   * 上へは押し出さない（体が玉の上に乗らない。上からのしかかると、玉が横へ押し出される）
   */
  private solveBalls(): void {
    const { pos, n } = this;
    for (const b of this.balls) {
      let contacts = 0, sx = 0, sz = 0, sw = 0;
      const keep = 1 - b.share;
      for (let i = 0; i < n; i++) {
        const k = 3 * i;
        const dy = pos[k + 1] - b.y;
        if (dy >= b.r || dy <= -b.r) continue;
        // その高さでの玉の断面の半径
        const hr = Math.sqrt(b.r * b.r - dy * dy);
        const dx = pos[k] - b.x, dz = pos[k + 2] - b.z;
        const hd = Math.hypot(dx, dz);
        if (hd >= hr) continue;
        const pen = hr - hd;
        // 真上・真下で向きが決まらなければ、体の重心から玉への向きの反対へ
        let nx: number, nz: number;
        if (hd > 1e-6) {
          nx = dx / hd;
          nz = dz / hd;
        } else {
          const c = this.center;
          const ex = c.x - b.x, ez = c.z - b.z, el = Math.hypot(ex, ez) || 1;
          nx = ex / el;
          nz = ez / el;
        }
        pos[k] += nx * pen * keep;
        pos[k + 2] += nz * pen * keep;
        // 玉は深く入った頂点ほど強く押される（浅くかすっただけの頂点で平均を薄めない）
        sx -= nx * pen * pen;
        sz -= nz * pen * pen;
        sw += pen;
        contacts++;
      }
      if (sw > 0) {
        const mx = (sx / sw) * b.share, mz = (sz / sw) * b.share;
        b.x += mx;
        b.z += mz;
        b.moveX += mx;
        b.moveZ += mz;
      }
      b.contacts = contacts;
    }
  }

  /** 今の向き (rad, Y軸まわり。ローカル +Z が前) */
  get yaw(): number {
    const q = this.rotation;
    return 2 * Math.atan2(q.y, q.w);
  }

  volume(p: Float32Array = this.pos): number {
    const t = this.tris;
    let v = 0;
    for (let i = 0; i < t.length; i += 3) {
      const a = 3 * t[i], b = 3 * t[i + 1], c = 3 * t[i + 2];
      v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
        + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2])
        + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    return v / 6;
  }
}

/** 背骨の弧を表す点の数 */
const SPINE_SAMPLES = 48;
/**
 * お尻を横へ振るときに動かす所（静止形状で）：
 *   前端からの前後の位置（前後の長さに対する比）が TAIL_REAR_FROM より前は動かさず、TAIL_REAR_TO より後ろは丸ごと
 *   底からの高さ（高さに対する比）が TAIL_LOW_FROM より下は丸ごと、TAIL_LOW_TO より上は動かさない
 * 体の約 3 割が振れる。広げると（前端から・高さ 90% まで）お尻の丸みが大きく振れるが、丸い体型では後頭部（帽子の後ろの支え）まで
 * 振れて頭と帽子が動く。狭くすると（前から 25% より後ろ・高さ 75% まで）お尻の先だけがとがって動く
 */
/**
 * 接地面を柔らかくする範囲：床から体の高さのこの割合までを「接地面」とみなす（床に近いほど重い）。
 * 静止形状の前後の位置（後端 0〜前端 1）が CONTACT_FACE_FROM より前は外し始め、CONTACT_FACE_TO で完全に外す（顔の付く所）
 */
const CONTACT_HEIGHT = 0.3;
const CONTACT_FACE_FROM = 0.62;
const CONTACT_FACE_TO = 0.8;
/** お尻を丸い玉に寄せる範囲：静止形状の前端から測って、この割合の所から寄せ始め、TO より後ろは丸ごと寄せる */
/** ふくらませるとき、一番張り出す高さ（底 0〜頭頂 1）と、その広がり、上への伸びの割合 */
const INFLATE_WIDE_AT = 0.35;
const INFLATE_WIDE_SPAN = 0.4;
const INFLATE_UP = 0.6;
/** ふくらませるとき、頭（高さ INFLATE_HEAD_FROM〜TO）は横へ広げるのを弱める（帽子のかぶる所が太ると、帽子が食い込みを避けて浮く） */
const INFLATE_HEAD_FROM = 0.5;
const INFLATE_HEAD_TO = 0.95;
const INFLATE_HEAD_KEEP = 0.25;

/** ふくらませるときの、高さ t（底 0〜頭頂 1）での横・前後の倍率 */
function inflateAt(t: number, inflate: number, wide: number): [number, number] {
  const low = Math.exp(-(((t - INFLATE_WIDE_AT) / INFLATE_WIDE_SPAN) ** 2));
  const base = 1 - (1 - INFLATE_HEAD_KEEP) * smoothstep(INFLATE_HEAD_FROM, INFLATE_HEAD_TO, t);
  return [1 + inflate * (base + wide * low), 1 + inflate * (base + wide * low * 0.7)];
}
const TAIL_DOME_FROM = 0.3;
const TAIL_DOME_TO = 0.75;
/** お尻の玉：体と玉の境目をなめらかにつなぐ幅（静止形状の平均半径に対する比）と、隣どうしでならす回数 */
const TAIL_DOME_BLEND = 0.35;
const TAIL_DOME_SMOOTH = 6;
const TAIL_REAR_FROM = 0.3;
const TAIL_REAR_TO = 0.8;
const TAIL_LOW_FROM = 0.45;
const TAIL_LOW_TO = 0.8;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

function centroid(p: Float32Array, out: Vector3): Vector3 {
  out.set(0, 0, 0);
  const n = p.length / 3;
  for (let i = 0; i < p.length; i += 3) {
    out.x += p[i]; out.y += p[i + 1]; out.z += p[i + 2];
  }
  return out.divideScalar(n);
}

function dist(p: Float32Array, a: number, b: number): number {
  const dx = p[3 * a] - p[3 * b], dy = p[3 * a + 1] - p[3 * b + 1], dz = p[3 * a + 2] - p[3 * b + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
