import * as THREE from 'three';
import { createAccessoryMaterial } from '../render/accessoryMaterial';
import type { ToonColors } from '../render/toonMaterial';
import { readVertex } from './FaceIndex';
import { bowGeometries, lathe, withOutline } from './shapes';
import type { Accessory, AttachContext, OutfitParams } from './types';

export interface BraidStyle {
  /** 横の位置（顔座標の x。+ で見る人から見て右） */
  fx: number;
  /** 編み始めの高さ（顔座標の y） */
  top: number;
  /** 毛先の位置：体の下端から上へ、体の高さに対するこの比の所で終わる */
  bottomMargin: number;
  /** 編み目の幅・1つの長さ（頭の半径に対する比） */
  width: number;
  segment: number;
  /** 体の表面から浮かせる量（頭の半径に対する比） */
  lift: number;
  /** リボンの位置（編み始めから毛先までの割合）と大きさ（頭の半径に対する比） */
  bowAt: number;
  bowSize: number;
  hair: ToonColors;
  bow: ToonColors;
}

/** 体の表面の道筋をたどる点の数 */
const PATH = 14;
/** 編み目の間隔（1つの長さに対する比。小さいほど深く重なる） */
const LOBE_STEP = 0.42;
/** 編み目の傾き（ラジアン） */
const LOBE_TILT = 0.55;
/** 編み目の数の上限（体型を変えても作り直さずに済むよう、多めに作って使う分だけ表示する） */
const MAX_LOBES = 40;

/**
 * 編み目の間隔の追従：立ち止まっているときは update 1回にこの割合ずつ（呼吸の伸び縮みを拾わない）、
 * 差がこれより大きいとき（比）と動いているときは SPACING_MOVE の割合ずつ（一度に合わせると階段状に跳んで見える）
 */
const SPACING_FOLLOW = 0.005;
const SPACING_SNAP = 0.03;
const SPACING_MOVE = 0.4;
/** 立ち止まって決めた間隔に合わせて、編み目を縦に伸ばしてよい上限（倍）。三つ編みを伸ばしている間に、これ以上伸ばすことはない */
const LOBE_STRETCH_MAX = 1.3;
/** 編み目の数を変えるのは、ちょうどの数からこれ以上離れたとき（0.5 より大きくして境目でのばたつきを防ぐ） */
const COUNT_KEEP = 0.8;
/** 帽子の外へ出た所から編み始めまでの道筋の長さ（編み目1つの長さに対する比。一番上の編み目の上半分ほど） */
const COVER_CLEAR = 0.55;
/** 編み始めで除く長さへ、update 1回に縮める差の割合 */
const TRIM_FOLLOW = 0.25;
/** 帽子に隠れる所を除いても、これだけ（道筋の点の数）は残す */
const MIN_PATH = 3;
/**
 * つばを突き抜けたかを調べる所（各部品の形の座標。z が体の外向き）：編み目・リボン・房。
 * 先頭は部品の中心、残りはふくらみの頂と上下の端（中心からそこまでがつばを通り抜けたら、その部品は突き抜けている）。
 * 左右の端は見ない（見ると、横から見た薄いつばのそばで端がつばをかすめただけで部品ごと消え、転がる間に出たり消えたりした）。
 * リボンは隠さないので中心だけ（通り抜けたかを数えるのに使う）
 */
const LOBE_PROBE: [number, number, number][] = [[0, 0, 0], [0, 0.08, 0.14], [0, -0.55, 0.03], [0, 0.33, 0.05]];
const BOW_PROBE: [number, number, number][] = [[0, 0.05, 0]];
const TUFT_PROBE: [number, number, number][] = [[0, -0.4, 0], [0, -0.3, 0.28], [0, -0.95, 0.1], [0, 0, 0.17]];
/** つばを通り抜けた先の部品の下につばがあるかは、中心から体の側へこれだけ（形の座標。部品の幅ほど）の所までで見る */
const SINK = 1;

/**
 * 道筋の先頭から、帽子に隠れる所（cover が true）と、そこからさらに道筋に沿って clear の長さを除くとしたら、
 * 先頭から道筋に沿ってどれだけ除くか。
 * 帽子の縁が道筋の先頭より上（clear 以内）にあるときも、縁から clear の所まで除く
 * （先頭が隠れた瞬間に clear だけ一度に跳ばないように）
 */
