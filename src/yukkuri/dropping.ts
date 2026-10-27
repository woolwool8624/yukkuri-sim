import * as THREE from 'three';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import { createAccessoryOutlineMaterial } from '../render/outlineMaterial';
import type { PartSelection } from '../face/parts';
import { loadJSON, saveJSON } from '../platform/storage';
import { bodyFacing, showFace } from './fx';
import type { Yukkuri } from './Yukkuri';

/**
 * うんうん：餡子をチューブから絞り出すように、太くやわらかい一本の塊を出す。
 *   1. 出す     … 力んだ顔で小刻みに震えながら、体の後ろの下から塊を出す
 *   2. すっきり … 出し終わったら一歩前へ跳ね、感動した顔で「すっきりー」
 * 塊は地面に寝そべって真っすぐ後ろへ伸びる。先に出た所（体から遠い先）が一番太くて丸く、
 * 出し終わりの所（体の側）へ向かってなめらかに細くなる（横から見ると、しずくを長く伸ばしたような形）。
 * 出している途中も、先に出た太い所が先頭で、出口からはその時に出ている太さの所が押し出される。
 * 断面はやや横に広い丸で、底は地面で平らにつぶれる。
 * 出し終わると、やわらかいので少し横に広がって沈む。
 * 道筋は出し始めに決め、時間とともに先へ伸ばして見せる。出している間とすっきりーの間は、その場から歩き出さない。
 * 出したものは「片付ける」まで残る
 */
type Phase = 'none' | 'wait' | 'push' | 'relief';

/** 出口の位置の調整値（体型ごとに保存する。調整パネルの「動きの調整」→「うんうんの出る位置」） */
export interface ExitParams {
  /** いつもの出口：背中側（顔の正面から π）の、床から体の高さのこの比の所 */
  height: number;
  /** 左右のずれ（rad。+ で体の右へ）。どの出口にも効く */
  side: number;
  /** 前から出すとき（うんうんたいそうで後ろへ反ったとき）の出口：体の正面の、床から体の高さのこの比（口よりずっと下） */
  frontHeight: number;
  /** 寝転んで仰向けのときの出口：今の高さが、寝転んだ体の高さのこの比に一番近い所 */
  supineHeight: number;
  /**
   * 横に転がって仰向けになったとき（前後に長い体型）の出口：背中側の、床から（静止形状の）体の高さのこの比の所。
   * 横に転がると体の上下が入れ替わるので、いつもの出口のあたりが上の方に来る
   */
  rolledHeight: number;
}

export const DEFAULT_EXIT: ExitParams = { height: 0.26, side: 0, frontHeight: 0.12, supineHeight: 0.6, rolledHeight: 0.26 };

/** 体型ごとの出口の初期値（DEFAULT_EXIT との違いだけ。体型 ID → 値）。調整パネルで体型ごとに合わせた値 */
const PRESET_EXIT: Record<string, Partial<ExitParams>> = {
  ball: { height: 0.18, frontHeight: 0.11, supineHeight: 0.59 },
  egg: { height: 0.15 },
  chick: { height: 0.14 },
  flat: { height: 0.17, supineHeight: 0.63 },
  eggplant: { height: 0.11 },
  caterpillar: { height: 0.21 },
};

/** 体型 id の出口の初期値 */
function exitDefaults(id: string): ExitParams {
  return { ...DEFAULT_EXIT, ...PRESET_EXIT[id] };
}

/** 保存先。体型 ID → その体型の調整値（初期値のままの体型は持たない） */
const STORAGE_KEY = 'droppingExit';
/** 仰向けの出口を探す範囲：背中側の ±この角度・床から（寝転ぶ前の）体の高さのこの比以下 */
const SUPINE_AZ_RANGE = 1.6;
const SUPINE_MAX_HEIGHT = 0.6;
/**
 * 仰向けの出口を探すときの、高さの差に足す向きの差の重み。横に広い体型（扁平型）は背中の左右の端の高さがほぼ同じで、
 * 少しの揺れで左右どちらかの端が選ばれ、塊が横へ 1.2 m ずれる側が毎回変わった（といれで塊の行き先が見積もれない）。
 * 重みを強くしたうえで、探す範囲を背中の真ん中から片側（体の左）だけにして、出る側を決める（左右対称の体型は真ん中が選ばれ、変わらない）
 */
const SUPINE_AZ_WEIGHT = 0.3;
/** 出口の目印の大きさ（胴の半径に対する比） */
const MARKER_SIZE = 0.06;
/** 塊の一番太い所の横幅の半分・高さの半分・地面に寝そべる長さ（胴の半径に対する比） */
const HALF_WIDTH = 0.3;
const HALF_HEIGHT = 0.27;
const LENGTH = 1.15;
/** 太さの形（出し終わった後、体の側から数えた長さの比 u で）：u = 0（出し終わり）がこの比で一番細く、THICK_AT から先は一番太い */
const END_RATIO = 0.18;
const THICK_AT = 0.8;
/** 出す速さ（胴の半径に対する比 / 秒） */
const SPEED = 0.4;
/** 出し終わってから沈むまでの時間（秒）と、沈んだときの高さ・幅の比 */
const SETTLE_TIME = 0.8;
const SETTLE_H = 0.88;
const SETTLE_W = 1.06;
/** 出している間の震えの振れ幅（胴の半径に対する比） */
const PUSH_TREMBLE = 0.012;
/** すっきりー：前へ跳ねる速さ（m/s、前・上）と、その後の時間（秒） */
const HOP_FORWARD = 1.0;
const HOP_UP = 2.4;
/** 前に出したときに、すっきりーで後ろへ跳ねる強さ（前へ跳ねる HOP_FORWARD と同じ単位） */
const HOP_BACK = 0.6;
const RELIEF_TIME = 3.2;
/** 体勢が落ち着くのを待つ上限（秒） */
const WAIT_MAX = 8;
/** 置いておく数の上限（古いものから消す。といれへ運ぶと 1 つが 3 つに分かれるので多めに） */
const MAX_PILES = 40;
/** といれへ口で運ぶとき、1 つの塊を分ける数（指示） */
export const POO_PIECES = 3;
/** 断面の分割数と、道筋に沿った輪の間隔（幅に対する比） */
const SIDES = 24;
const RING_STEP = 0.24;
/** 道筋の点の数：出口から地面に寝そべる所まで（この番号の点が寝そべる所の始まり） */
const PATH_DROP = 16;
/** 地面から浮かせる高さ（ちらつき防止） */
const FLOOR = 0.003;

const ANKO = { lit: '#7a4646', shade: '#55292d', deep: '#341519', rim: '#a8706a' };

/** 表情（目・眉・口だけ上書き。頬・涙は足りないときだけ足す） */
const FACE_PUSH: Partial<PartSelection> = { eyes: 'squeeze', brows: 'worried', mouth: 'openSmall' };
const AT_LEAST_PUSH: Partial<PartSelection> = { blush: 'mild' };
const FACE_RELIEF: Partial<PartSelection> = { eyes: 'smile', brows: 'worried', mouth: 'smile' };
const AT_LEAST_RELIEF: Partial<PartSelection> = { blush: 'mild', tears: 'few' };

interface Pile {
  group: THREE.Group;
  geometry: THREE.BufferGeometry;
  /** 道筋（密な点列）と、各点までの長さ。ground：地面に寝そべり始める所までの長さ */
  pts: THREE.Vector3[];
  len: number[];
  ground: number;
  /** 今出ている長さと、出し終わってからの時間（-1 は出している途中） */
  shown: number;
  settle: number;
  /** 一番太い所の横幅の半分・高さの半分 */
  w: number;
  h: number;
  /** 体から切り離してからの時間（-1 は出している途中）。切り離すと、体の中にあった根元を消し、宙にある所を地面に下ろす */
  detached: number;
  /** 道筋の、体の表面を出る所までの長さ（ここより手前は体の中） */
  exitS: number;
  /** 断面の横向き（出す向きに直交する水平の向き。道筋は出す向きを含む縦の面の中にあるので一定） */
  side: THREE.Vector3;
  /** といれの中に出したか（汚れとして数えない：そばにいてもストレスがたまらず、嫌がって離れない） */
  toilet: boolean;
  /** といれへ運んで減った数（POO_PIECES に分けたうち、体の側から何切れ持っていったか） */
  cut: number;
  /**
   * 分けた一切れ（といれへ運んで置いたもの）：元の塊のどの所だったか（太さの形を、元の塊の長さに対する比 0〜1 の範囲で引き継ぐ）。
   * 一切れはもう分けない（運ぶ途中でやめてといれの外に置いたものは、次はまるごと 1 回で運ぶ）
   */
  profile?: [number, number];
}

/** といれへ口で運ぶ：外にある塊 1 つの扱い（Cleanup が使う） */
export interface LooseDirt {
  /** 次に持っていく一切れの真ん中（地面の上） */
  next(): THREE.Vector3 | null;
  /** 次の一切れを持っていく（元の塊から消す）。といれに置く関数を返す。もうなければ null */
  take(): ((x: number, z: number, yaw: number) => void) | null;
}