function coveredLength(pts: THREE.Vector3[], cover: (p: THREE.Vector3) => boolean, clear: number): number {
  /** a（隠れている）と b（隠れていない）の間の、帽子の縁の位置の割合（a からの） */
  const edge = (a: THREE.Vector3, b: THREE.Vector3) => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 8; i++) {
      const m = (lo + hi) / 2;
      if (cover(a.clone().lerp(b, m))) lo = m;
      else hi = m;
    }
    return hi;
  };
  if (!cover(pts[0])) {
    // 先頭から道筋を上へ clear だけ延ばした所が隠れていれば、縁から先頭までの距離を差し引く
    const back = pts[0].clone().addScaledVector(pts[0].clone().sub(pts[1]).normalize(), clear);
    return cover(back) ? clear * edge(back, pts[0]) : 0;
  }
  let k = 0, d = 0;
  while (k < pts.length - MIN_PATH && cover(pts[k])) {
    if (k > 0) d += pts[k - 1].distanceTo(pts[k]);
    k++;
  }
  if (k === 0) return 0;
  // 帽子の縁を横切る所（k-1 と k の間）から clear だけ下
  return d + pts[k - 1].distanceTo(pts[k]) * edge(pts[k - 1], pts[k]) + clear;
}

/** 道筋の先頭から、道筋に沿って d の長さを除く（MIN_PATH 個の点は残す）。除いた先頭は、ちょうどその位置に置いた点にする */
function cutPath(pts: THREE.Vector3[], nrms: THREE.Vector3[], d: number): void {
  if (d <= 0) return;
  let i = 0;
  while (i < pts.length - MIN_PATH && d > pts[i].distanceTo(pts[i + 1])) {
    d -= pts[i].distanceTo(pts[i + 1]);
    i++;
  }
  const t = Math.min(1, d / Math.max(1e-6, pts[i].distanceTo(pts[i + 1])));
  const start = pts[i].clone().lerp(pts[i + 1], t);
  const startN = nrms[i].clone().lerp(nrms[i + 1], t).normalize();
  pts.splice(0, i + 1, start);
  nrms.splice(0, i + 1, startN);
}

/**
 * 法線 nrm と、編み目の伸びる向き down から、横の向き（nrm × down）。
 * 2 つがほぼ同じ向きのときは横の向きが定まらず毎コマ回ってしまうので、nrm を down に直交する成分にし、
 * それも小さいときは真上（down に直交する成分）で補う
 */
function sideOf(nrm: THREE.Vector3, down: THREE.Vector3): THREE.Vector3 {
  const n = nrm.clone().addScaledVector(down, -nrm.dot(down));
  if (n.lengthSq() < 0.04) {
    const up = new THREE.Vector3(0, 1, 0);
    const u = up.addScaledVector(down, -up.dot(down));
    n.lerp(u, 1 - n.length() / 0.2);
  }
  return new THREE.Vector3().crossVectors(n, down).normalize();
}

/** 体の中心 c から単位ベクトル dir の向きの、体の表面までの距離（その向きに近い頂点のうち一番遠いもの。間引いて数える） */
function surfaceDist(pos: Float32Array, c: THREE.Vector3, dir: THREE.Vector3): number {
  let best = 0;
  for (let i = 0; i < pos.length; i += 3 * 2) {
    const x = pos[i] - c.x, y = pos[i + 1] - c.y, z = pos[i + 2] - c.z;
    const l = Math.hypot(x, y, z);
    if (l < 1e-6) continue;
    if ((x * dir.x + y * dir.y + z * dir.z) / l > SURFACE_COS) best = Math.max(best, l);
  }
  return best;
}
/** 伸ばすときの残りのずれの補正：毎回積む割合・残す割合（漏らし）・大きさの上限（頭の半径に対する比） */
const REACH_FIX_GAIN = 0.25;
const REACH_FIX_LEAK = 0.85;
const REACH_FIX_MAX = 0.4;
/** 表面までの距離を測るとき、向きがこれ（cos）より近い頂点を数える */
const SURFACE_COS = 0.96;

/** 体の中心（頂点の平均。間引いて数える） */
function bodyCenter(pos: Float32Array): THREE.Vector3 {
  const c = new THREE.Vector3();
  let n = 0;
  for (let i = 0; i < pos.length; i += 3 * 16) {
    c.x += pos[i]; c.y += pos[i + 1]; c.z += pos[i + 2];
    n++;
  }
  return c.divideScalar(Math.max(1, n));
}