interface Ring {
  c: THREE.Vector3;
  t: THREE.Vector3;
  side: THREE.Vector3;
  up: THREE.Vector3;
  w: number;
  h: number;
}

/** 真上 */
const Y_UP = new THREE.Vector3(0, 1, 0);

export class Dropping {
  /** 出したもの（体と一緒に震えないよう、シーンに直接置く） */
  readonly object = new THREE.Group();
  private readonly material: THREE.ShaderMaterial;
  private readonly outline: THREE.ShaderMaterial;
  private readonly piles: Pile[] = [];
  private current: Pile | null = null;
  private settling: Pile[] = [];
  private phase: Phase = 'none';
  private t = 0;
  /** 今回は体の前から出す（出し終わっても前へ跳ねない） */
  private front = false;
  /** 出口の位置の調整値と、体型ごとの保存 */
  readonly exit: ExitParams = { ...DEFAULT_EXIT };
  private readonly savedExit: Record<string, ExitParams>;
  private presetId = '';
  /** 出口の目印を出すか（調整用）。赤：いつもの出口（仰向けで寝転んでいれば仰向けの出口）、青：前から出すときの出口 */
  showExit = false;
  private readonly markers: THREE.Mesh[];

  constructor(private readonly y: Yukkuri) {
    this.material = createAccessoryMaterial(y.bodyMaterial, ANKO, { rim: 0.25 });
    this.outline = createAccessoryOutlineMaterial(y.outlineMaterial);
    this.savedExit = { ...loadJSON<Record<string, ExitParams>>(STORAGE_KEY) };
    // 目印：体の表面から少し外へ浮かせて置く（体の向こう側にあるときは体に隠れる。透けて見えると、どちら側か分からない）
    const ball = new THREE.SphereGeometry(1, 16, 12);
    this.markers = ['#ff3b30', '#2f7bff'].map((color) => {
      const m = new THREE.Mesh(ball, new THREE.MeshBasicMaterial({ color }));
      m.visible = false;
      this.object.add(m);
      return m;
    });
  }

  /** 体型を切り替える：出口の調整値を、その体型で保存したもの（なければ初期値）にする */
  usePreset(id: string): void {
    this.presetId = id;
    Object.assign(this.exit, exitDefaults(id), this.savedExit[id]);
  }

  /** 今の体型の出口の調整値を初期値（その体型の初期値）に戻す */
  resetExit(): void {
    Object.assign(this.exit, exitDefaults(this.presetId));
    this.saveExit();
  }

  /** 今の出口の調整値を、別の体型（ユーザー設定など）にも写す */
  copyExitTo(id: string): void {
    this.storeExit(id);
    saveJSON(STORAGE_KEY, this.savedExit);
  }

  /** 今の出口の調整値を、今の体型のものとして保存する */
  saveExit(): void {
    if (!this.presetId) return;
    this.storeExit(this.presetId);
    saveJSON(STORAGE_KEY, this.savedExit);
  }

  private storeExit(id: string): void {
    const e = this.exit;
    const d = exitDefaults(id);
    const same = (Object.keys(d) as (keyof ExitParams)[]).every((k) => e[k] === d[k]);
    if (same) delete this.savedExit[id];
    else this.savedExit[id] = { ...e };
  }

  /**
   * 出口の今の位置と法線。front：体の前から出すときの出口。
   * 寝転んで仰向けのとき（前から出すときを除く）は、背中が地面に着いていつもの出口が地面すれすれになるので、
   * 背中の下側の範囲から、地面から高い所を選び直す。求められないときは false
   */
  private exitPoint(front: boolean, pos: THREE.Vector3, nrm: THREE.Vector3): boolean {
    const y = this.y;
    const e = this.exit;
    // 向き az は顔の正面が 0・背中が π で、体の右へ回ると背中側は増え、正面側は減る
    if (front) return y.outfit.surfacePoint(-e.side, e.frontHeight, pos, nrm);
    // 横に転がって仰向け（前後に長い体型）：体の上下が入れ替わり、背中側の出口が上の方に来るので、そのまま背中側から出す
    if (y.locomotion.rolledBack) return y.outfit.surfacePoint(Math.PI + e.side, e.rolledHeight, pos, nrm);
    if (!y.outfit.surfacePoint(Math.PI + e.side, e.height, pos, nrm)) return false;
    if (y.locomotion.lyingPose === 'supine') {
      // 体の高さは寝転んだ今の高さ（体の一番高い所）
      const p = y.bodyMesh.geometry.getAttribute('position').array as Float32Array;
      let top = 0;
      for (let i = 1; i < p.length; i += 3) top = Math.max(top, p[i]);
      const i = y.outfit.surfaceIndexAt(Math.PI + e.side, SUPINE_AZ_RANGE, SUPINE_MAX_HEIGHT, top * e.supineHeight, -0.3, SUPINE_AZ_WEIGHT, -1);
      if (i >= 0) y.outfit.vertexPoint(i, pos, nrm);
    }
    return true;
  }

  /** 描画の直前に呼ぶ（体の描画メッシュを更新した後）：出口の目印を体の今の形に合わせて置く */
  sync(): void {
    const show = this.showExit;
    const R = this.y.shape.radius;
    const pos = new THREE.Vector3(), nrm = new THREE.Vector3();
    this.markers.forEach((m, i) => {
      m.visible = show && this.exitPoint(i === 1, pos, nrm);
      if (!m.visible) return;
      m.position.copy(pos).addScaledVector(nrm, MARKER_SIZE * R * 0.6);
      m.scale.setScalar(MARKER_SIZE * R);
    });
  }

  /** 出し始めるのを待っているか、出している最中か（すっきりーの前まで） */
  get pushing(): boolean {
    return this.phase === 'wait' || this.phase === 'push';
  }

  /** 出している最中か（すっきりーが終わるまで） */
  get active(): boolean {
    return this.phase !== 'none';
  }

  /**
   * 出し始める（腹ばい・仰向けのままでもよい）。食べている・出している最中なら何もしない。
   * front：いつもの背中側でなく、体の前の下から前へ出す（うんうんたいそうで後ろへ反ったとき）
   */
  start(opts: { front?: boolean } = {}): boolean {
    const y = this.y;
    if (this.active || y.feeding.active || y.exercise.active || y.vomit.active || y.rest.fainting) return false;
    y.rest.wake(true);
    // 移動はやめて、出し終わるまで保留する。体勢が変わっている途中（起き上がる・倒れ込む・寝返る・跳ねるなど）なら、
    // 立って止まるか寝転がり終えるまで待ってから出す（途中の向きで出口を決めると、横や前に出てしまう）
    y.locomotion.hold();
    this.phase = 'wait';
    this.t = 0;
    this.front = opts.front ?? false;
    if (this.settled()) this.begin();
    return true;
  }

  /** 体が立って止まっているか、寝転がり終えて止まっているか */
  private settled(): boolean {
    const loco = this.y.locomotion;
    // 寝転んでいるなら、体が姿勢に付いてくるまで（転がっている途中に出し始めると、宙から出てきた。いもむし型の仰向け）
    return loco.idle || loco.settled;
  }

  /** 出し始める（出口を決めて、塊を作る） */
  private begin(): void {
    const y = this.y;
    const pos = new THREE.Vector3(), nrm = new THREE.Vector3();
    if (!this.exitPoint(this.front, pos, nrm)) {
      this.finish();
      return;
    }
    const pile = this.makePile(pos, nrm);
    // といれの中に出したか：地面に寝そべる所の始まりと先が、どちらもといれの中
    const stage = y.stage;
    const g = pile.pts[PATH_DROP], e = pile.pts[pile.pts.length - 1];
    pile.toilet = !!stage && stage.inToilet(g.x, g.z) && stage.inToilet(e.x, e.z);
    this.piles.push(pile);
    this.object.add(pile.group);
    while (this.piles.length > MAX_PILES) this.dispose(this.piles.shift()!);
    this.current = pile;
    this.phase = 'push';
    this.t = 0;
    showFace(y, FACE_PUSH, AT_LEAST_PUSH);
  }

  /**
   * 今の体勢で出すと、地面に寝そべる所の始まりと先がどこに来るか（といれに入るように位置を合わせるのに使う）。
   * 出口を求められないときは null
   */
  predict(): { start: THREE.Vector3; end: THREE.Vector3 } | null {
    const pos = new THREE.Vector3(), nrm = new THREE.Vector3();
    if (!this.exitPoint(false, pos, nrm)) return null;
    const p = this.makePile(pos, nrm);
    p.geometry.dispose();
    return { start: p.pts[PATH_DROP].clone(), end: p.pts[p.pts.length - 1].clone() };
  }

  /**
   * 出したもののどれかが、水平に見て点 c から radius 以内にあるか（寝転んだ体が起き上がるときに貫通しそうか）。
   * 体の中に隠れている根元は数えない。といれの中のものは all のときだけ数える（汚れとしては数えない）
   */
  near(c: THREE.Vector3, radius: number, all = false): boolean {
    for (const p of this.piles) {
      if (p === this.current || (p.toilet && !all)) continue;
      const from = this.lieFrom(p);
      for (let i = 0; i < p.pts.length; i += 2) {
        if (p.len[i] < from) continue;
        const d = Math.hypot(p.pts[i].x - c.x, p.pts[i].z - c.z);
        if (d < radius + p.w) return true;
      }
    }
    return false;
  }