/** 地面に沿わせた所の、道筋の地面からの高さ（編み目の幅に対する比。編み目の厚みの半分ほど） */
const GROUND_FLOAT = 0.35;
/** 道筋の一番低い所が、地面に沿わせる高さのこれ倍より高くなったら、地面から離れたとみなす */
const LIFT_OFF = 2.5;
/** 地面に沿わせた形と体に沿った形の間を移るとき、update 1回に縮める差の割合 */
const LAY_FOLLOW = 0.15;
/** 地面に沿わせた所で、編み目の向きを寝かせ終えるまでの距離（GROUND_FLOAT の高さに対する比） */
const GROUND_TURN = 6;

/** 道筋に沿って、高さ floor より下へ初めて行く所までの距離（行かなければ -1） */
function groundCrossing(pts: THREE.Vector3[], floor: number): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const L = a.distanceTo(b);
    if (b.y < floor && i > 0) {
      if (a.y < floor) return d; // 道筋の始まりから下にある
      return d + L * ((a.y - floor) / Math.max(1e-6, a.y - b.y));
    }
    d += L;
  }
  return -1;
}

/**
 * 道筋（体の表面から浮かせた点の列と、その法線）の、距離 from から先を、地面に沿って体の外へ流す。
 * 距離は道筋の長さのまま保つ（長さの調整値どおりの長さになる）。
 * 流した所の法線は、流し始めの法線から真上へ寝かせていく（編み目の前面が上を向き、地面に寝た形になる）
 */
function layOnGround(pts: THREE.Vector3[], nrms: THREE.Vector3[], from: number, floor: number, center: THREE.Vector3): void {
  // 流し始め：道筋に沿って from の所
  let d = 0, k = 1;
  while (k < pts.length - 1 && d + pts[k].distanceTo(pts[k - 1]) < from) d += pts[k].distanceTo(pts[k - 1]), k++;
  const a = pts[k - 1], b = pts[k];
  const t = THREE.MathUtils.clamp((from - d) / Math.max(1e-6, a.distanceTo(b)), 0, 1);
  const start = a.clone().lerp(b, t);
  // 流す向き：体の中心から流し始めへ向かう水平の向き（体の外向き）。
  // 法線から取ると、体の真下近くでは法線がほぼ真下を向き、わずかな揺れで向きが大きく変わる
  const dir = start.clone().sub(center).setY(0);
  if (dir.lengthSq() < 1e-8) dir.copy(b).sub(a).setY(0);
  if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1);
  dir.normalize();
  // 置き換える前の道筋に沿った距離
  const dist = [start.distanceTo(b)];
  for (let i = k + 1; i < pts.length; i++) dist.push(dist[dist.length - 1] + pts[i].distanceTo(pts[i - 1]));
  const startN = nrms[k - 1].clone().lerp(nrms[k], t).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  // ほぼ真下を向いているときは体の外向きから（真上へ混ぜる途中で長さ 0 を通らないように）
  const n0 = startN.y < -0.7 ? startN.clone().lerp(dir, 0.7).normalize() : startN;
  for (let i = k; i < pts.length; i++) {
    pts[i] = start.clone().addScaledVector(dir, dist[i - k]);
    const w = THREE.MathUtils.smoothstep(dist[i - k], 0, floor * GROUND_TURN);
    nrms[i] = n0.clone().lerp(up, w).normalize();
  }
}

/**
 * 三つ編み：体の表面に沿って垂れる編み目の列。編み目は左右に交互に傾いたふくらみで、
 * 下の方にリボン、その下に毛先の房。
 * 道筋は体の表面の点（静止形状で選んだ頂点）なので、体の変形についていく
 */