  /** 出したものの道筋の点（水平）を順に渡す。出している最中のもの・体の中に隠れている根元・といれの中のものは数えない */
  forEachPoint(f: (x: number, z: number) => void): void {
    for (const p of this.piles) {
      if (p === this.current || p.toilet) continue;
      const from = this.lieFrom(p);
      for (let i = 0; i < p.pts.length; i += 2) if (p.len[i] >= from) f(p.pts[i].x, p.pts[i].z);
    }
  }

  /**
   * といれの外にある塊（出し終えて体から離れたもの）。体の側から POO_PIECES 切れに分けて、1 切れずつ持っていける
   */
  loose(): LooseDirt[] {
    const out: LooseDirt[] = [];
    for (const p of this.piles) {
      if (p.toilet || p === this.current || p.detached < 0) continue;
      const n = piecesOf(p);
      const seg = (k: number) => {
        const a = p.exitS, total = p.len[p.len.length - 1];
        return [a + ((total - a) * k) / n, a + ((total - a) * (k + 1)) / n];
      };
      out.push({
        next: () => (p.cut < n && this.piles.includes(p) ? this.pointAt(p, (seg(p.cut)[0] + seg(p.cut)[1]) / 2).setY(0) : null),
        take: () => {
          if (p.cut >= n || !this.piles.includes(p)) return null;
          const [s0, s1] = seg(p.cut);
          const total = p.len[p.len.length - 1];
          // 太さの範囲：元の塊の長さに対する比（一切れならその一切れの範囲の中で）
          const [u0, u1] = p.profile ?? [0, 1];
          const profile: [number, number] = [u0 + ((u1 - u0) * s0) / total, u0 + ((u1 - u0) * s1) / total];
          p.cut++;
          if (p.cut >= n) {
            this.piles.splice(this.piles.indexOf(p), 1);
            this.dispose(p);
          } else this.build(p);
          return (x, z, yaw) => this.placePiece(p, s1 - s0, profile, x, z, yaw);
        },
      });
    }
    return out;
  }

  /** 地面に残っている所の始まり（道筋の長さ）：体の中に隠れている根元と、といれへ持っていった分を除く */
  private lieFrom(p: Pile): number {
    const base = p.detached >= 0 ? p.exitS : p.ground;
    if (p.cut <= 0) return base;
    const total = p.len[p.len.length - 1];
    return Math.max(base, p.exitS + ((total - p.exitS) * p.cut) / piecesOf(p));
  }

  /** 道筋の長さ s の所 */
  private pointAt(p: Pile, s: number): THREE.Vector3 {
    let k = 0;
    while (k < p.len.length - 2 && p.len[k + 1] < s) k++;
    const f = THREE.MathUtils.clamp((s - p.len[k]) / Math.max(1e-6, p.len[k + 1] - p.len[k]), 0, 1);
    return p.pts[k].clone().lerp(p.pts[k + 1], f);
  }

  /** 分けた一切れを（x, z）に向き yaw で置く（長さ len の真っすぐな塊。太さは元の塊の profile の範囲）。といれの中か外かは置いた所で決まる */
  private placePiece(src: Pile, len: number, profile: [number, number], x: number, z: number, yaw: number): void {
    const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const a = new THREE.Vector3(x, src.h, z).addScaledVector(dir, -len / 2);
    const pts: THREE.Vector3[] = [], lens: number[] = [];
    const n = 12;
    for (let i = 0; i <= n; i++) {
      pts.push(a.clone().addScaledVector(dir, (len * i) / n));
      lens.push((len * i) / n);
    }
    const geometry = new THREE.BufferGeometry();
    const group = new THREE.Group();
    group.add(new THREE.Mesh(geometry, this.outline), new THREE.Mesh(geometry, this.material));
    group.children.forEach((m) => (m.frustumCulled = false));
    const stage = this.y.stage;
    const e = pts[pts.length - 1];
    const toilet = !!stage && stage.inToilet(a.x, a.z) && stage.inToilet(e.x, e.z);
    const piece: Pile = {
      group, geometry, pts, len: lens, ground: 0, shown: len, settle: SETTLE_TIME, w: src.w, h: src.h,
      side: new THREE.Vector3(0, 1, 0).cross(dir).normalize(), detached: SETTLE_TIME, exitS: 0, toilet, cut: 0, profile,
    };
    this.piles.push(piece);
    this.object.add(group);
    while (this.piles.length > MAX_PILES) this.dispose(this.piles.shift()!);
    this.build(piece);
  }

  /** といれの中にあるものの道筋の点（水平）を順に渡す（といれへ運んだ一切れを置く所を選ぶのに使う） */
  forEachToiletPoint(f: (x: number, z: number) => void): void {
    for (const p of this.piles) {
      if (!p.toilet) continue;
      for (let i = 0; i < p.pts.length; i += 2) if (p.len[i] >= this.lieFrom(p)) f(p.pts[i].x, p.pts[i].z);
    }
  }

  /** 出したものを全部片付ける（出している最中ならそこでやめる） */
  clear(): void {
    if (this.active) this.finish();
    this.current = null;
    this.settling = [];
    for (const p of this.piles) this.dispose(p);
    this.piles.length = 0;
  }

  /** 固定時間刻みで呼ぶ */
  update(dt: number): void {
    this.t += dt;
    if (this.phase === 'wait' && (this.settled() || this.t > WAIT_MAX)) this.begin();
    const p = this.current;
    if (p) {
      // 出している間：力んで小刻みに震える（出だしはなめらかに）
      this.y.tremble = PUSH_TREMBLE * Math.min(1, this.t * 3);
      const total = p.len[p.len.length - 1];
      p.shown = Math.min(total, p.shown + SPEED * this.y.shape.radius * dt);
      if (p.shown >= total) {
        this.current = null;
        p.settle = 0;
        p.detached = 0; // 出し終わったら体から切り離す
        this.settling.push(p);
        this.relieved();
      }
      this.build(p);
    }
    for (let i = this.settling.length - 1; i >= 0; i--) {
      const s = this.settling[i];
      if (s.settle < SETTLE_TIME) s.settle += dt;
      if (s.detached >= 0 && s.detached < SETTLE_TIME) s.detached += dt;
      this.build(s);
      if (s.settle >= SETTLE_TIME && (s.detached < 0 || s.detached >= SETTLE_TIME)) this.settling.splice(i, 1);
    }
    if (this.phase === 'relief' && this.t > RELIEF_TIME) this.finish();
  }

  /** 出し終わった：震えを止め、一歩前へ跳ねて、感動した顔で「すっきりー」 */
  private relieved(): void {
    const y = this.y;
    this.phase = 'relief';
    this.t = 0;
    y.tremble = 0;
    showFace(y, FACE_RELIEF, AT_LEAST_RELIEF);
    // 前の向きは体の向きから（腹ばいでお尻を突き上げていると顔は真下を向き、顔からは前後が決まらない）
    const facing = bodyFacing(y);
    // 立っていれば一歩前へ跳ねる（寝転がっているときは跳ねない）。
    // 前に出したときは、前へ跳ねると塊に乗ってしまうので、後ろへ小さく跳ねて塊から離れる
    if (!y.locomotion.isLying) {
      const step = this.front ? -HOP_BACK : HOP_FORWARD;
      y.impulse(facing.x * step, HOP_UP, facing.z * step);
    }
    const R = y.shape.radius;
    const pos = new THREE.Vector3(y.center.x, y.center.y + y.height * 0.5 + R * 0.25, y.center.z).addScaledVector(facing, R * 0.9);
    y.texts.say('すっきりー', pos, R * 0.42, RELIEF_TIME, new THREE.Vector3(facing.x * R * 0.25, R * 0.12, facing.z * R * 0.25));
  }

  private finish(): void {
    this.phase = 'none';
    this.y.tremble = 0;
    this.y.face.override = null;
    this.y.locomotion.release();
  }