export class Braid implements Accessory {
  readonly object = new THREE.Group();
  private path: number[] = [];
  private readonly lobes: THREE.Group[] = [];
  private readonly bow = new THREE.Group();
  private readonly tuft: THREE.Group;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private headR = 1;
  /** 編み目の間隔（道筋に沿った距離）。呼吸などの小さな伸び縮みにはゆっくりしか追従しない（-1 は未定） */
  private spacing = -1;
  /**
   * 立ち止まって落ち着いているときの編み目の間隔（-1 は未定）。伸ばしている間はこれを使う（伸ばす合間に歩く・身をかがめるなどで
   * 間隔が変わったまま伸ばすと、編み目の間が空いた）
   */
  private restSpacing = -1;
  private count = 0;
  /** 編み目の数を、落ち着いているときに決めたか（決めるまでは仮の数で、毎回決め直す） */
  private counted = false;
  /** 地面に沿わせ始める所（道筋に沿った距離）。小さな動きにはゆっくりしか追従しない（-1 は地面に届いていない） */
  private groundAt = -1;
  /** 地面に届いているか（離れるのははっきり離れたときだけ）と、地面に沿わせた形をどれだけ混ぜているか（0〜1） */
  private onGround = false;
  private laid = 0;
  /** 編み始めで除いている長さ（道筋に沿った距離。-1 は未定） */
  private trimmed = -1;
  /** 点が帽子に隠れているか（帽子をかぶっているとき Outfit が設定する）。編み始めを帽子の外へ出すのに使う */
  cover: ((p: THREE.Vector3) => boolean) | null = null;
  /**
   * 線分が帽子のつばの上面を下（頭の側）から上へ通り抜けた回数（逆向きは負。帽子をかぶっているとき Outfit が設定する）。
   * つばを突き抜けた所から先の部品を隠すのに使う
   */
  crossing: ((p: THREE.Vector3, q: THREE.Vector3) => number) | null = null;
  /**
   * 物をつかむ所（毛先の房の中ほど）と、そこでの向き：down は三つ編みの垂れる向き、side は横、front は体の外向き。
   * 三つ編みを簡易的な手として使う（枝を持つなど）。update のたびに書き換える。ready は一度でも置けたか
   */
  readonly grip = { pos: new THREE.Vector3(), down: new THREE.Vector3(0, -1, 0), side: new THREE.Vector3(1, 0, 0), front: new THREE.Vector3(0, 0, 1), ready: false };
  /**
   * 三つ編みを伸ばす：つかむ所（grip）を reachTarget（ワールド）へ、reachAmount（0〜1）の割合で寄せる。
   * 編み始めは体に付けたまま、道筋を「編み始め → 元の毛先 → 目標」の曲線へなめらかに曲げる（物を拾うときなど）
   */
  readonly reachTarget = new THREE.Vector3();
  reachAmount = 0;
  /**
   * つかむ所（房の中ほど）が道筋の先からどれだけ手前にあるか（道筋に沿った長さ）。伸ばすときは、道筋の先を目標からこの分だけ
   * 先へ延ばして、つかむ所がちょうど目標に来るようにする。前の回の値を使う（向きの補正を積み重ねると、動く目標に追いつけず膨らみ続けた）
   */
  private reachShort = 0;
  /**
   * それでも残るずれ（つかむ所 → 目標）の補正。少しずつ積むが、毎回少し減らし（漏らし）、大きさにも上限を付ける
   * （漏らさずに積むと、振り回す目標を追いかけて膨らみ続け、振る角度がおかしくなった）
   */
  private readonly reachFix = new THREE.Vector3();

  constructor(ctx: AttachContext, private readonly style: BraidStyle, private readonly params: OutfitParams) {
    const hair = createAccessoryMaterial(ctx.bodyMaterial, style.hair, { rim: 0.2 });
    const bow = createAccessoryMaterial(ctx.bodyMaterial, style.bow, { doubleSide: true });
    this.materials.push(hair, bow);
    const ol = ctx.outlineMaterial;
    // 編み目：上が丸く下がとがった平たいしずく形（単位の大きさ。置くときに大きさを合わせる）。
    // 左右交互に斜めに傾け、とがった先を中央の下へ向けて重ねると、V 字が連なる三つ編みの模様になる
    const lobe = lathe([
      [0.001, -0.62], [0.07, -0.6], [0.15, -0.44], [0.25, -0.16], [0.3, 0.08],
      [0.27, 0.24], [0.17, 0.33], [0.001, 0.36],
    ], 20);
    lobe.scale(1, 1, 0.45);
    this.geometries.push(lobe);
    for (let i = 0; i < MAX_LOBES; i++) {
      const g = withOutline(lobe, hair, ol);
      this.lobes.push(g);
      this.object.add(g);
    }
    for (const g of bowGeometries(0.55, { tail: 0, lift: 0.15 })) {
      this.geometries.push(g);
      this.bow.add(withOutline(g, bow, ol));
    }
    this.object.add(this.bow);
    // 毛先の房：上がふくらみ、下へとがる（少し広がった筆の形）
    // 断面は下から上へ並べる（逆だと面が裏返り、輪郭線だけが黒く見える）
    const tuft = lathe([[0.001, -1.05], [0.2, -0.95], [0.42, -0.7], [0.5, -0.3], [0.32, 0], [0.001, 0.05]], 24);
    tuft.scale(1, 1, 0.55);
    this.geometries.push(tuft);
    this.tuft = withOutline(tuft, hair, ol);
    this.object.add(this.tuft);
  }