  /** 道筋を決める：出口のすぐ内側から外へ出て地面まで下り、地面に寝そべって真っすぐ後ろへ伸びる */
  private makePile(exit: THREE.Vector3, nrm: THREE.Vector3): Pile {
    const R = this.y.shape.radius;
    const w = HALF_WIDTH * R, h = HALF_HEIGHT * R;
    // 出す向き：出口の法線の水平成分。寝転がって出口が真下（体の下）や真上を向いているときは、
    // 体の底の向き（体の下向きが寝転がって傾いた向き）の水平成分＝頭と反対の側
    const out = nrm.clone().setY(0);
    if (out.lengthSq() < 0.09) {
      const down = new THREE.Vector3(0, -1, 0).applyQuaternion(this.y.body.rotation).setY(0);
      if (down.lengthSq() > 0.0025) out.copy(down);
      else out.copy(exit).sub(this.y.center).setY(0);
    }
    if (out.lengthSq() < 1e-6) out.set(0, 0, -1);
    out.normalize();
    // 出口のすぐ内側（つなぎ目が体に隠れるように）から、地面に寝そべる所へ
    // 出口では体の表面に垂直に出てくる（水平に押し出すと、斜めの表面を太い塊が横切ってしまう）。
    // 法線が真下を向いているとき（体の下の出口）は、地面に沿って横へ出る
    const n = nrm.clone().normalize();
    if (n.y < -0.5) n.lerp(out, 0.7).normalize();
    const a = exit.clone().addScaledVector(n, -w * 0.6);
    a.y = Math.max(a.y, h);
    const c1 = exit.clone().addScaledVector(n, w * 0.9);
    c1.y = Math.max(c1.y, h);
    // 地面に着く所：出口が高いほど（腹ばいで背中側が上がったとき）少し離れた所へ垂れる
    const drop = Math.max(0, exit.y - h);
    const g = new THREE.Vector3(exit.x, h, exit.z).addScaledVector(out, w * 0.7 + drop * 0.6);
    // 着く手前は上から下りてくる（高い所から垂れて、地面に寝そべる）
    const c2 = g.clone().addScaledVector(out, -w * 0.5).add(new THREE.Vector3(0, drop * 0.5, 0));
    const end = g.clone().addScaledVector(out, LENGTH * R);
    const raw: THREE.Vector3[] = [];
    const n1 = PATH_DROP;
    for (let i = 0; i < n1; i++) raw.push(bezier(a, c1, c2, g, i / n1));
    const n2 = 48;
    for (let i = 0; i <= n2; i++) raw.push(g.clone().lerp(end, i / n2));
    const len = [0];
    for (let i = 1; i < raw.length; i++) len.push(len[i - 1] + raw[i].distanceTo(raw[i - 1]));
    // 体の表面を出る所：道筋で出口に一番近い点の少し先（太さの分だけ体から離れた所）
    let ei = 0;
    for (let i = 1; i < n1; i++) if (raw[i].distanceTo(exit) < raw[ei].distanceTo(exit)) ei = i;
    const exitS = Math.min(len[n1], len[ei] + h * 0.5);
    const geometry = new THREE.BufferGeometry();
    const group = new THREE.Group();
    group.add(new THREE.Mesh(geometry, this.outline), new THREE.Mesh(geometry, this.material));
    group.children.forEach((m) => (m.frustumCulled = false));
    const side = new THREE.Vector3(0, 1, 0).cross(out).normalize();
    return { group, geometry, pts: raw, len, ground: len[n1], shown: 0, settle: -1, w, h, side, detached: -1, exitS, toilet: false, cut: 0 };
  }

  /**
   * 太さの比（道筋に沿った長さ s。今出ている長さ shown）。出したものは道筋に沿って先へ押し出されるので、
   * 位置 s にあるのは、出し終わったときに total - shown + s の所に来る部分（先頭は先に出た一番太い所）
   */
  private thickness(s: number, shown: number, total: number, profile?: [number, number]): number {
    // 分けた一切れは、元の塊のその範囲の太さ
    const u = profile ? profile[0] + (profile[1] - profile[0]) * THREE.MathUtils.clamp(s / total, 0, 1)
      : THREE.MathUtils.clamp((total - shown + s) / total, 0, 1);
    return END_RATIO + (1 - END_RATIO) * Math.pow(THREE.MathUtils.smoothstep(u, 0, THICK_AT), 0.8);
  }

  /** 今出ている長さまでの塊を作る。先は丸く閉じる */
  private build(p: Pile): void {
    const total = p.len[p.len.length - 1];
    const settle = p.settle < 0 ? 0 : THREE.MathUtils.smoothstep(p.settle, 0, SETTLE_TIME);
    const W = p.w * (1 + (SETTLE_W - 1) * settle), H = p.h * (1 + (SETTLE_H - 1) * settle);
    const step = p.w * RING_STEP;
    const rings: Ring[] = [];
    // 出し終わって体が離れたら、体に入っていた根元の分を除き、残りを地面に下ろす（落ちて寝そべる）。
    // 寝転がったまま体が動かないときは、根元は体の中に残す（下ろすと帽子などを突き抜ける）
    const drop = p.detached < 0 ? 0 : THREE.MathUtils.smoothstep(p.detached, 0, SETTLE_TIME);
    // 切り離したら、体の中にあった根元（exitS より手前）を消す
    // といれへ運んで減ったら、体の側から持っていった分を除く
    const cutTo = p.cut > 0 ? p.exitS + ((total - p.exitS) * p.cut) / piecesOf(p) : 0;
    const from = Math.max(p.detached < 0 ? 0 : p.exitS, cutTo);
    // 地面に寝そべる向き（体から離れる水平な向き）
    const out = new THREE.Vector3().crossVectors(p.side, Y_UP);
    let k = 0;
    for (let s = from; ; s += step) {
      const last = s >= p.shown;
      const d = Math.min(s, p.shown);
      while (k < p.len.length - 2 && p.len[k + 1] < d) k++;
      const f = THREE.MathUtils.clamp((d - p.len[k]) / Math.max(1e-6, p.len[k + 1] - p.len[k]), 0, 1);
      const c = p.pts[k].clone().lerp(p.pts[k + 1], f);
      let t = p.pts[k + 1].clone().sub(p.pts[k]).normalize();
      // 宙にあった所を地面に下ろすときは、断面の向きも寝かせる（垂れていた向きのままだと、
      // 断面の縦横が両方水平になり、地面で平たい板のように見える）
      // 寝かせる向きは地面に寝そべる所と同じ（体から離れる向き。逆向きに寝かせると断面が裏返る）
      if (drop > 0 && d < p.ground) t = t.lerp(out, drop).normalize();
      const side = p.side;
      const up = new THREE.Vector3().crossVectors(t, side).normalize();
      const th = this.thickness(d, p.shown, total, p.profile);
      const hh = H * th;
      // 地面に寝そべる所は、底が地面に着く高さまで下げる（細い所も浮かない）
      if (c.y <= p.h * 1.01) c.y = Math.min(c.y, hh);
      else c.y += (hh - c.y) * drop;
      rings.push({ c, t, side, up, w: W * th, h: hh });
      if (last) break;
    }
    // 根元の丸いふた（体の中に隠れている間は見えない。体が離れると見える）：最初の断面から後ろへ半球
    const first = rings[0];
    const head: Ring[] = [];
    for (let i = 8; i >= 1; i--) {
      const a = (i / 8) * (Math.PI / 2);
      const kc = Math.max(Math.cos(a), 0.02);
      const c = first.c.clone().addScaledVector(first.t, -Math.sin(a) * Math.min(first.w, first.h * 1.4));
      // 地面に寝そべっている所だけ、底を地面に着けたまま閉じる（宙にあるときはそのまま丸く閉じる）
      if (first.c.y <= first.h * 1.01) c.y = Math.min(c.y, first.h * kc);
      head.push({ c, t: first.t, side: first.side, up: first.up, w: first.w * kc, h: first.h * kc });
    }
    rings.unshift(...head);
    // 先の丸いふた：先の断面から、だ円の半球（底は地面に着いたまま）
    const end = rings[rings.length - 1];
    const caps = 8;
    const capLen = Math.min(end.w, end.h * 1.4);
    for (let i = 1; i <= caps; i++) {
      const a = (i / caps) * (Math.PI / 2);
      const kc = Math.max(Math.cos(a), 0.02);
      const c = end.c.clone().addScaledVector(end.t, Math.sin(a) * capLen);
      if (end.c.y <= end.h * 1.01) c.y = Math.min(c.y, end.h * kc);
      rings.push({ c, t: end.t, side: end.side, up: end.up, w: end.w * kc, h: end.h * kc });
    }
    const pos = new Float32Array(rings.length * (SIDES + 1) * 3);
    const v = new THREE.Vector3();
    rings.forEach((ring, i) => {
      for (let j = 0; j <= SIDES; j++) {
        const a = (j / SIDES) * Math.PI * 2;
        v.copy(ring.c).addScaledVector(ring.side, Math.cos(a) * ring.w).addScaledVector(ring.up, Math.sin(a) * ring.h);
        // 底は地面で平らにつぶれる
        if (v.y < FLOOR) v.y = FLOOR;
        const o = (i * (SIDES + 1) + j) * 3;
        pos[o] = v.x; pos[o + 1] = v.y; pos[o + 2] = v.z;
      }
    });
    const index: number[] = [];
    for (let i = 0; i < rings.length - 1; i++) {
      for (let j = 0; j < SIDES; j++) {
        const a = i * (SIDES + 1) + j, b = a + SIDES + 1;
        index.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    const g = p.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(index);
    g.computeVertexNormals();
    g.computeBoundingSphere();
  }

  private dispose(p: Pile): void {
    this.object.remove(p.group);
    p.geometry.dispose();
  }
}

/** 塊を分ける数：出したままの塊は POO_PIECES、分けた一切れは 1（もう分けない） */
function piecesOf(p: Pile): number {
  return p.profile ? 1 : POO_PIECES;
}

function bezier(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, t: number): THREE.Vector3 {
  const u = 1 - t;
  return a.clone().multiplyScalar(u * u * u)
    .addScaledVector(b, 3 * u * u * t)
    .addScaledVector(c, 3 * u * t * t)
    .addScaledVector(d, t * t * t);
}