  rebuild(ctx: AttachContext): void {
    const ix = ctx.index;
    this.headR = ix.headR;
    const st = this.style;
    // 体の下端まで届く長さに、調整値の比を掛ける（短くても編み目2つ分は残す）
    const full = Math.min(st.top - 0.5, ix.lowestFy(st.fx, st.bottomMargin));
    const k = THREE.MathUtils.clamp(this.params.braidLength, 0, 1);
    const bottom = Math.min(st.top - st.segment * 1.5, st.top + (full - st.top) * k);
    this.path = [];
    this.spacing = -1;
    this.restSpacing = -1;
    this.count = 0;
    this.counted = false;
    this.trimmed = -1;
    this.groundAt = -1;
    this.onGround = false;
    this.laid = 0;
    for (let i = 0; i < PATH; i++) {
      const fy = st.top + ((bottom - st.top) * i) / (PATH - 1);
      // 下へ行くほど少し外側（体の丸みに沿って広がる）
      this.path.push(ix.nearest(st.fx * (1 + 0.08 * (i / (PATH - 1))), fy));
    }
    this.update(ctx);
    // 作り直した直後の数は仮のもの（帽子がまだ載り直していないことがある）。落ち着いたときに決める
    this.counted = false;
  }

  update(ctx: AttachContext): void {
    const st = this.style;
    const R = this.headR;
    const lift = st.lift * R;
    // 道筋：表面の点を法線方向へ浮かせたもの
    const pts: THREE.Vector3[] = [];
    const nrms: THREE.Vector3[] = [];
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    for (const i of this.path) {
      readVertex(ctx.pos, ctx.nrm, i, p, n);
      pts.push(p.clone().addScaledVector(n, lift));
      nrms.push(n.clone());
    }
    // 帽子に隠れる所は編まない（編み目がフリルやつばを突き抜けないように）。
    // 編み始めは、帽子の外へ出た所から一番上の編み目の高さぶん下
    // 除く長さはなめらかに追従させる（頭に押されたフリルが段ごとにたくし上がると、隠れる所が一度に変わるため）
    const covered = this.cover ? coveredLength(pts, this.cover, st.segment * R * COVER_CLEAR) : 0;
    this.trimmed = this.trimmed < 0 ? covered : this.trimmed + (covered - this.trimmed) * TRIM_FOLLOW;
    cutPath(pts, nrms, this.trimmed);
    // 地面に届いたら、そこから先は地面に沿って体の外へ流す（地面で押しつぶされないように）。
    // 体の下側は地面とほぼ平行なので、呼吸で体がわずかに上下するだけで届く所が道筋に沿って大きく動き、
    // 曲がり角の編み目の向きが揺れる。届く所も、小さな動きにはゆっくりしか追従させない
    // 地面に届いたかは、届いたらすぐ「届いた」に、離れるのは道筋がはっきり地面から離れたときだけにする
    // （寝転んで付け根が地面すれすれだと、わずかな揺れで届く・届かないが行き来する）。
    // 地面に沿わせた形と体に沿った形の間は、LAY_FOLLOW の割合ずつなめらかに移る（一度に切り替えると、編み目が床と体の間を跳ぶ）
    const floor = st.width * R * GROUND_FLOAT;
    const reach = groundCrossing(pts, floor);
    if (reach >= 0) {
      this.onGround = true;
      if (this.groundAt < 0) this.groundAt = reach;
      else this.groundAt += (reach - this.groundAt) * (Math.abs(reach - this.groundAt) > st.segment * R ? TRIM_FOLLOW : SPACING_FOLLOW);
    } else if (Math.min(...pts.map((q) => q.y)) > floor * LIFT_OFF) {
      this.onGround = false; // 浮いている（跳んでいるときなど）
    }
    this.laid += ((this.onGround ? 1 : 0) - this.laid) * LAY_FOLLOW;
    if (!this.onGround && this.laid < 0.01) {
      this.laid = 0;
      this.groundAt = -1;
    }
    if (this.groundAt >= 0 && this.laid > 0) {
      const lp = pts.map((q) => q.clone()), ln = nrms.map((q) => q.clone());
      layOnGround(lp, ln, this.groundAt, floor, bodyCenter(ctx.pos));
      for (let i = 0; i < pts.length; i++) {
        pts[i].lerp(lp[i], this.laid);
        nrms[i].lerp(ln[i], this.laid).normalize();
      }
    }
    // 伸ばす：道筋を、編み始め → 元の毛先 → 目標（補正つき）の 2 次曲線へ寄せる
    // 曲げた道筋は体の中へ入らないよう、体の中心から見たその向きの体の表面より lift だけ外へ押し出す
    // （元の道筋と同じ距離では、横に広い・前後に長い・下ぶくれの体型で表面の内側に入った）
    if (this.reachAmount > 1e-3) {
      const a = this.reachAmount;
      const root = pts[0].clone();
      const ctrl = pts[pts.length - 1].clone();
      const out = this.reachTarget.clone().sub(ctrl);
      // 延ばす向きは水平寄りに（下向きに延ばすと地面の下へ潜った）
      if (out.lengthSq() > 1e-8) out.normalize();
      out.y = Math.max(out.y, 0);
      const end = this.reachTarget.clone().addScaledVector(out, this.reachShort).add(this.reachFix);
      const c = bodyCenter(ctx.pos);
      for (let i = 0; i < pts.length; i++) {
        const t = i / (pts.length - 1);
        const q = root.clone().multiplyScalar((1 - t) * (1 - t))
          .addScaledVector(ctrl, 2 * (1 - t) * t).addScaledVector(end, t * t);
        pts[i].lerp(q, a);
        if (i === 0) continue;
        const v = pts[i].clone().sub(c);
        const d = v.length();
        if (d < 1e-6) continue;
        const need = surfaceDist(ctx.pos, c, v.multiplyScalar(1 / d)) + lift;
        // 先（つかむ所）は目標に届かせる（地面すれすれの目標は、その向きの体の表面より内側に見えることがある）
        const keep = 1 - THREE.MathUtils.smoothstep(t, 0.7, 1);
        if (d < need) pts[i].copy(c).addScaledVector(v, d + (need - d) * keep);
      }
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const total = cum[cum.length - 1];
    // 点ごとの接線（前後の点を結ぶ向き）。区間の向きをそのまま使うと、編み目が点をまたぐたびに向きが跳ぶ
    const tans = pts.map((_, i) => pts[Math.min(pts.length - 1, i + 1)].clone().sub(pts[Math.max(0, i - 1)]).normalize());
    /** 道筋に沿った距離 d の位置・接線・法線 */
    const at = (d: number) => {
      let k = 1;
      while (k < cum.length - 1 && cum[k] < d) k++;
      const t = THREE.MathUtils.clamp((d - cum[k - 1]) / Math.max(1e-6, cum[k] - cum[k - 1]), 0, 1);
      const pos = pts[k - 1].clone().lerp(pts[k], t);
      const nrm = nrms[k - 1].clone().lerp(nrms[k], t).normalize();
      const tan = tans[k - 1].clone().lerp(tans[k], t).normalize();
      return { pos, nrm, tan };
    };
    /** 置く：up を接線の逆（下向きに垂れる）、前を法線にした向き */
    const place = (obj: THREE.Object3D, d: number, side: number, scale: THREE.Vector3, roll: number) => {
      const { pos, nrm, tan } = at(d);
      const down = tan;
      const lat = sideOf(nrm, down);
      const front = new THREE.Vector3().crossVectors(down, lat).normalize();
      const m = new THREE.Matrix4().makeBasis(lat, down.clone().negate(), front);
      obj.position.copy(pos).addScaledVector(lat, side);
      obj.quaternion.setFromRotationMatrix(m);
      obj.rotateZ(roll);
      obj.scale.copy(scale);
    };

    const w = st.width * R;
    const seg = st.segment * R;
    // 編み目の数と間隔：道筋の長さから決めるが、呼吸で体がふくらむたびに三つ編みが伸び縮みしないよう、
    // 間隔はゆっくり追従させる（体型を変えたときなど大きく変わったときはすぐ合わせる）
    const target = total * st.bowAt;
    // 数は立ち止まって落ち着いているときだけ決め直す。動いている間（這う・跳ねるなどで体が伸び縮みし、
    // 頭が前に出たり帽子が浮いたりして帽子に隠れる所も変わる）は数を保ち、間隔だけを合わせる。
    // 境目で行ったり来たりしないよう、今の数から COUNT_KEEP 以上離れたときだけ変える
    // 作り直した直後（帽子が載り終わる前など）は仮の数として、落ち着くまで毎回決め直す
    let count = this.count;
    const still = ctx.still !== false;
    // 伸ばしている間は、編み目の大きさ・間隔を伸ばす前のまま変えず、長さの変わった分は毛先の側で編み目を足し引きする
    // （下の lobes）。足す編み目は小さい所から育て、引く編み目は小さくして消す（数をいきなり変えると、編み目が出たり消えたりしてちらついた）。
    // 前は数を止めて間隔と編み目を縦に引き伸ばしていたが、伸ばすと編み目がばらけて三つ編みに見えなかった（指示：三つ編みの見た目から外れない）
    const reaching = this.reachAmount > 1e-3;
    if (!reaching && (!this.counted || still)) {
      const raw = target / (seg * LOBE_STEP);
      if (!this.counted || Math.abs(raw - count) >= COUNT_KEEP) count = Math.min(MAX_LOBES, Math.max(2, Math.round(raw)));
      if (still) this.counted = true;
    }
    if (!reaching) {
      const want = target / count;
      if (this.spacing < 0 || count !== this.count) this.spacing = want;
      else this.spacing += (want - this.spacing) * (!still || Math.abs(want - this.spacing) > want * SPACING_SNAP ? SPACING_MOVE : SPACING_FOLLOW);
      this.count = count;
      if (still) this.restSpacing = this.spacing;
    } else if (this.restSpacing > 0) this.spacing = this.restSpacing;
    else if (this.spacing < 0) this.spacing = target / count;
    // 描く編み目の数（伸ばしている間は端数あり。端数の分だけ一番先の編み目を小さく）
    const shown = reaching ? THREE.MathUtils.clamp(target / this.spacing, 2, MAX_LOBES) : count;
    const braidEnd = this.spacing * shown;
    // 立ち止まって決めた間隔が編み目 1 つ分の間隔より少し広いとき、編み目を縦に伸ばして埋める（伸ばしている間も同じ量のまま）
    const stretch = THREE.MathUtils.clamp(this.spacing / (seg * LOBE_STEP), 1, LOBE_STRETCH_MAX);
    this.lobes.forEach((g, i) => {
      g.visible = i < Math.ceil(shown - 1e-3);
      if (!g.visible) return;
      const d = (i + 0.5) * this.spacing;
      // 下ほど少し細く。左右交互に、とがった先が中央の下を向くよう傾ける
      const taper = 1 - 0.25 * (i / shown);
      const grow = THREE.MathUtils.clamp(shown - i, 0, 1);
      const s = i % 2 === 0 ? 1 : -1;
      place(g, d, s * w * 0.2 * taper, new THREE.Vector3(w * 1.05 * taper, seg * 1.45 * taper * stretch, w * taper).multiplyScalar(grow), -s * LOBE_TILT);
      // 下の編み目ほど手前（上の編み目の先に重なる）
      g.translateZ(w * 0.04 * (i / shown));
    });
    // リボンは三つ編みの流れる向き（数個前の編み目からの向き）に立てる。
    // 結び目のあたりは体の下へ回り込み始めるので、その場の向きだと下を向いてしまう
    // 短い三つ編みではリボンも少し小さく（編み目を覆ってしまわないように）
    const b = st.bowSize * R * THREE.MathUtils.clamp(0.55 + 0.6 * this.params.braidLength, 0.7, 1);
    {
      const here = at(braidEnd);
      const before = at(Math.max(0, braidEnd - seg * 2.5));
      const down = here.pos.clone().sub(before.pos).normalize();
      const lat = sideOf(here.nrm, down);
      const front = new THREE.Vector3().crossVectors(down, lat).normalize();
      this.bow.position.copy(here.pos).addScaledVector(front, w * 0.25);
      this.bow.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(lat, down.negate(), front));
      this.bow.scale.setScalar(b);
    }
    // 房は結び目から下へ（長すぎると地面に届くので、編み目2つ分ほどまで）
    // （長さも間隔と同じくゆっくり追従させた長さから。呼吸で伸び縮みしないように）
    const tuftLen = THREE.MathUtils.clamp(braidEnd / st.bowAt - braidEnd, seg, seg * 1.8) * 1.05;
    place(this.tuft, braidEnd + w * 0.05, 0, new THREE.Vector3(w * 0.9, tuftLen, w * 0.9), 0);
    // つかむ所：房の中ほど
    {
      const g = at(braidEnd + tuftLen * 0.5);
      const down = g.tan.clone();
      const lat = sideOf(g.nrm, down);
      this.grip.pos.copy(g.pos);
      this.grip.down.copy(down);
      this.grip.side.copy(lat);
      this.grip.front.crossVectors(down, lat).normalize();
      this.grip.ready = true;
      // つかむ所が道筋の先から手前にある長さ（次の回の延ばす分。なめらかに追う）
      const short = Math.max(0, total - (braidEnd + tuftLen * 0.5));
      // 前の回の長さをそのまま使う（なめらかに追わせると遅れ、追いつく瞬間に毛先がぐいっと動いた）
      this.reachShort = short;
      if (this.reachAmount > 1e-3) {
        this.reachFix.multiplyScalar(REACH_FIX_LEAK).addScaledVector(this.reachTarget.clone().sub(this.grip.pos), REACH_FIX_GAIN * this.reachAmount);
        const max = R * REACH_FIX_MAX;
        if (this.reachFix.length() > max) this.reachFix.setLength(max);
      } else this.reachFix.set(0, 0, 0);
    }
    this.hideThroughBrim(pts[0]);
  }

  /**
   * 帽子のつばを突き抜けた編み目と房を隠す。こーろこーろの転がり始めなどで帽子が顔の側へ倒れ、つばを垂らすと、
   * 頭の上の房やリボンをつばが貫いて、つばの上に黄色や白のかけらが出た（つばは頭だけをよける）。
   * 付け根（root。つばの下）から部品の中心を順にたどり、つばの上面を下から上へ通り抜けた所から先でつばの上に乗っている部品と、
   * 中心はつばの下でもふくらみや上下の端がつばの上に出ている部品を隠す。そこは本来つばにかぶさられて見えない所。
   * 縁を回り込む・縁の下をくぐって地面に出た三つ編みはつばの面を通らないので、そのまま見える。
   * 地面へ垂れたつばの縁を乗り越えて地面に出た所も見せる（隠すと、転がる間に縁の外の毛先が出たり消えたりした）
   */
  private hideThroughBrim(root: THREE.Vector3): void {
    const cross = this.crossing;
    const parts: [THREE.Object3D, [number, number, number][]][] = [];
    for (const g of this.lobes) if (g.visible) parts.push([g, LOBE_PROBE]);
    parts.push([this.bow, BOW_PROBE], [this.tuft, TUFT_PROBE]);
    if (!cross) {
      this.bow.visible = this.tuft.visible = true;
      return;
    }
    let side = 0;
    let prev = root;
    for (const [obj, probe] of parts) {
      obj.updateMatrix();
      const at = (p: [number, number, number]) => new THREE.Vector3(...p).applyMatrix4(obj.matrix);
      // 先頭は部品の中心
      const center = at(probe[0]);
      side += cross(prev, center);
      prev = center;
      // 通り抜けた先でも、すぐ下（体の側）につばがなければ縁の外（地面へ垂れたつばの縁を越えて地面に出た所）なので見せる
      const [cx, cy] = probe[0];
      const onBrim = side > 0 && cross(center, at([cx, cy, -SINK])) < 0;
      // リボンは隠さない（地面へ垂れたつばの端に乗ると「通り抜けた先」になり、隠すと転がる間に出たり消えたりした。
      // 羽の先が少しつばの上に出る方が目立たない）。通り抜けたかを数えるのには使う
      obj.visible = obj === this.bow || (!onBrim && !probe.slice(1).some((p) => cross(center, at(p)) > 0));
    }
  }

  dispose(): void {
    this.materials.forEach((m) => m.dispose());
    this.geometries.forEach((g) => g.dispose());
  }
}
